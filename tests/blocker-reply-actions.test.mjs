import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import { canAcknowledge, canResolve, draftKey, ReplyDrafts } from '../src/reply-ui.mjs';
import { needsAttention } from '../src/journal-views.mjs';
import { readJournal, updateJournal } from '../src/store.mjs';
import { commit, memoryStorage, previewState, tick, view } from './ui-harness.mjs';

const q = (ui, selector) => ui.document.querySelector(selector);
const resolve = { collection: 'blockers', id: 'B1', record_revision: 3, kind: 'resolve' };
const savedDraft = { ...resolve, token: 'legacy-resolve' };
function legacyStorage({ delivery = null, kind = 'resolve' } = {}) {
  const storage = memoryStorage();
  storage.setItem('request-journal:replies:v1:C1', JSON.stringify({ version: 1, drafts: [{ ...savedDraft, kind }], delivery }));
  return storage;
}
const update = (expected_revision, upsert = {}) => ({ expected_revision,
  turn: { id: `T${expected_revision + 1}`, source: 'user:1', summary: 'Check the blocked operation', end_reason: null }, upsert });
async function setup(t, blockerExtras = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-blocker-actions-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const state = await updateJournal(dir, 'C1', update(0, {
    requests: [{ id: 'R1', title: 'Read the account', done_when: 'The account read succeeds', source: 'user:1', status: 'active' }],
    blockers: [{ id: 'B1', request_id: 'R1', title: 'Sign in', evidence: 'tool:access-denied', next_action: 'Sign in to the account', owner: 'user', status: 'open', ...blockerExtras }],
  }));
  return { dir, state };
}

test('Blockers have no Resolve action while Q&A, Note and Complete keep their acknowledgment', async () => {
  const ui = await view(), journal = previewState();
  journal.cards.push({ id: 'C2', request_id: 'R1', revision: 1, type: 'completion', title: 'Completed result', body: 'Verified result', status: 'open' });
  ui.show(journal);
  for (const place of ['attention', 'cards-body', 'history-cards']) {
    const blocker = q(ui, `#jc-${place} [data-record="B1"]`);
    assert.equal(Boolean(blocker.querySelector('[data-reply-kind="resolve"]')), false);
    assert.equal([...blocker.querySelectorAll('button')].some(button => /^(Resolve|Resolved)$/.test(button.textContent)), false);
  }
  assert.equal(canResolve('blockers', journal.blockers[0]), false);
  assert.equal(q(ui, '#jc-attention [data-record="B1"] [data-reply-kind="defer"]').textContent, 'Later');
  assert.equal(q(ui, '#jc-attention [data-record="B1"] textarea').getAttribute('aria-label'), 'Comment · 메일 연결을 확인해 주세요');
  for (const type of ['qa', 'note', 'completion']) assert.equal(canResolve('cards', { type, status: 'open' }), true);
  assert.ok(q(ui, '#jc-attention [data-record="Q1"] [data-reply-kind="resolve"] svg'));
  assert.ok(q(ui, '#jc-attention [data-record="C2"] [data-reply-kind="resolve"] svg'));
});

for (const kind of ['resolve', 'acknowledge']) test(`a forged Blocker ${kind} cannot replace a valid draft or stage a new delivery`, () => {
  const drafts = new ReplyDrafts(memoryStorage(), 'C1');
  const comment = { ...resolve, kind: 'comment', text: 'I logged in.' };
  assert.equal(drafts.set(comment, 'report'), true);
  const action = { ...resolve, kind };
  assert.equal(drafts.set(action, 'forged'), false);
  assert.deepEqual([...drafts.drafts.values()], [{ ...comment, token: 'report' }]);
  assert.equal(drafts.stage('forged-delivery', [action]), false);
  assert.equal(drafts.delivery, null);
});

test('saved legacy Blocker resolve stays readable but cannot be inspected or staged as a current action', () => {
  const drafts = new ReplyDrafts(legacyStorage(), 'C1');
  assert.equal(drafts.storageAvailable, true);
  assert.deepEqual([...drafts.drafts.values()], [savedDraft]);
  assert.deepEqual(drafts.inspect(previewState()).items, []);
  assert.deepEqual(drafts.inspect(previewState()).stale, [savedDraft]);
  assert.equal(drafts.stage('legacy-resend', [resolve]), false);
  assert.equal(drafts.delivery, null);
  assert.equal(drafts.remove(draftKey(resolve)), true);
  assert.equal(drafts.drafts.size, 0);
});

