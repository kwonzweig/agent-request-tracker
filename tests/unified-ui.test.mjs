import test from 'node:test';
import assert from 'node:assert/strict';
import { view, state, commit, markReadState, tick } from './ui-harness.mjs';

const q = (ui, selector) => ui.document.querySelector(selector);
const card = (ui, place, id) => q(ui, '#jc-' + place + ' .jc-card[data-record="' + id + '"]');
const action = (ui, place, id, kind) => card(ui, place, id).querySelector('[data-reply-kind="' + kind + '"]');
function input(ui, node, value) { node.value = value; node.dispatchEvent(new ui.window.Event('input', { bubbles: true })); }
function toggle(ui, node, open) { node.toggleAttribute('open', open); node.dispatchEvent(new ui.window.Event('toggle')); }
const receipt = (ui, outcome = 'accepted') => ({ id: ui.envelope().delivery_id, source: 'user:reply', items: ui.envelope().items.map(item => ({ ...item, outcome })) });

test('Attention, Cards and History share a header, separate links and direct content', async () => {
  const ui = await view(), first = state(); first.requests[0].workspace = { id: 'PR #1', url: 'https://example.com/pull/1' };
  ui.show(first);
  for (const place of ['attention', 'cards', 'history']) {
    const record = card(ui, place, 'D1');
    assert.equal(record.tagName, place === 'attention' ? 'ARTICLE' : 'DETAILS');
    assert.equal(record.firstElementChild.className, 'jc-record-summary');
    assert.equal(record.querySelector('.jc-title-line .jc-badge').textContent, 'Decision');
    assert.equal(record.querySelector('.jc-title-line .jc-record-title').textContent, '어디에 표시할까요?');
    assert.equal(record.querySelector('.jc-status-strip').parentElement.className, 'jc-summary-top');
    const refs = record.querySelector('.jc-record-refs');
    assert.ok(refs.parentElement === (place === 'attention' ? record.querySelector('.jc-card-tools') : record.firstElementChild));
    assert.equal(refs.querySelector('[data-request-link]').textContent, '↗ 원래 요청');
    assert.equal(refs.querySelector('.jc-workspace-link').textContent, '↗ PR #1');
    assert.equal(record.querySelector('.jc-primary').textContent, '사용할 화면을 정합니다.');
    assert.equal(record.querySelector('details'), null);
    if (place === 'history') assert.ok(record.querySelector('.jc-comment') === null);
    else assert.equal(record.querySelector('.jc-comment-editor').hidden, true);
    assert.doesNotMatch(record.textContent, /Details|Request:|Responsible|Source:|Record:|Revision 1|assistant:1|user:1/);
  }
  assert.ok(action(ui, 'attention', 'D1', 'defer'));
  assert.equal(action(ui, 'cards', 'D1', 'resolve'), null);
  assert.equal(card(ui, 'history', 'D1').querySelector('[data-reply-kind], [data-choice], textarea'), null);
  assert.equal(card(ui, 'attention', 'D1').lastElementChild.lastElementChild.className, 'jc-card-footer');
});

