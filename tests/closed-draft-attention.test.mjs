import test from 'node:test';
import assert from 'node:assert/strict';
import { view, previewState, commit, tick, memoryStorage } from './ui-harness.mjs';
import { ReplyDrafts } from '../src/reply-ui.mjs';

const q = (ui, selector) => ui.document.querySelector(selector);
function type(ui, selector, value) {
  const field = q(ui, selector); field.value = value;
  field.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
}
const cases = [
  { name: 'answered Decision with a different unsent choice', collection: 'decisions', id: 'D1', choice: 'B', value: '별도 화면',
    update: record => ({ ...record, status: 'answered', user_answer: { revision: 1, option_id: 'A', source: 'user:4' } }) },
  { name: 'answered Decision with an unsent Other answer', collection: 'decisions', id: 'D1', choice: 'other', value: 'Keep this private source.',
    update: record => ({ ...record, status: 'answered', user_answer: { revision: 1, option_id: 'A', source: 'user:4' } }) },
  { name: 'resolved Decision with an unsent choice', collection: 'decisions', id: 'D1', choice: 'B', value: '별도 화면',
    update: record => ({ ...record, status: 'resolved' }) },
  { name: 'read Q&A with a saved unsent read acknowledgment', collection: 'cards', id: 'Q1', action: 'resolve', value: 'Mark as read', saved: true,
    update: record => ({ ...record, status: 'resolved' }) },
  { name: 'resolved Blocker with a legacy unsent action', collection: 'blockers', id: 'B1', action: 'resolve', value: 'Report completion', legacy: true,
    update: record => ({ ...record, status: 'resolved' }) },
  { name: 'Later Decision with an unsent choice', collection: 'decisions', id: 'D1', choice: 'B', value: '별도 화면',
    update: record => ({ ...record, attention: { state: 'later', actor: 'user', source: 'user:4' } }) },
  { name: 'legacy deferred Decision with an unsent choice', collection: 'decisions', id: 'D1', choice: 'B', value: '별도 화면',
    update: record => ({ ...record, status: 'deferred' }) },
];

for (const scenario of cases) test(`${scenario.name} stays in Cards and allows an unrelated reply`, async () => {
  const storage = memoryStorage(), first = previewState();
  if (scenario.legacy || scenario.saved) storage.setItem('request-journal:replies:v1:C1', JSON.stringify({ version: 1, delivery: null,
    drafts: [{ collection: scenario.collection, id: scenario.id, record_revision: 3, kind: scenario.action, token: 'legacy-action' }] }));
  const ui = await view({ storage }); ui.show(first);
  const control = scenario.choice ? `[data-choice="${scenario.choice}"][data-record="${scenario.id}"]`
    : `[data-record="${scenario.id}"] [data-reply-kind="${scenario.action}"]`;
  if (!scenario.legacy && !scenario.saved) q(ui, `#jc-attention ${control}`).click();
  if (scenario.choice === 'other') type(ui, '#jc-attention [data-record="D1"] textarea', scenario.value);
  const before = [...new ReplyDrafts(ui.storage, 'C1').drafts.values()];
  const closed = commit(first, { [scenario.collection]: [scenario.update(first[scenario.collection].find(record => record.id === scenario.id))] });
  await ui.refresh(closed);
  assert.equal(Boolean(q(ui, `#jc-attention [data-record="${scenario.id}"]`)), false);
  assert.equal(Boolean(q(ui, '#jc-attention .jc-warning')), false, 'a settled or postponed card creates no Attention obligation');
  assert.doesNotMatch(q(ui, '#jc-draft').textContent, /choices changed|Review/);
  const card = q(ui, `#jc-cards-body [data-record="${scenario.id}"]`);
  assert.ok(card.querySelector('.jc-draft-hint') === null);
  assert.ok(card.querySelector('.jc-warning').textContent.includes(scenario.value), 'original unsent input stays with its card');
  assert.deepEqual([...new ReplyDrafts(ui.storage, 'C1').drafts.values()], before);

  const reopened = await view({ storage: ui.storage }); reopened.show(closed);
  assert.equal(Boolean(q(reopened, '#jc-attention .jc-warning')), false);
  assert.ok(q(reopened, `#jc-cards-body [data-record="${scenario.id}"] .jc-warning`).textContent.includes(scenario.value));
  type(reopened, '#jc-tree [data-record="R1"] textarea', 'Proceed with the independent work.');
  assert.equal(q(reopened, '#jc-send').disabled, false);
  q(reopened, '#jc-send').click(); await tick();
  assert.equal(reopened.sent.length, 1);
  assert.deepEqual(reopened.envelope().items, [{ collection: 'requests', id: 'R1', record_revision: 1, kind: 'comment', text: 'Proceed with the independent work.' }]);
  const envelope = reopened.envelope();
  await reopened.refresh(commit(closed, { replies: [{ id: envelope.delivery_id, source: 'user:5', items: envelope.items.map(item => ({ ...item, outcome: 'accepted' })) }] }));
  assert.deepEqual([...new ReplyDrafts(ui.storage, 'C1').drafts.values()], before, 'unrelated delivery cannot consume the preserved draft');
});