for (const kind of ['resolve', 'acknowledge']) test(`direct staging rejects a saved Blocker ${kind} even when inspect is bypassed`, () => {
  const drafts = new ReplyDrafts(legacyStorage({ kind }), 'C1');
  assert.equal(drafts.stage('legacy-resend', [{ ...resolve, kind }]), false);
  assert.equal(drafts.delivery, null);
});

for (const kind of ['resolve', 'acknowledge']) for (const status of ['open', 'resolved']) test(`a legacy ${kind} draft on a Blocker with ${status} status stays in Cards without requiring cleanup`, async () => {
  const storage = legacyStorage({ kind }), ui = await view({ storage });
  const first = previewState();
  const journal = status === 'open' ? first : commit(first, { blockers: [{ ...first.blockers[0], status }] });
  ui.show(journal);
  const drafts = new ReplyDrafts(storage, 'C1');
  assert.equal(drafts.storageAvailable, true);
  const field = q(ui, '#jc-tree [data-record="R1"] textarea'); field.value = 'Keep this request context.';
  field.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  assert.equal(Boolean(q(ui, '#jc-attention .jc-warning')), false);
  assert.equal(Boolean(q(ui, '#jc-cards-body [data-record="B1"] .jc-warning button')), false);
  const retained = q(ui, '#jc-cards-body [data-record="B1"] .jc-warning');
  assert.ok(retained, 'the old action remains visible with its card');
  assert.match(retained.textContent, /kept here and will not be sent/);
  assert.doesNotMatch(q(ui, '#jc-draft').textContent, /Review|choices changed/);
  assert.equal(q(ui, '#jc-send').disabled, false);
  q(ui, '#jc-send').click(); await tick();
  assert.deepEqual(ui.envelope().items, [{ collection: 'requests', id: 'R1', record_revision: 1, kind: 'comment', text: 'Keep this request context.' }]);
  assert.deepEqual(new ReplyDrafts(storage, 'C1').drafts.get(draftKey({ ...resolve, kind })), { ...savedDraft, kind });
});

for (const mode of ['Later', 'Alternative', 'Other', 'Comment']) test(`a retired Blocker action cannot block a valid ${mode} reply or be consumed by it`, async () => {
  const storage = legacyStorage(), ui = await view({ storage }), first = previewState();
  const withChoices = ['Alternative', 'Other'].includes(mode);
  const journal = withChoices ? commit(first, { blockers: [{ ...first.blockers[0], revision: 1,
    options: [{ id: 'file', label: 'Use the supplied file' }] }] }) : first;
  ui.show(journal);
  const card = q(ui, '#jc-attention [data-record="B1"]');
  if (mode === 'Later') card.querySelector('[data-reply-kind="defer"]').click();
  else if (withChoices) card.querySelector(`[data-choice="${mode === 'Other' ? 'other' : 'file'}"]`).click();
  if (mode === 'Other' || mode === 'Comment') {
    const input = q(ui, '#jc-attention [data-record="B1"] textarea'); input.value = 'Use the file I supplied.';
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  }
  assert.equal(q(ui, '#jc-send').disabled, false);
  q(ui, '#jc-send').click(); await tick();
  assert.equal(ui.envelope().items.length, 1);
  assert.equal(ui.envelope().items[0].kind, mode === 'Later' ? 'defer' : mode === 'Comment' ? 'comment' : 'answer');
  assert.deepEqual(new ReplyDrafts(storage, 'C1').drafts.get(draftKey(resolve)), savedDraft);
  assert.equal(journal.blockers[0].status, 'open');
});

test('an old pending Blocker resolve delivery reconciles its historical receipt without resolving the obstacle', () => {
  const comment = { collection: 'requests', id: 'R1', record_revision: 1, kind: 'comment', text: 'Keep the original context.' };
  const storage = legacyStorage({ delivery: { id: 'old-delivery', conversation_id: 'C1', items: [resolve, comment], tokens: ['legacy-resolve', 'legacy-comment'], status: 'sending' } });
  const saved = JSON.parse(storage.getItem('request-journal:replies:v1:C1'));
  saved.drafts.push({ ...comment, token: 'legacy-comment' });
  storage.setItem('request-journal:replies:v1:C1', JSON.stringify(saved));
  const drafts = new ReplyDrafts(storage, 'C1');
  assert.equal(drafts.storageAvailable, true);
  assert.equal(drafts.delivery.status, 'uncertain');
  const journal = commit(previewState(), { replies: [{ id: 'old-delivery', source: 'user:legacy-report', items: [resolve, comment].map(item => ({ ...item, outcome: 'accepted' })) }] });
  assert.equal(drafts.reconcile(journal), true);
  assert.equal(drafts.delivery, null);
  assert.equal(drafts.drafts.size, 0);
  assert.equal(journal.blockers[0].status, 'open');
  assert.equal(needsAttention(journal.blockers[0]), true);
});