test('terminal cards leave Attention while supplied QA stays expanded until resolution', async () => {
  const ui = await view(), first = state();
  const journal = commit(first, {
    decisions: [{ ...first.decisions[0], required: false, status: 'answered', resolution: { actor: 'agent', source: 'assistant:2', note: 'Applied the stated default', option_id: 'A' } }],
    blockers: [{ id: 'B1', request_id: 'R1', title: 'Resolved blocker', status: 'resolved', owner: 'agent', evidence: 'Dependency recovered', next_action: 'Continue' }],
    cards: [
      { id: 'N1', request_id: 'R1', revision: 1, type: 'note', title: 'Resolved note', body: 'Read this once', status: 'resolved', source: 'assistant:2' },
      { id: 'Q1', request_id: 'R1', revision: 1, type: 'qa', title: 'Supplied answer', body: 'Answer supplied', status: 'answered', source: 'assistant:2', nudge: { text: 'Check the result', priority: 'high' } },
      { id: 'S1', request_id: 'R1', revision: 1, type: 'suggestion', title: 'Superseded suggestion', body: 'Older proposal', status: 'superseded', source: 'assistant:2' },
      { id: 'N2', request_id: 'R1', revision: 1, type: 'note', title: 'Obsolete note', body: 'Old context', status: 'dismissed', source: 'assistant:2' },
    ],
  });
  ui.show(journal); await ui.refresh(commit(journal, { turn: { summary: 'Later unrelated turn' } }));
  assert.equal(q(ui, '#jc-count').textContent, '1');
  for (const id of ['D1', 'B1', 'N1', 'S1', 'N2']) {
    assert.equal(card(ui, 'attention', id), null);
    assert.equal(card(ui, 'cards', id).hasAttribute('open'), false);
  }
  const qa = card(ui, 'attention', 'Q1');
  assert.equal(qa.tagName, 'ARTICLE');
  assert.ok(qa.querySelector('summary') === null);
  assert.equal(qa.querySelector('.jc-card-status'), null);
  assert.ok(action(ui, 'attention', 'Q1', 'resolve').querySelector('svg'));
  assert.equal(qa.querySelector('[aria-label="High priority"]').className, 'jc-reminder');
  assert.equal(qa.querySelector('.jc-nudge').textContent, 'Check the result');
  assert.match(card(ui, 'cards', 'D1').textContent, /Agent · OutcomeApplied the stated default/);
  assert.equal(card(ui, 'cards', 'D1').querySelector('.jc-card-status').textContent, '✓ Resolved');
  assert.equal(card(ui, 'cards', 'D1').querySelector('.jc-card-status').classList.contains('resolved'), true);
  assert.equal(journal.decisions[0].status, 'answered');
  assert.doesNotMatch(card(ui, 'cards', 'D1').querySelector('.jc-status-strip').textContent, /User|Agent/);
  assert.equal(card(ui, 'cards', 'N2').querySelector('.jc-card-status').classList.contains('neutral'), true);
});

test('Later stages a version-bound draft and leaves Attention only after the recorded outcome', async () => {
  const ui = await view(), first = state(); ui.show(first);
  input(ui, q(ui, '#jc-tree .jc-comment textarea'), 'Keep this request comment');
  action(ui, 'attention', 'D1', 'defer').click();
  assert.equal(action(ui, 'cards', 'D1', 'defer').getAttribute('aria-pressed'), 'true');
  assert.ok(card(ui, 'attention', 'D1').querySelector('.jc-card-status') === null);
  assert.equal(ui.sent.length, 0); assert.match(q(ui, '#jc-draft').textContent, /2 replies ready/);
  q(ui, '#jc-send').click(); await tick();
  assert.ok(ui.envelope().items.some(item => item.kind === 'defer' && item.record_revision === 1));
  assert.ok(ui.envelope().items.some(item => item.kind === 'comment' && item.text === 'Keep this request comment'));
  toggle(ui, card(ui, 'cards', 'D1'), false);
  const later = commit(first, { decisions: [{ ...first.decisions[0], attention: { state: 'later', actor: 'user', source: 'user:reply', reason: 'Review tomorrow' } }], replies: [receipt(ui)] });
  await ui.refresh(later);
  assert.equal(card(ui, 'attention', 'D1'), null);
  assert.equal(card(ui, 'cards', 'D1').hasAttribute('open'), false);
  assert.equal(card(ui, 'cards', 'D1').querySelector('.jc-card-status').textContent, 'Later');
  assert.equal(card(ui, 'cards', 'D1').querySelectorAll('.jc-card-status').length, 1);
  const returned = commit(later, { decisions: [{ ...later.decisions[0], attention: { state: 'pending', actor: 'agent', source: 'assistant:3', reason: 'Dependency needs this choice' } }] });
  await ui.refresh(returned);
  assert.equal(card(ui, 'attention', 'D1').tagName, 'ARTICLE');
  assert.equal(card(ui, 'cards', 'D1').hasAttribute('open'), false);
});

