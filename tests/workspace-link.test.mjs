import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import { readJournal, updateJournal, validateJournal } from '../src/store.mjs';

const request = (workspace) => ({ id: 'R1', title: 'Deliver outcome', done_when: 'Verified output',
  source: 'user:1', status: 'active', ...(workspace === undefined ? {} : { workspace }) });
const update = (expected_revision, upsert) => ({ expected_revision,
  turn: { id: `T${expected_revision + 1}`, source: 'user:1', summary: 'Capture request', end_reason: null }, upsert });
async function inTemp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-workspace-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function schemaValidator(ref = '#/$defs/request') {
  const schema = JSON.parse(await fs.readFile(new URL('../schema/journal.schema.json', import.meta.url), 'utf8'));
  return new Ajv({ strict: false }).compile(ref ? { $defs: schema.$defs, $ref: ref } : schema);
}

test('legacy unlinked requests remain valid and a null patch removes a workspace link', async t => {
  const dir = await inTemp(t);
  const validate = await schemaValidator(null);
  const legacy = await updateJournal(dir, 'c', update(0, { requests: [request()] }));
  assert.equal(validate(legacy), true, JSON.stringify(validate.errors));
  assert.equal(Object.hasOwn(legacy.requests[0], 'workspace'), false);
  const workspace = { id: 'PR #27 / review', url: 'https://github.com/acme/repo/pull/27?tab=files#diff' };
  const linked = await updateJournal(dir, 'c', update(1, { requests: [{ id: 'R1', workspace }] }));
  assert.deepEqual(linked.requests[0].workspace, workspace);
  assert.equal(linked.requests[0].status, 'active');
  assert.equal(validate(linked), true, JSON.stringify(validate.errors));
  const unlinked = await updateJournal(dir, 'c', update(2, { requests: [{ id: 'R1', workspace: null }] }));
  assert.equal(unlinked.requests[0].workspace, null);
  assert.deepEqual(unlinked.history[2].changes[0].before.workspace, workspace);
  assert.equal(validate(unlinked), true, JSON.stringify(validate.errors));
  assert.deepEqual((await readJournal(dir, 'c')).requests[0], unlinked.requests[0]);
});

test('writer rejects malformed workspace values without changing the saved file', async t => {
  const dir = await inTemp(t);
  await updateJournal(dir, 'c', update(0, { requests: [request()] }));
  const file = path.join(dir, 'c.json'), before = await fs.readFile(file, 'utf8');
  const invalid = [[], 'PR #27', 42, {}, { id: 'PR #27' }, { url: 'https://example.com/ticket' },
    { id: '', url: 'https://example.com/ticket' }, { id: ' \t ', url: 'https://example.com/ticket' },
    { id: 'x'.repeat(129), url: 'https://example.com/ticket' }, { id: 27, url: 'https://example.com/ticket' }];
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', '/ticket', '//example.com/ticket',
    '', null, 42, 'https://', 'https:///example.com/ticket', 'https://[invalid]/ticket',
    'https://example.com:bad/ticket', ' https://example.com/ticket', 'https://example.com/tick et',
    'https://example.com/\\ticket', 'https://example.com/\nticket', 'https://example.com/\u0000ticket',
    'https://example.com/\u007fticket', 'https://user:secret@example.com/ticket',
    'https://user@example.com/ticket', 'https://@example.com/ticket']) invalid.push({ id: 'PR #27', url });
  for (const workspace of invalid) {
    await assert.rejects(updateJournal(dir, 'c', update(1, { requests: [{ id: 'R1', workspace }] })),
      error => error.code === 'INVALID_REQUEST', JSON.stringify(workspace));
    assert.equal(await fs.readFile(file, 'utf8'), before);
  }
});

test('workspace schema validates labels and rejects unsafe URLs in requests and history', async () => {
  const validate = await schemaValidator();
  for (const workspace of [null, { id: 'PR #27', url: 'HTTPS://EXAMPLE.COM:443/ticket?view=1#discussion' },
    { id: 'x'.repeat(128), url: 'http://localhost:3000/ticket' }, { id: '작업 #27', url: 'https://example.com/ticket' }]) {
    assert.equal(validate(request(workspace)), true, JSON.stringify(validate.errors));
  }
  for (const workspace of [{ id: ' ', url: 'https://example.com/ticket' },
    { id: 'x'.repeat(129), url: 'https://example.com/ticket' }, {}, [],
    ...['javascript:alert(1)', 'https:///example.com/ticket', 'https://example.com/\\ticket',
      'https://example.com/\nticket', 'https://example.com/\u0000ticket', 'https://example.com/\u007fticket',
      'https://user:secret@example.com/ticket', 'https://@example.com/ticket'].map(url => ({ id: 'PR #27', url }))]) {
    assert.equal(validate(request(workspace)), false, JSON.stringify(workspace));
  }
  const history = await schemaValidator('#/$defs/history');
  const malformed = request({ id: 'PR #27', url: 'javascript:alert(1)' });
  assert.equal(history({ revision: 1, turn_id: 'T1', changes: [
    { collection: 'requests', id: 'R1', before: null, after: malformed },
  ] }), false);
  assert.equal(history({ revision: 2, turn_id: 'T2', changes: [
    { collection: 'requests', id: 'R1', before: malformed, after: request(null) },
  ] }), false);
});

test('writer validates historical workspace links after the current link has been removed', async t => {
  const dir = await inTemp(t);
  await updateJournal(dir, 'c', update(0, { requests: [request({ id: 'PR #27', url: 'https://example.com/ticket' })] }));
  const saved = await updateJournal(dir, 'c', update(1, { requests: [{ id: 'R1', workspace: null }] }));
  const malformed = { id: 'PR #27', url: 'https://user:secret@example.com/ticket' };
  saved.history[0].changes.find(change => change.collection === 'requests').after.workspace = malformed;
  saved.history[1].changes.find(change => change.collection === 'requests').before.workspace = malformed;
  assert.throws(() => validateJournal(saved), error => error.code === 'INVALID_REQUEST');
});
