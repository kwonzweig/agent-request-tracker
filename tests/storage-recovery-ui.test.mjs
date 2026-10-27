import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyDrafts, draftKey } from '../src/reply-ui.mjs';
import { view, previewState, commit, memoryStorage, tick } from './ui-harness.mjs';

const q = (ui, selector) => ui.document.querySelector(selector);
const comment = { collection: 'blockers', id: 'B1', record_revision: 3, kind: 'comment', text: 'Original comment' };
function pending() {
  const storage = memoryStorage(), drafts = new ReplyDrafts(storage, 'C1');
  assert.equal(drafts.set(comment, 'original-token'), true);
  assert.equal(drafts.stage('pending-delivery', [comment]), true);
  return storage;
}
function received(journal = previewState(), item = comment) {
  return commit(journal, { replies: [{ id: 'pending-delivery', source: 'user:4', items: [{ ...item, outcome: 'accepted' }] }] });
}
function assertLocked(ui) {
  assert.equal(q(ui, '#jc-send').disabled, true);
  for (const control of ui.document.querySelectorAll('.jc-read-icon')) assert.equal(control.disabled, false, 'Silent server read is independent of reply draft storage');
  assert.equal(ui.sent.length, 0);
}

test('a recovered storage read imports current drafts without resending an uncertain delivery', async () => {
  const storage = pending(), read = storage.getItem;
  storage.getItem = () => { throw Error('private storage exception'); };
  const ui = await view({ storage }); ui.show(previewState());
  assert.equal(q(ui, '#jc-storage').hidden, false);
  const warning = q(ui, '#jc-storage').textContent;
  assertLocked(ui);

  storage.getItem = read;
  const other = new ReplyDrafts(storage, 'C1');
  assert.equal(other.set({ ...comment, text: 'Newer comment from another view' }, 'new-token'), true);
  const before = [...storage.values];
  await ui.refresh(previewState());
  assert.equal(q(ui, '#jc-storage').hidden, true);
  assert.equal(q(ui, '#jc-attention [data-record="B1"] textarea').value, 'Newer comment from another view');
  assert.match(q(ui, '#jc-draft').textContent, /Delivery is unconfirmed/);
  assert.equal(q(ui, '#connection').hidden, true);
  assert.deepEqual([...storage.values], before, 'reading again does not alter the pending batch or drafts');
  assertLocked(ui);
  assert.match(warning, /Draft storage cannot be accessed/);
  assert.doesNotMatch(warning, /private storage exception/);
});

test('receipt cleanup resumes after a write failure and preserves newer concurrent edits', async () => {
  const storage = pending(), write = storage.setItem, latest = received();
  storage.setItem = () => { throw Error('private write exception'); };
  const ui = await view({ storage }); ui.show(latest);
  const warning = q(ui, '#jc-storage').textContent;
  assert.match(q(ui, '#jc-draft').textContent, /Delivery is unconfirmed/);
  assertLocked(ui);

  storage.setItem = write;
  const other = new ReplyDrafts(storage, 'C1');
  assert.equal(other.set({ ...comment, text: 'Newer same-card comment' }, 'new-token'), true);
  const unrelated = { collection: 'requests', id: 'R1', record_revision: 1, kind: 'comment', text: 'Unrelated comment' };
  assert.equal(other.set(unrelated, 'unrelated-token'), true);
  const frozen = storage.getItem(other.deliveryKey);
  await ui.refresh(latest);
  assert.equal(q(ui, '#jc-storage').hidden, true);
  assert.equal(q(ui, '#connection').hidden, true);
  assert.equal(q(ui, '#jc-send').disabled, false);
  assert.equal(ui.sent.length, 0);
  const recovered = new ReplyDrafts(storage, 'C1');
  assert.equal(recovered.delivery, null);
  assert.equal(storage.getItem(recovered.deliveryKey), frozen, 'settlement does not rewrite the immutable delivery');
  assert.equal(recovered.drafts.get(draftKey(comment)).text, 'Newer same-card comment');
  assert.equal(recovered.drafts.get(draftKey(unrelated)).text, 'Unrelated comment');
  assert.match(warning, /Draft storage could not be written/);
  assert.doesNotMatch(warning, /private write exception/);
});

test('continuing cleanup write failure remains locked and preserves stored bytes', async () => {
  const storage = pending(), before = [...storage.values], latest = received();
  storage.setItem = () => { throw Error('writes denied'); };
  const ui = await view({ storage }); ui.show(latest);
  await ui.refresh(latest); await ui.refresh(latest);
  assert.equal(q(ui, '#jc-storage').hidden, false);
  assert.match(q(ui, '#jc-storage').textContent, /Draft storage could not be written/);
  assert.equal(q(ui, '#connection').hidden, true, 'a successful journal read clears the initial checking notice');
  assert.deepEqual([...storage.values], before);
  assertLocked(ui);
});

