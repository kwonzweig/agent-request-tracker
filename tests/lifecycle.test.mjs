import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import { attentionItems, attentionState, needsAttention, turnChanges } from '../src/journal-views.mjs';
import { canResolve, canDefer, hasChoices, ReplyDrafts } from '../src/reply-ui.mjs';
import { formatReplyText } from '../src/reply-text.mjs';
import { evaluateStop, readJournal, updateJournal } from '../src/store.mjs';
import { legacyDoneFixture } from './legacy-done-fixture.mjs';
import { legacyBlockerFixture } from './legacy-blocker-fixture.mjs';

const request = { id: 'R1', title: 'Deliver the approved outcome', done_when: 'Operation verified', source: 'user:1', status: 'active' };
const options = [{ id: 'file', label: 'Use the supplied file', impact: 'Continue using the authorized uploaded source' }];
const decision = { id: 'D1', request_id: 'R1', revision: 1, question: 'Which route?', why: 'Permission matters',
  no_answer_behavior: 'Wait before dependent work', options, status: 'open', required: true };
const blocker = { id: 'B1', request_id: 'R1', title: 'Login unavailable', evidence: 'tool:login-denied',
  next_action: 'Sign in to the linked account', owner: 'user', status: 'open' };
const qa = { id: 'Q1', request_id: 'R1', revision: 1, type: 'qa', title: 'What does Open mean?',
  body: 'The card still needs a response.', source: 'agent:1', status: 'answered' };
const update = (expected_revision, upsert = {}, end_reason = null) => ({ expected_revision,
  turn: { id: `T${expected_revision + 1}`, source: 'user:1', summary: 'Reconcile the current input', end_reason }, upsert });
const reply = (id, collection, target, record_revision, kind, extra = {}) => ({ id, source: `user:${id}`,
  items: [{ collection, id: target, record_revision, kind, outcome: 'accepted', ...extra }] });
async function setup(t, upsert = {}, legacy = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-lifecycle-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await (legacy ? legacyBlockerFixture : updateJournal)(dir, 'c', update(0, { requests: [request], ...upsert }));
  return dir;
}

test('a missed choice stays pending across turns; Later persists through changes until a sourced dependency reopening', async t => {
  const dir = await setup(t, { decisions: [decision], cards: [qa] });
  const missed = await updateJournal(dir, 'c', update(1));
  assert.deepEqual(attentionItems(missed).map(item => item.record.id), ['D1', 'Q1']);
  const later = reply('later', 'decisions', 'D1', 1, 'defer');
  await updateJournal(dir, 'c', update(2, { replies: [later], decisions: [{ id: 'D1',
    attention: { state: 'later', actor: 'user', source: later.source } }] }));
  const changed = await updateJournal(dir, 'c', update(3, { decisions: [{ id: 'D1', revision: 2, why: 'The route has a new effect' }] }));
  assert.equal(attentionState(changed.decisions[0]), 'later');
  assert.equal(needsAttention(changed.decisions[0]), false);
  assert.equal(changed.decisions[0].required, true);
  for (const attention of [null, { state: 'pending', actor: 'agent', source: 'agent:5' }]) {
    await assert.rejects(updateJournal(dir, 'c', update(4, { decisions: [{ id: 'D1', attention }] })), error => error.code === 'REOPEN_REASON_REQUIRED');
  }
  const reopened = await updateJournal(dir, 'c', update(4, { decisions: [{ id: 'D1', attention: {
    state: 'pending', actor: 'agent', source: 'workspace:import-ready', reason: 'Import is ready and cannot select its source until this choice is answered' } }] }));
  assert.equal(needsAttention(reopened.decisions[0]), true);
  assert.equal((await readJournal(dir, 'c')).decisions[0].attention.reason, reopened.decisions[0].attention.reason);
});

