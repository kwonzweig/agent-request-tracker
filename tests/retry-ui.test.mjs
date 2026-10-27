import test from 'node:test';
import assert from 'node:assert/strict';
import { view, previewState, commit, memoryStorage, tick } from './ui-harness.mjs';
import { ReplyDrafts, recordRevision } from '../src/reply-ui.mjs';

const q = (ui, selector) => ui.document.querySelector(selector);
const deliveryKey = 'request-journal:replies:v1:C1:delivery';
function deferred() { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; }
const receipt = (journal, envelope, patch = {}) => commit(journal, { replies: [{ id: envelope.delivery_id, source: 'user:4',
  items: envelope.items.map(item => ({ ...item, ...patch, outcome: 'accepted' })) }] });
async function pending(options = {}) {
  const ui = await view({ sendImpl: async () => { throw Error('host response lost'); }, ...options });
  const journal = previewState(); ui.show(journal);
  q(ui, '#jc-attention [data-record="D1"] [data-choice="A"]').click();
  q(ui, '#jc-send').click(); await tick();
  return { ui, journal, original: structuredClone(ui.sent[0]), envelope: ui.envelope() };
}
async function sendLegacyRead(ui, journal, id = 'Q1') {
  const drafts = new ReplyDrafts(ui.storage, 'C1');
  assert.equal(drafts.set({ collection: 'cards', id, record_revision: recordRevision(journal, 'cards', id), kind: 'resolve' }, `legacy-read-${id}`), true);
  await ui.refresh(journal);
  const count = ui.sent.length;
  q(ui, '#jc-send').click(); await tick();
  assert.equal(ui.sent.length, count + 1, 'An explicitly restored legacy read uses ordinary Send');
}
function locked(ui) {
  assert.equal(q(ui, '#jc-send').disabled, true);
  assert.ok(new ReplyDrafts(ui.storage, 'C1').delivery);
}

