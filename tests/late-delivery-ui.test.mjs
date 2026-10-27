import test from 'node:test';
import assert from 'node:assert/strict';
import { view, previewState, commit, memoryStorage, tick } from './ui-harness.mjs';
import { ReplyDrafts, recordRevision } from '../src/reply-ui.mjs';

const q = (ui, selector) => ui.document.querySelector(selector);
const read = (ui, id) => q(ui, `#jc-attention [data-record="${id}"] .jc-read-icon`);
function deferred() { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; }
const initial = () => commit(previewState(), { cards: [{ id: 'N2', request_id: 'R1', revision: 1, type: 'note', title: 'Unread note', body: 'Read this separately', status: 'open' }] });
const receipt = (journal, envelope) => commit(journal, { replies: [{ id: envelope.delivery_id, source: 'user:5', items: envelope.items.map(item => ({ ...item, outcome: 'accepted' })) }] });
async function sendLegacyRead(ui, journal, id) {
  const drafts = new ReplyDrafts(ui.storage, 'C1');
  assert.equal(drafts.set({ collection: 'cards', id, record_revision: recordRevision(journal, 'cards', id), kind: 'resolve' }, `legacy-read-${id}`), true);
  await ui.refresh(journal);
  const count = ui.sent.length;
  q(ui, '#jc-send').click(); await tick();
  assert.equal(ui.sent.length, count + 1, 'An explicitly restored legacy read uses ordinary Send');
}