test('successful reads do not conceal an unresolved write failure', () => {
  const storage = memoryStorage(), drafts = new ReplyDrafts(storage, 'C1'), write = storage.setItem;
  assert.equal(drafts.set(comment, 'original-token'), true);
  storage.setItem = () => { throw Error('writes denied'); };
  const before = [...storage.values];
  assert.equal(drafts.set({ ...comment, text: 'Unwritten edit' }, 'failed-token'), false);
  assert.equal(drafts.storageAvailable, false);
  assert.equal(drafts.refresh(), true, 'saved drafts can still be checked');
  assert.equal(drafts.storageAvailable, false, 'read access is not proof that writes recovered');
  assert.equal(drafts.storageFailure, 'write');
  assert.deepEqual([...storage.values], before);
  assert.equal(drafts.drafts.get(draftKey(comment)).text, comment.text);

  storage.setItem = write;
  assert.equal(drafts.set({ ...comment, text: 'Explicit edit after recovery' }, 'recovered-token'), true);
  assert.equal(drafts.storageAvailable, true);
  assert.equal(drafts.storageFailure, null);
  assert.equal(drafts.drafts.get(draftKey(comment)).text, 'Explicit edit after recovery');
});

for (const corrupt of ['base JSON', 'operation JSON', 'delivery shape']) test(`malformed ${corrupt} remains locked without altering drafts`, async () => {
  const storage = pending();
  if (corrupt === 'base JSON') storage.setItem('request-journal:replies:v1:C1', '{');
  else if (corrupt === 'operation JSON') storage.setItem([...storage.values.keys()].find(key => key.includes(':item:')), '{');
  else storage.setItem('request-journal:replies:v1:C1:delivery', JSON.stringify({ id: 'pending-delivery', conversation_id: 'C1', items: [comment], tokens: [] }));
  const before = [...storage.values], ui = await view({ storage }); ui.show(received());
  await ui.refresh(received());
  assert.equal(q(ui, '#jc-storage').hidden, false);
  assert.match(q(ui, '#jc-storage').textContent, /Saved draft data is invalid/);
  assert.deepEqual([...storage.values], before);
  assertLocked(ui);
});

test('storage recovery cannot settle a receipt that differs from the immutable delivery', async () => {
  const storage = pending(), read = storage.getItem;
  storage.getItem = () => { throw Error('reads denied'); };
  const ui = await view({ storage }); ui.show(previewState());
  storage.getItem = read;
  const before = [...storage.values];
  await ui.refresh(received(previewState(), { ...comment, text: 'Different comment' }));
  assert.equal(q(ui, '#jc-storage').hidden, true);
  assert.match(q(ui, '#jc-draft').textContent, /saved reply differs/);
  assert.deepEqual([...storage.values], before);
  assertLocked(ui);
});

test('a successful read clears the initial checking notice while restored delivery stays uncertain', async () => {
  const storage = pending(), ui = await view({ storage }); ui.show(previewState());
  assert.equal(q(ui, '#connection').hidden, true);
  const latest = commit(previewState(), { turn: { summary: 'Latest saved journal' } });
  await ui.refresh(latest);
  assert.equal(q(ui, '#connection').hidden, true);
  assert.match(q(ui, '#jc-draft').textContent, /Delivery is unconfirmed/);
  assertLocked(ui);
});

test('a receipt-marker storage read failure does not disable working Web Locks', async () => {
  const storage = memoryStorage(), drafts = new ReplyDrafts(storage, 'C1'), read = storage.getItem;
  drafts.lockManager = { request: async (name, options, callback) => callback() };
  assert.equal(drafts.set(comment, 'original-token'), true);
  storage.getItem = key => {
    if (key === `${drafts.deliveryKey}:receipt:next-delivery`) throw Error('receipt read denied');
    return read(key);
  };
  const before = [...storage.values];
  assert.equal(await drafts.stageAsync('next-delivery', [comment]), false);
  assert.equal(!!drafts.coordinationUnavailable, false, 'a storage exception is not a Web Locks failure');
  assert.equal(drafts.storageAvailable, false);
  assert.equal(drafts.storageFailure, 'access');
  assert.equal(drafts.delivery, null);
  assert.deepEqual([...storage.values], before);

  storage.getItem = read;
  assert.equal(await drafts.stageAsync('next-delivery', [comment]), true, 'a later explicit staging attempt can use the same working locks');
  assert.deepEqual(drafts.delivery.items, [comment]);
});