test('a comment reports a performed human step; failed verification keeps the same blocker pending and preserves the report', async t => {
  const dir = await setup(t, { blockers: [blocker] });
  const report = reply('step-completed', 'blockers', 'B1', 1, 'comment', { text: 'I logged in.' });
  const received = await updateJournal(dir, 'c', update(1, { replies: [report] }));
  assert.equal(received.blockers[0].status, 'open');
  assert.equal(needsAttention(received.blockers[0]), true);
  for (const resolution of [undefined, { actor: 'user', source: report.source, note: 'The user reported sign-in' },
    { actor: 'agent', source: report.source, note: 'Treat the comment as verification' }]) {
    const patch = { id: 'B1', status: 'resolved', ...(resolution ? { resolution } : {}) };
    await assert.rejects(updateJournal(dir, 'c', update(2, { blockers: [patch] })), error => error.code === 'BLOCKER_VERIFICATION_REQUIRED');
  }
  const failed = await updateJournal(dir, 'c', update(2, { blockers: [{ id: 'B1', evidence: 'tool:retry-denied',
    next_action: 'Grant the required account role', attention: { state: 'pending', actor: 'agent',
      source: 'tool:retry-denied', reason: 'The connection still returns access denied after the reported sign-in' } }] }));
  assert.equal(failed.blockers[0].id, 'B1');
  assert.equal(failed.blockers[0].status, 'open');
  assert.equal(needsAttention(failed.blockers[0]), true);
  assert.deepEqual(failed.replies[0], report);
  const verified = await updateJournal(dir, 'c', update(3, { blockers: [{ id: 'B1', status: 'resolved',
    resolution: { actor: 'agent', source: 'tool:connection-ok', note: 'The affected operation succeeded after role access was granted', record_revision: 3 } }] }));
  assert.equal(needsAttention(verified.blockers[0]), false);
  assert.deepEqual(turnChanges(verified, 'T2')[0].actions, ['commented']);
});

test('blocker alternatives retain explicit answer evidence without claiming that the obstacle was solved; Later remains available', async t => {
  const dir = await setup(t, { blockers: [{ ...blocker, options, revision: 1, recommendation: 'file' }] });
  const chosen = reply('alternative', 'blockers', 'B1', 1, 'answer', { option_id: 'file' });
  const selected = await updateJournal(dir, 'c', update(1, { replies: [chosen], blockers: [{ id: 'B1',
    user_answer: { revision: 1, source: chosen.source, option_id: 'file' } }] }));
  assert.equal(selected.blockers[0].status, 'open');
  assert.equal(needsAttention(selected.blockers[0]), true);
  assert.equal(hasChoices('blockers', selected.blockers[0]), false);
  assert.equal(canDefer('blockers', selected.blockers[0]), true);
  const later = reply('blocker-later', 'blockers', 'B1', 2, 'defer');
  const postponed = await updateJournal(dir, 'c', update(2, { replies: [later], blockers: [{ id: 'B1',
    attention: { state: 'later', actor: 'user', source: later.source } }] }));
  assert.equal(needsAttention(postponed.blockers[0]), false);
  const dismissed = await updateJournal(dir, 'c', update(3, { blockers: [{ id: 'B1', status: 'dismissed', dismissal: {
    actor: 'agent', source: chosen.source, reason: 'The explicitly authorized file source replaces the login path' } }] }));
  assert.equal(dismissed.blockers[0].user_answer.source, chosen.source);
  assert.equal(dismissed.blockers[0].resolution, undefined);
  assert.equal(needsAttention(dismissed.blockers[0]), false);
});

