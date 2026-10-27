import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJournal, updateJournal } from '../src/store.mjs';
import { view } from './ui-harness.mjs';

const request = (id, parent_id = null, extras = {}) => ({ id, parent_id, title: `Deliverable ${id}`,
  status: 'active', source: 'user:1', done_when: 'Verify the requested result.', ...extras });
const blocker = request_id => ({ id: `B-${request_id}`, request_id, title: `Access needed for ${request_id}`,
  status: 'open', owner: 'user', evidence: 'tool:access-denied', next_action: 'Restore access.' });
async function persisted(t, requests, blockers) {
  const dir = await mkdtemp(join(tmpdir(), 'journal-goal-blocker-'));
  t.after(async () => {
    assert.equal(dirname(dir), tmpdir());
    await rm(dir, { recursive: true, force: true });
  });
  const saved = await updateJournal(dir, 'goal-blocker', { expected_revision: 0,
    turn: { id: 'T1', source: 'user:1', summary: 'Saved deliverable outcomes.', end_reason: null },
    upsert: { requests, blockers } });
  const readback = await readJournal(dir, 'goal-blocker');
  assert.deepEqual(readback, saved);
  const ui = await view(); ui.show(readback);
  return ui;
}
const q = (ui, selector) => ui.document.querySelector(selector);

test('an excluded blocked child keeps the completed root Goal Done and Agent Needs your input', async t => {
  const ui = await persisted(t, [
    request('R1', null, { status: 'done', evidence: 'verified:primary-result' }),
    request('R2', 'R1', { scope_exclusion_source: 'user:exclude-followup' }),
  ], [blocker('R2')]);
  assert.equal(q(ui, '#jc-goal-title').textContent, 'Deliverable R1');
  assert.equal(q(ui, '#jc-goal-status').textContent, 'Done');
  assert.equal(q(ui, '#jc-agent-status').textContent, 'Needs your input');
  assert.ok(q(ui, '#jc-attention [data-record="B-R2"]'));
});

test('an excluded ancestry edge also keeps its blocked grandchild outside the root Goal', async t => {
  const ui = await persisted(t, [
    request('R1', null, { status: 'done', evidence: 'verified:primary-result' }),
    request('R2', 'R1', { scope_exclusion_source: 'user:exclude-followup' }),
    request('R3', 'R2'),
  ], [blocker('R3')]);
  assert.equal(q(ui, '#jc-goal-status').textContent, 'Done');
  assert.equal(q(ui, '#jc-agent-status').textContent, 'Needs your input');
});

test('an included blocked child keeps the active root Goal Blocked', async t => {
  const ui = await persisted(t, [request('R1'), request('R2', 'R1')], [blocker('R2')]);
  assert.equal(q(ui, '#jc-goal-title').textContent, 'Deliverable R1');
  assert.equal(q(ui, '#jc-goal-status').textContent, 'Blocked');
  assert.equal(q(ui, '#jc-agent-status').textContent, 'Needs your input');
});

test('a root blocker remains applicable because a root has no ancestry edge to exclude', async t => {
  const ui = await persisted(t, [request('R1', null, { scope_exclusion_source: 'user:prior-scope' })], [blocker('R1')]);
  assert.equal(q(ui, '#jc-goal-status').textContent, 'Blocked');
});

test('included blockers on another displayed root still block the aggregate Goal', async t => {
  const ui = await persisted(t, [
    request('R1', null, { status: 'done', evidence: 'verified:primary-result' }),
    request('R2', 'R1', { scope_exclusion_source: 'user:exclude-followup' }),
    request('R3'), request('R4', 'R3'),
  ], [blocker('R2'), blocker('R4')]);
  assert.equal(q(ui, '#jc-goal-title').textContent, 'Deliverable R1 · Deliverable R3');
  assert.equal(q(ui, '#jc-goal-status').textContent, 'Blocked');
  assert.equal(q(ui, '#jc-agent-status').textContent, 'Needs your input');
});
