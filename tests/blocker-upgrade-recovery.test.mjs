import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import { attentionItems, needsAttention } from '../src/journal-views.mjs';
import { draftKey, ReplyDrafts } from '../src/reply-ui.mjs';
import { readJournal, updateJournal } from '../src/store.mjs';
import { legacyBlockerFixture } from './legacy-blocker-fixture.mjs';
import { memoryStorage, view } from './ui-harness.mjs';

const q = (ui, selector) => ui.document.querySelector(selector);
const update = (expected_revision, upsert = {}) => ({ expected_revision,
  turn: { id: `T${expected_revision + 1}`, source: 'user:1', summary: 'Inspect the blocked account', end_reason: null }, upsert });
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-blocker-upgrade-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const state = await updateJournal(dir, 'C1', update(0, {
    requests: [{ id: 'R1', title: 'Read the account', done_when: 'The account read succeeds', source: 'user:1', status: 'active' }],
    blockers: [{ id: 'B1', request_id: 'R1', title: 'Sign in', evidence: 'tool:access-denied', next_action: 'Sign in to the account', owner: 'user', status: 'open' }],
  }));
  return { dir, state };
}

for (const kind of ['resolve', 'acknowledge']) test(`an unrecorded legacy ${kind} delivery reconciles a real stale receipt after upgrade without retrying or losing newer drafts`, async t => {
  const { dir, state } = await setup(t), storage = memoryStorage();
  const retired = { collection: 'blockers', id: 'B1', record_revision: 1, kind };
  const comment = { collection: 'requests', id: 'R1', record_revision: 1, kind: 'comment', text: 'Keep the account scope. Do not publish anything.' };
  const blockerComment = { collection: 'blockers', id: 'B1', record_revision: 1, kind: 'comment', text: 'I logged in to the linked account.' };
  const items = [retired, comment, blockerComment], tokens = ['old-action', 'old-context', 'old-report'];
  storage.setItem('request-journal:replies:v1:C1', JSON.stringify({ version: 1,
    drafts: items.map((item, index) => ({ ...item, token: tokens[index] })),
    delivery: { id: 'old-delivery', conversation_id: 'C1', items, tokens, status: 'sending' },
  }));
  const pending = new ReplyDrafts(storage, 'C1'), ui = await view({ storage }); ui.show(state);
  assert.equal(pending.delivery.status, 'uncertain');
  assert.equal(q(ui, '#jc-send').disabled, true);
  assert.equal(ui.sent.length, 0);
  const editor = new ReplyDrafts(storage, 'C1');
  const newerComment = { ...comment, text: 'Keep this newer restriction. Use the private account only.' };
  const newerReport = { ...blockerComment, text: 'The account still reports access denied.' };
  const later = { ...retired, kind: 'defer' };
  assert.equal(editor.set(newerComment, 'new-context'), true);
  assert.equal(editor.set(newerReport, 'new-report'), true);
  assert.equal(editor.set(later, 'new-later'), true);
  const receipt = { id: 'old-delivery', source: 'user:same-thread-arrival', items: items.map(item => ({
    ...item, outcome: item.kind === 'comment' ? 'accepted' : 'stale',
  })) };

  const recorded = await updateJournal(dir, 'C1', update(1, { replies: [receipt] }));
  assert.deepEqual(recorded.replies, [receipt]);
  assert.deepEqual(await readJournal(dir, 'C1'), recorded, 'the current reader must replay the newly recorded stale outcome');
  assert.deepEqual(recorded.blockers, state.blockers);
  const schema = JSON.parse(await fs.readFile('schema/journal.schema.json', 'utf8'));
  const validate = new Ajv({ strict: false }).compile(schema);
  assert.equal(validate(recorded), true, JSON.stringify(validate.errors));
  await ui.refresh(recorded);
  const reconciled = new ReplyDrafts(storage, 'C1');
  assert.equal(reconciled.delivery, null);
  assert.deepEqual(reconciled.drafts.get(draftKey(retired)), { ...retired, token: 'old-action', review_needed: true });
  assert.deepEqual(reconciled.drafts.get(draftKey(comment)), { ...newerComment, token: 'new-context' });
  assert.deepEqual(reconciled.drafts.get(draftKey(blockerComment)), { ...newerReport, token: 'new-report' });
  assert.deepEqual(reconciled.drafts.get(draftKey(later)), { ...later, token: 'new-later' });
  assert.deepEqual(reconciled.inspect(recorded).items, [newerComment, newerReport, later]);
  assert.equal(q(ui, '#jc-send').disabled, false);
  assert.equal(ui.sent.length, 0, 'receipt recovery cannot retry the frozen old batch');
  assert.equal(Boolean(q(ui, '#jc-attention .jc-warning')), false);
  assert.ok(q(ui, '#jc-attention [data-record="B1"] .jc-card-status') === null);
  assert.equal(Boolean(q(ui, '#jc-cards-body [data-record="B1"] .jc-warning button')), false);
  for (const patch of [
    { id: 'B1', attention: { state: 'acknowledged', actor: 'user', source: receipt.source } },
    { id: 'B1', status: 'resolved', resolution: { actor: 'agent', source: receipt.source, note: 'Treat the received old action as proof', record_revision: 1 } },
  ]) {
    await assert.rejects(updateJournal(dir, 'C1', update(2, { blockers: [patch] })), error => error.code === 'BLOCKER_VERIFICATION_REQUIRED');
  }
  await assert.rejects(updateJournal(dir, 'C1', update(2, { replies: [{ ...receipt, items: receipt.items.map(item => ({ ...item, outcome: 'accepted' })) }] })), error => error.code === 'IMMUTABLE_REPLY');
  assert.deepEqual(await readJournal(dir, 'C1'), recorded);
});

