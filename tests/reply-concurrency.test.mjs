import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateJournal, readJournal, validateJournal } from '../src/store.mjs';
import test from 'node:test';
import { view, state, commit, memoryStorage, tick } from './ui-harness.mjs';
import { ReplyDrafts, draftKey } from '../src/reply-ui.mjs';
const storage = () => { const values = new Map(); return { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), key: index => [...values.keys()][index] ?? null, get length() { return values.size; } }; };
const comment = (id = 'N1', text = 'Original') => ({ collection: 'cards', id, record_revision: 1, kind: 'comment', text });
const items = drafts => [...drafts.drafts.values()].map(({ token, ...item }) => item);
test('stale persistence and construction cannot erase shared uncertain delivery', () => {
  const saved = storage(), a = new ReplyDrafts(saved, 'c'), b = new ReplyDrafts(saved, 'c');
  a.set(comment(), 'original');
  assert.equal(a.stage('first', items(a)), true);
  a.deliveryStatus('uncertain', 'first');
  b.persist();
  const c = new ReplyDrafts(saved, 'c');
  assert.equal(c.delivery.id, 'first');
  assert.equal(c.drafts.size, 1);
  assert.equal(b.stage('second', items(a)), false);
  assert.equal(c.stage('third', items(c)), false);
});
test('different item edits merge and stale removal cannot delete a newer edit', () => {
  const saved = storage(), a = new ReplyDrafts(saved, 'c'), b = new ReplyDrafts(saved, 'c');
  a.set(comment(), 'old');
  b.persist();
  a.set(comment('N1', 'Newer'), 'new');
  b.remove(draftKey(comment()));
  b.set(comment('N2', 'Other'), 'other');
  const c = new ReplyDrafts(saved, 'c');
  assert.equal(c.drafts.get(draftKey(comment())).text, 'Newer');
  assert.equal(c.drafts.size, 2);
});
test('receipt reconciliation preserves a newer same-item edit and cannot resurrect a delivery', () => {
  const saved = storage(), a = new ReplyDrafts(saved, 'c'), b = new ReplyDrafts(saved, 'c');
  a.set(comment(), 'old'); a.stage('first', items(a));
  b.persist(); b.set(comment('N1', 'Newer'), 'new');
  assert.equal(a.reconcile({ conversation_id: 'c', replies: [{ id: 'first', items: [{ ...comment(), outcome: 'accepted' }] }] }), true);
  b.deliveryStatus('uncertain', 'first'); b.persist();
  const c = new ReplyDrafts(saved, 'c');
  assert.equal(c.delivery, null);
  assert.equal(c.drafts.get(draftKey(comment())).text, 'Newer');
});

test('atomic asynchronous staging allows only one unconfirmed send and fails closed without locks', async () => {
  const saved = storage(), a = new ReplyDrafts(saved, 'c'), b = new ReplyDrafts(saved, 'c');
  let queue = Promise.resolve();
  const locks = { request(name, options, callback) { const task = queue.then(callback); queue = task.catch(() => {}); return task; } };
  a.lockManager = b.lockManager = locks;
  a.set(comment(), 'original'); b.persist();
  const results = await Promise.all([a.stageAsync('first', items(a)), b.stageAsync('second', items(b))]);
  assert.deepEqual(results, [true, false]);
  const c = new ReplyDrafts(saved, 'other'); c.set(comment(), 'other');
  assert.equal(await c.stageAsync('third', items(c)), false);
  assert.equal(c.coordinationUnavailable, true);
  assert.equal(c.drafts.size, 1);
});
test('stale prepared batch cannot send changed shared content under old tokens', () => {
  const saved = storage(), a = new ReplyDrafts(saved, 'c'), b = new ReplyDrafts(saved, 'c');
  a.set(comment(), 'old'); const batch = items(a);
  b.set(comment('N1', 'Changed'), 'new');
  assert.equal(a.stage('old-batch', batch), false);
  assert.equal(a.delivery, null);
});