test('a genuine Web Locks failure remains fail closed', async () => {
  const storage = memoryStorage(), drafts = new ReplyDrafts(storage, 'C1');
  assert.equal(drafts.set(comment, 'original-token'), true);
  drafts.lockManager = { request: async () => { throw Error('lock request denied'); } };
  const before = [...storage.values];
  assert.equal(await drafts.stageAsync('next-delivery', [comment]), false);
  assert.equal(drafts.coordinationUnavailable, true);
  assert.equal(drafts.delivery, null);
  assert.deepEqual([...storage.values], before);
});

test('a successful journal read preserves an unsettled delivery error', async () => {
  const ui = await view({ sendImpl: async () => { throw Error('host rejected the message'); } });
  const latest = previewState(); ui.show(latest);
  q(ui, '#jc-attention [data-record="D1"] [data-choice="A"]').click();
  q(ui, '#jc-send').click(); await tick();
  const error = q(ui, '#connection').textContent;
  assert.match(error, /Delivery is unconfirmed/);
  await ui.refresh(latest);
  assert.equal(q(ui, '#connection').hidden, false);
  assert.equal(q(ui, '#connection').textContent, error);
  assert.equal(q(ui, '#jc-send').disabled, true);
  assert.equal(ui.sent.length, 1);
});

test('an exact settled receipt clears only its originating delivery error', async () => {
  const ui = await view({ sendImpl: async () => { throw Error('host rejected the message'); } });
  const latest = previewState(); ui.show(latest);
  q(ui, '#jc-attention [data-record="D1"] [data-choice="A"]').click();
  q(ui, '#jc-send').click(); await tick();
  const envelope = ui.envelope();
  assert.match(q(ui, '#connection').textContent, /Delivery is unconfirmed/);
  const settled = commit(latest, { replies: [{ id: envelope.delivery_id, source: 'user:4',
    items: envelope.items.map(item => ({ ...item, outcome: 'accepted' })) }] });
  await ui.refresh(settled);
  assert.equal(new ReplyDrafts(ui.storage, 'C1').delivery, null);
  assert.equal(q(ui, '#connection').hidden, true);
  assert.doesNotMatch(q(ui, '#connection').textContent, /unconfirmed/);
  assert.equal(ui.sent.length, 1, 'receipt reconciliation sends no replacement message');

  const input = q(ui, '#jc-attention [data-record="B1"] textarea'); input.value = 'New reply';
  input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  q(ui, '#jc-send').click(); await tick();
  const replacement = ui.envelope(), error = q(ui, '#connection').textContent;
  assert.notEqual(replacement.delivery_id, envelope.delivery_id);
  assert.match(error, /Delivery is unconfirmed/);
  await ui.refresh(settled);
  assert.equal(q(ui, '#connection').hidden, false);
  assert.equal(q(ui, '#connection').textContent, error, 'an old receipt cannot clear a new delivery error');
  assert.equal(new ReplyDrafts(ui.storage, 'C1').delivery.id, replacement.delivery_id);
  assert.equal(ui.sent.length, 2);
});

test('a mismatched receipt cannot clear its originating delivery error', async () => {
  const ui = await view({ sendImpl: async () => { throw Error('host rejected the message'); } });
  const latest = previewState(); ui.show(latest);
  q(ui, '#jc-attention [data-record="D1"] [data-choice="A"]').click();
  q(ui, '#jc-send').click(); await tick();
  const envelope = ui.envelope(), error = q(ui, '#connection').textContent;
  await ui.refresh(commit(latest, { replies: [{ id: envelope.delivery_id, source: 'user:4',
    items: envelope.items.map(item => ({ ...item, option_id: 'B', outcome: 'accepted' })) }] }));
  assert.equal(q(ui, '#connection').hidden, false);
  assert.equal(q(ui, '#connection').textContent, error);
  assert.match(q(ui, '#jc-draft').textContent, /saved reply differs/);
  assert.equal(new ReplyDrafts(ui.storage, 'C1').delivery.id, envelope.delivery_id);
  assert.equal(ui.sent.length, 1);
});

