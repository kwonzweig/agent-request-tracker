import test from 'node:test';
import assert from 'node:assert/strict';
import { view, previewState, commit, memoryStorage, tick } from './ui-harness.mjs';
import { ReplyDrafts, recordRevision } from '../src/reply-ui.mjs';

const q = (ui, selector) => ui.document.querySelector(selector);
const read = (ui, id = 'Q1', place = 'attention') => q(ui, `#jc-${place} [data-record="${id}"] .jc-read-icon`);
const type = (ui, selector, value) => {
  const input = q(ui, selector); input.value = value; input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
};
const notificationState = () => commit(previewState(), { cards: [
  { id: 'N2', request_id: 'R1', revision: 1, type: 'note', title: 'Note', body: 'Saved note', status: 'open', source: 'agent:4' },
  { id: 'C1', request_id: 'R1', revision: 1, type: 'completion', title: 'Complete', body: 'Saved result', status: 'open', source: 'agent:4' },
] });

for (const id of ['Q1', 'N2', 'C1']) test(`accepted read receipt keeps ${id} out of Attention before its lifecycle update, including fresh views`, async () => {
  const journal = notificationState(), ui = await view(); ui.show(journal);
  q(ui, '#jc-attention [data-record="D1"] [data-choice="A"]').click();
  type(ui, `#jc-attention [data-record="${id}"] .jc-comment textarea`, 'Keep this comment unsent.');
  const before = [...new ReplyDrafts(ui.storage, 'C1').drafts.values()];
  const legacy = { collection: 'cards', id, record_revision: recordRevision(journal, 'cards', id), kind: 'resolve' };
  const editor = new ReplyDrafts(ui.storage, 'C1'); editor.set(legacy, 'legacy-read'); editor.stage('legacy-delivery', [legacy]);
  const envelope = { delivery_id: 'legacy-delivery', items: [legacy] };
  const accepted = commit(journal, { replies: [{ id: envelope.delivery_id, source: 'user:5',
    items: envelope.items.map(item => ({ ...item, outcome: 'accepted' })) }] });
  await ui.refresh(accepted);
  assert.equal(new ReplyDrafts(ui.storage, 'C1').delivery, null, 'The exact receipt settles the submitted delivery');
  assert.ok(q(ui, `#jc-attention [data-record="${id}"]`) === null, 'Receipt settlement must not revive the read notification');
  assert.ok(q(ui, `#jc-cards-body [data-record="${id}"] .jc-read-icon`) === null, 'An unchanged read notification cannot send another acknowledgment');
  assert.deepEqual(accepted.cards.find(card => card.id === id), journal.cards.find(card => card.id === id), 'No lifecycle status is manufactured');
  assert.deepEqual([...new ReplyDrafts(ui.storage, 'C1').drafts.values()], before);
  assert.equal(ui.sent.length, 0);
  const reopened = await view({ storage: ui.storage }); reopened.show(accepted);
  const independent = await view(); independent.show(accepted);
  for (const fresh of [reopened, independent]) {
    assert.ok(q(fresh, `#jc-attention [data-record="${id}"]`) === null);
    assert.ok(q(fresh, `#jc-cards-body [data-record="${id}"] .jc-read-icon`) === null);
    assert.equal(fresh.sent.length, 0);
  }
  const revised = commit(accepted, { cards: [{ ...accepted.cards.find(card => card.id === id), body: 'Materially revised content to read.' }] });
  await ui.refresh(revised); await independent.refresh(revised);
  for (const fresh of [ui, independent]) {
    assert.ok(q(fresh, `#jc-attention [data-record="${id}"]`));
    assert.equal(read(fresh, id).disabled, false, 'A material revision restores the read action');
  }
  assert.deepEqual([...new ReplyDrafts(ui.storage, 'C1').drafts.values()], before, 'Revising the notification preserves unrelated drafts');
});

test('global Send retires a newly accepted read while sending only the unchanged intended choice and comment', async () => {
  const journal = notificationState(), storage = memoryStorage(), editor = new ReplyDrafts(storage, 'C1');
  editor.set({ collection: 'cards', id: 'Q1', record_revision: 3, kind: 'resolve' }, 'redundant-read');
  const ui = await view({ storage }); ui.show(journal);
  q(ui, '#jc-attention [data-record="D1"] [data-choice="A"]').click();
  type(ui, '#jc-attention [data-record="Q1"] .jc-comment textarea', 'Keep and send this separate comment.');
  const before = [...new ReplyDrafts(storage, 'C1').drafts.values()].filter(item => item.kind !== 'resolve');
  const accepted = commit(journal, { replies: [{ id: 'other-view-read', source: 'user:5', items: [
    { collection: 'cards', id: 'Q1', record_revision: 3, kind: 'resolve', outcome: 'accepted' },
  ] }] });
  ui.setRead(accepted); q(ui, '#jc-send').click(); await tick();
  assert.equal(ui.sent.length, 1);
  assert.deepEqual(ui.envelope().items.map(({ collection, id, kind }) => ({ collection, id, kind })), [
    { collection: 'decisions', id: 'D1', kind: 'answer' }, { collection: 'cards', id: 'Q1', kind: 'comment' },
  ]);
  assert.deepEqual([...new ReplyDrafts(storage, 'C1').drafts.values()], before, 'Cleanup consumes only the redundant read, not the still-pending batch drafts');
});