test('changed alternatives reject stale acceptance and cannot reuse a saved receipt as permission for a new choice', async t => {
  const dir = await setup(t, { blockers: [{ ...blocker, options, revision: 1 }] });
  const old = reply('old-alternative', 'blockers', 'B1', 1, 'answer', { option_id: 'file' });
  await updateJournal(dir, 'c', update(1, { replies: [old] }));
  await assert.rejects(updateJournal(dir, 'c', update(2, { blockers: [{ id: 'B1', options: [{ id: 'file', label: 'Different file', impact: 'Changes the authorized source' }] }] })),
    error => error.code === 'BLOCKER_REVISION_REQUIRED');
  await updateJournal(dir, 'c', update(2, { blockers: [{ id: 'B1', revision: 2,
    options: [{ id: 'file', label: 'Different file', impact: 'Changes the authorized source' }] }] }));
  await assert.rejects(updateJournal(dir, 'c', update(3, { blockers: [{ id: 'B1',
    user_answer: { revision: 2, source: old.source, option_id: 'file' } }] })), error => error.code === 'REPLY_ANSWER_MISMATCH');
  const stale = { ...old, id: 'late-alternative', source: 'user:late-alternative', items: [{ ...old.items[0], outcome: 'stale' }] };
  const saved = await updateJournal(dir, 'c', update(3, { replies: [stale] }));
  assert.equal(saved.blockers[0].user_answer, null);
  assert.equal(saved.replies.at(-1).items[0].outcome, 'stale');
});

test('Q&A and Note resolve from an attributable report or explicit agent interpretation of a comment; comments alone do not resolve', async t => {
  const note = { ...qa, id: 'N1', type: 'note', status: 'open', title: 'Progress context' };
  const dir = await setup(t, { cards: [qa, note] });
  assert.equal(canResolve('cards', qa), true);
  const understood = reply('understood', 'cards', 'Q1', 1, 'comment', { text: '알겠어.' });
  const input = await updateJournal(dir, 'c', update(1, { replies: [understood] }));
  assert.equal(needsAttention(input.cards[0]), true);
  assert.equal(input.cards[0].status, 'answered');
  const resolved = await updateJournal(dir, 'c', update(2, { cards: [{ id: 'Q1', status: 'resolved', resolution: {
    actor: 'user', source: understood.source, note: 'The user explicitly acknowledged the explanation in their comment' } }] }));
  assert.equal(needsAttention(resolved.cards[0]), false);
  assert.equal(resolved.replies[0].items[0].text, '알겠어.');
  const report = reply('note-read', 'cards', 'N1', 1, 'resolve');
  const both = await updateJournal(dir, 'c', update(3, { replies: [report], cards: [{ id: 'N1', status: 'resolved',
    resolution: { actor: 'user', source: report.source, note: 'The user submitted Resolved for the note' } }] }));
  assert.deepEqual(attentionItems(both), []);
  assert.equal(formatReplyText(report.items, () => note).includes('Action: Mark as read'), true);
  assert.deepEqual(turnChanges(both, 'T4')[0].actions, ['updated', 'status_changed', 'resolution_reported']);
});

test('follow-up comments and ambiguous choices preserve pending work and never invent explicit answers', async t => {
  const dir = await setup(t, { cards: [qa], decisions: [decision] });
  const followup = reply('followup', 'cards', 'Q1', 1, 'comment', { text: '그럼 내 답이 필요한 거야?' });
  const uncertain = reply('uncertain', 'decisions', 'D1', 1, 'comment', { text: '잘 모르겠어' });
  const saved = await updateJournal(dir, 'c', update(1, { replies: [followup, uncertain] }, 'complete'));
  assert.equal(saved.decisions[0].user_answer, undefined);
  assert.equal(saved.cards[0].resolution, undefined);
  assert.deepEqual(attentionItems(saved).map(item => item.record.id), ['D1', 'Q1']);
  assert.equal(evaluateStop(saved, { turnId: 'T2' }).allowed, false);
});