test('an open changed choice still requires review and blocks unrelated sending', async () => {
  const ui = await view(), first = previewState(); ui.show(first);
  q(ui, '#jc-attention [data-record="D1"][data-choice="B"]').click();
  const changed = commit(first, { decisions: [{ ...first.decisions[0], revision: 2, options: [{ id: 'A', label: 'A new route' }] }] });
  await ui.refresh(changed);
  type(ui, '#jc-tree [data-record="R1"] textarea', 'Independent comment');
  assert.match(q(ui, '#jc-attention .jc-warning').textContent, /Review needed/);
  assert.ok(q(ui, '#jc-attention .jc-warning').textContent.includes('별도 화면'));
  assert.equal(q(ui, '#jc-send').disabled, true);
  q(ui, '#jc-send').click(); await tick();
  assert.equal(ui.sent.length, 0);
});

for (const outcome of ['answered', 'later']) test(`a rejected shared choice on a now-${outcome} Decision cannot block an unrelated ready comment`, async () => {
  const storage = memoryStorage(), a = await view({ storage }), b = await view({ storage }), first = previewState();
  a.show(first); b.show(first);
  type(b, '#jc-tree [data-record="R1"] textarea', 'Continue the independent work.');
  q(a, '#jc-attention [data-record="D1"][data-choice="A"]').click(); await b.refresh(first);
  q(a, '#jc-attention [data-record="D1"][data-choice="B"]').click();
  q(b, '#jc-attention [data-record="D1"][data-choice="A"]').click();
  assert.match(q(b, '#jc-draft').textContent, /reply changed in another view/);
  assert.equal(q(b, '#jc-send').disabled, true, 'an open unreviewed shared choice still prevents sending');
  q(b, '#jc-send').click(); await tick(); assert.equal(b.sent.length, 0);
  const before = [...new ReplyDrafts(storage, 'C1').drafts.values()];
  const decision = outcome === 'answered'
    ? { ...first.decisions[0], status: 'answered', user_answer: { revision: 1, option_id: 'A', source: 'user:4' } }
    : { ...first.decisions[0], attention: { state: 'later', actor: 'user', source: 'user:4' } };
  const settled = commit(first, { decisions: [decision] }); await b.refresh(settled);
  assert.equal(q(b, '#jc-attention .jc-warning'), null);
  assert.doesNotMatch(q(b, '#jc-draft').textContent, /reply changed|Review/);
  assert.equal(q(b, '#jc-send').disabled, false);
  assert.deepEqual([...new ReplyDrafts(storage, 'C1').drafts.values()], before);

  const pendingAgain = commit(settled, { decisions: [{ ...first.decisions[0], revision: 2 }] });
  await b.refresh(pendingAgain);
  assert.equal(q(b, '#jc-send').disabled, true, 'reopening the same card restores its review boundary');
  assert.match(q(b, '#jc-draft').textContent, /reply changed|choices changed/);
  const settledAgain = commit(pendingAgain, { decisions: [decision] }); await b.refresh(settledAgain);
  q(b, '#jc-send').click(); await tick();
  assert.equal(b.sent.length, 1);
  assert.deepEqual(b.envelope().items, [{ collection: 'requests', id: 'R1', record_revision: 1, kind: 'comment', text: 'Continue the independent work.' }]);
  assert.deepEqual([...new ReplyDrafts(storage, 'C1').drafts.values()], before, 'sending unrelated work leaves the saved choice intact');
});