test('read retirement preserves a concurrent newer-version read and unrelated drafts', async () => {
  const journal = notificationState(), storage = memoryStorage(), editor = new ReplyDrafts(storage, 'C1');
  const old = { collection: 'cards', id: 'Q1', record_revision: 3, kind: 'resolve' };
  editor.set(old, 'redundant-read');
  editor.set({ collection: 'cards', id: 'Q1', record_revision: 3, kind: 'comment', text: 'Preserved comment.' }, 'comment-token');
  editor.set({ collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', option_id: 'A' }, 'choice-token');
  const accepted = commit(journal, { replies: [{ id: 'other-view-read', source: 'user:5', items: [{ ...old, outcome: 'accepted' }] }] });
  const revised = commit(accepted, { cards: [{ ...accepted.cards.find(card => card.id === 'Q1'), body: 'New content.' }] });
  const next = { collection: 'cards', id: 'Q1', record_revision: revised.revision, kind: 'resolve' };
  const write = storage.setItem; let overlap = true;
  storage.setItem = (key, value) => {
    if (overlap && key.includes('read-receipt')) {
      overlap = false;
      new ReplyDrafts(storage, 'C1').set(next, 'new-read-token');
    }
    write(key, value);
  };
  const ui = await view({ storage }); ui.show(revised);
  const saved = [...new ReplyDrafts(storage, 'C1').drafts.values()];
  assert.equal(saved.some(item => item.token === 'redundant-read'), false);
  assert.deepEqual(saved.find(item => item.token === 'new-read-token'), { ...next, token: 'new-read-token' });
  assert.ok(saved.some(item => item.token === 'comment-token'));
  assert.ok(saved.some(item => item.token === 'choice-token'));
  assert.ok(q(ui, '#jc-attention .jc-warning') === null);
});

test('Attention has fixed expanded cards, while Cards and History retain disclosures and Blocker never gains a read control', async () => {
  const ui = await view(); ui.show(notificationState());
  for (const card of ui.document.querySelectorAll('#jc-attention .jc-card')) {
    assert.equal(card.tagName, 'ARTICLE');
    assert.ok(card.querySelector('summary') === null);
    assert.ok(card.querySelector('.jc-record-body'));
  }
  assert.equal(q(ui, '#jc-cards-body [data-record="Q1"]').tagName, 'DETAILS');
  assert.equal(q(ui, '#jc-history-cards [data-record="N2"]').tagName, 'DETAILS');
  assert.ok(read(ui, 'B1') === null);
});

test('an uncertain restored legacy read never hides its card or automatically resends', async () => {
  const journal = notificationState(), storage = memoryStorage(), editor = new ReplyDrafts(storage, 'C1');
  const item = { collection: 'cards', id: 'Q1', record_revision: 3, kind: 'resolve' };
  editor.set(item, 'legacy-read'); editor.stage('legacy-delivery', [item]);
  const ui = await view({ storage }); ui.show(journal); await ui.refresh(journal);
  assert.ok(q(ui, '#jc-attention [data-record="Q1"]')); assert.equal(ui.sent.length, 0);
  assert.equal(read(ui).disabled, false, 'Server read is independent of an old uncertain chat acknowledgment');
  assert.equal(q(ui, '#jc-send').disabled, true);
});

test('a stale legacy receipt leaves the card unread in current and fresh views', async () => {
  const journal = notificationState(), item = { collection: 'cards', id: 'Q1', record_revision: 3, kind: 'resolve' };
  const stale = commit(journal, { replies: [{ id: 'stale-read', source: 'user:5', items: [{ ...item, outcome: 'stale' }] }] });
  for (const ui of [await view(), await view()]) {
    ui.show(stale); assert.ok(q(ui, '#jc-attention [data-record="Q1"]')); assert.equal(read(ui).disabled, false); assert.equal(ui.sent.length, 0);
  }
});

test('global Send preflight retires an already accepted legacy read without sending a second acknowledgment', async () => {
  const journal = notificationState(), storage = memoryStorage(), item = { collection: 'cards', id: 'Q1', record_revision: 3, kind: 'resolve' };
  new ReplyDrafts(storage, 'C1').set(item, 'legacy-read');
  const ui = await view({ storage }); ui.show(journal);
  const accepted = commit(journal, { replies: [{ id: 'other-view-read', source: 'user:5', items: [{ ...item, outcome: 'accepted' }] }] });
  ui.setRead(accepted); q(ui, '#jc-send').click(); await tick();
  assert.equal(ui.sent.length, 0); assert.equal(new ReplyDrafts(storage, 'C1').drafts.size, 0);
  assert.equal(q(ui, '#jc-attention [data-record="Q1"]'), null);
  const revised = commit(accepted, { cards: [{ ...accepted.cards.find(card => card.id === 'Q1'), body: 'New content.' }] });
  await ui.refresh(revised); assert.ok(q(ui, '#jc-attention [data-record="Q1"]')); assert.equal(q(ui, '#jc-attention .jc-warning'), null);
});

test('an old accepted legacy read cannot retire a newer unfulfilled saved read', async () => {
  const journal = notificationState(), old = { collection: 'cards', id: 'Q1', record_revision: 3, kind: 'resolve' };
  const revised = commit(journal, { cards: [{ ...journal.cards.find(card => card.id === 'Q1'), body: 'New content.' }],
    replies: [{ id: 'old-read', source: 'user:5', items: [{ ...old, outcome: 'accepted' }] }] });
  const next = { ...old, record_revision: revised.revision }, storage = memoryStorage();
  new ReplyDrafts(storage, 'C1').set(next, 'new-read');
  const ui = await view({ storage }); ui.show(revised); await ui.refresh(revised);
  assert.deepEqual([...new ReplyDrafts(storage, 'C1').drafts.values()], [{ ...next, token: 'new-read' }]);
  assert.ok(q(ui, '#jc-attention [data-record="Q1"]')); assert.equal(ui.sent.length, 0);
});