test('a Comment reports a blocker step without pretending verification and resolved QA has no active action', async () => {
  let saved;
  const ui = await view({ toolImpl: async (request, reply) => {
    if (request.name !== 'journal_mark_read') return reply;
    saved = markReadState(reply.structuredContent.journal, request.arguments);
    return { structuredContent: { journal: saved } };
  } }), first = state();
  const journal = commit(first, { blockers: [{ id: 'B1', request_id: 'R1', title: 'Reconnect', evidence: 'Connection failed', next_action: 'Connect the account', status: 'open', owner: 'user' }],
    cards: [{ id: 'Q1', request_id: 'R1', revision: 1, type: 'qa', title: 'Supplied answer', body: 'Explanation', status: 'answered' }] });
  ui.show(journal);
  assert.equal(action(ui, 'attention', 'B1', 'resolve'), null);
  input(ui, card(ui, 'attention', 'B1').querySelector('textarea'), 'I logged in.');
  assert.equal(ui.sent.length, 0); assert.ok(card(ui, 'attention', 'B1').querySelector('.jc-card-status') === null);
  assert.equal(card(ui, 'cards', 'B1').querySelector('textarea').value, 'I logged in.');
  q(ui, '#jc-send').click(); await tick();
  assert.deepEqual(ui.envelope().items, [{ collection: 'blockers', id: 'B1', record_revision: 2, kind: 'comment', text: 'I logged in.' }]);
  const observed = commit(journal, { replies: [receipt(ui)], blockers: [{ ...journal.blockers[0], evidence: 'Recheck still failed' }] });
  await ui.refresh(observed);
  assert.ok(card(ui, 'attention', 'B1'));
  action(ui, 'attention', 'Q1', 'resolve').click(); await tick();
  assert.equal(ui.sent.length, 1, 'Only the explicit blocker Comment sent a chat message');
  assert.deepEqual(ui.toolCalls.filter(call => call.name === 'journal_mark_read'), [{ name: 'journal_mark_read',
    arguments: { conversation_id: 'C1', card_id: 'Q1', record_revision: 2 } }]);
  assert.deepEqual(saved.turn, observed.turn); assert.deepEqual(saved.replies, observed.replies);
  assert.equal(card(ui, 'attention', 'Q1'), null);
  assert.equal(card(ui, 'cards', 'Q1').querySelector('.jc-card-status').textContent, '✓ Resolved');
  assert.equal(action(ui, 'cards', 'Q1', 'resolve'), null);
  assert.equal(card(ui, 'history', 'Q1').querySelector('textarea, [data-reply-kind]'), null);
  assert.match(card(ui, 'history', 'Q1').textContent, /User marked as read/);
  for (const place of ['cards', 'history']) {
    assert.doesNotMatch(card(ui, place, 'Q1').textContent, /User · Outcome|Marked as read in Request Tracker\./,
      'The exact direct-read marker uses one attribution instead of repeating its fixed save note');
  }
  assert.equal([...card(ui, 'cards', 'Q1').querySelectorAll('.jc-user-reply')].filter(row => row.textContent === 'User marked as read').length, 1);
  const cosmetic = commit(saved, { cards: [{ ...saved.cards[0], urls: [{ label: 'Result', url: 'https://example.com/result' }] }] });
  await ui.refresh(cosmetic);
  assert.match(card(ui, 'cards', 'Q1').textContent, /User marked as read/);
  assert.doesNotMatch(card(ui, 'history', 'Q1').textContent, /User marked as read/, 'A later link edit is not another user read action');
  const manual = commit(cosmetic, { cards: [{ ...cosmetic.cards[0], resolution: {
    actor: 'user', source: 'user:manual', note: 'Keep this separately recorded outcome.',
  } }] });
  await ui.refresh(manual);
  for (const place of ['cards', 'history']) {
    assert.match(card(ui, place, 'Q1').textContent, /User · OutcomeKeep this separately recorded outcome\./);
    assert.doesNotMatch(card(ui, place, 'Q1').textContent, /User marked as read/);
  }
});