for (const kind of ['resolve', 'acknowledge']) test(`writer rejects a new accepted Blocker ${kind} receipt`, async t => {
  const { dir, state } = await setup(t);
  const receipt = { id: 'forged-action', source: 'user:logged-in', items: [{ ...resolve, record_revision: 1, kind, outcome: 'accepted' }] };
  await assert.rejects(updateJournal(dir, 'C1', update(1, { replies: [receipt] })), error => error.code === 'INVALID_REPLY');
  assert.deepEqual(await readJournal(dir, 'C1'), state);
});

for (const report of ['direct', 'comment', 'answer']) test(`a report through ${report} cannot hide an unresolved Blocker as acknowledged`, async t => {
  const { dir, state } = await setup(t, { revision: 1, options: [{ id: 'file', label: 'Use the supplied file', impact: 'Use the authorized upload' }] });
  const source = `user:${report}`;
  const replies = report === 'direct' ? [] : [{ id: report, source, items: [{ ...resolve, record_revision: 1, kind: report,
    ...(report === 'comment' ? { text: 'I logged in.' } : { outcome: 'accepted', option_id: 'file' }) }] }];
  const patch = { id: 'B1', attention: { state: 'acknowledged', actor: 'user', source },
    ...(report === 'answer' ? { user_answer: { revision: 1, source, option_id: 'file' } } : {}) };
  await assert.rejects(updateJournal(dir, 'C1', update(1, { replies, blockers: [patch] })), error => error.code === 'BLOCKER_VERIFICATION_REQUIRED');
  assert.deepEqual(await readJournal(dir, 'C1'), state);
  assert.equal(canAcknowledge('blockers', state.blockers[0]), false);
});

test('historical Blocker resolve receipts stay readable and immutable through new checkpoints', async t => {
  const { dir, state } = await setup(t);
  const receipt = { id: 'old-resolve', source: 'user:old-report', items: [{ ...resolve, record_revision: 1, outcome: 'accepted' }] };
  const legacy = commit(state, { replies: [receipt] });
  await fs.writeFile(path.join(dir, 'C1.json'), JSON.stringify(legacy));
  assert.deepEqual(await readJournal(dir, 'C1'), legacy);
  const retained = await updateJournal(dir, 'C1', update(2, { replies: [receipt] }));
  assert.deepEqual(retained.replies, [receipt]);
  assert.deepEqual(retained.history.slice(0, 2), legacy.history);
  assert.equal(retained.blockers[0].status, 'open');
  const schema = JSON.parse(await fs.readFile('schema/journal.schema.json', 'utf8'));
  const validate = new Ajv({ strict: false }).compile(schema);
  assert.equal(validate(retained), true, JSON.stringify(validate.errors));
  await assert.rejects(updateJournal(dir, 'C1', update(3, { blockers: [{ id: 'B1', status: 'resolved', resolution: {
    actor: 'agent', source: receipt.source, note: 'The old reply claims completion', record_revision: 1,
  } }] })), error => error.code === 'BLOCKER_VERIFICATION_REQUIRED');
});

test('a logged-in comment and failed retry keep a Blocker open until independent agent verification', async t => {
  const { dir } = await setup(t);
  const receipt = { id: 'logged-in', source: 'user:logged-in', items: [{ ...resolve, record_revision: 1, kind: 'comment', text: 'I logged in.' }] };
  const reported = await updateJournal(dir, 'C1', update(1, { replies: [receipt] }));
  assert.equal(reported.blockers[0].status, 'open');
  assert.equal(needsAttention(reported.blockers[0]), true);
  const ui = await view(); ui.show(reported);
  assert.ok(q(ui, '#jc-attention [data-record="B1"] .jc-card-status') === null);
  await assert.rejects(updateJournal(dir, 'C1', update(2, { blockers: [{ id: 'B1', status: 'resolved', resolution: {
    actor: 'agent', source: receipt.source, note: 'The user reported sign-in', record_revision: 1,
  } }] })), error => error.code === 'BLOCKER_VERIFICATION_REQUIRED');
  const failed = await updateJournal(dir, 'C1', update(2, { blockers: [{ id: 'B1', evidence: 'tool:retry-denied' }] }));
  assert.equal(failed.blockers[0].status, 'open');
  assert.deepEqual(failed.replies, [receipt]);
  const verified = await updateJournal(dir, 'C1', update(3, { blockers: [{ id: 'B1', status: 'resolved', resolution: {
    actor: 'agent', source: 'tool:account-read-ok', note: 'The account read succeeded', record_revision: 3,
  } }] }));
  assert.equal(verified.blockers[0].status, 'resolved');
});
