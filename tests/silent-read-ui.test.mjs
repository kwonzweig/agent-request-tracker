import test from 'node:test';
import assert from 'node:assert/strict';
import { view, previewState, commit, memoryStorage, tick } from './ui-harness.mjs';
import { ReplyDrafts, recordRevision } from '../src/reply-ui.mjs';

const q = (ui, selector) => ui.document.querySelector(selector);
const close = (ui, id = 'Q1', place = 'attention') => q(ui, `#jc-${place} [data-record="${id}"] .jc-read-icon`);
const notificationState = () => commit(previewState(), { cards: [
  { id: 'N2', request_id: 'R1', revision: 1, type: 'note', title: 'Note', body: 'Saved note', status: 'open', source: 'agent:4' },
  { id: 'C1', request_id: 'R1', revision: 1, type: 'completion', title: 'Complete', body: 'Saved result', status: 'open', source: 'agent:4' },
] });
function savedRead(journal, id, revision = recordRevision(journal, 'cards', id)) {
  const saved = structuredClone(journal), index = saved.cards.findIndex(card => card.id === id), before = saved.cards[index];
  const after = { ...before, status: 'resolved', resolution: { actor: 'user', source: `app:journal_mark_read:${id}:${revision}`,
    note: 'Marked as read in Request Tracker.', record_revision: revision } };
  saved.cards[index] = after; saved.revision++;
  saved.history.push({ revision: saved.revision, turn_id: saved.turn.id, changes: [{ collection: 'cards', id, before, after }] });
  return saved;
}
function readHost(journal) {
  let saved = journal;
  return { get saved() { return saved; }, async call(request) {
    if (request.name === 'journal_mark_read') saved = savedRead(saved, request.arguments.card_id, request.arguments.record_revision);
    return { structuredContent: { journal: saved, runtime_version: 'test' } };
  } };
}

for (const id of ['Q1', 'N2', 'C1']) test(`× saves ${id} without a chat message, new turn or reply draft and survives reload`, async () => {
  const journal = notificationState(), host = readHost(journal), ui = await view({ toolImpl: request => host.call(request) }); ui.show(journal);
  const before = [...ui.storage.values]; close(ui, id).click(); await tick();
  assert.equal(ui.sent.length, 0);
  assert.deepEqual(ui.toolCalls, [{ name: 'journal_mark_read', arguments: {
    conversation_id: 'C1', card_id: id, record_revision: recordRevision(journal, 'cards', id),
  } }]);
  assert.equal(q(ui, `#jc-attention [data-record="${id}"]`), null);
  assert.match(q(ui, `#jc-cards-body [data-record="${id}"] .jc-status-strip`).textContent, /Resolved/);
  assert.equal(close(ui, id, 'cards-body'), null);
  assert.deepEqual(host.saved.turn, journal.turn); assert.deepEqual(host.saved.replies, journal.replies);
  assert.deepEqual([...ui.storage.values], before, 'No local draft, delivery or receipt marker is created');
  const reopened = await view(); reopened.show(host.saved);
  assert.equal(q(reopened, `#jc-attention [data-record="${id}"]`), null); assert.equal(reopened.sent.length, 0);
});

test('silent read preserves choices, invalid Other and every unsent comment', async () => {
  const journal = notificationState(), host = readHost(journal), ui = await view({ toolImpl: request => host.call(request) }); ui.show(journal);
  q(ui, '#jc-attention [data-record="D1"] [data-choice="A"]').click();
  q(ui, '#jc-attention [data-record="S1"] [data-choice="other"]').click();
  for (const [id, value] of [['Q1', 'Same card comment.'], ['B1', 'Other card comment.']]) {
    const input = q(ui, `#jc-attention [data-record="${id}"] textarea`); input.value = value;
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  }
  const before = [...new ReplyDrafts(ui.storage, 'C1').drafts.values()]; close(ui).click(); await tick();
  assert.equal(ui.sent.length, 0); assert.equal(ui.toolCalls.length, 1);
  assert.deepEqual([...new ReplyDrafts(ui.storage, 'C1').drafts.values()], before);
  assert.match(q(ui, '#jc-cards-body [data-record="Q1"] .jc-warning').textContent, /Unsent comment.*Same card comment\./s);
  assert.equal(q(ui, '#jc-attention [data-record="D1"] [data-choice="A"]').getAttribute('aria-pressed'), 'true');
  assert.equal(q(ui, '#jc-send').disabled, true);
});