for (const kind of ['resolve', 'acknowledge']) test(`a stale retired ${kind} receipt still needs a real historical target and cannot authorize Later`, async t => {
  const { dir, state } = await setup(t);
  const item = { collection: 'blockers', id: 'B1', record_revision: 1, kind, outcome: 'stale' };
  const receipt = { id: 'received-retired-action', source: 'user:retired-action-arrival', items: [item] };
  for (const target of [{ ...item, id: 'missing' }, { ...item, record_revision: 2 }]) {
    await assert.rejects(updateJournal(dir, 'C1', update(1, { replies: [{ ...receipt, items: [target] }] })), error => error.code === 'MISSING_REPLY_TARGET');
    assert.deepEqual(await readJournal(dir, 'C1'), state);
  }
  const recorded = await updateJournal(dir, 'C1', update(1, { replies: [receipt] }));
  await assert.rejects(updateJournal(dir, 'C1', update(2, { blockers: [{ id: 'B1', attention: {
    state: 'later', actor: 'user', source: receipt.source,
  } }] })), error => error.code === 'REPLY_ATTENTION_MISMATCH');
  assert.deepEqual(await readJournal(dir, 'C1'), recorded);
});

for (const control of ['acknowledged', 'later', 'resolved', 'dismissed']) test(`a legacy ${control} Blocker keeps its saved history and has the correct current Attention state through an unchanged checkpoint`, async t => {
  const { dir } = await setup(t);
  const patch = control === 'resolved' ? { id: 'B1', status: 'resolved', resolution: { actor: 'agent', source: 'tool:account-read-ok', note: 'The account read succeeded', record_revision: 1 } }
    : control === 'dismissed' ? { id: 'B1', status: 'dismissed', dismissal: { actor: 'user', source: 'user:scope-removal', reason: 'The account path is outside the requested scope' } }
    : { id: 'B1', attention: { state: control, actor: 'user', source: `user:legacy-${control}` } };
  const legacy = control === 'acknowledged' ? await legacyBlockerFixture(dir, 'C1', update(1, { blockers: [patch] }))
    : await updateJournal(dir, 'C1', update(1, { blockers: [patch] }));
  const loaded = await readJournal(dir, 'C1'), ui = await view(); ui.show(loaded);
  const expectedAttention = control === 'acknowledged';
  assert.equal(Boolean(q(ui, '#jc-attention [data-record="B1"]')), expectedAttention);
  assert.equal(needsAttention(loaded.blockers[0], 'blockers'), expectedAttention);
  assert.equal(attentionItems(loaded).some(item => item.collection === 'blockers' && item.record.id === 'B1'), expectedAttention);
  assert.deepEqual(loaded, legacy);
  const checkpoint = await updateJournal(dir, 'C1', update(2));
  await ui.refresh(checkpoint);
  assert.equal(Boolean(q(ui, '#jc-attention [data-record="B1"]')), expectedAttention);
  assert.deepEqual(checkpoint.blockers, legacy.blockers);
  assert.deepEqual(checkpoint.history.slice(0, 2), legacy.history);
  assert.equal(checkpoint.history.at(-1).changes.some(change => change.collection === 'blockers'), false);
  if (expectedAttention) {
    assert.equal(checkpoint.blockers[0].attention.state, 'acknowledged', 'visibility must not rewrite historical fields');
    assert.ok(q(ui, '#jc-attention [data-record="B1"] .jc-card-status') === null);
    assert.equal(q(ui, '#jc-agent-status').textContent, 'Needs your input');
    assert.equal(q(ui, '#jc-attention [data-record="B1"] [data-reply-kind="defer"]').textContent, 'Later');
  }
  assert.equal(needsAttention({ type: 'note', status: 'open', attention: { state: 'acknowledged' } }, 'cards'), false);
});
