import test from 'node:test';
import assert from 'node:assert/strict';
import { view, state, commit, previewState, memoryStorage, tick } from './ui-harness.mjs';

const q = (ui, selector) => ui.document.querySelector(selector);
function type(ui, selector, value) {
  const field = q(ui, selector); field.value = value;
  field.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
}
async function send(ui) { q(ui, '#jc-send').click(); await tick(); }

test('saved human replies retain URL-only answers, destinations and prohibitions in all views', async () => {
  const ui = await view(), first = previewState();
  const words = 'Use https://allowed.example/path, not https://forbidden.example/path. [Read this](https://docs.example).';
  const saved = commit(first, { replies: [{ id: 'reply', source: 'user:4', items: [
    { collection: 'blockers', id: 'B1', record_revision: 3, kind: 'comment', text: words, outcome: 'accepted' },
    { collection: 'requests', id: 'R1', record_revision: 1, kind: 'comment', text: 'https://task.example', outcome: 'accepted' },
    { collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', text: 'https://answer.example', outcome: 'accepted' },
  ] }] });
  ui.show(saved);
  for (const selector of ['#jc-attention [data-record="B1"]', '#jc-cards-body [data-record="B1"]', '#jc-history-cards [data-record="B1"]']) {
    const body = q(ui, selector).querySelector('.jc-user-reply');
    assert.match(body.textContent, /Use https:\/\/allowed.example\/path, not https:\/\/forbidden.example\/path\. Read this\./);
    assert.deepEqual([...body.querySelectorAll('a')].map(a => a.href), ['https://allowed.example/path', 'https://forbidden.example/path', 'https://docs.example/']);
  }
  assert.equal(q(ui, '#jc-tree .jc-user-reply a').href, 'https://task.example/');
  assert.equal(q(ui, '#jc-history-requests .jc-user-reply a').href, 'https://task.example/');
  assert.equal(q(ui, '#jc-cards-body [data-record="D1"] .jc-user-reply a').href, 'https://answer.example/');
});

test('reply text is inert and historical URLs are not replaced by newer record links', async () => {
  const ui = await view(), first = previewState();
  const saved = commit(first, { replies: [{ id: 'reply', source: 'user:4', items: [
    { collection: 'blockers', id: 'B1', record_revision: 3, kind: 'comment', text: '<img src=x onerror=bad()> [bad](javascript:alert(1)) https://original.example', outcome: 'accepted' },
  ] }], blockers: [{ ...first.blockers[0], title: 'New connection', action_url: 'https://new.example' }] });
  ui.show(saved);
  const body = q(ui, '#jc-cards-body [data-record="B1"] .jc-user-reply');
  assert.equal(body.querySelector('img'), null);
  assert.equal(body.querySelectorAll('a').length, 1);
  assert.equal(body.querySelector('a').href, 'https://original.example/');
  assert.match(body.textContent, /javascript:alert\(1\)/);
  assert.doesNotMatch(body.textContent, /new.example/);
});

test('explicit Markdown destinations preserve meaningful punctuation inside their delimiters', async () => {
  const ui = await view(), first = previewState();
  const urls = ['https://source.example/record!', 'https://source.example/query?q=why?', 'https://source.example/page#part;', 'https://source.example/path,', 'https://source.example/a(b)'];
  const saved = commit(first, { replies: [{ id: 'punctuation', source: 'user:4', items: [
    { collection: 'blockers', id: 'B1', record_revision: 3, kind: 'comment', text: urls.map((url, i) => `[Target ${i}](${url}).`).join(' '), outcome: 'accepted' },
  ] }] });
  ui.show(saved);
  for (const selector of ['#jc-attention', '#jc-cards-body', '#jc-history-cards']) {
    const body = q(ui, `${selector} [data-record="B1"] .jc-user-reply`);
    assert.deepEqual([...body.querySelectorAll('a')].map(link => link.href), urls);
  }
});

test('explicit links preserve surrounding prose and balanced destination parentheses', async () => {
  const ui = await view(), first = previewState();
  const words = '(See [record](https://source.example/record!)). [A](https://source.example/a(b(c)))[B](https://source.example/b?x=!).';
  const saved = commit(first, { replies: [{ id: 'boundaries', source: 'user:4', items: [
    { collection: 'blockers', id: 'B1', record_revision: 3, kind: 'comment', text: words, outcome: 'accepted' },
  ] }] });
  ui.show(saved);
  const body = q(ui, '#jc-attention [data-record="B1"] .jc-user-reply');
  assert.deepEqual([...body.querySelectorAll('a')].map(link => link.href), ['https://source.example/record!', 'https://source.example/a(b(c))', 'https://source.example/b?x=!']);
  assert.match(body.textContent, /\(See record\)\. AB\./);
});

test('comments on an earlier card remain visible, editable, discardable and bound to that card version', async () => {
  const ui = await view(), first = previewState(); ui.show(first);
  type(ui, '#jc-attention [data-record="B1"] textarea', 'Original draft');
  const changed = commit(first, { blockers: [{ ...first.blockers[0], title: 'A different connection', action_url: 'https://new.example' }] });
  await ui.refresh(changed);
  assert.equal(q(ui, '#jc-attention [data-record="B1"] textarea').value, '');
  assert.equal(q(ui, '#jc-queued-comments').hidden, false);
  assert.match(q(ui, '#jc-queued-comments').textContent, /메일 연결을 확인해 주세요/);
  assert.equal(q(ui, '#jc-queued-comments textarea').value, 'Original draft');
  q(ui, '#jc-history-tab').click();
  assert.equal(q(ui, '#jc-records textarea'), null);
  type(ui, '#jc-queued-comments textarea', 'Edited original draft');
  await send(ui);
  assert.equal(ui.envelope().items[0].record_revision, 3);
  assert.equal(ui.envelope().items[0].text, 'Edited original draft');
  const other = await view(); other.show(first);
  type(other, '#jc-attention [data-record="B1"] textarea', 'Discard me');
  await other.refresh(changed); q(other, '#jc-queued-comments button').click();
  assert.equal(q(other, '#jc-queued-comments').hidden, true);
  assert.equal(q(other, '#jc-send').disabled, true);
});

test('unchanged-journal polling refreshes shared drafts and uncertain delivery across views', async () => {
  const storage = memoryStorage(), a = await view({ storage, sendImpl: async () => { throw Error('lost acknowledgement'); } }), b = await view({ storage });
  const first = previewState(); a.show(first); b.show(first);
  type(a, '#jc-attention [data-record="B1"] textarea', 'Shared comment');
  await b.refresh(first);
  assert.equal(q(b, '#jc-attention [data-record="B1"] textarea').value, 'Shared comment');
  await send(a); await b.refresh(first);
  assert.equal(q(b, '#jc-send').disabled, true);
  assert.match(q(b, '#jc-draft').textContent, /Delivery is unconfirmed/);
  await send(b); assert.equal(b.sent.length, 0);
});

test('auxiliary Decision link changes retain the original selected choice without false stale warning', async () => {
  const ui = await view(), first = state(); ui.show(first);
  q(ui, '#jc-attention [data-choice="A"]').click();
  const changed = commit(first, { decisions: [{ ...first.decisions[0], urls: [{ label: 'Help', url: 'https://help.example' }] }] });
  await ui.refresh(changed);
  assert.equal(q(ui, '#jc-attention [data-choice="A"]').getAttribute('aria-pressed'), 'true');
  assert.doesNotMatch(q(ui, '#jc-draft').textContent, /choices changed/);
  await send(ui); assert.equal(ui.envelope().items[0].record_revision, 1);
});

test('History uses the actual blocker end-reason enum', async () => {
  const ui = await view(), journal = previewState();
  journal.turn.end_reason = 'blocker'; ui.show(journal);
  assert.match(q(ui, '#jc-turn-body').textContent, /Blocked/);
  assert.doesNotMatch(q(ui, '#jc-turn-body').textContent, /blocker/);
});
