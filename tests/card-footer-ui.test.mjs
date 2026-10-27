import test from 'node:test';
import assert from 'node:assert/strict';
import { view, previewState, commit, markReadState, tick } from './ui-harness.mjs';

const q = (ui, selector) => ui.document.querySelector(selector);
const card = (ui, place, id) => q(ui, `#jc-${place} [data-record="${id}"]`);
function toggle(ui, node, open) { node.toggleAttribute('open', open); node.dispatchEvent(new ui.window.Event('toggle')); }
function linkedState() {
  const first = previewState();
  return commit(first, { requests: [{ ...first.requests[0], workspace: { id: 'Workspace', url: 'https://example.com/work' } }],
    cards: [{ ...first.cards.find(record => record.id === 'Q1'), urls: [{ label: 'Result', url: 'https://example.com/result' }] }] });
}

test('Close saves read silently and is hidden on collapsed Cards, absent in History, Decision and Blocker', async () => {
  const journal = linkedState(), ui = await view({ toolImpl: async request => ({
    structuredContent: { journal: markReadState(journal, request.arguments) },
  }) }); ui.show(journal);
  const attention = card(ui, 'attention', 'Q1'), control = attention.querySelector('.jc-read-icon');
  assert.equal(control.textContent, '');
  assert.equal(control.querySelector('svg').getAttribute('aria-hidden'), 'true');
  assert.ok(control.classList.contains('jc-close-icon'));
  assert.match(control.getAttribute('aria-label'), /^Mark as read · /);
  assert.equal(control.hasAttribute('aria-pressed'), false, 'Immediate read is an action button, not a toggle');
  assert.equal(card(ui, 'attention', 'D1').querySelector('[data-reply-kind="defer"]').getAttribute('aria-pressed'), 'false');
  assert.equal(card(ui, 'attention', 'D1').querySelector('[data-choice="A"]').getAttribute('aria-pressed'), 'false');
  const listed = card(ui, 'cards-body', 'Q1'), listedControl = listed.querySelector('.jc-read-icon');
  toggle(ui, listed, false); assert.equal(listedControl.hidden, true);
  toggle(ui, listed, true); assert.equal(listedControl.hidden, false);
  for (const id of ['D1', 'B1']) assert.ok(card(ui, 'attention', id).querySelector('.jc-read-icon') === null);
  assert.ok(q(ui, '#jc-history-cards .jc-read-icon') === null);
  control.click(); await tick();
  assert.equal(ui.sent.length, 0);
  assert.deepEqual(ui.toolCalls, [{ name: 'journal_mark_read', arguments: { conversation_id: 'C1', card_id: 'Q1', record_revision: 4 } }]);
  assert.equal(card(ui, 'attention', 'Q1'), null);
});

test('expanded card links share the footer with Comment; collapsing moves the exact same link row beneath the title', async () => {
  const journal = linkedState(), ui = await view(); ui.show(journal);
  const attention = card(ui, 'attention', 'Q1');
  assert.ok(attention.querySelector('.jc-record-summary .jc-record-refs') === null);
  const tools = attention.querySelector('.jc-card-footer .jc-card-tools');
  assert.ok(tools.querySelector('.jc-comment-toggle'));
  assert.ok(tools.querySelector('.jc-record-refs [data-request-link="R1"]'));
  assert.ok(tools.querySelector('.jc-workspace-link'));
  assert.ok(tools.querySelector('.jc-resource-link'));
  const listed = card(ui, 'cards-body', 'Q1'), refs = listed.querySelector('.jc-record-refs');
  const urls = [...refs.querySelectorAll('a')].map(node => node.href);
  refs.querySelector('.jc-links-toggle').click();
  assert.equal(refs.querySelector('.jc-link-overflow').hidden, false);
  toggle(ui, listed, false); assert.equal(refs.parentElement, listed.firstElementChild);
  toggle(ui, listed, true); assert.equal(refs.parentElement, listed.querySelector('.jc-card-tools'));
  assert.equal(listed.querySelectorAll('.jc-record-refs').length, 1);
  assert.deepEqual([...refs.querySelectorAll('a')].map(node => node.href), urls);
  assert.equal(refs.querySelector('.jc-link-overflow').hidden, false);
  const input = listed.querySelector('.jc-comment textarea'); input.value = 'Keep this draft.';
  input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  toggle(ui, listed, false); toggle(ui, listed, true);
  assert.equal(input.value, 'Keep this draft.');
  await ui.refresh(commit(journal, {}));
  assert.equal(card(ui, 'cards-body', 'Q1').querySelector('.jc-comment textarea').value, 'Keep this draft.');
  assert.equal(card(ui, 'cards-body', 'Q1').querySelector('.jc-link-overflow').hidden, false);
  assert.equal(card(ui, 'attention', 'Q1').querySelector('.jc-link-overflow').hidden, true, 'Each view keeps its own overflow state');
});

test('History link relocation preserves read-only content and historical destinations', async () => {
  const ui = await view(); ui.show(linkedState());
  const historical = card(ui, 'history-cards', 'Q1'), refs = historical.querySelector('.jc-record-refs');
  toggle(ui, historical, false); assert.equal(refs.parentElement, historical.firstElementChild);
  toggle(ui, historical, true); assert.equal(refs.parentElement, historical.querySelector('.jc-card-footer'));
  assert.ok(historical.querySelector('.jc-comment-toggle, textarea, [data-reply-kind]') === null);
  assert.equal(refs.querySelector('.jc-workspace-link').href, 'https://example.com/work');
});

test('Attention omits only redundant Open status and card Draft badges while the footer still reports unsent choices', async () => {
  const ui = await view(); ui.show(linkedState());
  for (const id of ['D1', 'B1', 'S1']) {
    assert.ok(card(ui, 'attention', id).querySelector('.jc-card-status') === null);
    assert.equal(card(ui, 'cards-body', id).querySelector('.jc-card-status').textContent, 'Open');
  }
  q(ui, '#jc-attention [data-record="D1"] [data-choice="A"]').click();
  assert.ok(q(ui, '.jc-card .jc-draft-hint') === null);
  assert.ok(q(ui, '.jc-request .jc-draft-hint') === null);
  assert.match(q(ui, '#jc-draft').textContent, /1 reply ready/);
  assert.equal(ui.sent.length, 0);
});

test('Attention preserves meaningful Waiting status and activity status after removing redundant Open', async () => {
  const first = linkedState(), ui = await view();
  ui.show(commit(first, { cards: [{ id: 'N2', request_id: 'R1', type: 'note', revision: 1, title: 'Awaiting result', body: 'Still pending', status: 'waiting' }] }));
  assert.equal(card(ui, 'attention', 'N2').querySelector('.jc-card-status').textContent, 'Waiting');
  assert.equal(q(ui, '#jc-agent-status').textContent, 'Needs your input');
});

test('empty Attention reports No action needed without claiming every card was acknowledged', async () => {
  const ui = await view(), first = previewState();
  ui.show(commit(first, { decisions: [{ ...first.decisions[0], status: 'resolved' }],
    blockers: [{ ...first.blockers[0], status: 'resolved' }], cards: first.cards.map(record => ({ ...record, status: 'resolved' })) }));
  assert.equal(q(ui, '#jc-attention .jc-empty').textContent, 'No action needed.');
  assert.ok(q(ui, '#jc-cards-body [data-record="Q1"]'));
});
