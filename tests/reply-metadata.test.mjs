import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readJournal, updateJournal } from '../src/store.mjs';

const update = (expected_revision, upsert = {}) => ({ expected_revision,
  turn: { id: `T${expected_revision + 1}`, source: 'user:1', summary: 'Record the actual reply', end_reason: null }, upsert });
const receipt = (id = 'reply-1') => ({ id, source: `message:${id}`, items: [
  { collection: 'cards', id: 'C1', record_revision: 1, kind: 'comment', text: 'Keep this context.' },
] });
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-reply-metadata-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await updateJournal(dir, 'c', update(0, {
    requests: [{ id: 'R1', title: 'Deliver the result', done_when: 'Verified output', source: 'user:1', status: 'active' }],
    cards: [{ id: 'C1', request_id: 'R1', revision: 1, type: 'note', title: 'Useful context',
      body: 'The authorized work continues.', source: 'agent:1', status: 'open' }],
  }));
  return dir;
}
async function connect(t, dir) {
  const client = new Client({ name: 'reply-metadata-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('src/server.mjs')],
    env: { ...process.env, REQUEST_JOURNAL_DATA_DIR: dir }, stderr: 'pipe' }));
  t.after(() => client.close());
  return client;
}
const callUpdate = (client, revision, replies) => client.callTool({ name: 'journal_update',
  arguments: { conversation_id: 'c', ...update(revision, { replies }) } });

test('published receipt schema accepts optional recorded provenance and rejects malformed metadata', async () => {
  const schema = JSON.parse(await fs.readFile('schema/journal.schema.json', 'utf8'));
  const validate = new Ajv({ strict: false }).compile({ $defs: schema.$defs, $ref: '#/$defs/reply' });
  for (const metadata of [{}, { input_method: 'card' }, { input_method: 'chat' },
    { recorded_at: '2026-10-06T12:34:56.123Z' }, { recorded_at: '2026-10-06T07:34:56-05:00' }]) {
    assert.equal(validate({ ...receipt(), ...metadata }), true, JSON.stringify(validate.errors));
  }
  for (const metadata of [{ input_method: 'inferred' }, { input_method: null }, { input_method: 3 },
    { recorded_at: 'yesterday' }, { recorded_at: '2026-10-06' }, { recorded_at: '2026-13-06T12:34:56Z' },
    { recorded_at: '2026-10-06T25:34:56Z' }, { recorded_at: null }]) {
    assert.equal(validate({ ...receipt(), ...metadata }), false, JSON.stringify(metadata));
  }
});

test('writer rejects invalid reply metadata without committing any receipt or history', async t => {
  const dir = await setup(t), before = await readJournal(dir, 'c');
  for (const metadata of [{ input_method: 'inferred' }, { input_method: null }, { input_method: 3 },
    { recorded_at: 'yesterday' }, { recorded_at: '2026-10-06' }, { recorded_at: '2026-02-30T12:34:56Z' },
    { recorded_at: '2026-10-06T25:34:56Z' }, { recorded_at: null }]) {
    await assert.rejects(updateJournal(dir, 'c', update(1, { replies: [{ ...receipt(), ...metadata }] })),
      error => error.code === 'INVALID_REPLY');
    assert.deepEqual(await readJournal(dir, 'c'), before);
  }
});

test('direct writer retains supplied valid metadata and exact immutable history', async t => {
  const dir = await setup(t);
  const original = { ...receipt(), input_method: 'chat', recorded_at: '2026-10-06T07:34:56-05:00' };
  const saved = await updateJournal(dir, 'c', update(1, { replies: [original] }));
  assert.deepEqual(saved.replies, [original]);
  const repeated = await updateJournal(dir, 'c', update(2, { replies: [original] }));
  assert.deepEqual(repeated.replies, [original]);
  assert.deepEqual(repeated.history.slice(0, 2), saved.history);
  assert.deepEqual(await readJournal(dir, 'c'), repeated);
});

test('source MCP stamps new replies at recording time without guessing their input method', async t => {
  const dir = await setup(t), client = await connect(t, dir);
  const originals = [
    { ...receipt('card-reply'), input_method: 'card', recorded_at: '2000-01-01T00:00:00.000Z' },
    { ...receipt('chat-reply'), input_method: 'chat' }, receipt('unknown-reply'),
  ];
  const started = Date.now(), result = await callUpdate(client, 1, originals), finished = Date.now();
  assert.equal(result.isError, undefined);
  for (const [index, saved] of result.structuredContent.journal.replies.entries()) {
    assert.equal(typeof saved.recorded_at, 'string');
    assert.ok(Date.parse(saved.recorded_at) >= started && Date.parse(saved.recorded_at) <= finished);
    const { recorded_at, ...rest } = saved;
    const { recorded_at: supplied, ...original } = originals[index];
    assert.deepEqual(rest, original, 'stamping must preserve the full received batch and declared input method');
  }
  assert.deepEqual(await readJournal(dir, 'c'), result.structuredContent.journal);
});

test('source MCP retries preserve the original stamp and reject changed receipt metadata or text', async t => {
  const dir = await setup(t), client = await connect(t, dir);
  const original = { ...receipt(), input_method: 'card' };
  const saved = (await callUpdate(client, 1, [original])).structuredContent.journal;
  assert.equal(typeof saved.replies[0].recorded_at, 'string');
  const retry = await callUpdate(client, 2, [original]);
  assert.equal(retry.isError, undefined);
  assert.deepEqual(retry.structuredContent.journal.replies, saved.replies);
  assert.deepEqual(retry.structuredContent.journal.history.slice(0, 2), saved.history);
  const current = retry.structuredContent.journal;
  for (const changed of [{ ...original, input_method: 'chat' },
    { ...original, recorded_at: '2000-01-01T00:00:00.000Z' },
    { ...original, items: [{ ...original.items[0], text: 'Changed text' }] }]) {
    const rejected = await callUpdate(client, 3, [changed]);
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /cannot be changed/);
    assert.deepEqual(await readJournal(dir, 'c'), current);
  }
});

test('source MCP keeps unstamped legacy receipts exactly unchanged on idempotent upsert', async t => {
  const dir = await setup(t), original = receipt();
  const before = await updateJournal(dir, 'c', update(1, { replies: [original] }));
  const client = await connect(t, dir), result = await callUpdate(client, 2, [original]);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.journal.replies, [original]);
  assert.deepEqual(result.structuredContent.journal.history.slice(0, 2), before.history);
  assert.deepEqual(await readJournal(dir, 'c'), result.structuredContent.journal);
});

test('source MCP rejects malformed declared metadata rather than hiding it with a generated stamp', async t => {
  const dir = await setup(t), client = await connect(t, dir), before = await readJournal(dir, 'c');
  for (const metadata of [{ input_method: 'inferred' }, { recorded_at: 'not an ISO time' }]) {
    const rejected = await callUpdate(client, 1, [{ ...receipt(), ...metadata }]);
    assert.equal(rejected.isError, true);
    assert.deepEqual(await readJournal(dir, 'c'), before);
  }
});
