import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('source MCP advertises cards and receipts and accepts a receipt with its semantic answer', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'journal-protocol-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const client = new Client({ name: 'journal-protocol-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('src/server.mjs')], env: { ...process.env, REQUEST_JOURNAL_DATA_DIR: dir }, stderr: 'pipe' }));
  try {
    const tools = await client.listTools();
    const update = tools.tools.find(tool => tool.name === 'journal_update');
    assert.ok(update.inputSchema.properties.upsert.properties.cards);
    assert.ok(update.inputSchema.properties.upsert.properties.replies);
    const turn = { id: 'T1', source: 'user:1', summary: 'Capture optional preference', end_reason: null };
    const first = await client.callTool({ name: 'journal_update', arguments: { conversation_id: 'c', expected_revision: 0, turn, upsert: {
      requests: [{ id: 'R1', title: 'Deliver the requested outcome', done_when: 'Verified output', source: 'user:1', status: 'active' }],
      cards: [{ id: 'C1', request_id: 'R1', revision: 1, type: 'suggestion', title: 'An optional preference', body: 'The preference does not block work.', source: 'agent:1', status: 'open', options: [{ id: 'A', label: 'A', impact: 'First effect' }] }],
    } } });
    assert.equal(first.isError, undefined);
    const manifest = JSON.parse(await readFile(new URL('../plugin/plugin.json', import.meta.url), 'utf8'));
    assert.equal(first.structuredContent.runtime_version, manifest.version);
    const receipt = { id: 'delivery-1', source: 'user:received-1', items: [{ collection: 'cards', id: 'C1', record_revision: 1, kind: 'answer', outcome: 'accepted', option_id: 'A' }] };
    const answered = await client.callTool({ name: 'journal_update', arguments: { conversation_id: 'c', expected_revision: 1, turn: { ...turn, id: 'T2' }, upsert: {
      replies: [receipt], cards: [{ id: 'C1', status: 'answered', user_answer: { revision: 1, source: receipt.source, option_id: 'A' } }],
    } } });
    assert.equal(answered.isError, undefined);
    const savedReceipt = answered.structuredContent.journal.replies[0];
    assert.equal(typeof savedReceipt.recorded_at, 'string');
    assert.deepEqual(savedReceipt, { ...receipt, recorded_at: savedReceipt.recorded_at });
    assert.equal(answered.structuredContent.journal.cards[0].status, 'answered');
    const repeated = await client.callTool({ name: 'journal_update', arguments: { conversation_id: 'c', expected_revision: 2, turn: { ...turn, id: 'T3' }, upsert: { replies: [receipt] } } });
    assert.equal(repeated.isError, undefined);
    assert.equal(repeated.structuredContent.journal.replies.length, 1);
    const read = await client.callTool({ name: 'journal_read', arguments: { conversation_id: 'c' } });
    assert.deepEqual(read.structuredContent.journal.replies, [savedReceipt]);
  } finally { await client.close(); }
});
