import test from 'node:test';
import assert from 'node:assert/strict';
import { view, state, commit, previewState, tick } from './ui-harness.mjs';

const q = (ui, selector) => ui.document.querySelector(selector);

test('Later history distinguishes card, chat and legacy provenance without changing content or old title context', async () => {
  for (const [inputMethod, caption] of [[undefined, 'User chose'], ['card', 'User selected'], ['chat', 'Recorded from your message']]) {
    const first = state(), ui = await view();
    const receipt = { id: 'later-reply', source: 'private-message-reference',
      ...(inputMethod ? { input_method: inputMethod } : {}), items: [{ collection: 'decisions', id: 'D1',
        record_revision: 1, kind: 'defer', text: 'Review this next week.', outcome: 'accepted' }] };
    const saved = commit(first, { decisions: [{ ...first.decisions[0], question: 'Updated question',
      attention: { state: 'later', actor: 'user', source: receipt.source } }], replies: [receipt] });
    ui.show(saved);
    for (const place of ['cards-body', 'history-cards']) {
      const card = q(ui, `#jc-${place} [data-record="D1"]`), rows = card.querySelectorAll('.jc-user-reply');
      assert.equal(rows.length, 1);
      const row = rows[0];
      assert.ok(row.textContent.startsWith(caption), row.textContent);
      assert.equal(row.querySelector('.jc-badge.deferred')?.textContent, 'Later');
      assert.match(row.textContent, /Review this next week\./);
      assert.match(row.textContent, /On: 어디에 표시할까요\?/);
      assert.doesNotMatch(row.textContent, /private-message-reference|User · Later/);
      assert.ok(row.querySelector('time') === null, 'Missing timestamps must stay missing');
    }
  }
});

test('Later history shows an actual receipt recording time as a separate badge', async () => {
  const first = state(), ui = await view(), recordedAt = '2026-10-06T16:00:00.000Z';
  const saved = commit(first, { replies: [{ id: 'reply', source: 'user:2', input_method: 'chat', recorded_at: recordedAt,
    items: [{ collection: 'decisions', id: 'D1', record_revision: 1, kind: 'defer', outcome: 'stale' }] }] });
  ui.show(saved);
  for (const place of ['cards-body', 'history-cards']) {
    const row = q(ui, `#jc-${place} [data-record="D1"] .jc-user-reply`), time = row.querySelector('time');
    assert.ok(time, 'A known recording time must appear');
    assert.equal(time.getAttribute('datetime'), recordedAt);
    assert.equal(time.title, 'Recorded at');
    assert.ok(time.classList.contains('jc-badge'));
    assert.ok(time.textContent);
    assert.equal(row.querySelector('.jc-badge.deferred').textContent, 'Later');
    assert.match(row.textContent, /Review needed/);
  }
});

test('Later applied in a subsequent turn retains its earlier receipt provenance and recording time in History', async () => {
  for (const [inputMethod, caption] of [['card', 'User selected'], ['chat', 'Recorded from your message'], [undefined, 'User chose']]) {
    const first = state(), ui = await view(), recordedAt = '2026-10-06T16:00:00.000Z';
    const receipt = { id: 'earlier-later-reply', source: 'private-earlier-message', ...(inputMethod ? { input_method: inputMethod } : {}), recorded_at: recordedAt,
      items: [{ collection: 'decisions', id: 'D1', record_revision: 1, kind: 'defer', outcome: 'accepted' }] };
    const received = commit(first, { replies: [receipt] });
    const applied = commit(received, { decisions: [{ ...first.decisions[0],
      attention: { state: 'later', actor: 'user', source: receipt.source } }] });
    ui.show(applied);
    const rows = q(ui, '#jc-history-cards [data-record="D1"]').querySelectorAll('.jc-user-reply');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].querySelector('span').textContent, caption);
    assert.equal(rows[0].querySelector('time')?.getAttribute('datetime'), recordedAt);
    assert.equal(rows[0].querySelector('time')?.title, 'Recorded at');
    assert.equal(rows[0].querySelector('.jc-badge.deferred').textContent, 'Later');
    assert.doesNotMatch(rows[0].textContent, /private-earlier-message/);
  }
});