test('an explicit choice inside Comment retains the full limits as the User answer without fabricating an option selection', async t => {
  const dir = await setup(t, { decisions: [decision] });
  const text = 'Use the supplied file in the proposal, but do not build or publish anything.';
  const comment = reply('limited-choice', 'decisions', 'D1', 1, 'comment', { text });
  const saved = await updateJournal(dir, 'c', update(1, { replies: [comment], decisions: [{ id: 'D1', status: 'answered',
    user_answer: { revision: 1, source: comment.source, text } }] }));
  assert.deepEqual(saved.decisions[0].user_answer, { revision: 1, source: comment.source, text });
  assert.equal(saved.decisions[0].resolution, undefined);
  assert.equal(saved.replies[0].items[0].text, text);
  assert.equal(needsAttention(saved.decisions[0]), false);
  assert.equal(saved.requests[0].status, 'active');
  const other = await setup(t, { decisions: [decision] });
  await assert.rejects(updateJournal(other, 'c', update(1, { replies: [comment], decisions: [{ id: 'D1', status: 'answered',
    user_answer: { revision: 1, source: comment.source, option_id: 'file', text } }] })), error => error.code === 'REPLY_ANSWER_MISMATCH');
  await updateJournal(other, 'c', update(1, { replies: [comment] }));
  await updateJournal(other, 'c', update(2, { decisions: [{ id: 'D1', revision: 2, why: 'Now considering production changes' }] }));
  await assert.rejects(updateJournal(other, 'c', update(3, { decisions: [{ id: 'D1', status: 'answered',
    user_answer: { revision: 2, source: comment.source, text } }] })), error => error.code === 'REPLY_ANSWER_MISMATCH');
});

test('delayed verification of an old blocker cannot close revised alternatives or a new target in the same save', async t => {
  const dir = await setup(t, { blockers: [{ ...blocker, revision: 1, options }] });
  const oldVerification = { actor: 'agent', source: 'tool:old-target-ok', note: 'The original target was checked successfully', record_revision: 1 };
  await updateJournal(dir, 'c', update(1, { blockers: [{ id: 'B1', revision: 2,
    options: [{ id: 'file', label: 'Use another file', impact: 'Changes the source and target' }] }] }));
  await assert.rejects(updateJournal(dir, 'c', update(2, { blockers: [{ id: 'B1', status: 'resolved', resolution: oldVerification }] })),
    error => error.code === 'STALE_VERIFICATION');
  await assert.rejects(updateJournal(dir, 'c', update(2, { blockers: [{ id: 'B1', revision: 3, next_action: 'Connect a different account',
    status: 'resolved', resolution: { ...oldVerification, record_revision: 2 } }] })), error => error.code === 'STALE_VERIFICATION');
  const saved = await readJournal(dir, 'c');
  assert.equal(saved.blockers[0].status, 'open');
  assert.equal(saved.blockers[0].revision, 2);
});

test('replaying a reply after a sourced user pause never resumes the request or converts its checkpoint to completion', async t => {
  const dir = await setup(t, { blockers: [blocker] });
  const report = reply('paused-report', 'blockers', 'B1', 1, 'comment', { text: 'I logged in. Keep this paused.' });
  const pausedUpdate = update(1, { replies: [report] }, 'user_paused');
  pausedUpdate.turn.source = 'user:stop'; pausedUpdate.turn.pause_source = 'user:stop';
  const paused = await updateJournal(dir, 'c', pausedUpdate);
  assert.equal(evaluateStop(paused, { turnId: 'T2' }).allowed, true);
  const repeated = { ...pausedUpdate, expected_revision: 2 };
  const replayed = await updateJournal(dir, 'c', repeated);
  assert.equal(replayed.turn.end_reason, 'user_paused');
  assert.equal(replayed.blockers[0].status, 'open');
  assert.equal(replayed.requests[0].status, 'active');
  assert.equal(replayed.replies.length, 1);
  assert.equal(evaluateStop(replayed, { turnId: 'T2' }).allowed, true);
});