test('blocker Alternatives show choices and Other with a separate collapsed Comment and preserve the answer draft', async () => {
  const ui = await view(), first = state();
  const journal = commit(first, { blockers: [{ id: 'B1', request_id: 'R1', revision: 1, title: 'Choose a recovery', evidence: 'The account is unavailable', next_action: 'Reconnect', status: 'open', owner: 'user',
    options: [{ id: 'retry', label: 'Retry the connection' }, { id: 'file', label: 'Use the supplied file', impact: 'The user supplies the file' }], recommendation: 'retry' }] });
  ui.show(journal);
  const blocker = card(ui, 'attention', 'B1');
  assert.equal(blocker.querySelector('.jc-comment-editor').hidden, true);
  assert.deepEqual([...blocker.querySelectorAll('.jc-actions button')].map(node => node.textContent), ['Later']);
  assert.equal(blocker.querySelector('.jc-field-label').textContent, 'Alternatives');
  assert.equal(blocker.querySelectorAll('[data-choice]').length, 3);
  blocker.querySelector('[data-choice="other"]').click();
  input(ui, card(ui, 'attention', 'B1').querySelector('textarea'), 'Use this approved input source');
  toggle(ui, card(ui, 'cards', 'B1'), false);
  await ui.refresh(commit(journal, { turn: { summary: 'Unchanged blocker' } }));
  assert.equal(card(ui, 'attention', 'B1').hasAttribute('open'), false);
  assert.equal(card(ui, 'attention', 'B1').tagName, 'ARTICLE');
  assert.ok(card(ui, 'attention', 'B1').querySelector('summary') === null);
  assert.equal(card(ui, 'cards', 'B1').hasAttribute('open'), false);
  assert.equal(card(ui, 'cards', 'B1').querySelector('textarea').value, 'Use this approved input source');
  assert.equal(card(ui, 'cards', 'B1').querySelector('.jc-comment-editor').hidden, true);
  q(ui, '#jc-send').click(); await tick();
  assert.deepEqual(ui.envelope().items, [{ collection: 'blockers', id: 'B1', record_revision: 2, kind: 'answer', text: 'Use this approved input source' }]);
});

test('two outline links and expandable overflow retain inherited historical destinations without raw URLs', async () => {
  const ui = await view(), first = state();
  const oldUrl = 'https://example.com/work/1', newUrl = 'https://example.com/work/2', extraUrl = 'https://docs.example.com/guide';
  const second = commit(first, {
    requests: [{ ...first.requests[0], workspace: { id: 'Old workspace', url: oldUrl } }, { id: 'R2', parent_id: 'R1', title: 'Child request', status: 'active', source: 'user:2' }],
    blockers: [{ id: 'B1', request_id: 'R2', title: 'Linked blocker', status: 'open', owner: 'user', next_action: 'Open setup',
      evidence: 'Setup lives at ' + oldUrl + '. Reference ' + extraUrl + '.', action_url: extraUrl,
      urls: [{ label: 'Workspace duplicate', url: oldUrl }, { label: 'Setup guide', url: extraUrl }, { label: 'Troubleshooting', url: 'https://docs.example.com/troubleshoot' }] }],
  });
  const third = commit(second, { requests: [{ ...second.requests[0], workspace: { id: 'New workspace', url: newUrl } }] });
  ui.show(third); q(ui, '#jc-history-tab').click(); q(ui, '#jc-prev').click();
  const historical = card(ui, 'history', 'B1');
  assert.equal(historical.querySelector('.jc-workspace-link').getAttribute('href'), oldUrl);
  assert.equal(card(ui, 'cards', 'B1').querySelector('.jc-workspace-link').getAttribute('href'), newUrl);
  const refs = historical.querySelector('.jc-record-refs');
  assert.equal([...refs.children].filter(node => node.classList.contains('jc-link')).length, 2);
  assert.equal(refs.querySelector('.jc-link-overflow').hidden, true);
  let summaryClicks = 0; historical.firstElementChild.addEventListener('click', () => summaryClicks++);
  refs.querySelector('.jc-links-toggle').click();
  assert.equal(refs.querySelector('.jc-link-overflow').hidden, false);
  assert.equal(summaryClicks, 0);
  q(ui, '#jc-cards-tab').click(); q(ui, '#jc-history-tab').click();
  assert.equal(card(ui, 'history', 'B1').querySelector('.jc-link-overflow').hidden, false);
  assert.equal(historical.querySelectorAll('.jc-resource-link').length, 2);
  assert.match(historical.textContent, /Setup guide|Next actionOpen setup/);
  assert.doesNotMatch(historical.textContent, /https?:\/\/|Responsible|Source:|Record:|Details/);
});