test('a Later application never imports a receipt that was only recorded in a future turn', async () => {
  const first = state(), ui = await view(), recordedAt = '2026-10-06T16:00:00.000Z';
  const applied = commit(first, { decisions: [{ ...first.decisions[0],
    attention: { state: 'later', actor: 'user', source: 'private-message' } }] });
  const future = commit(applied, { replies: [{ id: 'future-later-reply', source: 'private-message', input_method: 'card', recorded_at: recordedAt,
    items: [{ collection: 'decisions', id: 'D1', record_revision: 1, kind: 'defer', outcome: 'accepted' }] }] });
  ui.show(future);
  q(ui, '#jc-history-tab').click(); q(ui, '#jc-prev').click();
  assert.equal(q(ui, '#jc-turn').value, 'T2');
  const row = q(ui, '#jc-history-cards [data-record="D1"] .jc-user-reply');
  assert.equal(row.querySelector('span').textContent, 'Recorded from your message');
  assert.ok(row.querySelector('time') === null, 'An unrecorded future receipt must not supply a timestamp');
  assert.doesNotMatch(row.textContent, /User selected|private-message/);
});

test('all recorded response kinds use action sentences and real recording time without changing the saved response body', async () => {
  const first = previewState(), recordedAt = '2026-10-06T16:00:00.000Z';
  const cases = [
    { collection: 'decisions', id: 'D1', record_revision: 1, kind: 'answer', text: 'Keep the answer wording.', caption: 'User answered', action: 'Answer' },
    { collection: 'cards', id: 'Q1', record_revision: 3, kind: 'resolve', caption: 'User marked as read', action: 'Marked as read' },
    { collection: 'blockers', id: 'B1', record_revision: 3, kind: 'resolve', caption: 'User reported completion', action: 'Completion reported' },
    { collection: 'blockers', id: 'B1', record_revision: 3, kind: 'acknowledge', caption: 'User acknowledged', action: 'Acknowledged' },
    { collection: 'decisions', id: 'D1', record_revision: 1, kind: 'comment', text: 'Keep the comment wording.', caption: 'Your comment' },
  ];
  for (const inputMethod of [undefined, 'card', 'chat']) {
    const ui = await view();
    const saved = commit(first, { replies: cases.map(({ caption, action, ...item }, index) => ({
      id: `reply-${index}`, source: `private-message-${index}`, recorded_at: recordedAt,
      ...(inputMethod ? { input_method: inputMethod } : {}), items: [{ ...item, outcome: 'accepted' }],
    })) });
    ui.show(saved);
    assert.match(q(ui, '#jc-history-cards [data-record="Q1"] .jc-change').textContent, /Read acknowledgment received/);
    assert.match(q(ui, '#jc-history-cards [data-record="B1"] .jc-change').textContent, /Completion report received/);
    for (const place of ['cards-body', 'history-cards']) {
      for (const id of ['D1', 'Q1', 'B1']) {
        const rows = [...q(ui, `#jc-${place} [data-record="${id}"]`).querySelectorAll('.jc-user-reply')];
        const expected = cases.filter(item => item.id === id);
        assert.equal(rows.length, expected.length);
        rows.forEach((row, index) => {
          const item = expected[index], chat = inputMethod === 'chat' && item.kind !== 'comment';
          assert.equal(row.querySelector('span').textContent, chat ? 'Recorded from your message' : item.caption);
          assert.equal(row.querySelector('time')?.getAttribute('datetime'), recordedAt);
          assert.equal(row.querySelector('time')?.title, 'Recorded at');
          if (chat) assert.equal(row.querySelector('.jc-badge:not(.jc-reply-time)').textContent, item.action);
          if (item.text) assert.equal(row.querySelector('p').textContent, item.text);
          assert.doesNotMatch(row.textContent, /private-message-|User ·/);
        });
      }
      assert.equal(q(ui, `#jc-${place} [data-record="B1"] .jc-card-status`).textContent, 'Open',
        'Historical completion reports must never imply verified Blocker resolution');
    }
  }
});