test('dismissal preserves provenance, cannot bypass a required decision, and late replies do not reactivate the old path', async t => {
  const dir = await setup(t, { decisions: [decision], blockers: [blocker] });
  await assert.rejects(updateJournal(dir, 'c', update(1, { blockers: [{ id: 'B1', status: 'dismissed' }] })), error => error.code === 'INVALID_DISMISSAL');
  const obsolete = await legacyDoneFixture(dir, 'c', update(1, { decisions: [{ id: 'D1', status: 'dismissed', dismissal: {
    actor: 'agent', source: 'agent:duplicate-review', reason: 'This prompt is obsolete; permission still has not been established' } }],
    requests: [{ id: 'R1', status: 'done', evidence: 'workspace:output-only' }] }, 'complete'));
  assert.equal(needsAttention(obsolete.decisions[0]), false);
  assert.equal(evaluateStop(obsolete, { turnId: 'T2' }).allowed, false);
  const late = reply('late-answer', 'decisions', 'D1', 1, 'answer', { option_id: 'file', outcome: 'stale' });
  const saved = await updateJournal(dir, 'c', update(2, { replies: [late] }));
  assert.equal(saved.decisions[0].status, 'dismissed');
  assert.equal(saved.decisions[0].user_answer, undefined);
  assert.equal(saved.replies.at(-1).items[0].outcome, 'stale');
  await assert.rejects(updateJournal(dir, 'c', update(3, { decisions: [{ id: 'D1', status: 'open' }] })), error => error.code === 'REOPEN_REASON_REQUIRED');
  await assert.rejects(updateJournal(dir, 'c', update(3, { replies: [reply('dismiss-input', 'blockers', 'B1', 1, 'dismiss')] })), error => error.code === 'INVALID_REPLY');
});

test('superseded and dismissed prompts retain an unanswered required-choice boundary until a valid replacement is answered', async t => {
  for (const status of ['superseded', 'dismissed']) {
    const surviving = { ...decision, id: 'D2', question: 'The current route?' };
    const dir = await setup(t, { decisions: [decision, surviving] });
    const retired = await legacyDoneFixture(dir, 'c', update(1, { decisions: [{ id: 'D1', status, dismissal: {
      actor: 'agent', source: 'agent:duplicate-review', reason: 'The current prompt replaces this duplicate',
      replacement: { collection: 'decisions', id: 'D2' } } }], requests: [{ id: 'R1', status: 'done', evidence: 'workspace:output-only' }] }, 'complete'));
    assert.equal(needsAttention(retired.decisions[0]), false);
    assert.equal(evaluateStop(retired, { turnId: 'T2' }).allowed, false);
    const answer = reply(`replacement-${status}`, 'decisions', 'D2', 1, 'answer', { option_id: 'file' });
    const settled = await updateJournal(dir, 'c', update(2, { replies: [answer], decisions: [{ id: 'D2', status: 'answered',
      user_answer: { revision: 1, source: answer.source, option_id: 'file' } }] }, 'complete'));
    assert.equal(evaluateStop(settled, { turnId: 'T3' }).allowed, true);
  }
  const dir = await setup(t, { decisions: [decision] });
  const unbound = await legacyDoneFixture(dir, 'c', update(1, { decisions: [{ id: 'D1', status: 'superseded' }],
    requests: [{ id: 'R1', status: 'done', evidence: 'workspace:output-only' }] }, 'complete'));
  assert.equal(evaluateStop(unbound, { turnId: 'T2' }).allowed, false);
  assert.deepEqual((await readJournal(dir, 'c')).decisions, unbound.decisions);
});

test('hidden required decisions preserve permission but cannot justify handing back an empty Attention view', async t => {
  for (const status of ['dismissed', 'superseded']) {
    const dir = await setup(t, { decisions: [decision] });
    const patch = { id: 'D1', status, ...(status === 'dismissed' ? { dismissal: {
      actor: 'agent', source: 'agent:obsolete-card', reason: 'The prompt is obsolete, but no route has been authorized' } } : {}) };
    const hidden = await updateJournal(dir, 'c', update(1, { decisions: [patch] }, 'decision'));
    assert.deepEqual(attentionItems(hidden), []);
    assert.equal(hidden.decisions[0].required, true);
    assert.equal(evaluateStop(hidden, { turnId: 'T2' }).allowed, false);
  }
  const dir = await setup(t, { decisions: [decision] });
  const later = await updateJournal(dir, 'c', update(1, { decisions: [{ id: 'D1', attention: {
    state: 'later', actor: 'user', source: 'user:later' } }] }, 'decision'));
  assert.deepEqual(attentionItems(later), []);
  assert.equal(evaluateStop(later, { turnId: 'T2' }).allowed, false);
  const pending = await updateJournal(dir, 'c', update(2, { decisions: [{ id: 'D1', attention: {
    state: 'pending', actor: 'agent', source: 'workspace:ready', reason: 'The next authorized operation now depends on this route choice' } }] }, 'decision'));
  assert.deepEqual(attentionItems(pending).map(item => item.record.id), ['D1']);
  assert.equal(evaluateStop(pending, { turnId: 'T3' }).allowed, true);
});

