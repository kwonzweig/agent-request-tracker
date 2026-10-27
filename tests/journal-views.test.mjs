import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { turnChanges, workspaceGroups } from '../src/journal-views.mjs';
import { journalAt } from '../src/reply-ui.mjs';
import { updateJournal } from '../src/store.mjs';

const request = (id = 'R1', extra = {}) => ({ id, title: 'Original outcome', done_when: 'Verified output', source: 'user:1', status: 'active', ...extra });
const decision = (extra = {}) => ({ id: 'D1', request_id: 'R1', revision: 1, question: 'Original question?',
  why: 'Choose the effect', options: [{ id: 'A', label: 'Original A', impact: 'Original effect' }],
  no_answer_behavior: 'Continue under the current scope', status: 'open', ...extra });
const blocker = () => ({ id: 'B1', request_id: 'R1', title: 'Access unavailable', evidence: 'tool:error:access',
  next_action: 'Grant access', owner: 'user', status: 'open' });
const update = (expected_revision, turnId, upsert = {}) => ({ expected_revision,
  turn: { id: turnId, source: 'user:1', summary: 'Record turn', end_reason: null }, upsert });
async function inTemp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-views-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('workspace groups use canonical full URLs and retain legacy unlinked requests', () => {
  const requests = [request('R1'), request('R2', { workspace: null }),
    request('R3', { workspace: { id: 'PR #27', url: 'HTTPS://EXAMPLE.COM:443/pull/27?tab=files#diff' } }),
    request('R4', { workspace: { id: 'Same target', url: 'https://example.com/pull/27?tab=files#diff' } }),
    request('R5', { workspace: { id: 'PR #27', url: 'https://other.example.com/pull/27?tab=files#diff' } }),
    request('R6', { workspace: { id: 'PR #27', url: 'https://example.com/pull/27?tab=discussion#diff' } })];
  const before = structuredClone(requests);
  assert.deepEqual(workspaceGroups(requests), [
    { key: 'unlinked', label: 'Unlinked', url: null, requests: requests.slice(0, 2) },
    { key: 'https://example.com/pull/27?tab=files#diff', label: 'PR #27', url: 'https://example.com/pull/27?tab=files#diff', requests: requests.slice(2, 4) },
    { key: 'https://other.example.com/pull/27?tab=files#diff', label: 'PR #27', url: 'https://other.example.com/pull/27?tab=files#diff', requests: [requests[4]] },
    { key: 'https://example.com/pull/27?tab=discussion#diff', label: 'PR #27', url: 'https://example.com/pull/27?tab=discussion#diff', requests: [requests[5]] },
  ]);
  assert.deepEqual(requests, before);
  assert.deepEqual(workspaceGroups([]), []);
});

test('turn changes aggregate multiple saves into unique entities without future facts', async t => {
  const dir = await inTemp(t);
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()] }));
  await updateJournal(dir, 'c', update(1, 'T2', { requests: [{ id: 'R1', title: 'Revised outcome' }, request('R2')] }));
  await updateJournal(dir, 'c', update(2, 'T2', { requests: [{ id: 'R1', status: 'waiting' }] }));
  await updateJournal(dir, 'c', update(3, 'T2', {
    requests: [{ id: 'R1', status: 'done', evidence: 'test:passed-in-T2' }],
    replies: [{ id: 'receipt-1', source: 'user:comment-T2', items: [
      { collection: 'requests', id: 'R1', record_revision: 3, kind: 'comment', text: 'Keep this scope.' },
    ] }],
  }));
  const journal = await updateJournal(dir, 'c', update(4, 'T3', { requests: [{ id: 'R1', title: 'Future outcome', evidence: 'test:future' }] }));
  const original = structuredClone(journal), rows = turnChanges(journal, 'T2');
  assert.equal(rows.length, 3);
  const notice = rows.find(row => row.collection === 'cards');
  assert.equal(notice.after.type, 'completion');
  assert.equal(notice.after.title, 'Revised outcome');
  assert.deepEqual(notice.actions, ['created']);
  const changed = rows.find(row => row.id === 'R1');
  assert.equal(changed.collection, 'requests');
  assert.equal(changed.before.title, 'Original outcome');
  assert.equal(changed.before.status, 'active');
  assert.equal(changed.after.title, 'Revised outcome');
  assert.equal(changed.after.status, 'done');
  assert.equal(changed.after.evidence, 'test:passed-in-T2');
  assert.deepEqual(changed.actions, ['updated', 'status_changed', 'commented']);
  assert.deepEqual(changed.replies[0], { collection: 'requests', id: 'R1', record_revision: 3,
    kind: 'comment', text: 'Keep this scope.', reply_id: 'receipt-1', source: 'user:comment-T2',
    target: journal.history[2].changes.find(change => change.collection === 'requests').after });
  const created = rows.find(row => row.id === 'R2');
  assert.equal(created.before, null);
  assert.deepEqual(created.actions, ['created']);
  assert.deepEqual(created.replies, []);
  assert.equal(JSON.stringify(rows).includes('Future'), false);
  assert.deepEqual(journal, original);
  changed.after.title = 'Caller mutation';
  assert.deepEqual(journal, original);
});

