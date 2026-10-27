import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIMessageParamsSchema } from '@openai/mcp-extensions/app';
import { view, state, commit, previewState, memoryStorage, tick } from './ui-harness.mjs';

const q = (ui, selector) => ui.document.querySelector(selector);
const choose = (ui, option = 'A') => q(ui, `#jc-attention [data-choice="${option}"][data-record="D1"]`).click();
const input = (ui, selector, value) => { const field = q(ui, selector); field.value = value; field.dispatchEvent(new ui.window.Event('input', { bubbles: true })); };
async function send(ui) { q(ui, '#jc-send').click(); await tick(); }

test('approved tabs, English type/state badges, host theme, meaningful details and old optional collections', async () => {
  const ui = await view({ hostContext: { theme: 'dark', styles: { variables: { '--color-text-primary': '#eee' } } } });
  const first = state(); first.requests[0].title = '<img src=x onerror=attack()>원래 요청';
  delete first.cards; delete first.replies;
  ui.show(first);
  assert.equal(ui.document.documentElement.lang, 'en');
  assert.equal(q(ui, '#jc-attention-tab').getAttribute('aria-selected'), 'true');
  assert.equal(q(ui, '#jc-agent-status').textContent, 'Needs your input');
  assert.equal(q(ui, '#jc-goal-status').textContent, 'In progress');
  assert.match(q(ui, '#jc-tree').textContent, /원래 요청/);
  assert.equal(ui.document.querySelectorAll('img').length, 0);
  assert.equal(q(ui, '#connection').hidden, true);
  assert.equal(q(ui, '#jc-draft').textContent, '');
  assert.equal(q(ui, '#jc-attention .jc-badge.decision').textContent, 'Decision');
  assert.equal(q(ui, '#jc-attention .jc-card details'), null);
  assert.match(q(ui, '#jc-attention .jc-record-body').textContent, /사용할 화면을 정합니다.|Without answer/);
  assert.doesNotMatch(q(ui, '#jc-attention').textContent, /Source:|Record:|Revision 1/);
  assert.deepEqual(ui.themes, ['dark']); ui.theme({ theme: 'light' }); assert.deepEqual(ui.themes, ['dark', 'light']);
  assert.equal(ui.styles.length, 1);
});

test('the header keeps the goal and excludes duplicate response and diagnostic status labels', async () => {
  const ui = await view(), first = previewState(); ui.show(first);
  const checkHeader = () => {
    const goal = q(ui, '#jc-goal-title');
    assert.equal(goal.textContent, '원래 요청');
    assert.equal(goal.closest('[hidden]'), null);
    for (const id of ['jc-response', 'jc-goal-status', 'jc-agent-status']) {
      const diagnostic = q(ui, '#' + id), hidden = diagnostic.closest('[hidden]');
      assert.ok(hidden, id + ' must stay out of the visible header');
      assert.equal(hidden.getAttribute('aria-hidden'), 'true');
    }
  };
  checkHeader();
  await ui.refresh(commit(first, { turn: { summary: 'The latest response belongs in History.' } }));
  checkHeader();
  assert.match(q(ui, '#jc-turn-body').textContent, /The latest response belongs in History\./);
});