test('a Later blocker cannot justify handback until a concrete dependency reopens it visibly', async t => {
  const dir = await setup(t, { blockers: [blocker] });
  const later = await updateJournal(dir, 'c', update(1, { blockers: [{ id: 'B1', attention: {
    state: 'later', actor: 'user', source: 'user:later-access' } }] }, 'blocker'));
  assert.equal(later.blockers[0].status, 'open');
  assert.deepEqual(attentionItems(later), []);
  assert.equal(evaluateStop(later, { turnId: 'T2' }).allowed, false);
  const pending = await updateJournal(dir, 'c', update(2, { blockers: [{ id: 'B1', attention: {
    state: 'pending', actor: 'agent', source: 'workspace:import-ready', reason: 'The ready import now requires access to the authorized source' } }] }, 'blocker'));
  assert.deepEqual(attentionItems(pending).map(item => item.record.id), ['B1']);
  assert.equal(evaluateStop(pending, { turnId: 'T3' }).allowed, true);
});

test('a known human comment source cannot be relabeled as independent blocker verification', async t => {
  const dir = await setup(t, { blockers: [blocker] });
  const report = reply('login-comment', 'blockers', 'B1', 1, 'comment', { text: 'Login done' });
  const fake = { id: 'B1', status: 'resolved', resolution: {
    actor: 'agent', source: report.source, note: 'Treat the user report as an operation check', record_revision: 1 } };
  await assert.rejects(updateJournal(dir, 'c', update(1, { replies: [report], blockers: [fake] })),
    error => error.code === 'BLOCKER_VERIFICATION_REQUIRED');
  const received = await updateJournal(dir, 'c', update(1, { replies: [report] }));
  assert.equal(received.blockers[0].status, 'open');
  await assert.rejects(updateJournal(dir, 'c', update(2, { blockers: [fake] })),
    error => error.code === 'BLOCKER_VERIFICATION_REQUIRED');
  const verified = await updateJournal(dir, 'c', update(2, { blockers: [{ id: 'B1', status: 'resolved', resolution: {
    actor: 'agent', source: 'tool:affected-operation-ok', note: 'The affected operation independently succeeded', record_revision: 1 } }] }));
  assert.equal(verified.blockers[0].status, 'resolved');
  assert.deepEqual(verified.replies[0], report);
});

test('unversioned blocker condition changes cannot reuse checks of the previous title or destination', async t => {
  for (const condition of [{ title: 'A different account is unavailable' }, { action_url: 'https://example.com/new-account' }]) {
    const dir = await setup(t, { blockers: [{ ...blocker, action_url: 'https://example.com/old-account' }] });
    await assert.rejects(updateJournal(dir, 'c', update(1, { blockers: [{ id: 'B1', ...condition, status: 'resolved', resolution: {
      actor: 'agent', source: 'tool:old-account-ok', note: 'Only the previous account was checked', record_revision: 1 } }] })),
      error => error.code === 'STALE_VERIFICATION');
    assert.equal((await readJournal(dir, 'c')).blockers[0].status, 'open');
  }
});

