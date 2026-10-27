import test from 'node:test';
import assert from 'node:assert/strict';
import { view, commit, tick } from './ui-harness.mjs';
import { needsAttention } from '../src/journal-views.mjs';
import { canResolve, canDefer } from '../src/reply-ui.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateJournal, readJournal, evaluateStop, markCardRead } from '../src/store.mjs';

function completed() {
  return commit({ schema_version: 1, conversation_id: 'C1', revision: 0,
    requests: [], cards: [], decisions: [], blockers: [], replies: [], history: [], turn: null }, {
    requests: [{ id: 'R1', title: '다운로드 화면 만들기', status: 'done', source: 'user:1',
      done_when: '파일을 다운로드할 수 있다', evidence: '다운로드와 파일 내용을 확인했습니다.',
      workspace: { id: 'DEMO-42', url: 'https://example.com/work/42' } }],
    cards: [{ id: 'C1', request_id: 'R1', revision: 1, type: 'completion', status: 'open',
      title: '다운로드 화면 만들기', body: '다운로드와 파일 내용을 확인했습니다.', source: 'agent:1',
      completion: { request_revision: 1 }, urls: [{ label: '결과 보기', url: 'https://example.com/result' }] }],
    turn: { end_reason: 'complete', summary: '다운로드 화면을 완성했습니다.' },
  });
}

test('unread Complete stays in Attention without an Open or Answered status badge', async () => {
  for (const status of ['open', 'answered']) {
    const journal = completed();
    journal.cards[0].status = status;
    const ui = await view(); ui.show(journal);
    const card = ui.document.querySelector('#jc-attention [data-record="C1"]');
    assert.ok(card);
    assert.ok(card.querySelector('.jc-card-status') === null, 'Unread Complete must not show a card status badge');
    assert.ok(ui.document.querySelector('#jc-cards-body [data-record="C1"] .jc-card-status') === null,
      'Cards view must also omit the unread Complete status badge');
  }
});

test('completion uses the approved expanded card with result links and a top-right silent Close read control', async () => {
  const state = completed(), ui = await view({ toolImpl: async request => {
    const saved = commit(state, { cards: [{ ...state.cards[0], status: 'resolved', resolution: { actor: 'user',
      source: `app:journal_mark_read:C1:${request.arguments.record_revision}`, record_revision: request.arguments.record_revision } }] });
    return { structuredContent: { journal: saved } };
  } }); ui.show(state);
  const card = ui.document.querySelector('#jc-attention [data-record="C1"]');
  assert.equal(card.tagName, 'ARTICLE');
  assert.ok(card.querySelector('summary') === null);
  assert.equal(card.querySelector('.jc-badge.completion').textContent, 'Complete');
  assert.match(card.textContent, /다운로드와 파일 내용을 확인했습니다/);
  assert.ok([...card.querySelectorAll('a')].some(link => link.getAttribute('href') === 'https://example.com/result'));
  assert.match(card.textContent, /DEMO-42/);
  assert.ok(card.querySelector('textarea'));
  assert.equal(card.querySelector('details'), null);
  const resolve = card.querySelector('.jc-read-icon[data-reply-kind="resolve"]');
  assert.ok(resolve);
  assert.ok(resolve.querySelector('svg'));
  assert.equal(resolve.title, 'Mark as read');
  resolve.click();
  await tick();
  assert.equal(ui.sent.length, 0);
  assert.deepEqual(ui.toolCalls, [{ name: 'journal_mark_read', arguments: { conversation_id: 'C1', card_id: 'C1', record_revision: 1 } }]);
  assert.equal(ui.document.querySelector('#jc-attention [data-record="C1"]'), null);
  assert.equal(state.requests[0].status, 'done');
});

test('completion survives an unrelated turn; acknowledgment hides only its Attention entry', async () => {
  const first = completed(), ui = await view(); ui.show(first);
  const next = commit(first, {}); await ui.refresh(next);
  assert.ok(ui.document.querySelector('#jc-attention [data-record="C1"]'));
  const resolved = commit(next, { cards: [{ ...next.cards[0], status: 'resolved',
    resolution: { actor: 'user', source: 'user:3', note: '확인했습니다.' } }] });
  await ui.refresh(resolved);
  assert.equal(ui.document.querySelector('#jc-attention [data-record="C1"]'), null);
  assert.ok(ui.document.querySelector('#jc-cards-body [data-record="C1"]'));
  assert.equal(resolved.requests[0].status, 'done');
  assert.equal(resolved.history[0].changes.find(change => change.collection === 'cards').after.status, 'open');
});

test('completion is acknowledgment-only and never hides just because its request is done', () => {
  const record = completed().cards[0];
  assert.equal(needsAttention(record), true);
  assert.equal(canResolve('cards', record), true);
  assert.equal(canDefer('cards', record), false);
  assert.equal(needsAttention({ ...record, status: 'answered' }), true);
  assert.equal(needsAttention({ ...record, status: 'resolved' }), false);
  assert.equal(needsAttention({ ...record, status: 'superseded' }), false);
});

test('real writer completion is saved as read by × without a chat reply or new turn and stays read after reload', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tracker-completion-ui-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const request = completed().requests[0];
  const first = await updateJournal(dir, 'C1', { expected_revision: 0,
    turn: { id: 'T1', source: 'user:1', summary: '다운로드 화면을 완성했습니다.', end_reason: 'complete' },
    upsert: { requests: [request] } });
  const completion = first.cards.find(card => card.type === 'completion');
  assert.ok(completion);
  assert.equal(evaluateStop(first, { turnId: 'T1' }).allowed, true,
    'an unread completion notice is not a blocker');
  let save;
  const ui = await view({ toolImpl: request => {
    assert.equal(request.name, 'journal_mark_read');
    save = markCardRead(dir, request.arguments.conversation_id, {
      card_id: request.arguments.card_id, record_revision: request.arguments.record_revision,
    });
    return save.then(journal => ({ structuredContent: { journal } }));
  } }); ui.show(first);
  const card = ui.document.querySelector(`#jc-attention [data-record="${completion.id}"]`);
  card.querySelector('.jc-read-icon[data-reply-kind="resolve"]').click();
  const next = await save; await tick();
  const restored = await readJournal(dir, 'C1');
  assert.deepEqual(restored, next);
  assert.equal(ui.document.querySelector(`#jc-attention [data-record="${completion.id}"]`), null);
  assert.ok(ui.document.querySelector(`#jc-cards-body [data-record="${completion.id}"]`));
  assert.equal(restored.requests[0].status, 'done');
  assert.deepEqual(restored.replies, first.replies); assert.deepEqual(restored.turn, first.turn);
  assert.equal(restored.cards.find(card => card.id === completion.id).resolution.actor, 'user');
  assert.equal(ui.sent.length, 0); assert.equal(ui.toolCalls.length, 1);
  const reopened = await view(); reopened.show(restored);
  assert.equal(reopened.document.querySelector(`#jc-attention [data-record="${completion.id}"]`), null);
  assert.equal(reopened.sent.length, 0);
});
