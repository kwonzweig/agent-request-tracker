import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../src/store.mjs';

const turn = { id: 'T1', source: 'user:actual-1', summary: 'The saved outcome', end_reason: 'answer_delivered' };
const update = (expected_revision, upsert, checkpoint = turn) => ({ expected_revision, turn: checkpoint, upsert });
async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'journal-mark-read-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const state = await store.updateJournal(dir, 'c', update(0, {
    requests: [{ id: 'R1', title: 'Current task', done_when: 'Verified output', status: 'active', source: 'user:actual-1' },
      { id: 'R2', title: 'Finished task', done_when: 'Saved output', status: 'done', source: 'user:actual-1', evidence: 'artifact:finished' }],
    cards: [{ id: 'Q1', request_id: 'R1', revision: 1, type: 'qa', title: 'An answer', body: 'Original answer', source: 'agent:1', status: 'open' },
      { id: 'N1', request_id: 'R1', revision: 1, type: 'note', title: 'A note', body: 'Original note', source: 'agent:1', status: 'answered' },
      { id: 'S1', request_id: 'R1', revision: 1, type: 'suggestion', title: 'A suggestion', body: 'Requires a choice', source: 'agent:1', status: 'open' }],
    decisions: [{ id: 'D1', request_id: 'R1', revision: 1, question: 'Which choice?', why: 'A decision is needed',
      options: [{ id: 'A', label: 'A', impact: 'First effect' }], no_answer_behavior: 'Keep working', status: 'open', required: false }],
    blockers: [{ id: 'B1', request_id: 'R1', title: 'Access needed', evidence: 'tool:login', next_action: 'Sign in', owner: 'user', status: 'open' }],
  }));
  return { dir, state, file: join(dir, 'c.json') };
}
const mark = (dir, card_id, record_revision = 1) => store.markCardRead(dir, 'c', { card_id, record_revision });

for (const type of ['qa', 'note', 'completion']) test(`silent read persists only the exact ${type} card with User attribution`, async t => {
  const { dir, state } = await fixture(t), original = state.cards.find(card => card.type === type);
  const saved = await mark(dir, original.id);
  const card = saved.cards.find(card => card.id === original.id);
  assert.deepEqual(card, { ...original, status: 'resolved', resolution: { actor: 'user',
    source: `app:journal_mark_read:${original.id}:1`, note: 'Marked as read in Request Tracker.', record_revision: 1 } });
  for (const collection of ['requests', 'decisions', 'blockers', 'replies']) assert.deepEqual(saved[collection], state[collection]);
  assert.deepEqual(saved.cards.filter(item => item.id !== original.id), state.cards.filter(item => item.id !== original.id));
  assert.deepEqual(saved.turn, state.turn, 'the silent click does not create or alter a conversation turn');
  assert.deepEqual(saved.history.slice(0, -1), state.history);
  assert.equal(saved.revision, state.revision + 1);
  const event = saved.history.at(-1);
  assert.equal(event.turn_id, turn.id);
  assert.deepEqual(event.changes, [{ collection: 'cards', id: original.id, before: original, after: card },
    { collection: 'turn', id: turn.id, before: state.turn, after: state.turn }]);
  assert.deepEqual(await store.readJournal(dir, 'c'), saved);
});

test('duplicate silent reads of the same original binding are idempotent across unrelated writes', async t => {
  const { dir, file } = await fixture(t);
  const first = await mark(dir, 'Q1'), bytes = await fs.readFile(file, 'utf8');
  assert.deepEqual(await mark(dir, 'Q1'), first);
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
  const unrelated = await store.updateJournal(dir, 'c', update(first.revision, { cards: [{ id: 'N1', revision: 2, body: 'Updated unrelated note' }] }));
  const after = await fs.readFile(file, 'utf8');
  assert.deepEqual(await mark(dir, 'Q1'), unrelated);
  assert.equal(await fs.readFile(file, 'utf8'), after);
});

test('the original read remains idempotent after cosmetic URLs and nudge edits', async t => {
  const { dir, file } = await fixture(t);
  const marked = await mark(dir, 'Q1');
  const cosmetic = await store.updateJournal(dir, 'c', update(marked.revision, { cards: [{ id: 'Q1',
    urls: [{ label: 'Reference', url: 'https://example.com/reference' }], nudge: { text: 'A presentation reminder', priority: 'normal' } }] }));
  const bytes = await fs.readFile(file, 'utf8');
  assert.deepEqual(await mark(dir, 'Q1'), cosmetic);
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
  assert.deepEqual(cosmetic.cards.find(card => card.id === 'Q1').resolution, marked.cards.find(card => card.id === 'Q1').resolution);
});