for (const scenario of [
  { name: 'resolved Note', collection: 'cards', id: 'N1', update: record => ({ ...record, status: 'resolved' }) },
  { name: 'resolved Blocker', collection: 'blockers', id: 'B1', update: record => ({ ...record, status: 'resolved' }) },
  { name: 'Later Blocker', collection: 'blockers', id: 'B1', update: record => ({ ...record, attention: { state: 'later', actor: 'user', source: 'user:5' } }) },
]) test(`an earlier comment on a ${scenario.name} stays in Cards while a new comment remains sendable`, async () => {
  const ui = await view();
  const seed = previewState(), first = commit(seed, { cards: [{ ...seed.cards.find(record => record.id === 'N1'), status: 'open' }] });
  ui.show(first);
  const selector = `#jc-cards-body [data-record="${scenario.id}"]`;
  type(ui, `${selector} textarea`, 'Earlier unsent comment. Keep its original context.');
  const original = [...new ReplyDrafts(ui.storage, 'C1').drafts.values()];
  const settled = commit(first, { [scenario.collection]: [scenario.update(first[scenario.collection].find(record => record.id === scenario.id))] });
  await ui.refresh(settled);
  assert.equal(q(ui, '#jc-send').disabled, true, 'the retained old comment creates no sendable input');
  assert.equal(q(ui, '#jc-queued-comments').hidden, true, 'the old comment stays with the closed card');
  assert.ok(q(ui, `${selector} .jc-draft-hint`) === null);
  assert.match(q(ui, `${selector} .jc-warning`).textContent, /Earlier unsent comment\. Keep its original context\./);
  assert.deepEqual([...new ReplyDrafts(ui.storage, 'C1').drafts.values()], original);

  const reopened = await view({ storage: ui.storage }); reopened.show(settled);
  type(reopened, '#jc-tree [data-record="R1"] textarea', 'Proceed with the independent request.');
  q(reopened, '#jc-send').click(); await tick();
  assert.equal(reopened.sent.length, 1);
  assert.deepEqual(reopened.envelope().items, [{ collection: 'requests', id: 'R1', record_revision: 1, kind: 'comment', text: 'Proceed with the independent request.' }]);
  const envelope = reopened.envelope();
  const recorded = commit(settled, { replies: [{ id: envelope.delivery_id, source: 'user:6', items: envelope.items.map(item => ({ ...item, outcome: 'accepted' })) }] });
  await reopened.refresh(recorded);
  assert.deepEqual([...new ReplyDrafts(ui.storage, 'C1').drafts.values()], original);
  type(reopened, `${selector} textarea`, 'A new comment written after this card changed.');
  q(reopened, '#jc-send').click(); await tick();
  assert.equal(reopened.sent.length, 2);
  assert.deepEqual(reopened.envelope().items, [{ collection: scenario.collection, id: scenario.id, record_revision: 5, kind: 'comment', text: 'A new comment written after this card changed.' }]);
  assert.deepEqual([...new ReplyDrafts(ui.storage, 'C1').drafts.values()].filter(item => item.record_revision === original[0].record_revision), original,
    'the new comment cannot replace or rebind the older retained comment');
});