test('selecting stays unsent; one batch sends human summary plus version-bound JSON to active conversation', async () => {
  const ui = await view(); ui.show(previewState()); choose(ui);
  input(ui, '#jc-attention [data-record="B1"] textarea', '연결을 확인했습니다.');
  assert.equal(ui.sent.length, 0);
  await send(ui); await send(ui);
  assert.equal(ui.sent.length, 1); assert.equal(ui.sent[0].role, 'user');
  assert.doesNotThrow(() => OpenAIMessageParamsSchema.parse(ui.sent[0]));
  assert.equal(ui.sent[0]._meta['openai/message'].target, 'active');
  assert.match(ui.sent[0].content[0].text, /### 어디에 표시할까요\?\nAnswer: 채팅 카드/);
  assert.doesNotMatch(ui.sent[0].content[0].text, /D1|B1|record_revision/);
  const envelope = ui.envelope();
  assert.equal(envelope.conversation_id, 'C1'); assert.equal(envelope.items.length, 2);
  assert.deepEqual(envelope.items[0], { collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', option_id: 'A' });
  assert.equal(envelope.items[1].kind, 'comment'); assert.equal(envelope.items[1].record_revision, 3);
  assert.match(q(ui, '#jc-attention').textContent, /어디에表示|어디에 표시/);
  assert.equal(q(ui, '#jc-send').disabled, true);
});

test('Other cannot be empty and its text survives options, tabs, polling and reopening', async () => {
  const storage = memoryStorage(), ui = await view({ storage }); ui.show(state()); choose(ui, 'other');
  assert.equal(q(ui, '#jc-send').disabled, true);
  assert.match(q(ui, '#jc-draft').textContent, /Enter your answer under Other/);
  assert.equal(q(ui, '#jc-attention textarea').getAttribute('placeholder'), null);
  input(ui, '#jc-attention textarea', '내가 정한 방식'); choose(ui, 'A'); choose(ui, 'other');
  assert.equal(q(ui, '#jc-attention textarea').value, '내가 정한 방식');
  q(ui, '#jc-requests-tab').click(); q(ui, '#jc-attention-tab').click();
  await ui.refresh(commit(state(), { turn: { summary: '선택지는 그대로입니다.' } }));
  assert.equal(q(ui, '#jc-attention textarea').value, '내가 정한 방식');
  const reopened = await view({ storage }); reopened.show(commit(state(), { turn: { summary: '다시 열기' } }));
  assert.equal(q(reopened, '#jc-attention textarea').value, '내가 정한 방식');
  await send(reopened); assert.equal(reopened.envelope().items[0].text, '내가 정한 방식');
});

test('fresh read changes choice: visibly stale, entire batch blocked until explicit current choice review', async () => {
  const ui = await view(), first = previewState(); ui.show(first); choose(ui);
  input(ui, '#jc-attention [data-record="B1"] textarea', '댓글은 유지');
  const changed = commit(first, { decisions: [{ ...first.decisions[0], revision: 2, question: '새 표시 위치를 선택해 주세요.' }] });
  ui.setRead(changed); await send(ui);
  assert.equal(ui.sent.length, 0); assert.match(q(ui, '#jc-attention').textContent, /Review needed/);
  assert.equal(q(ui, '#jc-send').disabled, true);
  choose(ui, 'B'); await send(ui);
  assert.equal(ui.envelope().items.length, 2); assert.equal(ui.envelope().items[0].kind, 'comment');
  assert.equal(ui.envelope().items[1].record_revision, 4);
});

test('lost send acknowledgement stays locked across reopen and payload is frozen despite edits', async () => {
  const storage = memoryStorage(), ui = await view({ storage, sendImpl: async () => { throw new Error('lost acknowledgement'); } });
  ui.show(previewState()); input(ui, '#jc-attention [data-record="B1"] textarea', '처음 댓글'); choose(ui);
  await send(ui); const envelope = ui.envelope();
  input(ui, '#jc-attention [data-record="B1"] textarea', '나중에 편집한 댓글');
  const persisted = JSON.parse(storage.getItem('request-journal:replies:v1:C1:delivery'));
  assert.deepEqual(persisted.items, envelope.items);
  const reopened = await view({ storage }); reopened.show(previewState());
  await send(reopened); assert.equal(reopened.sent.length, 0);
  assert.equal(q(reopened, '#jc-send').disabled, true); assert.match(q(reopened, '#jc-draft').textContent, /Delivery is unconfirmed/);
  assert.equal(q(reopened, '#jc-attention [data-record="B1"] textarea').value, '나중에 편집한 댓글');
});

test('exact committed receipt clears matching drafts while preserving newer edits', async () => {
  const ui = await view(), journal = previewState(); ui.show(journal);
  choose(ui); input(ui, '#jc-attention [data-record="B1"] textarea', '보낸 댓글'); await send(ui);
  const envelope = ui.envelope(); input(ui, '#jc-attention [data-record="B1"] textarea', '새 댓글');
  const received = commit(journal, { replies: [{ id: envelope.delivery_id, source: 'user:4', items: envelope.items.map(item => ({ ...item, outcome: 'accepted' })) }],
    decisions: [{ ...journal.decisions[0], status: 'answered', user_answer: { revision: 1, option_id: 'A', source: 'user:4' } }] });
  await ui.refresh(received);
  assert.equal(q(ui, '#jc-attention [data-record="D1"]'), null);
  assert.equal(q(ui, '#jc-attention [data-record="B1"] textarea').value, '새 댓글');
  assert.equal(q(ui, '#jc-send').disabled, false);
  q(ui, '#jc-history-tab').click(); assert.match(q(ui, '#jc-records').textContent, /보낸 댓글/);
  await send(ui); assert.equal(ui.envelope().items.length, 1); assert.equal(ui.envelope().items[0].text, '새 댓글');
});

test('stale receipt releases delivery but retains review-needed choice and accepted comment history', async () => {
  const ui = await view(), journal = previewState(); ui.show(journal); choose(ui);
  input(ui, '#jc-attention [data-record="B1"] textarea', '보존할 댓글'); await send(ui); const envelope = ui.envelope();
  const raced = commit(journal, { decisions: [{ ...journal.decisions[0], revision: 2, question: '바뀐 질문을 확인해 주세요.' }] });
  const received = commit(raced, { replies: [{ id: envelope.delivery_id, source: 'user:5', items: envelope.items.map(item => ({ ...item, outcome: item.kind === 'answer' ? 'stale' : 'accepted' })) }] });
  await ui.refresh(received);
  assert.match(q(ui, '#jc-draft').textContent, /choices changed/); assert.equal(q(ui, '#jc-send').disabled, true);
  assert.equal(q(ui, '#jc-attention [data-record="B1"] textarea').value, '');
  q(ui, '#jc-history-tab').click(); assert.match(q(ui, '#jc-records').textContent, /보존할 댓글/);
  q(ui, '#jc-attention-tab').click(); choose(ui, 'B'); assert.equal(q(ui, '#jc-send').disabled, false);
});

test('receipt mismatch never releases an uncertain delivery', async () => {
  const ui = await view(), journal = state(); ui.show(journal); choose(ui); await send(ui); const envelope = ui.envelope();
  await ui.refresh(commit(journal, { replies: [{ id: envelope.delivery_id, source: 'user:2', items: [{ ...envelope.items[0], option_id: 'B', outcome: 'accepted' }] }] }));
  assert.equal(q(ui, '#jc-send').disabled, true); assert.match(q(ui, '#jc-draft').textContent, /saved reply differs/);
});

test('historical values are read-only without active choices or comment controls', async () => {
  const ui = await view(), first = state();
  const changed = commit(first, { requests: [{ ...first.requests[0], title: '바뀐 요청' }],
    decisions: [{ ...first.decisions[0], revision: 2, question: '바뀐 질문' }] });
  ui.show(changed); q(ui, '#jc-history-tab').click(); q(ui, '#jc-prev').click();
  assert.match(q(ui, '#jc-records').textContent, /원래 요청/); assert.doesNotMatch(q(ui, '#jc-records').textContent, /바뀐 요청|바뀐 질문/);
  assert.equal(q(ui, '#jc-records [data-choice]'), null);
  assert.equal(q(ui, '#jc-records textarea, #jc-records [data-reply-kind]'), null);
  assert.equal(ui.sent.length, 0);
});

test('disabled storage and unsupported message host are truthful and prevent unsafe sends', async () => {
  const ui = await view({ storage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } });
  ui.show(state()); choose(ui); assert.equal(q(ui, '#jc-storage').hidden, false); assert.match(q(ui, '#jc-storage').textContent, /lost when you close/);
  await send(ui); assert.equal(ui.sent.length, 0);
  const unsupported = await view({ canSend: false }); unsupported.show(state()); choose(unsupported);
  assert.equal(q(unsupported, '#jc-send').disabled, true); assert.match(q(unsupported, '#jc-draft').textContent, /host cannot send replies/);
});

test('failed refresh prevents sending; polling rejects older revisions and cross-conversation data', async () => {
  const ui = await view(), first = state(); ui.show(first);
  const changed = commit(first, { requests: [{ ...first.requests[0], title: '바뀐 요청' }] }); await ui.refresh(changed);
  await ui.refresh(first); assert.match(q(ui, '#jc-tree').textContent, /바뀐 요청/);
  await ui.refresh({ ...changed, conversation_id: 'OTHER' }); assert.match(q(ui, '#connection').textContent, /different conversation/);
  choose(ui); ui.setRead(first); await send(ui); assert.equal(ui.sent.length, 0);
});

test('Agent Working requires current observed execution evidence; Goal completion stays independent', async () => {
  const ui = await view(); const journal = state(); journal.decisions = [];
  ui.show(journal); assert.equal(q(ui, '#jc-agent-status').textContent, 'Unknown');
  await ui.refresh(commit(journal, { turn: { continuing_run: { id: 'run', status: 'running', observed_turn_id: 'T2', request_ids: ['R1'] } } }));
  assert.equal(q(ui, '#jc-agent-status').textContent, 'Unknown');
  const unscoped = commit(journal, { turn: { continuing_run: { id: 'run', status: 'running', evidence: 'runtime:1', observed_turn_id: 'T2' } } });
  await ui.refresh(unscoped); assert.equal(q(ui, '#jc-agent-status').textContent, 'Unknown');
  const observed = commit(unscoped, { turn: { continuing_run: { id: 'run', status: 'running', evidence: 'runtime:1', observed_turn_id: 'T3', request_ids: ['R1'] } } });
  await ui.refresh(observed); assert.equal(q(ui, '#jc-agent-status').textContent, 'Working');
  await ui.refresh(commit(observed, { turn: { end_reason: 'answer_delivered' } }));
  assert.equal(q(ui, '#jc-goal-status').textContent, 'In progress'); assert.equal(q(ui, '#jc-agent-status').textContent, 'Work remains');
});

test('Agent Done requires completed authorized work, not just a finished response', async () => {
  const journal = state(); journal.decisions = [];
  const ui = await view();
  const finished = commit(journal, { requests: [{ ...journal.requests[0], status: 'done', evidence: 'verified:result' }], turn: { end_reason: 'complete' } });
  ui.show(finished);
  assert.equal(q(ui, '#jc-agent-status').textContent, 'Done');
  assert.match(q(ui, '#jc-agent-status').className, /done/);
  const unfinished = commit(finished, { requests: [{ ...journal.requests[0], status: 'active' }], turn: { end_reason: 'complete' } });
  await ui.refresh(unfinished);
  assert.equal(q(ui, '#jc-agent-status').textContent, 'Work remains');
  assert.match(q(ui, '#jc-agent-status').className, /blocked/);
  const hiddenChoice = commit(unfinished, { requests: [{ ...journal.requests[0], status: 'done', evidence: 'verified:result' }],
    decisions: [{ ...state().decisions[0], required: true, status: 'dismissed', dismissal: { actor: 'agent', reason: 'No longer displayed', source: 'agent:1' } }],
    turn: { end_reason: 'complete' } });
  await ui.refresh(hiddenChoice);
  assert.equal(q(ui, '#jc-agent-status').textContent, 'Work remains');
  await ui.refresh(commit(hiddenChoice, { turn: { end_reason: 'interrupted' } }));
  assert.notEqual(q(ui, '#jc-agent-status').textContent, 'Done');
});

test('unsafe blocker URLs never become links and valid destinations stay readable', async () => {
  const ui = await view(), journal = previewState(); journal.blockers[0].action_url = 'javascript:alert(1)'; ui.show(journal);
  assert.equal(q(ui, '#jc-attention a'), null);
  await ui.refresh(commit(journal, { blockers: [{ ...journal.blockers[0], action_url: 'https://example.com/path' }] }));
  assert.equal(q(ui, '#jc-attention a').getAttribute('href'), 'https://example.com/path');
  assert.match(q(ui, '#jc-attention [data-record="B1"] .jc-links').textContent, /연결 페이지 열기/);
});