test('receipt-only turns show turn-end targets and separately retain old stale choice context', async t => {
  const dir = await inTemp(t);
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], decisions: [decision()] }));
  await updateJournal(dir, 'c', update(1, 'T2', { decisions: [{ id: 'D1', revision: 2, question: 'Current question?',
    options: [{ id: 'B', label: 'Current B', impact: 'Current effect' }] }] }));
  await updateJournal(dir, 'c', update(2, 'T3', { replies: [{ id: 'receipt-old', source: 'user:reply-T3', items: [
    { collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', outcome: 'stale', option_id: 'A' },
    { collection: 'requests', id: 'R1', record_revision: 1, kind: 'comment', text: 'Retain this outcome.' },
  ] }] }));
  const journal = await updateJournal(dir, 'c', update(3, 'T4', {
    requests: [{ id: 'R1', title: 'Future outcome' }],
    decisions: [{ id: 'D1', revision: 3, question: 'Future question?' }],
  }));
  const rows = turnChanges(journal, 'T3');
  assert.equal(rows.length, 2);
  const answered = rows.find(row => row.id === 'D1');
  assert.deepEqual(answered.before, answered.after);
  assert.equal(answered.after.question, 'Current question?');
  assert.deepEqual(answered.actions, ['answered']);
  assert.equal(answered.replies[0].target.question, 'Original question?');
  assert.equal(answered.replies[0].target.options[0].label, 'Original A');
  assert.equal(answered.replies[0].outcome, 'stale');
  assert.equal(answered.replies[0].reply_id, 'receipt-old');
  assert.equal(answered.replies[0].source, 'user:reply-T3');
  const commented = rows.find(row => row.id === 'R1');
  assert.deepEqual(commented.before, commented.after);
  assert.deepEqual(commented.actions, ['commented']);
  assert.equal(JSON.stringify(rows).includes('Future'), false);
});

test('accepted answer receipts and applied answers share one entity entry', async t => {
  const dir = await inTemp(t);
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], decisions: [decision()] }));
  const journal = await updateJournal(dir, 'c', update(1, 'T2', {
    decisions: [{ id: 'D1', status: 'answered', user_answer: { revision: 1, source: 'user:answer-T2', option_id: 'A' } }],
    replies: [{ id: 'receipt-answer', source: 'user:answer-T2', items: [
      { collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', outcome: 'accepted', option_id: 'A' },
    ] }],
  }));
  const rows = turnChanges(journal, 'T2');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].before.status, 'open');
  assert.equal(rows[0].after.status, 'answered');
  assert.deepEqual(rows[0].actions, ['updated', 'status_changed', 'answered']);
  assert.equal(rows[0].replies[0].target.status, 'open');
  assert.equal(rows[0].replies[0].outcome, 'accepted');
});

test('turn actions retain status toggles and evidence when final state matches the initial state', async t => {
  const dir = await inTemp(t);
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()], blockers: [{ ...blocker(), resolution: null }] }));
  await updateJournal(dir, 'c', update(1, 'T2', { blockers: [{ id: 'B1', status: 'resolved',
    resolution: { actor: 'agent', source: 'tool:access-check', note: 'Access check succeeded', record_revision: 1 } }] }));
  const journal = await updateJournal(dir, 'c', update(2, 'T2', { blockers: [{ id: 'B1', status: 'open', resolution: null }] }));
  const rows = turnChanges(journal, 'T2');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].before, rows[0].after);
  assert.equal(rows[0].after.evidence, 'tool:error:access');
  assert.deepEqual(rows[0].actions, ['updated', 'status_changed']);
});

test('turn views exclude checkpoints and respect a historical journal revision', async t => {
  const dir = await inTemp(t);
  await updateJournal(dir, 'c', update(0, 'T1', { requests: [request()] }));
  const journal = await updateJournal(dir, 'c', update(1, 'T2'));
  assert.deepEqual(turnChanges(journal, 'T2'), []);
  assert.deepEqual(turnChanges(journal, 'unknown'), []);
  assert.deepEqual(turnChanges(journalAt(journal, 1), 'T2'), []);
  assert.deepEqual(turnChanges(journal, 'T1')[0].actions, ['created']);
});