test('an origin settlement clears its old delivery error after another view settles a newer delivery', async () => {
  const a = await view({ sendImpl: async () => { throw Error('first host response lost'); } });
  const journal = previewState(); a.show(journal);
  q(a, '#jc-attention [data-record="D1"] [data-choice="A"]').click();
  q(a, '#jc-send').click(); await tick();
  const first = a.envelope(), firstError = q(a, '#connection').textContent;
  const firstReceipt = commit(journal, { replies: [{ id: first.delivery_id, source: 'user:4',
    items: first.items.map(item => ({ ...item, outcome: 'accepted' })) }] });
  const b = await view({ storage: a.storage, sendImpl: async () => { throw Error('second host response lost'); } }); b.show(firstReceipt);
  const input = q(b, '#jc-attention [data-record="B1"] textarea'); input.value = 'A separate second reply';
  input.dispatchEvent(new b.window.Event('input', { bubbles: true }));
  q(b, '#jc-send').click(); await tick();
  const second = b.envelope();
  const bothReceipts = commit(firstReceipt, { replies: [{ id: second.delivery_id, source: 'user:5',
    items: second.items.map(item => ({ ...item, outcome: 'accepted' })) }] });
  b.show(bothReceipts);
  assert.equal(q(a, '#connection').textContent, firstError, 'The first view has not read either receipt yet');
  await a.refresh(bothReceipts);
  assert.equal(new ReplyDrafts(a.storage, 'C1').delivery, null);
  assert.equal(q(a, '#connection').hidden, true, 'Its own settlement marker clears the old error even after the next settlement');
  assert.equal(a.sent.length + b.sent.length, 2);
});

test('a delivery error remains until exact receipt cleanup writes succeed', async () => {
  const storage = memoryStorage(), write = storage.setItem;
  const ui = await view({ storage, sendImpl: async () => { throw Error('host rejected the message'); } });
  const latest = previewState(); ui.show(latest);
  q(ui, '#jc-attention [data-record="D1"] [data-choice="A"]').click();
  q(ui, '#jc-send').click(); await tick();
  const envelope = ui.envelope(), error = q(ui, '#connection').textContent;
  const settled = commit(latest, { replies: [{ id: envelope.delivery_id, source: 'user:4',
    items: envelope.items.map(item => ({ ...item, outcome: 'accepted' })) }] });
  storage.setItem = () => { throw Error('cleanup writes denied'); };
  await ui.refresh(settled);
  assert.equal(q(ui, '#connection').hidden, false);
  assert.equal(q(ui, '#connection').textContent, error);
  assert.equal(new ReplyDrafts(storage, 'C1').delivery.id, envelope.delivery_id);
  storage.setItem = write;
  await ui.refresh(settled);
  assert.equal(q(ui, '#connection').hidden, true);
  assert.equal(new ReplyDrafts(storage, 'C1').delivery, null);
  assert.equal(ui.sent.length, 1);
});

test('accepted reads preserve unrelated action errors', async () => {
  const ui = await view(), latest = previewState(); ui.show(latest);
  q(ui, '#jc-attention [data-record="D1"] [data-choice="A"]').click();
  const changed = commit(latest, { decisions: [{ ...latest.decisions[0], question: 'A changed decision' }] });
  ui.setRead(changed); q(ui, '#jc-send').click(); await tick();
  const error = q(ui, '#connection').textContent;
  assert.match(error, /A reply changed/);
  await ui.refresh(changed);
  assert.equal(q(ui, '#connection').hidden, false);
  assert.equal(q(ui, '#connection').textContent, error);
  assert.equal(ui.sent.length, 0);
});

test('a successful journal read clears an obsolete read-failure notice', async () => {
  const ui = await view(), latest = previewState(); ui.show(latest);
  await ui.refresh({ ...latest, conversation_id: 'OTHER' });
  assert.match(q(ui, '#connection').textContent, /Could not refresh/);
  await ui.refresh(latest);
  assert.equal(q(ui, '#connection').hidden, true);
  assert.equal(ui.sent.length, 0);
});

test('an initial localStorage getter failure remains fail closed without an in-memory fallback', async () => {
  const storage = memoryStorage(), ui = await view({ storage });
  Object.defineProperty(ui.window, 'localStorage', { configurable: true, get() { throw Error('getter denied'); } });
  ui.show(previewState());
  assert.equal(q(ui, '#jc-storage').hidden, false);
  assert.match(q(ui, '#jc-storage').textContent, /Draft storage cannot be accessed/);
  Object.defineProperty(ui.window, 'localStorage', { configurable: true, value: storage });
  await ui.refresh(previewState());
  assert.equal(q(ui, '#jc-storage').hidden, false, 'captured null storage is not reacquired in this bounded recovery change');
  assert.deepEqual([...storage.values], []);
  assertLocked(ui);
});
