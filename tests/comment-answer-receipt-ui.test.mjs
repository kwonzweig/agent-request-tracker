import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJournal, updateJournal } from '../src/store.mjs';
import { view } from './ui-harness.mjs';

const words = 'Use plain text for the proposal, but do not publish it.';
const answer = (extras = {}) => ({ revision: 1, source: 'user:message', text: words, ...extras });
const comment = (extras = {}) => ({ collection: 'decisions', id: 'D1', record_revision: 1,
  kind: 'comment', text: words, outcome: 'accepted', ...extras });
const receipt = (item = comment(), source = 'user:message') => ({ id: 'receipt', source, items: [item] });
const decision = id => ({ id, request_id: 'R1', revision: 1, question: `How should we prepare ${id}?`,
  why: 'The user must choose the proposal format.', source: 'agent:1', required: true,
  no_answer_behavior: 'Wait for the answer.', status: 'open',
  options: [{ id: 'A', label: 'Plain text', impact: 'Prepare a text proposal.' }] });
function save(dir, revision, upsert) {
  return updateJournal(dir, 'comment-answer', { expected_revision: revision,
    turn: { id: `T${revision + 1}`, source: `user:${revision + 1}`, summary: 'Record the proposal choice', end_reason: null }, upsert });
}
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'journal-comment-answer-'));
  t.after(async () => {
    assert.equal(dirname(dir), tmpdir());
    await rm(dir, { recursive: true, force: true });
  });
  await save(dir, 0, { requests: [{ id: 'R1', title: 'Prepare a proposal', status: 'active',
    source: 'user:1', done_when: 'The proposal is ready for review.' }], decisions: [decision('D1'), decision('D2')] });
  return dir;
}
const card = (ui, place, id = 'D1') => ui.document.querySelector(`#jc-${place} [data-record="${id}"]`);
const rows = node => [...node.querySelectorAll('.jc-user-reply')].map(row => row.textContent);

for (const outcome of ['accepted', undefined]) {
  test(`one ${outcome ?? 'implicit accepted'} Comment-backed answer renders once with its full restriction`, async t => {
    const dir = await setup(t), item = comment();
    if (outcome === undefined) delete item.outcome;
    const saved = await save(dir, 1, { replies: [receipt(item)],
      decisions: [{ id: 'D1', status: 'answered', user_answer: answer() }] });
    const ui = await view(); ui.show(saved);
    for (const place of ['cards-body', 'history-cards']) {
      assert.deepEqual(rows(card(ui, place)), [`Your comment${words}`]);
    }
    const persisted = await readJournal(dir, 'comment-answer');
    assert.deepEqual(persisted.replies, [receipt(item)]);
    assert.deepEqual(persisted.decisions[0].user_answer, answer());
  });
}

test('an explicit accepted Answer receipt remains one User answer', async t => {
  const dir = await setup(t);
  const saved = await save(dir, 1, { replies: [receipt({ ...comment(), kind: 'answer' })],
    decisions: [{ id: 'D1', status: 'answered', user_answer: answer() }] });
  const ui = await view(); ui.show(saved);
  for (const place of ['cards-body', 'history-cards']) assert.deepEqual(rows(card(ui, place)), [`User answered${words}`]);
});

test('a later reconciliation turn displays the answer when the matching Comment is in an earlier turn', async t => {
  const dir = await setup(t);
  await save(dir, 1, { replies: [receipt()] });
  const saved = await save(dir, 2, { decisions: [{ id: 'D1', status: 'answered', user_answer: answer() }] });
  const ui = await view(); ui.show(saved);
  assert.deepEqual(rows(card(ui, 'cards-body')), [`Your comment${words}`]);
  assert.deepEqual(rows(card(ui, 'history-cards')), [`User answered${words}`]);
  ui.document.getElementById('jc-history-tab').click(); ui.document.getElementById('jc-prev').click();
  assert.deepEqual(rows(card(ui, 'history-cards')), [`Your comment${words}`]);
});

test('equal text from a different human source is preserved as a separate Comment', async t => {
  const dir = await setup(t);
  const saved = await save(dir, 1, { replies: [receipt(comment(), 'user:other-message')],
    decisions: [{ id: 'D1', status: 'answered', user_answer: answer() }] });
  const ui = await view(); ui.show(saved);
  for (const place of ['cards-body', 'history-cards']) {
    assert.deepEqual(rows(card(ui, place)), [`User answered${words}`, `Your comment${words}`]);
  }
});

test('a different qualification in a Comment cannot hide the complete User answer', async t => {
  const dir = await setup(t);
  await save(dir, 1, { decisions: [{ id: 'D1', status: 'answered', user_answer: answer() }] });
  const shorter = 'Use plain text for the proposal.';
  const saved = await save(dir, 2, { replies: [receipt(comment({ text: shorter }))] });
  const ui = await view(); ui.show(saved);
  for (const place of ['cards-body', 'history-cards']) {
    assert.deepEqual(rows(card(ui, place)), [`User answered${words}`, `Your comment${shorter}`]);
  }
});

test('a matching source and text on an older Decision version stay distinct', async t => {
  const dir = await setup(t);
  await save(dir, 1, { decisions: [{ id: 'D1', revision: 2, question: 'How should we prepare the revised proposal?' }] });
  await save(dir, 2, { decisions: [{ id: 'D1', status: 'answered', user_answer: answer({ revision: 2 }) }] });
  const saved = await save(dir, 3, { replies: [receipt()] });
  const ui = await view(); ui.show(saved);
  for (const place of ['cards-body', 'history-cards']) {
    const displayed = rows(card(ui, place));
    assert.equal(displayed.length, 2);
    assert.equal(displayed[0], `User answered${words}`);
    assert.ok(displayed[1].startsWith(`Your comment${words}`));
    assert.match(displayed[1], /On: How should we prepare D1\?/);
  }
});

test('a matching source and text addressed to another Decision do not hide this answer', async t => {
  const dir = await setup(t);
  await save(dir, 1, { decisions: [{ id: 'D1', status: 'answered', user_answer: answer() }] });
  const saved = await save(dir, 2, { replies: [receipt(comment({ id: 'D2' }))] });
  const ui = await view(); ui.show(saved);
  assert.deepEqual(rows(card(ui, 'cards-body')), [`User answered${words}`]);
  assert.deepEqual(rows(card(ui, 'cards-body', 'D2')), [`Your comment${words}`]);
  assert.deepEqual(rows(card(ui, 'history-cards', 'D2')), [`Your comment${words}`]);
});