test('ordinary-chat Later without a delivery receipt keeps User attribution and agent inference stays Agent', async () => {
  for (const [actor, caption] of [['user', 'Recorded from your message'], ['agent', 'Agent postponed']]) {
    const first = state(), ui = await view();
    const saved = commit(first, { decisions: [{ ...first.decisions[0],
      attention: { state: 'later', actor, source: 'private-source', reason: 'Review next week.' } }] });
    ui.show(saved);
    for (const place of ['cards-body', 'history-cards']) {
      const row = q(ui, `#jc-${place} [data-record="D1"] .jc-user-reply`);
      assert.ok(row, 'A sourced postponement must have an explanatory response row');
      assert.ok(row.textContent.startsWith(caption));
      assert.equal(row.querySelector('.jc-badge.deferred').textContent, 'Later');
      assert.ok(row.querySelector('time') === null);
      assert.doesNotMatch(row.textContent, /private-source|selected/);
    }
  }
});

test('an agent assumption keeps Agent attribution without claiming a User response', async () => {
  const first = state(), ui = await view();
  ui.show(commit(first, { decisions: [{ ...first.decisions[0], agent_assumption: 'Use a temporary folder until the user chooses.' }] }));
  for (const place of ['attention', 'cards-body', 'history-cards']) {
    const card = q(ui, `#jc-${place} [data-record="D1"]`);
    assert.match(card.textContent, /Agent assumption/);
    assert.match(card.textContent, /Use a temporary folder until the user chooses\./);
    assert.ok(card.querySelector('.jc-user-reply') === null);
  }
});

test('Decision and Suggestion share recommendation, Other editing and Later controls while preserving necessity', async () => {
  for (const type of ['decision', 'suggestion']) {
    const first = state(), ui = await view(), decision = first.decisions[0];
    decision.no_answer_behavior = undefined;
    if (type === 'suggestion') {
      first.decisions = [];
      first.cards = [{ ...decision, type: 'suggestion', title: decision.question, body: decision.why }];
    }
    ui.show(first);
    const card = q(ui, '#jc-attention [data-record="D1"]');
    assert.equal(card.querySelectorAll('[data-choice]').length, 3);
    assert.equal(card.querySelector('[data-choice="A"] .jc-recommendation').textContent, 'Recommended');
    assert.ok(card.querySelector('[data-reply-kind="resolve"]') === null);
    assert.equal(card.querySelector('[data-reply-kind="defer"]').textContent, 'Later');
    assert.equal(q(ui, '#jc-agent-status').textContent, type === 'decision' ? 'Needs your input' : 'Unknown');
    card.querySelector('[data-choice="other"]').click();
    const input = q(ui, '#jc-attention [data-record="D1"] .jc-input textarea');
    input.value = 'Keep my wording.'; input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    q(ui, '#jc-send').click(); await tick();
    assert.equal(ui.envelope().items[0].kind, 'answer');
    assert.equal(ui.envelope().items[0].text, 'Keep my wording.');
    assert.equal(ui.envelope().items[0].collection, type === 'decision' ? 'decisions' : 'cards');
  }
});

test('Blocker never gains a read or resolve control while Later remains available', async () => {
  const ui = await view(); ui.show(previewState());
  for (const place of ['attention', 'cards-body', 'history-cards']) {
    const card = q(ui, `#jc-${place} [data-record="B1"]`);
    assert.ok(card.querySelector('[data-reply-kind="resolve"], [data-reply-kind="acknowledge"]') === null);
    assert.ok(![...card.querySelectorAll('button')].some(button => /^(?:Resolved|Mark read|Acknowledge|Got it)$/.test(button.textContent)));
  }
  assert.ok(q(ui, '#jc-attention [data-record="B1"] [data-reply-kind="defer"]'));
});