test('the narrow read operation rejects other card roles and invalid input without writes', async t => {
  const { dir, file } = await fixture(t), bytes = await fs.readFile(file, 'utf8');
  for (const card of ['D1', 'B1', 'S1', 'missing']) {
    await assert.rejects(mark(dir, card), error => error.code === 'INVALID_READ_CARD');
    assert.equal(await fs.readFile(file, 'utf8'), bytes);
  }
  for (const record_revision of [0, -1, 1.5, '1', NaN]) await assert.rejects(mark(dir, 'Q1', record_revision));
  await assert.rejects(mark(dir, '../outside'), error => error.code === 'INVALID_ID');
  await assert.rejects(store.markCardRead(dir, 'c', { card_id: 'Q1', record_revision: 1, status: 'resolved' }), error => error.code === 'INVALID_MARK_READ');
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
});

test('changed or reopened content and lifecycle reject a stale read binding', async t => {
  const { dir, file } = await fixture(t);
  await store.updateJournal(dir, 'c', update(1, { cards: [{ id: 'Q1', revision: 2, body: 'A new answer' }] }));
  let bytes = await fs.readFile(file, 'utf8');
  await assert.rejects(mark(dir, 'Q1'), error => error.code === 'STALE_RECORD');
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
  const read = await mark(dir, 'Q1', 2);
  await store.updateJournal(dir, 'c', update(read.revision, { cards: [{ id: 'Q1', status: 'open' }] }));
  bytes = await fs.readFile(file, 'utf8');
  await assert.rejects(mark(dir, 'Q1', 2), error => error.code === 'STALE_RECORD');
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
  const current = await store.readJournal(dir, 'c');
  await store.updateJournal(dir, 'c', update(current.revision, { cards: [{ id: 'N1', status: 'deferred' }] }));
  await assert.rejects(mark(dir, 'N1', current.revision + 1), error => error.code === 'INVALID_READ_CARD');
});

test('silent read shares the existing atomic writer lock and preserves a concurrent unrelated update', async t => {
  const { dir } = await fixture(t);
  const patch = { cards: [{ id: 'N1', revision: 2, body: 'Concurrent note edit' }] };
  const results = await Promise.allSettled([mark(dir, 'Q1'), store.updateJournal(dir, 'c', update(1, patch))]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  assert.ok(results.filter(result => result.status === 'rejected').every(result => ['LOCKED', 'STALE_REVISION'].includes(result.reason.code)));
  let saved = await store.readJournal(dir, 'c');
  if (results[0].status === 'rejected') saved = await mark(dir, 'Q1');
  if (results[1].status === 'rejected') saved = await store.updateJournal(dir, 'c', update(saved.revision, patch));
  assert.equal(saved.cards.find(card => card.id === 'Q1').resolution.actor, 'user');
  assert.equal(saved.cards.find(card => card.id === 'N1').body, 'Concurrent note edit');
  assert.deepEqual(saved.turn, turn);
  assert.deepEqual(saved.replies, []);
});

test('simultaneous duplicate clicks commit one read and retry the original binding without another history event', async t => {
  const { dir } = await fixture(t);
  const results = await Promise.allSettled([mark(dir, 'Q1'), mark(dir, 'Q1')]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'LOCKED'));
  const saved = await store.readJournal(dir, 'c');
  assert.equal(saved.revision, 2);
  assert.deepEqual(await mark(dir, 'Q1'), saved);
});

test('a failed atomic read commit keeps the original file and releases only its owned lock', async t => {
  const { dir, file } = await fixture(t), bytes = await fs.readFile(file, 'utf8');
  const mocked = t.mock.method(fs, 'rename', async () => { throw Object.assign(Error('write failed'), { code: 'EIO' }); });
  await assert.rejects(mark(dir, 'Q1'), error => error.code === 'EIO');
  mocked.mock.restore();
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
  assert.deepEqual(await fs.readdir(dir), ['c.json']);
  await fs.writeFile(`${file}.lock`, 'another writer');
  await assert.rejects(mark(dir, 'Q1'), error => error.code === 'LOCKED');
  assert.equal(await fs.readFile(`${file}.lock`, 'utf8'), 'another writer');
});