test('changed conditions or new failure evidence reopen an unversioned resolved blocker and retain old verification in History', async t => {
  for (const condition of [{ title: 'Another account needs access' }, { action_url: 'https://example.com/new-account' },
    { evidence: 'tool:operation-denied-again' }]) {
    const dir = await setup(t, { blockers: [{ ...blocker, action_url: 'https://example.com/old-account' }] });
    const verified = await updateJournal(dir, 'c', update(1, { blockers: [{ id: 'B1', status: 'resolved', resolution: {
      actor: 'agent', source: 'tool:old-account-ok', note: 'The previous operation succeeded', record_revision: 1 } }] }));
    const reopened = await updateJournal(dir, 'c', update(2, { blockers: [{ id: 'B1', ...condition }] }));
    assert.equal(reopened.blockers[0].revision, undefined);
    assert.equal(reopened.blockers[0].id, 'B1');
    assert.equal(reopened.blockers[0].status, 'open');
    assert.equal(reopened.blockers[0].resolution, null);
    assert.equal(needsAttention(reopened.blockers[0]), true);
    assert.deepEqual(reopened.history[1], verified.history[1]);
    assert.deepEqual((await readJournal(dir, 'c')).blockers, reopened.blockers);
  }
});

test('cosmetic updates keep unversioned verification while changed destinations invalidate acknowledged input', async t => {
  const dir = await setup(t, { blockers: [{ ...blocker, action_url: 'https://example.com/account' }] });
  const verified = await updateJournal(dir, 'c', update(1, { blockers: [{ id: 'B1', status: 'resolved', resolution: {
    actor: 'agent', source: 'tool:operation-ok', note: 'The current operation succeeded', record_revision: 1 } }] }));
  const cosmetic = await updateJournal(dir, 'c', update(2, { blockers: [{ id: 'B1', nudge: { text: 'Historical context', priority: 'normal' },
    urls: [{ label: 'Guide', url: 'https://docs.example.com/guide' }] }] }));
  assert.equal(cosmetic.blockers[0].status, 'resolved');
  assert.deepEqual(cosmetic.blockers[0].resolution, verified.blockers[0].resolution);
  const other = await setup(t, { blockers: [{ ...blocker, action_url: 'https://example.com/account',
    attention: { state: 'acknowledged', actor: 'user', source: 'user:old-ack' } }] }, true);
  const changed = await updateJournal(other, 'c', update(1, { blockers: [{ id: 'B1', action_url: 'https://example.com/different-account' }] }));
  assert.equal(attentionState(changed.blockers[0]), 'pending');
  assert.equal(needsAttention(changed.blockers[0]), true);
});

test('legacy destination changes with an unchanged old acknowledgment still load without rewriting stored history', async t => {
  const attention = { state: 'acknowledged', actor: 'user', source: 'user:legacy-ack' };
  const dir = await setup(t, { blockers: [{ ...blocker, action_url: 'https://example.com/old-account', attention }] }, true);
  const state = await updateJournal(dir, 'c', update(1, { blockers: [{ id: 'B1', action_url: 'https://example.com/new-account' }] }));
  // The earlier version-1 writer did not invalidate acknowledgment when only
  // action_url changed. Preserve that valid older state on read, without migration.
  state.blockers[0].attention = attention;
  state.history[1].changes.find(change => change.collection === 'blockers').after.attention = attention;
  await fs.writeFile(path.join(dir, 'c.json'), JSON.stringify(state));
  assert.deepEqual(await readJournal(dir, 'c'), state);
  const checkpoint = await updateJournal(dir, 'c', update(2));
  assert.deepEqual(checkpoint.blockers, state.blockers);
  assert.deepEqual(checkpoint.history.slice(0, 2), state.history);
});

