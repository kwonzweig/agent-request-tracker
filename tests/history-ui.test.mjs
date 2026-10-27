import test from 'node:test';
import assert from 'node:assert/strict';
import { view, state, commit, previewState } from './ui-harness.mjs';

const q = (ui, selector) => ui.document.querySelector(selector);
const history = ui => q(ui, '#jc-history-tab').click();
const card = (ui, id) => q(ui, '#jc-history-cards [data-record="' + id + '"]');
const request = (ui, id) => q(ui, '#jc-history-requests [data-record="' + id + '"] details');
const ids = (ui, section) => [...q(ui, section).querySelectorAll('[data-record]')].map(node => node.dataset.record).sort();
function toggle(ui, details, open) {
  // linkedom does not implement the browser's built-in summary activation.
  details.toggleAttribute('open', open); details.dispatchEvent(new ui.window.Event('toggle'));
}
function selectTurn(ui, id) {
  const select = q(ui, '#jc-turn');
  for (const option of select.children) option.toggleAttribute('selected', option.value === id);
  select.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
}

test('History shows only selected-turn changes and omits empty sections and cumulative filters', async () => {
  const ui = await view(); ui.show(previewState()); history(ui);
  assert.deepEqual(ids(ui, '#jc-history-requests'), []);
  assert.deepEqual(ids(ui, '#jc-history-cards'), ['B1', 'N1', 'Q1', 'S1']);
  assert.equal(q(ui, '#jc-history-request-filter'), null);
  assert.equal(q(ui, '#jc-history-card-filter'), null);
  assert.equal(q(ui, '#jc-history-requests').closest('section').hidden, true);
  assert.equal(q(ui, '#jc-history-cards').closest('section').hidden, false);
  assert.equal(q(ui, '#jc-history-empty').hidden, true);
  assert.equal(card(ui, 'D1'), null);
  assert.equal(card(ui, 'B1').querySelector('.jc-change').textContent, 'Created');
  assert.equal(card(ui, 'N1').querySelector('.jc-change').textContent, 'Updated');
  assert.equal(q(ui, '#jc-history [data-choice]'), null);
});

test('History arrows reconstruct changed entities at that turn without future facts or active choices', async () => {
  const ui = await view(); ui.show(previewState()); history(ui); q(ui, '#jc-prev').click();
  assert.equal(q(ui, '#jc-turn').value, 'T2');
  assert.deepEqual(ids(ui, '#jc-history-requests'), ['R2']);
  assert.deepEqual(ids(ui, '#jc-history-cards'), ['N1']);
  assert.equal(request(ui, 'R2').querySelector('.jc-change').textContent, 'Created');
  assert.doesNotMatch(card(ui, 'N1').textContent, /Source:|Record:|Revision 2/);
  assert.doesNotMatch(q(ui, '#jc-records').textContent, /FAQ|메일 연결|모바일 화면도 확인했나요/);
  q(ui, '#jc-prev').click();
  assert.deepEqual(ids(ui, '#jc-history-requests'), ['R1']);
  assert.deepEqual(ids(ui, '#jc-history-cards'), ['D1']);
  assert.equal(q(ui, '#jc-prev').disabled, true);
  assert.equal(q(ui, '#jc-history [data-choice]'), null);
  assert.equal(card(ui, 'D1').querySelector('.jc-comment, textarea, [data-reply-kind]'), null);
  q(ui, '#jc-next').click(); assert.equal(q(ui, '#jc-turn').value, 'T2');
});

test('selection uses turn identity across additional saves and later turns', async () => {
  const ui = await view(), first = state();
  const second = commit(first, { requests: [{ ...first.requests[0], status: 'waiting' }],
    decisions: [{ ...first.decisions[0], question: 'Question in selected turn' }] });
  ui.show(second); history(ui); selectTurn(ui, 'T2');
  const sameTurn = commit(second, { requests: [{ ...second.requests[0], status: 'done' }],
    turn: { summary: 'Latest save of selected turn' } }, 'T2');
  await ui.refresh(sameTurn);
  assert.equal(q(ui, '#jc-turn').value, 'T2');
  assert.deepEqual(ids(ui, '#jc-history-requests'), ['R1']);
  assert.deepEqual(ids(ui, '#jc-history-cards'), ['D1']);
  assert.equal(request(ui, 'R1').querySelector('.jc-change').textContent, 'Status: In progress → Done');
  assert.match(q(ui, '#jc-turn-body').textContent, /Latest save of selected turn/);
  const later = commit(sameTurn, { cards: [{ id: 'N1', request_id: 'R1', revision: 1, type: 'note', title: 'Future note', body: 'Future fact', status: 'resolved' }] });
  await ui.refresh(later);
  assert.equal(q(ui, '#jc-turn').value, 'T2');
  assert.doesNotMatch(q(ui, '#jc-records').textContent, /Future note|Future fact/);
});