test('Send cannot include another view\'s choice that is absent from the displayed selection', async () => {
  const storage = memoryStorage(), journal = previewState();
  const a = await view({ storage }), b = await view({ storage }); a.show(journal); b.show(journal);
  q(b, '#jc-attention [data-record="D1"] [data-choice="A"]').click();
  q(a, '[data-tab="cards"]').click();
  const input = q(a, '#jc-cards [data-record="B1"] textarea'); input.value = 'Only the comment I typed';
  input.dispatchEvent(new a.window.Event('input', { bubbles: true }));
  const selected = q(a, '#jc-cards [data-record="D1"] [data-choice="A"]').getAttribute('aria-pressed') === 'true';
  q(a, '#jc-send').click(); await tick();
  assert.equal(a.sent.length, 1);
  assert.deepEqual(a.envelope().items.filter(item => item.kind === 'answer'), selected ?
    [{ collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', option_id: 'A' }] : [],
  'The Send gesture must not include a choice that was unselected on screen');
  assert.deepEqual(a.envelope().items.filter(item => item.kind === 'comment'),
    [{ collection: 'blockers', id: 'B1', record_revision: 3, kind: 'comment', text: 'Only the comment I typed' }]);
});

test('settlement of an old delivery notice imports shared choices before drawing Send selections', async () => {
  const { ui: a, journal, envelope } = await pending();
  const firstReceipt = receipt(journal, envelope), b = await view({ storage: a.storage }); b.show(firstReceipt);
  const secondComment = q(b, '#jc-attention [data-record="B1"] textarea'); secondComment.value = 'Second reply';
  secondComment.dispatchEvent(new b.window.Event('input', { bubbles: true }));
  q(b, '#jc-send').click(); await tick();
  const bothReceipts = receipt(firstReceipt, b.envelope()); b.show(bothReceipts);
  q(a, '[data-tab="cards"]').click();
  const read = a.storage.getItem; let baseReads = 0;
  // Schedule a real other-view edit at the origin settlement lookup, after
  // the journal reconciliation's first draft read. Its ordering must not hide it.
  a.storage.getItem = key => {
    if (key === 'request-journal:replies:v1:C1' && ++baseReads === 2)
      q(b, '#jc-attention [data-record="S1"] [data-choice="decline"]').click();
    return read(key);
  };
  await a.refresh(bothReceipts);
  assert.equal(q(a, '#connection').hidden, true);
  const input = q(a, '#jc-cards [data-record="B1"] textarea'); input.value = 'Only the new comment';
  input.dispatchEvent(new a.window.Event('input', { bubbles: true }));
  const selected = q(a, '#jc-cards [data-record="S1"] [data-choice="decline"]').getAttribute('aria-pressed') === 'true';
  q(a, '#jc-send').click(); await tick();
  assert.equal(a.sent.length, 2);
  assert.deepEqual(a.envelope().items.filter(item => item.kind === 'answer'), selected ?
    [{ collection: 'cards', id: 'S1', record_revision: 3, kind: 'answer', option_id: 'decline' }] : [],
  'Origin notice cleanup must not add an unseen answer to Send');
});

test('a resolved host rejection keeps a legacy read message visible and uncertain', async () => {
  const ui = await view({ sendImpl: async () => ({ isError: true }) }), journal = previewState(); ui.show(journal);
  await sendLegacyRead(ui, journal);
  assert.ok(q(ui, '#jc-attention [data-record="Q1"]'), 'A rejected read acknowledgment cannot hide its card');
  assert.match(q(ui, '#jc-draft').textContent, /Delivery is unconfirmed/);
  assert.match(q(ui, '#connection').textContent, /chat did not accept.*reply.*saved/i);
  assert.equal(q(ui, '#jc-retry').hidden, false);
  locked(ui);
  assert.equal(ui.sent.length, 1);
});

test('a resolved host rejection of a retry preserves the legacy read message and recovery preview', async () => {
  let calls = 0;
  const ui = await view({ sendImpl: async () => { if (++calls === 1) throw Error('initial response lost'); return { isError: true }; } });
  const journal = previewState(); ui.show(journal);
  await sendLegacyRead(ui, journal);
  const original = structuredClone(ui.sent[0]);
  q(ui, '#jc-retry-send').click(); await tick();
  assert.ok(q(ui, '#jc-attention [data-record="Q1"]'), 'A rejected retry cannot hide the original read');
  assert.match(q(ui, '#jc-draft').textContent, /Delivery is unconfirmed/);
  assert.match(q(ui, '#connection').textContent, /chat did not accept.*reply.*saved/i);
  assert.equal(q(ui, '#jc-retry').hidden, false);
  assert.equal(q(ui, '#jc-retry-preview').textContent, original.content[0].text);
  assert.deepEqual(ui.sent[1], original);
  locked(ui);
  assert.equal(ui.sent.length, 2);
});

test('a confirmed host send waits for its receipt without offering retry in that view', async () => {
  const ui = await view(); ui.show(previewState());
  q(ui, '#jc-attention [data-record="D1"] [data-choice="A"]').click();
  q(ui, '#jc-send').click(); await tick();
  assert.equal(q(ui, '#jc-retry').hidden, true);
  assert.match(q(ui, '#jc-draft').textContent, /Waiting for the agent to record/);
  locked(ui);
  await ui.refresh(previewState()); await tick();
  assert.equal(ui.sent.length, 1);
});

test('pending delivery shows the original reply and duplicate warning before an explicit retry', async () => {
  const { ui, original } = await pending();
  const recovery = q(ui, '#jc-retry');
  assert.ok(recovery, 'An unconfirmed reply needs a recovery control');
  assert.equal(recovery.hidden, false);
  assert.match(recovery.textContent, /duplicate.*chat|chat.*duplicate/i);
  assert.equal(q(ui, '#jc-retry-preview').textContent, original.content[0].text);
  assert.equal(q(ui, '#jc-retry-send').textContent, 'Retry reply');
  assert.equal(q(ui, '#jc-retry-send').disabled, false);
  locked(ui);
  await ui.refresh(previewState()); await tick();
  assert.equal(ui.sent.length, 1, 'Rendering and polling cannot retransmit');
});

test('an unfinished shared retry keeps its original preview and explains why Retry stays blocked', async () => {
  const { ui: source, journal, original, envelope } = await pending();
  source.storage.setItem(`${deliveryKey}:attempt:${envelope.delivery_id}`, JSON.stringify({ generation: 1, status: 'reserved' }));
  const ui = await view({ storage: source.storage }); ui.show(journal);
  assert.equal(q(ui, '#jc-retry').hidden, false);
  assert.equal(q(ui, '#jc-retry-send').disabled, true);
  assert.equal(q(ui, '#jc-retry-preview').textContent, original.content[0].text);
  assert.match(q(ui, '#jc-retry').textContent, /earlier retry.*no confirmed result.*agent.*check/i);
  assert.match(q(ui, '#jc-draft').textContent, /earlier retry.*no confirmed result.*agent.*check/i);
  q(ui, '#jc-retry-send').click(); await tick();
  locked(ui);
  assert.equal(ui.sent.length, 0);
});

test('a successful current retry clears its old unconfirmed banner while waiting for the same receipt', async () => {
  let calls = 0;
  const { ui, envelope } = await pending({ sendImpl: async () => { if (++calls === 1) throw Error('initial response lost'); } });
  assert.equal(q(ui, '#connection').hidden, false);
  assert.match(q(ui, '#connection').textContent, /Delivery is unconfirmed/);
  q(ui, '#jc-retry-send').click(); await tick();
  assert.match(q(ui, '#jc-draft').textContent, /Sent to the chat\. Waiting/);
  assert.equal(q(ui, '#connection').hidden, true, 'Confirmed retry must not retain the old unconfirmed banner');
  assert.equal(q(ui, '#jc-retry').hidden, true);
  assert.equal(new ReplyDrafts(ui.storage, 'C1').isDeliverySettled(envelope.delivery_id), false, 'Host confirmation does not invent an agent receipt');
  locked(ui);
  assert.equal(ui.sent.length, 2);
});

test('a successful current retry preserves a newer read error shown during its host call', async () => {
  const retryHost = deferred(); let calls = 0;
  const { ui, journal } = await pending({ sendImpl: () => ++calls === 1 ? Promise.reject(Error('initial response lost')) : retryHost.promise });
  q(ui, '#jc-retry-send').click(); await tick();
  ui.show({ ...journal, conversation_id: 'OTHER' });
  const error = q(ui, '#connection').textContent;
  assert.match(error, /different conversation/i);
  retryHost.resolve(); await tick();
  assert.equal(q(ui, '#connection').hidden, false);
  assert.equal(q(ui, '#connection').textContent, error, 'Retry success cannot clear an error that appeared after its gesture');
  assert.match(q(ui, '#jc-draft').textContent, /Sent to the chat\. Waiting/);
  locked(ui);
  assert.equal(ui.sent.length, 2);
});

test('one explicit retry emits exactly the frozen original official message', async () => {
  const { ui, journal, original, envelope } = await pending();
  const changed = commit(journal, { decisions: [{ ...journal.decisions[0], question: 'A newer question',
    options: [{ id: 'A', label: 'New label' }, { id: 'B', label: 'Another answer' }] }] });
  const other = new ReplyDrafts(ui.storage, 'C1');
  other.set({ collection: 'blockers', id: 'B1', record_revision: 3, kind: 'comment', text: 'A newer unsent draft' }, 'newer-comment');
  ui.setRead(changed);
  q(ui, '#jc-retry-send')?.click(); await tick();
  assert.equal(ui.sent.length, 2, 'The explicit gesture retransmits once');
  assert.deepEqual(ui.sent[1], original);
  assert.deepEqual(ui.envelope(), envelope);
  assert.equal(ui.sent[1]._meta['openai/message'].target, 'active');
  assert.equal(ui.sent[1]._meta['openai/message'].send, true);
  assert.ok([...new ReplyDrafts(ui.storage, 'C1').drafts.values()].some(item => item.text === 'A newer unsent draft'));
  locked(ui);
  await ui.refresh(changed); await tick();
  assert.equal(ui.sent.length, 2, 'A failed retry stays explicit');
});

test('receipt preflight settles the pending reply without another host message', async () => {
  const { ui, journal, envelope } = await pending();
  ui.setRead(receipt(journal, envelope));
  q(ui, '#jc-retry-send')?.click(); await tick();
  assert.equal(new ReplyDrafts(ui.storage, 'C1').delivery, null);
  assert.equal(ui.sent.length, 1);
  assert.equal(q(ui, '#jc-retry')?.hidden, true);
});

test('mismatched receipt preflight blocks retry and retains the normal Send lock', async () => {
  const { ui, journal, envelope } = await pending();
  ui.setRead(receipt(journal, envelope, { option_id: 'B' }));
  q(ui, '#jc-retry-send')?.click(); await tick();
  assert.equal(ui.sent.length, 1);
  locked(ui);
  assert.equal(q(ui, '#jc-retry-send')?.disabled, true);
  assert.match(q(ui, '#jc-draft').textContent, /saved reply differs/i);
});

test('failed fresh read blocks transmission and preserves the frozen reply', async () => {
  const { ui, journal, original } = await pending();
  ui.setRead({ ...journal, conversation_id: 'OTHER' });
  q(ui, '#jc-retry-send')?.click(); await tick();
  assert.equal(ui.sent.length, 1);
  locked(ui);
  assert.match(q(ui, '#connection').textContent, /Could not.*(check|read|retry)|latest.*could not/i);
  assert.equal(q(ui, '#jc-retry-preview')?.textContent, original.content[0].text);
});

test('a double click cannot queue a second retry while the first host call is pending', async () => {
  const retryHost = deferred(); let calls = 0;
  const { ui } = await pending({ sendImpl: () => ++calls === 1 ? Promise.reject(Error('initial response lost')) : retryHost.promise });
  const control = q(ui, '#jc-retry-send');
  assert.ok(control, 'The original reply must be reviewable');
  control.click(); control.click(); await tick();
  assert.equal(ui.sent.length, 2);
  assert.equal(q(ui, '#jc-retry-send').disabled, true);
  locked(ui);
  retryHost.reject(Error('retry response lost')); await tick();
  assert.equal(ui.sent.length, 2);
  control.click(); await tick();
  assert.equal(ui.sent.length, 2, 'The detached old review cannot send again');
});

test('a stale open view cannot silently repeat another view\'s completed retry attempt', async () => {
  const { ui: a, journal, original } = await pending();
  const b = await view({ storage: a.storage, sendImpl: async () => { throw Error('retry response lost'); } }); b.show(journal);
  const old = q(a, '#jc-retry-send');
  assert.ok(old, 'The pending delivery needs a visible original review');
  q(b, '#jc-retry-send').click(); await tick();
  old.click(); await tick();
  assert.equal(a.sent.length + b.sent.length, 2);
  assert.deepEqual(b.sent[0], original);
  locked(a);
});

test('an explicit legacy read message retry confirms only its original card and waits for the same receipt', async () => {
  let calls = 0;
  const ui = await view({ sendImpl: async () => { if (++calls === 1) throw Error('initial response lost'); } });
  const journal = previewState(); ui.show(journal);
  await sendLegacyRead(ui, journal);
  const original = structuredClone(ui.sent[0]), envelope = ui.envelope();
  assert.ok(q(ui, '#jc-attention [data-record="Q1"]'));
  q(ui, '#jc-retry-send').click(); await tick();
  assert.deepEqual(ui.sent[1], original);
  assert.equal(q(ui, '#jc-attention [data-record="Q1"]'), null);
  assert.equal(q(ui, '#jc-retry').hidden, true);
  locked(ui);
  await ui.refresh(receipt(journal, envelope));
  assert.equal(new ReplyDrafts(ui.storage, 'C1').delivery, null);
  assert.equal(q(ui, '#jc-attention [data-record="B1"] textarea').disabled, false);
  assert.equal(ui.sent.length, 2);
});

test('legacy pending replies restore a disclosed preview from the original versions', async () => {
  const { ui: source, journal, original, envelope } = await pending();
  const saved = JSON.parse(source.storage.getItem(deliveryKey)); delete saved.outbound;
  source.storage.setItem(deliveryKey, JSON.stringify(saved));
  const changed = commit(journal, { decisions: [{ ...journal.decisions[0], question: 'New question', options: [{ id: 'A', label: 'New answer' }] }] });
  const ui = await view({ storage: source.storage, sendImpl: async () => { throw Error('legacy response lost'); } }); ui.show(changed);
  assert.equal(q(ui, '#jc-retry-preview')?.textContent, original.content[0].text);
  assert.match(q(ui, '#jc-retry').textContent, /Preview restored from the original reply records\./);
  q(ui, '#jc-retry-send').click(); await tick();
  assert.equal(ui.sent.length, 1);
  assert.deepEqual(ui.envelope(), envelope);
  assert.equal(ui.sent[0].content[0].text, original.content[0].text);
});

test('legacy pending replies with unverifiable original history remain blocked', async () => {
  const { ui: source, journal } = await pending();
  const saved = JSON.parse(source.storage.getItem(deliveryKey)); delete saved.outbound;
  source.storage.setItem(deliveryKey, JSON.stringify(saved));
  const ui = await view({ storage: source.storage }); ui.show({ ...journal, history: [] });
  assert.ok(q(ui, '#jc-retry-send'), 'A blocked recovery state must explain why');
  assert.equal(q(ui, '#jc-retry-send').disabled, true);
  assert.match(q(ui, '#jc-retry').textContent, /original.*(record|reply).*(unavailable|verified)|verify.*original/i);
  q(ui, '#jc-retry-send').click(); await tick();
  assert.equal(ui.sent.length, 0);
  locked(ui);
});

test('new deliveries retain their exact outbound preview after original history becomes unavailable', async () => {
  const { ui: source, journal, original } = await pending();
  const saved = JSON.parse(source.storage.getItem(deliveryKey));
  assert.deepEqual(saved.outbound, original, 'The message must be frozen before its first host call');
  const ui = await view({ storage: source.storage, sendImpl: async () => { throw Error('response lost'); } });
  ui.show({ ...journal, history: [] });
  assert.equal(q(ui, '#jc-retry-preview').textContent, original.content[0].text);
  q(ui, '#jc-retry-send').click(); await tick();
  assert.deepEqual(ui.sent[0], original);
});

for (const invalid of ['route', 'envelope', 'extra-content', 'null-content']) {
  test(`stored outbound ${invalid} cannot become an unreviewed host message`, async () => {
    const { ui: source, journal, original } = await pending();
    const saved = JSON.parse(source.storage.getItem(deliveryKey));
    saved.outbound = structuredClone(original);
    if (invalid === 'route') saved.outbound._meta['openai/message'].target = 'other';
    if (invalid === 'envelope') {
      const envelope = JSON.parse(saved.outbound.content[1].resource.text); envelope.items[0].option_id = 'B';
      saved.outbound.content[1].resource.text = JSON.stringify(envelope);
    }
    if (invalid === 'extra-content') saved.outbound.content.push({ type: 'text', text: 'An unrelated command' });
    if (invalid === 'null-content') saved.outbound.content = null;
    source.storage.setItem(deliveryKey, JSON.stringify(saved));
    const ui = await view({ storage: source.storage }); ui.show(journal);
    assert.equal(q(ui, '#jc-retry-send')?.disabled, true);
    q(ui, '#jc-retry-send')?.click(); await tick();
    assert.equal(ui.sent.length, 0);
    locked(ui);
  });
}