for (const outcome of ['success', 'rejection']) {
  test(`late global host ${outcome} draws imported choices before the next Send gesture`, async () => {
    const response = deferred(), storage = memoryStorage(), journal = previewState(); let calls = 0;
    const a = await view({ storage, sendImpl: () => ++calls === 1 ? response.promise : undefined }); a.show(journal);
    const firstComment = q(a, '#jc-attention [data-record="B1"] textarea'); firstComment.value = 'First comment';
    firstComment.dispatchEvent(new a.window.Event('input', { bubbles: true }));
    q(a, '#jc-send').click(); await tick();
    const accepted = receipt(journal, a.envelope()), b = await view({ storage }); b.show(accepted);
    q(b, '#jc-attention [data-record="D1"] [data-choice="A"]').click();
    a.setRead(accepted);
    if (outcome === 'success') response.resolve(); else response.reject(Error('old host response lost'));
    await tick();
    const afterHost = q(a, '#jc-attention [data-record="D1"] [data-choice="A"]').getAttribute('aria-pressed');
    const nextComment = q(a, '#jc-attention [data-record="B1"] textarea'); nextComment.value = 'Second comment';
    nextComment.dispatchEvent(new a.window.Event('input', { bubbles: true }));
    const selected = q(a, '#jc-attention [data-record="D1"] [data-choice="A"]').getAttribute('aria-pressed') === 'true';
    q(a, '#jc-send').click(); await tick();
    assert.equal(a.sent.length, 2);
    assert.deepEqual(a.envelope().items.filter(item => item.kind === 'answer'), selected ?
      [{ collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', option_id: 'A' }] : [],
    'The next Send cannot include a choice that was unselected before its gesture');
    assert.deepEqual(a.envelope().items.filter(item => item.kind === 'comment'),
      [{ collection: 'blockers', id: 'B1', record_revision: 3, kind: 'comment', text: 'Second comment' }]);
    assert.equal(afterHost, 'true', 'A late callback that imports shared drafts must draw those drafts');
  });
}

for (const outcome of ['success', 'rejection']) {
  test(`late legacy read host ${outcome} after receipt settlement cannot manufacture a delivery or blank Attention`, async () => {
    const response = deferred(), journal = initial(), ui = await view({ sendImpl: () => response.promise }); ui.show(journal);
    await sendLegacyRead(ui, journal, 'Q1');
    const accepted = receipt(journal, ui.envelope()); ui.show(accepted);
    assert.equal(new ReplyDrafts(ui.storage, 'C1').delivery, null);
    assert.ok(q(ui, '#jc-attention [data-record="N2"]'));
    if (outcome === 'success') response.resolve(); else response.reject(Error('old send rejected'));
    await tick();
    assert.ok(q(ui, '#jc-attention [data-record="N2"]'), 'An old callback cannot blank the current Attention list');
    assert.ok(q(ui, '#jc-attention [data-record="Q1"]') === null, 'The settled read must remain hidden');
    assert.equal(read(ui, 'N2').disabled, false, 'A settled delivery cannot be resurrected by its callback');
    assert.doesNotMatch(q(ui, '#connection').textContent, /unconfirmed|Could not send/i);
    assert.equal(new ReplyDrafts(ui.storage, 'C1').delivery, null);
    assert.equal(ui.sent.length, 1);
  });

  test(`late legacy read host ${outcome} cannot confirm or report failure for a replacement pending read message`, async () => {
    const response = deferred(), nextResponse = deferred(), storage = memoryStorage(), journal = initial();
    const a = await view({ storage, sendImpl: () => response.promise }); a.show(journal);
    await sendLegacyRead(a, journal, 'Q1');
    const accepted = receipt(journal, a.envelope()); a.show(accepted);
    const b = await view({ storage, sendImpl: () => nextResponse.promise }); b.show(accepted);
    await sendLegacyRead(b, accepted, 'N2');
    const nextId = b.envelope().delivery_id; a.show(accepted);
    const input = q(a, '#jc-attention [data-record="N2"] .jc-comment textarea'); input.value = 'Keep this unsent comment.';
    input.dispatchEvent(new a.window.Event('input', { bubbles: true }));
    const savedComment = [...new ReplyDrafts(storage, 'C1').drafts.values()].filter(item => item.kind === 'comment');
    assert.ok(q(a, '#jc-attention [data-record="N2"]'));
    if (outcome === 'success') response.resolve(); else response.reject(Error('old send rejected'));
    await tick();
    assert.ok(q(a, '#jc-attention [data-record="N2"]'), 'Only the replacement host callback can confirm the replacement read');
    assert.match(q(a, '#jc-draft').textContent, /unconfirmed/i);
    assert.doesNotMatch(q(a, '#connection').textContent, /unconfirmed|Could not send/i, 'Old failure must not label the replacement delivery');
    assert.equal(new ReplyDrafts(storage, 'C1').delivery.id, nextId);
    assert.deepEqual([...new ReplyDrafts(storage, 'C1').drafts.values()].filter(item => item.kind === 'comment'), savedComment);
    assert.equal(a.sent.length + b.sent.length, 2);
    if (outcome === 'success') {
      nextResponse.reject(Error('replacement send rejected')); await tick();
      await a.refresh(accepted);
      for (const ui of [a, b]) {
        assert.ok(q(ui, '#jc-attention [data-record="N2"]'), 'Replacement failure stays visible in both views');
        assert.equal(read(ui, 'N2').disabled, false, 'The silent read action is independent of pending legacy message delivery');
        assert.match(q(ui, '#jc-draft').textContent, /unconfirmed/i);
      }
      q(b, '#jc-send').click(); await tick();
      assert.equal(a.sent.length + b.sent.length, 2, 'Replacement failure cannot trigger an automatic resend');
    } else {
      nextResponse.resolve(); await tick();
      assert.ok(q(b, '#jc-attention [data-record="N2"]') === null, 'The replacement callback still confirms its own read');
    }
  });
}

test('delivery status requires an explicit nonempty matching origin ID', () => {
  const drafts = new ReplyDrafts(memoryStorage(), 'C1');
  for (const id of [undefined, null, '', ' ', 'settled-id']) {
    assert.equal(drafts.deliveryStatus('waiting', id), false);
    assert.equal(drafts.delivery, null);
  }
  const item = { collection: 'cards', id: 'Q1', record_revision: 3, kind: 'resolve' };
  drafts.set(item, 'read-token'); assert.equal(drafts.stage('current-origin', [item]), true);
  const frozen = drafts.storage.getItem(drafts.deliveryKey);
  for (const id of [undefined, null, '', ' ', 'old-origin']) {
    assert.equal(drafts.deliveryStatus('waiting', id), false);
    assert.equal(drafts.delivery.id, 'current-origin');
    assert.equal(drafts.delivery.status, 'sending');
  }
  assert.equal(drafts.deliveryStatus('uncertain', 'current-origin'), true);
  assert.equal(drafts.delivery.status, 'uncertain');
  assert.equal(drafts.deliveryStatus('waiting', 'current-origin'), true);
  assert.equal(drafts.delivery.status, 'waiting');
  assert.equal(drafts.storage.getItem(drafts.deliveryKey), frozen, 'Status callbacks cannot change the frozen delivery payload');
});