test('a truly overlapping delete cannot overwrite a newer same-item edit', () => {
  const saved = storage(), a = new ReplyDrafts(saved, 'c'), b = new ReplyDrafts(saved, 'c');
  a.set(comment(), 'old'); b.persist();
  const original = saved.setItem;
  let overlap = true;
  saved.setItem = (key, value) => {
    if (overlap && key.includes(':item:') && JSON.parse(value).draft === null) {
      overlap = false;
      b.set(comment('N1', 'Concurrent edit'), 'new');
    }
    original(key, value);
  };
  a.remove(draftKey(comment()));
  const c = new ReplyDrafts(saved, 'c');
  assert.equal(c.drafts.get(draftKey(comment())).text, 'Concurrent edit');
});
test('legacy pending delivery remains readable and locked without constructor writes', () => {
  const saved = storage(), key = 'request-journal:replies:v1:c';
  const delivery = { id: 'legacy', conversation_id: 'c', items: [comment()], tokens: ['old'], status: 'sending' };
  saved.setItem(key, JSON.stringify({ version: 1, drafts: [{ ...comment(), token: 'old' }], delivery }));
  const before = saved.getItem(key), a = new ReplyDrafts(saved, 'c');
  assert.equal(saved.getItem(key), before);
  assert.equal(a.delivery.status, 'uncertain');
  a.set(comment('N2', 'New draft'), 'new');
  assert.equal(a.stage('duplicate', items(a)), false);
  assert.equal(new ReplyDrafts(saved, 'c').delivery.id, 'legacy');
});

test('typing and repeated edits keep only one full-text cell per surface and item', () => {
  const saved = storage(), a = new ReplyDrafts(saved, 'c');
  for (let length = 1; length <= 4000; length++) a.set(comment('N1', 'x'.repeat(length)), `typing-${length}`);
  for (let edit = 0; edit < 100; edit++) a.set(comment('N1', 'y'.repeat(4000)), `edit-${edit}`);
  assert.equal(saved.length, 1);
  assert.equal(new ReplyDrafts(saved, 'c').drafts.get(draftKey(comment())).text.length, 4000);
  assert.ok(saved.getItem(saved.key(0)).length < 5000);
});

