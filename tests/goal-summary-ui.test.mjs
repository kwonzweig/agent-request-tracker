import test from 'node:test';
import assert from 'node:assert/strict';
import { view, commit } from './ui-harness.mjs';

const request = (id, title, status, parent_id = null) => ({ id, title, status, parent_id,
  source: 'user:1', done_when: 'Verify the requested result',
  ...(status === 'done' ? { evidence: 'verified:result' } : {}) });
function journal(requests) {
  return commit({ schema_version: 1, conversation_id: 'goal-summary', revision: 0,
    requests: [], decisions: [], blockers: [], cards: [], replies: [], history: [], turn: null }, {
    requests, turn: { summary: 'Saved the current outcomes', end_reason: 'complete' },
  });
}
const q = (ui, selector) => ui.document.querySelector(selector);

test('Goal includes the deferred root even when Agent has finished its authorized children', async () => {
  const ui = await view();
  ui.show(journal([
    request('R1', 'Original goal', 'deferred'),
    request('R2', 'Completed child', 'done', 'R1'),
  ]));
  assert.equal(q(ui, '#jc-goal-title').textContent, 'Original goal');
  assert.equal(q(ui, '#jc-goal-status').textContent, 'Deferred');
  assert.equal(q(ui, '#jc-goal-status').className, 'jc-badge deferred');
  assert.equal(q(ui, '#jc-agent-status').textContent, 'Done');
});

test('an active root keeps Goal In progress after its child is Done', async () => {
  const ui = await view();
  ui.show(journal([
    request('R1', 'Original goal', 'active'),
    request('R2', 'Completed child', 'done', 'R1'),
  ]));
  assert.equal(q(ui, '#jc-goal-status').textContent, 'In progress');
  assert.equal(q(ui, '#jc-agent-status').textContent, 'Work remains');
});

for (const [status, expected] of [['deferred', 'Deferred'], ['proposed', 'Proposed']]) {
  test(`Goal includes the ${status} root alongside a Done root while Agent reports completed authorized work`, async () => {
    for (const roots of [
      [request('R1', 'Completed goal', 'done'), request('R2', 'Remaining goal', status)],
      [request('R2', 'Remaining goal', status), request('R1', 'Completed goal', 'done')],
    ]) {
      const ui = await view(); ui.show(journal(roots));
      assert.match(q(ui, '#jc-goal-title').textContent, /Completed goal/);
      assert.match(q(ui, '#jc-goal-title').textContent, /Remaining goal/);
      assert.equal(q(ui, '#jc-goal-status').textContent, expected);
      assert.equal(q(ui, '#jc-agent-status').textContent, 'Done');
    }
  });
}

test('mixed incomplete roots report a deterministic Goal status', async () => {
  for (const [statuses, expected] of [
    [['deferred', 'active'], 'In progress'],
    [['proposed', 'waiting'], 'Waiting'],
    [['cancelled', 'deferred'], 'Deferred'],
    [['proposed', 'deferred'], 'Deferred'],
  ]) {
    for (const order of [statuses, [...statuses].reverse()]) {
      const ui = await view();
      ui.show(journal([request('R1', 'First goal', order[0]), request('R2', 'Second goal', order[1])]));
      assert.equal(q(ui, '#jc-goal-title').textContent, 'First goal · Second goal');
      assert.equal(q(ui, '#jc-goal-status').textContent, expected);
    }
  }
});

test('Goal is Done when all displayed roots are Done', async () => {
  const ui = await view();
  ui.show(journal([
    request('R1', 'First goal', 'done'), request('R2', 'Completed child', 'done', 'R1'),
    request('R3', 'Second goal', 'done'),
  ]));
  assert.equal(q(ui, '#jc-goal-title').textContent, 'First goal · Second goal');
  assert.equal(q(ui, '#jc-goal-status').textContent, 'Done');
  assert.equal(q(ui, '#jc-agent-status').textContent, 'Done');
});
