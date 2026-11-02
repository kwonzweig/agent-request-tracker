import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tracker-toggle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); });
  async function connect() {
    const client = new Client({ name: 'activation-test', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [resolve('src/server.mjs')], env: { ...process.env, REQUEST_JOURNAL_DATA_DIR: dir }, stderr: 'pipe' }));
    clients.push(client);
    return client;
  }
  return { dir, connect };
}
const call = (client, name, args = {}) => client.callTool({ name, arguments: { conversation_id: 'session-a', ...args } });
const update = { expected_revision: 0, turn: { id: 'turn-1', source: 'user:1', summary: 'Answer delivered', end_reason: 'complete' }, upsert: {} };
async function hook(dir, event) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['src/hook.mjs'], { env: { ...process.env, REQUEST_JOURNAL_DATA_DIR: dir }, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveResult(out ? JSON.parse(out) : null) : reject(new Error(err)));
    child.stdin.end(JSON.stringify({ session_id: 'session-a', turn_id: 'turn-1', ...event }));
  });
}

test('ON/OFF/ON survives server restart, preserves records, and isolates conversations', async t => {
  const { dir, connect } = await fixture(t);
  let client = await connect();
  const read = await call(client, 'journal_read');
  assert.equal(read.structuredContent.tracking_enabled, false);
  assert.equal((await call(client, 'journal_update', update)).isError, true);
  const on = await call(client, 'journal_tracking', { enabled: true });
  assert.equal(on.isError, undefined);
  assert.equal(on.structuredContent.tracking_enabled, true);
  assert.equal((await call(client, 'journal_update', update)).isError, undefined);
  const before = await readFile(join(dir, 'session-a.json'), 'utf8');
  const off = await call(client, 'journal_tracking', { enabled: false });
  assert.equal(off.structuredContent.tracking_enabled, false);
  await client.close(); client = await connect();
  assert.equal((await call(client, 'journal_read')).structuredContent.tracking_enabled, false);
  assert.equal((await call(client, 'journal_update', { ...update, expected_revision: 1 })).isError, true);
  assert.equal((await call(client, 'journal_show')).isError, true);
  assert.equal(await readFile(join(dir, 'session-a.json'), 'utf8'), before);
  assert.equal((await call(client, 'journal_read', { conversation_id: 'session-b' })).structuredContent.tracking_enabled, false);
  await call(client, 'journal_tracking', { enabled: true });
  const resumed = await call(client, 'journal_read');
  assert.equal(resumed.structuredContent.journal.revision, 1);
  assert.equal(resumed.structuredContent.tracking_enabled, true);
  assert.equal((await call(client, 'journal_show')).isError, undefined);
});

test('OFF silences all hooks even with saved history; ON restores the next turn', async t => {
  const { dir, connect } = await fixture(t), client = await connect();
  assert.equal(await hook(dir, { hook_event_name: 'SessionStart' }), null);
  await call(client, 'journal_tracking', { enabled: true });
  assert.match((await hook(dir, { hook_event_name: 'SessionStart' })).hookSpecificOutput.additionalContext, /Request Tracker is active/);
  await call(client, 'journal_update', update);
  await call(client, 'journal_tracking', { enabled: false });
  for (const hook_event_name of ['SessionStart', 'UserPromptSubmit', 'Stop', 'Interrupt']) {
    assert.equal(await hook(dir, { hook_event_name }), null);
  }
  await call(client, 'journal_tracking', { enabled: true });
  assert.ok((await hook(dir, { hook_event_name: 'UserPromptSubmit', turn_id: 'turn-2' })).hookSpecificOutput);
});

test('Stop detects a missing or stale show request, with bounded repair and interruption priority', async t => {
  const { dir, connect } = await fixture(t), client = await connect();
  await call(client, 'journal_tracking', { enabled: true });
  await call(client, 'journal_update', update);
  assert.equal((await hook(dir, { hook_event_name: 'Stop' })).decision, 'block');
  assert.equal((await hook(dir, { hook_event_name: 'Stop', stop_hook_active: true })).decision, undefined);
  await call(client, 'journal_show');
  assert.deepEqual(await hook(dir, { hook_event_name: 'Stop' }), {});
  await call(client, 'journal_update', { ...update, expected_revision: 1 });
  assert.equal((await hook(dir, { hook_event_name: 'Stop' })).decision, 'block');
  await hook(dir, { hook_event_name: 'Interrupt' });
  assert.equal(await hook(dir, { hook_event_name: 'Stop' }), null);
});

test('silent reads retain the show receipt; a subsequent card edit requires showing again', async t => {
  const { dir, connect } = await fixture(t), client = await connect();
  await call(client, 'journal_tracking', { enabled: true });
  const saved = await call(client, 'journal_update', { ...update, upsert: {
    requests: [{ id: 'R1', title: 'Example result', done_when: 'Result verified', source: 'user:1', status: 'done', evidence: 'Verified result' }],
    cards: [{ id: 'N1', request_id: 'R1', revision: 1, type: 'note', title: 'A useful note', body: 'A useful explanation', source: 'agent:1', status: 'open' }]
  } });
  assert.equal(saved.isError, undefined);
  await call(client, 'journal_show');
  const acknowledged = await call(client, 'journal_mark_read', { card_id: 'N1', record_revision: 1 });
  assert.equal(acknowledged.isError, undefined);
  assert.deepEqual(await hook(dir, { hook_event_name: 'Stop' }), {});
  const edited = await call(client, 'journal_update', { ...update, expected_revision: 2, upsert: {
    cards: [{ id: 'N1', urls: [{ label: 'Related result', url: 'https://example.com/result' }] }]
  } });
  assert.equal(edited.isError, undefined);
  assert.equal((await hook(dir, { hook_event_name: 'Stop' })).decision, 'block');
});

test('an explicit user pause never triggers display repair or resumes work', async t => {
  const { dir, connect } = await fixture(t), client = await connect();
  await call(client, 'journal_tracking', { enabled: true });
  const paused = await call(client, 'journal_update', { ...update,
    turn: { ...update.turn, end_reason: 'user_paused', pause_source: update.turn.source },
    upsert: { requests: [{ id: 'R1', title: 'Paused work', done_when: 'Verified result', source: 'user:1', status: 'active' }] }
  });
  assert.equal(paused.isError, undefined);
  assert.deepEqual(await hook(dir, { hook_event_name: 'Stop' }), {});
});
