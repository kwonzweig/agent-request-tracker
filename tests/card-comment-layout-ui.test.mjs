import test from 'node:test';
import assert from 'node:assert/strict';
import { view, state, commit, previewState, markReadState, tick } from './ui-harness.mjs';

const q = (ui, selector) => ui.document.querySelector(selector);
const type = (ui, input, value) => { input.value = value; input.dispatchEvent(new ui.window.Event('input', { bubbles: true })); };

test('cards and Requests collapse Comment behind a speech bubble and retain drafts across collapse and polling', async () => {
  const first = previewState(), ui = await view(); ui.show(first);
  for (const selector of ['#jc-attention [data-record="D1"]', '#jc-attention [data-record="B1"]',
    '#jc-attention [data-record="S1"]', '#jc-attention [data-record="Q1"]', '#jc-tree [data-record="R1"]']) {
    const card = q(ui, selector), control = card.querySelector('.jc-comment-toggle');
    assert.ok(control, 'Every live record needs a Comment toggle');
    assert.equal(control.getAttribute('aria-expanded'), 'false');
    assert.ok(control.querySelector('svg'), 'Use a speech bubble icon');
    assert.equal(card.querySelector('.jc-comment-editor').hidden, true);
    control.click();
    assert.equal(control.getAttribute('aria-expanded'), 'true');
    assert.equal(card.querySelector('.jc-comment-editor').hidden, false);
    type(ui, card.querySelector('.jc-comment textarea'), 'Keep this comment.');
    control.click();
    assert.equal(card.querySelector('.jc-comment-editor').hidden, true);
    assert.equal(card.querySelector('.jc-comment textarea').value, 'Keep this comment.');
  }
  await ui.refresh(commit(first, {}));
  for (const selector of ['#jc-attention [data-record="D1"]', '#jc-tree [data-record="R1"]']) {
    const card = q(ui, selector);
    assert.equal(card.querySelector('.jc-comment-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(card.querySelector('.jc-comment textarea').value, 'Keep this comment.');
    assert.ok(card.querySelector('details') === null || selector.includes('jc-tree'));
  }
});

test('card actions sit above Comment and Decision answer and Comment send independently in the same batch', async () => {
  const first = state(), ui = await view(); ui.show(first);
  const card = q(ui, '#jc-attention [data-record="D1"]');
  assert.ok(card.querySelector('.jc-comment-toggle'), 'Decision needs Comment alongside its choices');
  const children = [...card.querySelector('.jc-record-body').children];
  assert.ok(children.indexOf(card.querySelector('.jc-actions')) < children.indexOf(card.querySelector('.jc-card-footer')));
  assert.ok(card.querySelector('[data-reply-kind="defer"]').classList.contains('jc-later-action'));
  card.querySelector('[data-choice="A"]').click();
  q(ui, '#jc-attention [data-record="D1"] .jc-comment-toggle').click();
  type(ui, q(ui, '#jc-attention [data-record="D1"] .jc-comment textarea'), 'Keep the existing limits.');
  q(ui, '#jc-attention [data-record="D1"] .jc-comment-toggle').click();
  q(ui, '#jc-send').click(); await tick();
  assert.deepEqual(ui.envelope().items.map(({ kind, option_id, text }) => ({ kind, ...(option_id ? { option_id } : {}), ...(text ? { text } : {}) })),
    [{ kind: 'answer', option_id: 'A' }, { kind: 'comment', text: 'Keep the existing limits.' }]);
});

test('Other text and Comment keep separate drafts and send both without replacing either', async () => {
  const ui = await view(); ui.show(state());
  q(ui, '#jc-attention [data-record="D1"] [data-choice="other"]').click();
  type(ui, q(ui, '#jc-attention [data-record="D1"] .jc-input:not(.jc-comment) textarea'), 'My own answer.');
  q(ui, '#jc-attention [data-record="D1"] .jc-comment-toggle').click();
  type(ui, q(ui, '#jc-attention [data-record="D1"] .jc-comment textarea'), 'A separate restriction.');
  q(ui, '#jc-attention [data-record="D1"] [data-choice="A"]').click();
  q(ui, '#jc-attention [data-record="D1"] [data-choice="other"]').click();
  assert.equal(q(ui, '#jc-attention [data-record="D1"] .jc-input:not(.jc-comment) textarea').value, 'My own answer.');
  assert.equal(q(ui, '#jc-attention [data-record="D1"] .jc-comment textarea').value, 'A separate restriction.');
  q(ui, '#jc-send').click(); await tick();
  assert.deepEqual(ui.envelope().items.map(({ kind, text }) => ({ kind, text })).sort((a, b) => a.kind.localeCompare(b.kind)),
    [{ kind: 'answer', text: 'My own answer.' }, { kind: 'comment', text: 'A separate restriction.' }]);
});

test('the read control silently saves read only on notification cards', async () => {
  const first = previewState(), ui = await view({ toolImpl: async request => ({
    structuredContent: { journal: markReadState(first, request.arguments) },
  }) });
  first.cards.push({ id: 'C1', request_id: 'R1', revision: 1, type: 'completion', title: 'Complete notification', body: 'Saved result', status: 'open', source: 'agent:3' });
  first.cards.push({ id: 'N2', request_id: 'R1', revision: 1, type: 'note', title: 'Note notification', body: 'Saved note', status: 'open', source: 'agent:3' });
  ui.show(first);
  for (const id of ['Q1', 'N2', 'C1']) {
    const card = q(ui, `#jc-attention [data-record="${id}"]`), control = card.querySelector('[data-reply-kind="resolve"]');
    assert.ok(control.querySelector('svg'));
    assert.equal(control.title, 'Mark as read');
    assert.equal(control.getAttribute('aria-label'), `Mark as read · ${first.cards.find(card => card.id === id).title}`);
    assert.equal(control.hasAttribute('aria-pressed'), false);
    assert.ok(control.closest('.jc-summary-top'));
    assert.ok(control.closest('.jc-status-strip') === null, 'Read control must stay separate from the status badge');
  }
  for (const id of ['B1', 'D1', 'S1']) assert.ok(q(ui, `#jc-attention [data-record="${id}"] [data-reply-kind="resolve"]`) === null);
  q(ui, '#jc-attention [data-record="Q1"] [data-reply-kind="resolve"]').click();
  await tick();
  assert.equal(ui.sent.length, 0);
  assert.ok(q(ui, '#jc-attention [data-record="Q1"]') === null);
  assert.deepEqual(ui.toolCalls, [{ name: 'journal_mark_read', arguments: { conversation_id: 'C1', card_id: 'Q1', record_revision: 3 } }]);
  assert.equal(first.cards.find(card => card.id === 'Q1').status, 'answered');
});