test('Request expansion exposes boxed completion bullets, Comment and links directly', async () => {
  const ui = await view(), first = state(); first.requests[0].done_when = '- Output works\n- Small screens fit';
  first.requests[0].evidence = 'Checked behavior. Guide https://docs.example.com/guide';
  first.requests[0].urls = [{ label: 'Guide', url: 'https://docs.example.com/guide' }];
  ui.show(first); q(ui, '#jc-requests-tab').click();
  const request = q(ui, '#jc-tree .jc-request[data-record="R1"] > details');
  assert.deepEqual([...request.querySelectorAll('.jc-done-when li')].map(node => node.textContent), ['Output works', 'Small screens fit']);
  assert.equal(request.querySelector('.jc-comment textarea').closest('details'), request);
  assert.equal(request.querySelector('.jc-done-when').closest('.jc-content-box').classList.contains('jc-primary'), true);
  assert.equal(request.querySelector('details'), null);
  assert.equal(request.querySelector('.jc-record-refs a').textContent, '↗ Guide');
  assert.match(request.querySelector('.jc-request-body').textContent, /EvidenceChecked behavior.|Background원래 범위/);
  assert.doesNotMatch(request.textContent, /https?:\/\/|Source:|Record:|Revision 1|Details/);
});

test('reopened reminders do not repeat identical primary or context prose', async () => {
  const ui = await view(), first = state();
  const reason = 'Connection is required to start this work.';
  const journal = commit(first, { blockers: [{ id: 'B1', request_id: 'R1', title: 'Reconnect', evidence: 'The account expired.', next_action: 'Connect the account', status: 'open', owner: 'user',
    attention: { state: 'pending', actor: 'agent', source: 'assistant:2', reason }, nudge: { text: reason, priority: 'high' } }] });
  ui.show(journal);
  for (const place of ['attention', 'cards', 'history']) {
    const record = card(ui, place, 'B1');
    assert.equal(record.textContent.split(reason).length - 1, 1);
    assert.equal(record.querySelector('.jc-detail-field').textContent, 'Next actionConnect the account');
  }
  await ui.refresh(commit(journal, { blockers: [{ ...journal.blockers[0], evidence: reason }] }));
  assert.equal(card(ui, 'attention', 'B1').textContent.split(reason).length - 1, 1);
  assert.equal(card(ui, 'attention', 'B1').querySelector('.jc-nudge'), null);
});

test('status families stay distinct and QA omits Open and Answered', async () => {
  const ui = await view(), first = state();
  const journal = commit(first, { cards: ['open', 'waiting', 'answered', 'resolved', 'done'].map((status, i) =>
    ({ id: 'N' + i, request_id: 'R1', revision: 1, type: 'note', title: status, body: 'Status detail', status, source: 'assistant:2' })).concat(
      ['open', 'answered', 'resolved'].map((status, i) => ({ id: 'Q' + i, request_id: 'R1', revision: 1, type: 'qa', title: status, body: 'QA', status }))) });
  ui.show(journal);
  const expected = [['Open', 'pending'], ['Waiting', 'waiting'], ['Answered', 'answered'], ['✓ Resolved', 'resolved'], ['✓ Done', 'done']];
  for (let i = 0; i < expected.length; i++) {
    const status = card(ui, 'cards', 'N' + i).querySelector('.jc-card-status');
    assert.equal(status.textContent, expected[i][0]); assert.equal(status.classList.contains(expected[i][1]), true);
  }
  assert.equal(card(ui, 'cards', 'Q0').querySelector('.jc-card-status'), null);
  assert.equal(card(ui, 'cards', 'Q1').querySelector('.jc-card-status'), null);
  assert.equal(card(ui, 'cards', 'Q2').querySelector('.jc-card-status').textContent, '✓ Resolved');
  const resolved = commit(journal, { cards: [{ ...journal.cards.find(record => record.id === 'Q2'), attention: { state: 'later', actor: 'user', source: 'user:3' } }] });
  await ui.refresh(resolved);
  assert.equal(card(ui, 'cards', 'Q2').querySelector('.jc-card-status').textContent, '✓ Resolved');
  assert.equal(q(ui, '#jc-tree .jc-badge.jc-request-status').textContent, 'In progress');
  assert.equal(q(ui, '#jc-attention [data-choice="A"] .jc-recommendation').classList.contains('jc-badge'), false);
  assert.doesNotMatch(q(ui, '#rjc').textContent, /Acknowledge|Got it|Check again|Bypass/);
});