test('receipt-only turns include affected entities and distinguish receipt arrival from acceptance', async () => {
  const ui = await view(), first = state();
  const receipt = { id: 'reply-1', source: 'user:2', items: [
    { collection: 'requests', id: 'R1', record_revision: 1, kind: 'comment', text: 'Comment on original request', outcome: 'accepted' },
    { collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', option_id: 'A', outcome: 'stale' },
  ] };
  const received = commit(first, { replies: [receipt] }); ui.show(received); history(ui);
  assert.deepEqual(ids(ui, '#jc-history-requests'), ['R1']);
  assert.deepEqual(ids(ui, '#jc-history-cards'), ['D1']);
  assert.equal(request(ui, 'R1').querySelector('.jc-change').textContent, 'Commented');
  assert.equal(card(ui, 'D1').querySelector('.jc-change').textContent, 'Answer received · Review needed');
  assert.equal(card(ui, 'D1').querySelector('summary .jc-badge.pending').textContent, 'Open');
  assert.match(q(ui, '#jc-records').textContent, /Comment on original request|User answeredReview needed/);
  assert.equal(q(ui, '#jc-records [data-choice]'), null);
  await ui.refresh(commit(received, { decisions: [{ ...first.decisions[0], revision: 2, question: 'Future question' }] }));
  q(ui, '#jc-prev').click(); assert.doesNotMatch(q(ui, '#jc-records').textContent, /Future question/);
});

test('History folds survive polling and revisiting while current drafts stay available in the live view', async () => {
  const ui = await view(), first = state(); ui.show(first); history(ui);
  const input = q(ui, '#jc-tree .jc-comment textarea');
  input.value = 'Unsent current request comment'; input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  toggle(ui, card(ui, 'D1'), false);
  assert.equal(card(ui, 'D1').querySelector('summary .jc-draft-hint'), null);
  assert.match(q(ui, '#jc-draft').textContent, /1 reply ready/);
  await ui.refresh(commit(first, { turn: { summary: 'No entity changes' } }));
  assert.deepEqual(ids(ui, '#jc-history-cards'), []);
  assert.equal(q(ui, '#jc-history-empty').hidden, false);
  q(ui, '#jc-prev').click();
  assert.equal(card(ui, 'D1').hasAttribute('open'), false);
  assert.equal(card(ui, 'D1').querySelector('textarea'), null);
  q(ui, '#jc-cards-tab').click(); history(ui);
  assert.equal(card(ui, 'D1').querySelector('summary .jc-draft-hint'), null);
  toggle(ui, card(ui, 'D1'), true);
  assert.equal(q(ui, '#jc-tree .jc-comment textarea').value, 'Unsent current request comment');
});

test('stale choices remain discoverable after an unchanged turn and old History navigation', async () => {
  const ui = await view(), first = state(); ui.show(first);
  q(ui, '#jc-attention [data-choice="A"]').click(); history(ui); toggle(ui, card(ui, 'D1'), false);
  const changed = commit(first, { decisions: [{ ...first.decisions[0], revision: 2, question: 'Changed choices' }] });
  await ui.refresh(changed); await ui.refresh(commit(changed, { turn: { summary: 'Poll with no card changes' } }));
  assert.match(q(ui, '#jc-draft').textContent, /choices changed/); assert.equal(q(ui, '#jc-send').disabled, true);
  q(ui, '#jc-prev').click(); q(ui, '#jc-prev').click();
  assert.equal(card(ui, 'D1').hasAttribute('open'), false);
  assert.equal(card(ui, 'D1').querySelector('summary .jc-draft-hint'), null);
  assert.match(q(ui, '#jc-attention .jc-warning').textContent, /Review needed/);
  q(ui, '#jc-attention-tab').click(); q(ui, '#jc-attention [data-choice="B"]').click();
  assert.equal(q(ui, '#jc-send').disabled, false);
});

test('historical blockers retain safe destination links and direct Next action without reply controls', async () => {
  const ui = await view(); ui.show(previewState()); history(ui);
  const blocker = card(ui, 'B1');
  assert.equal(blocker.querySelector('a').getAttribute('href'), 'https://example.com/');
  assert.equal(blocker.querySelector('[data-reply-kind], textarea'), null);
  assert.match(blocker.textContent, /Next action연결 페이지 열기/);
  assert.doesNotMatch(blocker.textContent, /Responsible/);
  assert.doesNotMatch(blocker.textContent, /https:\/\/example.com\//);
  assert.equal(q(ui, '#jc-cards [data-record="B1"] a').getAttribute('href'), 'https://example.com/');
});

test('History shows only replies received in its turn and preserves their original record context', async () => {
  const ui = await view(), first = state();
  const received = commit(first, {
    decisions: [{ ...first.decisions[0], revision: 2, question: 'Updated question' }],
    replies: [{ id: 'reply-1', source: 'user:2', items: [{ collection: 'decisions', id: 'D1', record_revision: 1,
      kind: 'comment', text: 'Original-version comment', outcome: 'accepted' }] }],
  });
  ui.show(received); history(ui);
  assert.equal(card(ui, 'D1').querySelector('.jc-change').textContent, 'Updated · Commented');
  assert.match(card(ui, 'D1').textContent, /On: 어디에 표시할까요\?/);
  assert.doesNotMatch(card(ui, 'D1').querySelector('.jc-user-reply').textContent, /Source:|Record:|Revision 1/);
  await ui.refresh(commit(received, { decisions: [{ ...received.decisions[0], revision: 3, question: 'Third question', status: 'answered' }] }));
  assert.equal(card(ui, 'D1').querySelector('.jc-change').textContent, 'Status: Open → ✓ Resolved');
  assert.doesNotMatch(card(ui, 'D1').textContent, /Original-version comment/);
  assert.match(q(ui, '#jc-cards [data-record="D1"]').textContent, /Original-version comment/);
  q(ui, '#jc-prev').click(); assert.match(card(ui, 'D1').textContent, /Original-version comment/);
});

test('only an exact trailing marker on the recommended option is deduplicated for presentation', async () => {
  const ui = await view(), first = state();
  first.decisions[0].options = [
    { id: 'A', label: '개인 지출 정리 (추천)', impact: '추천 문구는 별도 배지로 표시합니다.' },
    { id: 'B', label: '다른 방식 (추천)', impact: '원문을 유지합니다.' },
  ];
  ui.show(first);
  let choice = q(ui, '#jc-attention [data-choice="A"]');
  assert.equal(choice.querySelector('.jc-option-title > span').textContent, '개인 지출 정리');
  assert.equal(choice.querySelectorAll('.jc-recommendation').length, 1);
  assert.match(q(ui, '#jc-attention [data-choice="B"]').textContent, /다른 방식 \(추천\)/);
  assert.equal(first.decisions[0].options[0].label, '개인 지출 정리 (추천)');
  const english = commit(first, { decisions: [{ ...first.decisions[0], revision: 2,
    options: [{ id: 'A', label: 'Use this (Recommended)' }, { id: 'B', label: 'Recommended prose (Recommended) remains' }] }] });
  await ui.refresh(english); choice = q(ui, '#jc-attention [data-choice="A"]');
  assert.equal(choice.querySelector('.jc-option-title > span').textContent, 'Use this');
  assert.equal(choice.querySelectorAll('.jc-recommendation').length, 1);
  const prose = commit(english, { decisions: [{ ...english.decisions[0], revision: 3,
    options: [{ id: 'A', label: 'Recommended prose (Recommended) remains' }, { id: 'B', label: 'Other' }] }] });
  await ui.refresh(prose);
  assert.equal(q(ui, '#jc-attention [data-choice="A"] .jc-option-title > span').textContent, 'Recommended prose (Recommended) remains');
});