test('silent read works without chat-message capability or accessible local drafts', async () => {
  const journal = notificationState(), host = readHost(journal), storage = memoryStorage();
  storage.getItem = () => { throw Error('denied'); }; storage.setItem = () => { throw Error('denied'); };
  const ui = await view({ canSend: false, storage, toolImpl: request => host.call(request) }); ui.show(journal);
  assert.equal(close(ui).disabled, false); close(ui).click(); await tick();
  assert.equal(ui.sent.length, 0); assert.equal(ui.toolCalls.length, 1); assert.equal(q(ui, '#jc-attention [data-record="Q1"]'), null);
});

test('silent read leaves a pending ordinary Send and all stored bytes untouched', async () => {
  const journal = notificationState(), storage = memoryStorage(), editor = new ReplyDrafts(storage, 'C1');
  const comment = { collection: 'blockers', id: 'B1', record_revision: 3, kind: 'comment', text: 'Pending comment.' };
  editor.set(comment, 'pending-token'); editor.stage('pending-send', [comment]);
  const before = [...storage.values], host = readHost(journal), ui = await view({ storage, toolImpl: request => host.call(request) }); ui.show(journal);
  assert.equal(q(ui, '#jc-send').disabled, true); assert.equal(close(ui).disabled, false); close(ui).click(); await tick();
  assert.equal(ui.sent.length, 0); assert.equal(ui.toolCalls.length, 1); assert.deepEqual([...storage.values], before);
  assert.equal(new ReplyDrafts(storage, 'C1').delivery.id, 'pending-send'); assert.equal(q(ui, '#jc-send').disabled, true);
});

for (const failure of ['throw', 'isError', 'missing', 'unconfirmed']) test(`${failure} read-save failure leaves × visible for explicit retry with no chat fallback`, async () => {
  const journal = notificationState(); let failed = true;
  const ui = await view({ toolImpl: async request => {
    if (!failed) return { structuredContent: { journal: savedRead(journal, request.arguments.card_id, request.arguments.record_revision) } };
    if (failure === 'throw') throw Error('private exception');
    if (failure === 'isError') return { isError: true, content: [{ type: 'text', text: 'private server error' }] };
    return failure === 'missing' ? {} : { structuredContent: { journal } };
  } }); ui.show(journal); close(ui).click(); await tick();
  assert.ok(q(ui, '#jc-attention [data-record="Q1"]')); assert.equal(close(ui).disabled, false);
  assert.match(q(ui, '#connection').textContent, /Could not mark.*read/); assert.doesNotMatch(q(ui, '#connection').textContent, /private/);
  assert.equal(ui.sent.length, 0); assert.equal(new ReplyDrafts(ui.storage, 'C1').delivery, null);
  assert.equal(ui.toolCalls.length, 1); failed = false; close(ui).click(); await tick();
  assert.equal(ui.sent.length, 0); assert.equal(ui.toolCalls.length, 2); assert.equal(q(ui, '#jc-attention [data-record="Q1"]'), null);
});

test('duplicate × clicks across both rendered copies save once and stay visible until persistence', async () => {
  const journal = notificationState(); let finish;
  const ui = await view({ toolImpl: () => new Promise(resolve => { finish = resolve; }) }); ui.show(journal);
  const first = close(ui), second = close(ui, 'Q1', 'cards-body'); first.click(); first.click(); second.click(); await tick();
  assert.equal(ui.toolCalls.length, 1); assert.equal(ui.sent.length, 0); assert.ok(q(ui, '#jc-attention [data-record="Q1"]'));
  assert.equal(close(ui).disabled, true); assert.equal(close(ui, 'Q1', 'cards-body').disabled, true);
  finish({ structuredContent: { journal: savedRead(journal, 'Q1') } }); await tick(); assert.equal(q(ui, '#jc-attention [data-record="Q1"]'), null);
});

test('a delayed old read response cannot hide a newer reopened card', async () => {
  const journal = notificationState(); let finish;
  const ui = await view({ toolImpl: () => new Promise(resolve => { finish = resolve; }) }); ui.show(journal); close(ui).click(); await tick();
  const accepted = savedRead(journal, 'Q1');
  const reopened = commit(accepted, { cards: [{ ...accepted.cards.find(card => card.id === 'Q1'), body: 'New content.', status: 'open', resolution: null }] });
  ui.show(reopened); finish({ structuredContent: { journal: accepted } }); await tick();
  assert.ok(q(ui, '#jc-attention [data-record="Q1"]')); assert.match(q(ui, '#jc-attention [data-record="Q1"]').textContent, /New content/);
  assert.equal(close(ui).disabled, false); assert.equal(ui.sent.length, 0);
});