test('an explicit scope removal or canceled Request retires an obsolete requirement without inventing a User answer', async t => {
  const dir = await setup(t, { decisions: [decision] });
  const scope = await updateJournal(dir, 'c', update(1, { decisions: [{ id: 'D1', revision: 2, required: false, status: 'dismissed',
    dismissal: { actor: 'user', source: 'user:remove-publication', reason: 'The user removed publication from the authorized scope, so its route choice is obsolete' } }],
    requests: [{ id: 'R1', title: 'Deliver the remaining local result', source: 'user:remove-publication', status: 'done', evidence: 'workspace:local-result-verified' }] }, 'complete'));
  assert.equal(scope.decisions[0].user_answer, null);
  assert.equal(scope.decisions[0].required, false);
  assert.equal(scope.decisions[0].dismissal.source, 'user:remove-publication');
  assert.equal(scope.history[0].changes.find(change => change.collection === 'decisions').after.required, true);
  assert.equal(evaluateStop(scope, { turnId: 'T2' }).allowed, true);
  const other = await setup(t, { decisions: [decision] });
  const cancelled = await updateJournal(other, 'c', update(1, { requests: [{ id: 'R1', status: 'cancelled', source: 'user:cancel-outcome' }],
    decisions: [{ id: 'D1', status: 'superseded' }] }, 'complete'));
  assert.equal(cancelled.decisions[0].user_answer, undefined);
  assert.equal(cancelled.decisions[0].required, true);
  assert.equal(evaluateStop(cancelled, { turnId: 'T2' }).allowed, true);
});

test('legacy resolve drafts survive lost delivery without becoming sendable; old stale and acknowledgment receipts remain compatible', async t => {
  const dir = await setup(t, { blockers: [blocker] });
  const journal = await readJournal(dir, 'c');
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const item = { collection: 'blockers', id: 'B1', record_revision: 1, kind: 'resolve' };
  storage.setItem('request-journal:replies:v1:c', JSON.stringify({ version: 1,
    drafts: [{ ...item, token: 'token' }], delivery: { id: 'delivery', conversation_id: 'c',
      items: [item], tokens: ['token'], status: 'sending' } }));
  const drafts = new ReplyDrafts(storage, 'c');
  assert.deepEqual(drafts.inspect(journal).items, []);
  const restored = new ReplyDrafts(storage, 'c');
  assert.equal(restored.delivery.status, 'uncertain');
  assert.equal(restored.stage('duplicate', restored.inspect(journal).items), false);
  const changed = await updateJournal(dir, 'c', update(1, { blockers: [{ id: 'B1', evidence: 'tool:new-denial' }] }));
  assert.equal(restored.inspect(changed).stale.length, 1);
  const receipt = reply('delivery', 'blockers', 'B1', 1, 'resolve', { outcome: 'stale' });
  const saved = await legacyBlockerFixture(dir, 'c', update(2, { replies: [receipt] }));
  assert.equal(restored.reconcile(saved), true);
  assert.equal(restored.inspect(saved).stale.length, 1);
  const legacy = reply('legacy-ack', 'blockers', 'B1', 2, 'acknowledge');
  const withLegacy = await legacyBlockerFixture(dir, 'c', update(3, { replies: [legacy] }));
  assert.equal(withLegacy.replies.at(-1).items[0].kind, 'acknowledge');
  const schema = JSON.parse(await fs.readFile(new URL('../schema/journal.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv({ strict: false }).compile(schema);
  assert.equal(validate(withLegacy), true, JSON.stringify(validate.errors));
  assert.equal(canResolve('decisions', decision), false);
  assert.equal(canResolve('cards', { ...qa, type: 'suggestion' }), false);
});

test('legacy resolved records without added provenance load unchanged and stay outside Attention', async t => {
  const dir = await setup(t, { cards: [{ ...qa, status: 'open' }], blockers: [blocker] });
  const legacy = await readJournal(dir, 'c');
  for (const collection of ['cards', 'blockers']) {
    legacy[collection][0].status = 'resolved';
    legacy.history[0].changes.find(change => change.collection === collection).after.status = 'resolved';
  }
  await fs.writeFile(path.join(dir, 'c.json'), JSON.stringify(legacy));
  const loaded = await readJournal(dir, 'c');
  assert.deepEqual(loaded, legacy);
  assert.deepEqual(attentionItems(loaded), []);
  const next = await updateJournal(dir, 'c', update(1));
  assert.deepEqual(next.cards, legacy.cards);
  assert.deepEqual(next.blockers, legacy.blockers);
});