test('stale conflicting action click requires review before replacing another view selection', () => {
  const saved = storage(), a = new ReplyDrafts(saved, 'c'), b = new ReplyDrafts(saved, 'c');
  const answer = { collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', option_id: 'A' };
  const later = { collection: 'decisions', id: 'D1', record_revision: 1, kind: 'defer' };
  a.set(answer, 'answer');
  assert.equal(b.set(later, 'later'), false);
  assert.equal(b.sharedConflict, true);
  assert.deepEqual(b.sharedConflictTargets, [{ collection: 'decisions', id: 'D1', record_revision: 1, kind: 'defer' }],
    'The conflict retains the rejected action identity, not just the record ID');
  assert.deepEqual(items(b), [answer]);
  assert.equal(b.set(later, 'reviewed-later'), true);
  assert.equal(b.sharedConflict, false);
  assert.deepEqual(items(b), [later]);
  assert.equal(b.stage('conflicting', [answer, later]), false);
  assert.equal(b.delivery, null);
});

test('two rendered views require another click to replace the unseen shared action and send one action', async () => {
  const saved = memoryStorage(), a = await view({ storage: saved }), b = await view({ storage: saved });
  a.show(state()); b.show(state());
  a.document.querySelector('#jc-attention [data-record="D1"][data-choice="A"]').click();
  const later = () => b.document.querySelector('#jc-attention [data-record="D1"] [data-reply-kind="defer"]');
  later().click();
  assert.equal(later().getAttribute('aria-pressed'), 'false');
  assert.equal(b.document.querySelector('#jc-attention [data-record="D1"][data-choice="A"]').getAttribute('aria-pressed'), 'true');
  later().click();
  assert.equal(later().getAttribute('aria-pressed'), 'true');
  b.document.querySelector('#jc-send').click(); await tick();
  assert.equal(b.sent.length, 1);
  assert.deepEqual(b.envelope().items.map(item => item.kind), ['defer']);
  a.document.querySelector('#jc-send').click(); await tick();
  assert.equal(a.sent.length, 0);
});

test('truly overlapping competing actions stay review-needed and cannot freeze a delivery', () => {
  const saved = storage(), a = new ReplyDrafts(saved, 'c'), b = new ReplyDrafts(saved, 'c');
  const answer = { collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', option_id: 'A' };
  const later = { collection: 'decisions', id: 'D1', record_revision: 1, kind: 'defer' };
  const original = saved.setItem; let overlap = true;
  saved.setItem = (key, value) => {
    if (overlap && key.includes(':item:')) { overlap = false; b.set(later, 'later'); }
    original(key, value);
  };
  a.set(answer, 'answer');
  const assessment = a.inspect(state());
  assert.equal(assessment.stale.length, 2);
  assert.equal(assessment.items.length, 0);
  assert.equal(a.stage('conflicting', [answer, later]), false);
  assert.equal(a.stage('subset', [answer]), false, 'a conflict in shared drafts cannot be hidden by sending one action');
  assert.deepEqual(a.sharedConflictTargets, [{ collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer' }],
    'A delivery conflict retains the version and kind of the intended outgoing action');
  assert.equal(a.delivery, null);
  assert.equal(a.set(answer, 'reviewed'), true);
  assert.equal(a.inspect(state()).stale.length, 0);
  assert.deepEqual(a.inspect(state()).items, [answer]);
});

test('queued lock callback rejects a batch whose shared target became contradictory after inspection', async () => {
  const saved = storage(), a = new ReplyDrafts(saved, 'c'), b = new ReplyDrafts(saved, 'c');
  const answer = { collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', option_id: 'A' };
  const later = { collection: 'decisions', id: 'D1', record_revision: 1, kind: 'defer' };
  a.set(answer, 'answer');
  const batch = a.inspect(state()).items;
  assert.deepEqual(batch, [answer]);
  let release;
  a.lockManager = { request(name, options, callback) { return new Promise(resolve => { release = () => resolve(callback()); }); } };
  const staged = a.stageAsync('queued', batch);
  // Complete an operation prepared in another surface before the lock callback.
  b.writeItem(draftKey(later), { ...later, token: 'overlapping-later' });
  release();
  assert.equal(await staged, false);
  assert.equal(a.sharedConflict, true);
  assert.equal(a.delivery, null);
  assert.equal(a.drafts.size, 2, 'both unsent intentions remain available for review');
  assert.equal(a.inspect(state()).stale.length, 2);
  assert.equal(a.set(answer, 'reviewed'), true);
  assert.equal(a.sharedConflict, false);
});

test('quota-failed cleanup never settles a delivery and safely retries partial cleanup', () => {
  const values = new Map(); let quota = Infinity, clampAfterOne = false;
  const saved = {
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    get length() { return values.size; },
    setItem(key, value) {
      const candidate = new Map(values); candidate.set(key, String(value));
      const total = [...candidate].reduce((bytes, [k, v]) => bytes + k.length + v.length, 0);
      if (total > quota) throw new Error('QuotaExceededError');
      values.set(key, String(value));
      if (clampAfterOne && key.includes(':item:')) { clampAfterOne = false; quota = total + 130; }
    },
  };
  const a = new ReplyDrafts(saved, 'c');
  a.set(comment('N1', 'x'.repeat(1000)), 'first');
  a.set(comment('N2', 'y'.repeat(1000)), 'second');
  const batch = items(a); assert.equal(a.stage('quota-delivery', batch), true);
  const receipt = { conversation_id: 'c', replies: [{ id: 'quota-delivery', items: batch.map(item => ({ ...item, outcome: 'accepted' })) }] };
  const used = [...values].reduce((bytes, [k, v]) => bytes + k.length + v.length, 0);
  quota = used + 130;
  const b = new ReplyDrafts(saved, 'c');
  assert.equal(b.reconcile(receipt), false);
  assert.equal(saved.getItem(`${b.deliveryKey}:receipt:quota-delivery`), null);
  const reopened = new ReplyDrafts(saved, 'c');
  assert.equal(reopened.delivery.id, 'quota-delivery');
  assert.equal(reopened.stage('duplicate', batch), false);
  quota = Infinity; clampAfterOne = true;
  assert.equal(reopened.reconcile(receipt), false);
  const partial = new ReplyDrafts(saved, 'c');
  assert.equal(partial.delivery.id, 'quota-delivery');
  assert.equal(partial.drafts.size, 1, 'successful partial cleanup persists while delivery remains locked');
  quota = Infinity;
  assert.equal(partial.reconcile(receipt), true);
  const final = new ReplyDrafts(saved, 'c');
  assert.equal(final.delivery, null);
  assert.equal(final.drafts.size, 0);
});

for (const reverse of [false, true]) test(`same-key concurrent answers remain conflicted in either instance order (${reverse})`, () => {
  const saved = storage(), a = new ReplyDrafts(saved, 'c'), b = new ReplyDrafts(saved, 'c');
  a.instanceId = reverse ? 'a' : 'z'; b.instanceId = reverse ? 'z' : 'a';
  const answer = option_id => ({ collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', option_id });
  const original = saved.setItem; let overlap = true;
  saved.setItem = (key, value) => { if (overlap && key.includes(':item:')) { overlap = false; b.set(answer('B'), 'b'); } original(key, value); };
  a.set(answer('A'), 'a');
  const assessment = a.inspect(state());
  assert.equal(assessment.stale.length, 2);
  assert.deepEqual(assessment.stale.map(draft => draft.option_id).sort(), ['A', 'B']);
  assert.equal(assessment.items.length, 0);
  assert.equal(a.stage('unreviewed', items(a)), false);
  assert.equal(a.delivery, null);
  assert.equal(a.set(answer('B'), 'reviewed'), true);
  assert.deepEqual(a.inspect(state()).items, [answer('B')]);
});

for (const reverse of [false, true]) test(`same-key concurrent Other text requires review (${reverse})`, () => {
  const saved = storage(), a = new ReplyDrafts(saved, 'c'), b = new ReplyDrafts(saved, 'c');
  a.instanceId = reverse ? 'a' : 'z'; b.instanceId = reverse ? 'z' : 'a';
  const answer = text => ({ collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', text });
  const original = saved.setItem; let overlap = true;
  saved.setItem = (key, value) => { if (overlap && key.includes(':item:')) { overlap = false; b.set(answer('Other B'), 'b'); } original(key, value); };
  a.set(answer('Other A'), 'a');
  assert.deepEqual(a.inspect(state()).stale.map(draft => draft.text).sort(), ['Other A', 'Other B']);
  assert.equal(a.stage('unreviewed', items(a)), false);
  a.set(answer('Reviewed'), 'reviewed');
  assert.deepEqual(a.inspect(state()).items, [answer('Reviewed')]);
});
test('concurrent identical answers are harmless and remain sendable', () => {
  const saved = storage(), a = new ReplyDrafts(saved, 'c'), b = new ReplyDrafts(saved, 'c');
  const answer = { collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', option_id: 'A' };
  const original = saved.setItem; let overlap = true;
  saved.setItem = (key, value) => { if (overlap && key.includes(':item:')) { overlap = false; b.set(answer, 'b'); } original(key, value); };
  a.set(answer, 'a');
  assert.equal(a.inspect(state()).stale.length, 0);
  assert.equal(a.stage('identical', [answer]), true);
});
test('an unseen lower-stamp answer arriving after a deliberate edit remains a conflict', () => {
  const saved = storage(), a = new ReplyDrafts(saved, 'c'), b = new ReplyDrafts(saved, 'c');
  a.instanceId = 'z'; b.instanceId = 'a';
  const answer = option_id => ({ collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', option_id });
  const original = saved.setItem; let prepared;
  saved.setItem = (key, value) => { prepared = [key, value]; };
  b.set(answer('B'), 'b');
  saved.setItem = original;
  a.set(answer('A'), 'a');
  a.set(answer('A'), 'deliberate');
  original(...prepared);
  a.persist();
  assert.equal(a.inspect(state()).stale.length, 2);
  assert.equal(a.stage('late-unseen', items(a)), false);
});

for (const reverse of [false, true]) test(`rendered concurrent answers send nothing until an explicit reviewed choice (${reverse})`, async () => {
  const saved = memoryStorage(), a = await view({ storage: saved }), b = await view({ storage: saved });
  a.show(state()); b.show(state());
  const original = saved.setItem; let overlap = true;
  saved.setItem = (key, value) => {
    if (overlap && key.includes(':item:')) {
      overlap = false;
      b.document.querySelector(`#jc-attention [data-record="D1"][data-choice="${reverse ? 'A' : 'B'}"]`).click();
    }
    original(key, value);
  };
  a.document.querySelector(`#jc-attention [data-record="D1"][data-choice="${reverse ? 'B' : 'A'}"]`).click();
  b.document.getElementById('jc-send').click(); await tick();
  assert.equal(b.sent.length, 0);
  assert.equal(b.document.getElementById('jc-send').disabled, true);
  const alternatives = [...b.document.querySelectorAll('#jc-attention [data-record="D1"] .jc-content-box li')].map(node => node.textContent);
  assert.deepEqual(alternatives.sort(), state().decisions[0].options.map(option => option.label).sort());
  b.document.querySelector('#jc-attention [data-record="D1"][data-choice="B"]').click();
  assert.equal(b.document.querySelector('#jc-attention [data-record="D1"][data-choice="B"]').getAttribute('aria-pressed'), 'true');
  b.document.getElementById('jc-send').click(); await tick();
  assert.equal(b.sent.length, 1);
  assert.equal(b.envelope().items[0].option_id, 'B');
});

for (const reverse of [false, true]) test(`rendered Other conflicts expose both preserved texts (${reverse})`, async () => {
  const saved = memoryStorage(), a = new ReplyDrafts(saved, 'C1'), b = new ReplyDrafts(saved, 'C1');
  a.instanceId = reverse ? 'a' : 'z'; b.instanceId = reverse ? 'z' : 'a';
  const answer = text => ({ collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', text });
  const original = saved.setItem; let overlap = true;
  saved.setItem = (key, value) => { if (overlap && key.includes(':item:')) { overlap = false; b.set(answer('Keep private'), 'b'); } original(key, value); };
  a.set(answer('Publish only draft'), 'a');
  const ui = await view({ storage: saved }); ui.show(state());
  assert.deepEqual([...ui.document.querySelectorAll('#jc-attention [data-record="D1"] .jc-content-box li')].map(node => node.textContent).sort(),
    ['Other: Keep private', 'Other: Publish only draft']);
  assert.equal(ui.document.getElementById('jc-send').disabled, true);
  ui.document.getElementById('jc-send').click(); await tick(); assert.equal(ui.sent.length, 0);
});
test('polling renders a late lower-stamp conflict even when its displayed winner stays unchanged', async () => {
  const saved = memoryStorage(), a = new ReplyDrafts(saved, 'C1'), b = new ReplyDrafts(saved, 'C1');
  a.instanceId = 'z'; b.instanceId = 'a';
  const answer = option_id => ({ collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', option_id });
  const original = saved.setItem; let prepared;
  saved.setItem = (key, value) => { prepared = [key, value]; };
  b.set(answer('B'), 'b'); saved.setItem = original;
  a.set(answer('A'), 'a'); a.set(answer('A'), 'deliberate');
  const ui = await view({ storage: saved }); ui.show(state());
  assert.equal(ui.document.querySelector('#jc-attention [data-record="D1"][data-choice="A"]').getAttribute('aria-pressed'), 'true');
  assert.equal(ui.document.querySelectorAll('#jc-attention [data-record="D1"] .jc-content-box li').length, 0);
  original(...prepared); await ui.refresh(state());
  assert.equal(ui.document.querySelector('#jc-attention [data-record="D1"][data-choice="A"]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual([...ui.document.querySelectorAll('#jc-attention [data-record="D1"] .jc-content-box li')].map(node => node.textContent).sort(),
    state().decisions[0].options.map(option => option.label).sort());
  assert.equal(ui.document.getElementById('jc-send').disabled, true);
});

for (const reverse of [false, true]) for (const reconcileInOther of [false, true]) test(`receipt consumes submitted token only, preserving late concurrent answer (${reverse}, ${reconcileInOther})`, () => {
  const saved = storage(), a = new ReplyDrafts(saved, 'C1'), b = new ReplyDrafts(saved, 'C1');
  a.instanceId = reverse ? 'a' : 'z'; b.instanceId = reverse ? 'z' : 'a';
  const item = option_id => ({ collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', option_id });
  const original = saved.setItem; let delayed;
  saved.setItem = (key, value) => { delayed = [key, value]; };
  b.set(item('B'), 'unsent-b'); saved.setItem = original;
  a.set(item('A'), 'sent-a'); assert.equal(a.stage('delivery-a', [item('A')]), true);
  original(...delayed); a.refresh(); b.refresh();
  assert.equal(a.actionConflicts.get(draftKey(item('A'))).length, 2);
  const receipt = { conversation_id: 'C1', replies: [{ id: 'delivery-a', items: [{ ...item('A'), outcome: 'accepted' }] }] };
  assert.equal((reconcileInOther ? b : a).reconcile(receipt), true);
  const reopened = new ReplyDrafts(saved, 'C1');
  assert.equal(reopened.delivery, null);
  assert.deepEqual([...reopened.drafts.values()].map(draft => draft.token), ['unsent-b']);
  assert.equal(reopened.actionConflicts.size, 0);
});

for (const otherText of [false, true]) test(`writer-committed answer preserves visible stale alternative after cold reload (${otherText})`, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reply-receipt-conflict-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixture = state();
  await updateJournal(directory, 'C1', { expected_revision: 0, turn: { id: 'T1', source: 'user:1', summary: 'Synthetic initial fixture', end_reason: null },
    upsert: { requests: fixture.requests, decisions: fixture.decisions } });
  const saved = storage(), a = new ReplyDrafts(saved, 'C1'), b = new ReplyDrafts(saved, 'C1');
  a.instanceId = 'z'; b.instanceId = 'a';
  const item = option_id => ({ collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer',
    ...(otherText && option_id === 'B' ? { text: 'Keep this separate source private.' } : { option_id }) });
  const original = saved.setItem; let delayed;
  saved.setItem = (key, value) => { delayed = [key, value]; };
  b.set(item('B'), 'unsent-b'); saved.setItem = original;
  a.set(item('A'), 'sent-a'); a.stage('delivery-a', [item('A')]); original(...delayed);
  const source = 'user:synthetic-receipt';
  await updateJournal(directory, 'C1', { expected_revision: 1, turn: { id: 'T2', source, summary: 'Record submitted A', end_reason: null },
    upsert: { replies: [{ id: 'delivery-a', source, items: [{ ...item('A'), outcome: 'accepted' }] }],
      decisions: [{ id: 'D1', status: 'answered', user_answer: { revision: 1, source, option_id: 'A' } }] } });
  const journal = await readJournal(directory, 'C1');
  assert.equal(a.reconcile(journal), true);
  const cold = new ReplyDrafts(saved, 'C1');
  assert.equal(cold.delivery, null);
  assert.equal(cold.drafts.get(draftKey(item('B'))).token, 'unsent-b');
  assert.deepEqual(cold.inspect(journal).stale.map(({ token, ...draft }) => draft), [item('B')]);
  assert.equal(cold.inspect(journal).items.length, 0);
  assert.equal(journal.decisions[0].user_answer.option_id, 'A');
  assert.deepEqual(journal.replies[0].items.map(({ outcome, ...reply }) => reply), [item('A')]);
  const ui = await view({ storage: saved }); ui.show(journal);
  assert.equal(ui.document.getElementById('jc-attention').hidden, false);
  assert.equal(ui.document.querySelectorAll('#jc-attention .jc-warning').length, 0);
  const card = ui.document.querySelector('#jc-cards-body [data-record="D1"]');
  assert.ok(card.querySelector('.jc-draft-hint') === null);
  const warnings = [...card.querySelectorAll('.jc-warning')].map(node => node.textContent).join(' ');
  assert.ok(warnings.includes(otherText ? item('B').text : fixture.decisions[0].options.find(option => option.id === 'B').label),
    'the stale unsubmitted value must be inspectable on the answered card');
  assert.equal(ui.document.getElementById('jc-send').disabled, true);
  assert.equal(ui.sent.length, 0);
});
test('legacy saved delivery token cleanup remains readable and consumes only its matching draft', () => {
  const saved = storage(), key = 'request-journal:replies:v1:C1';
  const answer = { collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', option_id: 'A' };
  saved.setItem(key, JSON.stringify({ version: 1, drafts: [{ ...answer, token: 'legacy' }],
    delivery: { id: 'legacy-send', conversation_id: 'C1', items: [answer], tokens: ['legacy'], status: 'uncertain' } }));
  const drafts = new ReplyDrafts(saved, 'C1');
  assert.equal(drafts.reconcile({ conversation_id: 'C1', replies: [{ id: 'legacy-send', items: [{ ...answer, outcome: 'accepted' }] }] }), true);
  const cold = new ReplyDrafts(saved, 'C1');
  assert.equal(cold.delivery, null); assert.equal(cold.drafts.size, 0);
});

test('before/after receipt matrix preserves listed and Other branches in either order and lower sequences', async () => {
  const A = { collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', option_id: 'A' };
  for (const arrival of ['before', 'after']) for (const reverse of [false, true]) for (const lower of [false, true]) for (const otherText of [false, true]) {
    const saved = memoryStorage(), a = new ReplyDrafts(saved, 'C1'), b = new ReplyDrafts(saved, 'C1');
    a.instanceId = reverse ? 'a' : 'z'; b.instanceId = reverse ? 'z' : 'a';
    const B = otherText ? { ...A, option_id: undefined, text: 'Do not publish; keep the source private.' } : { ...A, option_id: 'B' };
    delete B.option_id;
    if (!otherText) B.option_id = 'B';
    const write = saved.setItem; let delayed;
    saved.setItem = (key, value) => { delayed = [key, value]; };
    b.set(B, 'unsent-B'); saved.setItem = write;
    a.set(A, 'submitted-A');
    if (lower) a.set(A, 'submitted-A-later');
    assert.equal(a.stage('sent-A', [A]), true);
    const journal = commit(state(), { replies: [{ id: 'sent-A', source: 'user:receipt-A', items: [{ ...A, outcome: 'accepted' }] }] });
    if (arrival === 'before') write(...delayed);
    assert.equal(a.reconcile(journal), true);
    if (arrival === 'after') write(...delayed);
    const cold = new ReplyDrafts(saved, 'C1');
    assert.equal(cold.delivery, null);
    assert.deepEqual([...cold.drafts.values()].map(draft => draft.token), ['unsent-B']);
    const ui = await view({ storage: saved }); ui.show(journal);
    const selected = ui.document.querySelector(`#jc-attention [data-record="D1"][data-choice="${otherText ? 'other' : 'B'}"]`);
    assert.equal(selected.getAttribute('aria-pressed'), 'true');
    if (otherText) assert.equal(ui.document.querySelector('#jc-attention [data-record="D1"] textarea').value, B.text);
    assert.equal(ui.sent.length, 0);
    const answered = commit(journal, { decisions: [{ ...journal.decisions[0], status: 'answered', user_answer: { revision: 1, source: 'user:receipt-A', option_id: 'A' } }] });
    assert.equal(cold.inspect(answered).stale[0].token, 'unsent-B');
    assert.equal(cold.inspect(answered).items.length, 0);
  }
});
for (const sharedToken of [false, true]) test(`identical concurrent answer receipt consumes only its matching tokens (${sharedToken})`, () => {
  const saved = storage(), a = new ReplyDrafts(saved, 'C1'), b = new ReplyDrafts(saved, 'C1');
  const answer = { collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', option_id: 'A' };
  const original = saved.setItem; let delayed;
  saved.setItem = (key, value) => { delayed = [key, value]; };
  b.set(answer, sharedToken ? 'submitted' : 'different-unsent'); saved.setItem = original;
  a.set(answer, 'submitted'); a.stage('identical-receipt', [answer]);
  assert.equal(a.reconcile({ conversation_id: 'C1', replies: [{ id: 'identical-receipt', items: [{ ...answer, outcome: 'accepted' }] }] }), true);
  original(...delayed);
  const cold = new ReplyDrafts(saved, 'C1');
  assert.equal(cold.delivery, null);
  assert.deepEqual([...cold.drafts.values()].map(draft => draft.token), sharedToken ? [] : ['different-unsent']);
});

for (const arrival of ['before', 'after']) test(`reviewer2 Appendix A natural-order reproduction preserves Other B arriving ${arrival}`, () => {
  const A = { collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', option_id: 'A' };
  const B = { collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', text: 'Do not publish; keep the source private.' };
  const journal = commit(state(), { replies: [{ id: 'sent-A', source: 'user:receipt-A', items: [{ ...A, outcome: 'accepted' }] }] });
  validateJournal(journal);
  const saved = memoryStorage();
  const [b, a] = [new ReplyDrafts(saved, 'C1'), new ReplyDrafts(saved, 'C1')].sort((x, y) => x.instanceId.localeCompare(y.instanceId));
  const write = saved.setItem; let paused = true;
  saved.setItem = (key, value) => {
    if (paused && key.includes(':item:')) {
      paused = false;
      assert.equal(a.set(A, 'submitted-A'), true);
      assert.equal(a.stage('sent-A', [A]), true);
      if (arrival === 'before') write(key, value);
      assert.equal(a.reconcile(journal), true);
      if (arrival === 'before') return;
    }
    write(key, value);
  };
  assert.equal(b.set(B, 'unsent-B'), true);
  const cold = new ReplyDrafts(saved, 'C1');
  assert.equal(cold.drafts.get(draftKey(B)).text, B.text);
  assert.equal(cold.delivery, null);
});
