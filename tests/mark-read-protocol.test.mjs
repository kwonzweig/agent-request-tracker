import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP exposes only the narrow app-only read operation and returns the saved journal silently', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'journal-mark-read-protocol-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const client = new Client({ name: 'silent-read-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('src/server.mjs')],
    env: { ...process.env, REQUEST_JOURNAL_DATA_DIR: dir }, stderr: 'pipe' }));
  try {
    const listed = await client.listTools(), tool = listed.tools.find(tool => tool.name === 'journal_mark_read');
    assert.ok(tool);
    assert.deepEqual(tool._meta.ui.visibility, ['app']);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['card_id', 'conversation_id', 'record_revision']);
    assert.equal(tool.annotations.idempotentHint, true);
    assert.deepEqual(listed.tools.find(tool => tool.name === 'journal_update')._meta.ui.visibility, ['model']);
    const turn = { id: 'T1', source: 'user:actual-1', summary: 'Saved result', end_reason: 'answer_delivered' };
    const initial = await client.callTool({ name: 'journal_update', arguments: { conversation_id: 'c', expected_revision: 0, turn,
      upsert: { requests: [{ id: 'R1', title: 'Requested output', done_when: 'Verified output', status: 'active', source: turn.source }],
        cards: [{ id: 'Q1', request_id: 'R1', revision: 1, type: 'qa', title: 'Answer', body: 'Original answer', source: 'agent:1', status: 'open' }] } } });
    assert.equal(initial.isError, undefined);
    const args = { conversation_id: 'c', card_id: 'Q1', record_revision: 1 };
    const read = await client.callTool({ name: 'journal_mark_read', arguments: args });
    assert.equal(read.isError, undefined);
    assert.deepEqual(read.structuredContent.journal.turn, turn);
    assert.deepEqual(read.structuredContent.journal.replies, []);
    assert.equal(read.structuredContent.journal.cards[0].status, 'resolved');
    assert.equal(read.structuredContent.journal.cards[0].resolution.actor, 'user');
    const manifest = JSON.parse(await readFile(new URL('../plugin/plugin.json', import.meta.url), 'utf8'));
    assert.equal(read.structuredContent.runtime_version, manifest.version);
    const repeated = await client.callTool({ name: 'journal_mark_read', arguments: args });
    assert.deepEqual(repeated.structuredContent.journal, read.structuredContent.journal);
    const invalid = await client.callTool({ name: 'journal_mark_read', arguments: { ...args, record_revision: 0 } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); }
});