test('answered Suggestions display the same resolved outcome in Cards and History without changing the saved status', async () => {
  const ui = await view(), first = state();
  const suggestion = { id: 'S1', request_id: 'R1', revision: 1, type: 'suggestion', title: 'Applied proposal', body: 'The proposal was selected.', status: 'open',
    options: [{ id: 'A', label: 'Apply it' }] };
  const proposed = commit(first, { cards: [suggestion] });
  const accepted = commit(proposed, { cards: [{ ...suggestion, status: 'answered', user_answer: { revision: 1, option_id: 'A', source: 'user:3' } }] });
  ui.show(accepted);
  for (const place of ['cards', 'history']) {
    const status = card(ui, place, 'S1').querySelector('.jc-card-status');
    assert.equal(status.textContent, '✓ Resolved');
    assert.equal(status.classList.contains('resolved'), true);
  }
  assert.equal(card(ui, 'history', 'S1').querySelector('.jc-change').textContent, 'Status: Open → ✓ Resolved · Answer received');
  assert.equal(accepted.cards[0].status, 'answered');
  assert.equal(accepted.cards[0].user_answer.source, 'user:3');
});

test('an older stale answer receipt cannot hide the current direct User answer in Cards or History', async () => {
  const ui = await view(), first = state();
  const stale = commit(first, { replies: [{ id: 'old-answer', source: 'user:2', items: [{ collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', option_id: 'A', outcome: 'stale' }] }] });
  const direct = commit(stale, { decisions: [{ ...first.decisions[0], revision: 2, status: 'answered', user_answer: { revision: 2, option_id: 'B', source: 'user:3' } }] });
  ui.show(direct);
  for (const place of ['cards', 'history']) {
    const replies = [...card(ui, place, 'D1').querySelectorAll('.jc-user-reply')].map(node => node.textContent);
    assert.ok(replies.some(value => value === 'User answered별도 화면'));
  }
  assert.match(card(ui, 'cards', 'D1').textContent, /User answeredReview needed채팅 카드/);
  assert.doesNotMatch(card(ui, 'history', 'D1').textContent, /Review needed채팅 카드/);
  q(ui, '#jc-history-tab').click(); q(ui, '#jc-prev').click();
  assert.match(card(ui, 'history', 'D1').textContent, /User answeredReview needed채팅 카드/);
  assert.doesNotMatch(card(ui, 'history', 'D1').textContent, /User answered별도 화면/);
});

test('matching accepted answer source, version and content displays its receipt once', async () => {
  const ui = await view(), first = state();
  const received = commit(first, { decisions: [{ ...first.decisions[0], status: 'answered', user_answer: { revision: 1, option_id: 'B', source: 'user:2' } }],
    replies: [{ id: 'current-answer', source: 'user:2', items: [{ collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', option_id: 'B', outcome: 'accepted' }] }] });
  ui.show(received);
  for (const place of ['cards', 'history']) {
    assert.equal(card(ui, place, 'D1').querySelectorAll('.jc-user-reply').length, 1);
    assert.equal(card(ui, place, 'D1').querySelector('.jc-user-reply').textContent, 'User answered별도 화면');
  }
});

test('legacy acknowledgment on an open Blocker stays acknowledgment without implying verified resolution', async () => {
  const ui = await view(), first = state();
  const blocked = commit(first, { blockers: [{ id: 'B1', request_id: 'R1', title: 'Reconnect', evidence: 'Connection failed', next_action: 'Connect the account', status: 'open', owner: 'user' }] });
  const acknowledged = commit(blocked, { replies: [{ id: 'legacy-ack', source: 'user:3', items: [{ collection: 'blockers', id: 'B1', record_revision: 2, kind: 'acknowledge', outcome: 'accepted' }] }] });
  ui.show(acknowledged);
  for (const place of ['cards', 'history']) {
    const record = card(ui, place, 'B1');
    assert.equal(record.querySelector('.jc-card-status').textContent, 'Open');
    assert.equal(record.querySelector('.jc-user-reply').textContent, 'User acknowledged');
    assert.doesNotMatch(record.querySelector('.jc-user-reply').textContent, /Resolved/);
  }
  assert.equal(card(ui, 'history', 'B1').querySelector('.jc-change').textContent, 'Acknowledgment received');
});
