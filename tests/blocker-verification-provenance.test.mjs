import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readJournal, updateJournal } from '../src/store.mjs';

const update = (expected_revision, upsert = {}) => ({ expected_revision,
  turn: { id: `T${expected_revision + 1}`, source: 'user:1', summary: 'Check the blocked operation', end_reason: null }, upsert });
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-blocker-provenance-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const state = await updateJournal(dir, 'c', update(0, {
    requests: [{ id: 'R1', title: 'Read the account', done_when: 'The account read succeeds', source: 'user:1', status: 'active' }],
    blockers: [{ id: 'B1', request_id: 'R1', revision: 1, title: 'Access unavailable', evidence: 'tool:access-denied',
      next_action: 'Choose a recovery path', owner: 'user', status: 'open',
      options: [{ id: 'file', label: 'Use the supplied file', impact: 'Use the authorized upload' },
        { id: 'live', label: 'Reconnect the account', impact: 'Retry the live operation' }] }],
    cards: [{ id: 'Q1', request_id: 'R1', revision: 1, type: 'qa', title: 'Access explanation',
      body: 'The account read needs access.', source: 'agent:1', status: 'open' }],
  }));
  return { dir, state };
}
const report = (kind, source) => kind === 'answer'
  ? { id: 'B1', user_answer: { revision: 1, source, option_id: 'file' } }
  : { id: 'B1', attention: { state: 'later', actor: 'user', source } };
const resolution = (source, record_revision) => ({ id: 'B1', status: 'resolved', resolution: {
  actor: 'agent', source, note: 'The operation now succeeds', record_revision,
} });
const readAcknowledgment = source => ({ id: 'Q1', status: 'resolved', resolution: {
  actor: 'user', source, note: 'The user marked the explanation as read.',
} });
const dismissal = (source, actor = 'user') => ({ id: 'Q1', status: 'dismissed', dismissal: {
  actor, source, reason: 'The access explanation no longer applies.',
} });

for (const kind of ['answer', 'Later']) for (const timing of kind === 'answer'
  ? ['prior write', 'same write', 'replaced history'] : ['prior write', 'replaced history']) {
  test(`a direct human ${kind} source from ${timing} cannot become independent Blocker verification`, async t => {
    const { dir, state } = await setup(t);
    // Source spelling supplies no authority: this is structurally a human report.
    const source = `tool:human-${kind}-${timing.replaceAll(' ', '-')}`;
    let before = state;
    if (timing !== 'same write') before = await updateJournal(dir, 'c', update(1, { blockers: [report(kind, source)] }));
    if (timing === 'replaced history') {
      const replacement = kind === 'answer'
        ? { id: 'B1', user_answer: { revision: 1, source: 'message:new-choice', option_id: 'live' } }
        : { id: 'B1', attention: { state: 'pending', actor: 'agent', source: 'check:dependency', reason: 'The account read now needs this recovery path' } };
      before = await updateJournal(dir, 'c', update(2, { blockers: [replacement] }));
    }
    assert.equal(before.replies.length, 0, 'direct chat provenance has no receipt to trigger the existing exclusion');
    const patch = { ...(timing === 'same write' ? report(kind, source) : {}), ...resolution(source, before.revision) };
    await assert.rejects(updateJournal(dir, 'c', update(before.revision, { blockers: [patch] })), error => error.code === 'BLOCKER_VERIFICATION_REQUIRED');
    assert.deepEqual(await readJournal(dir, 'c'), before, 'rejecting the claimed verification must preserve all recorded input and history');
  });
}

for (const timing of ['prior write', 'same write', 'replaced history']) {
  test(`a direct human read acknowledgment source from ${timing} cannot become independent Blocker verification`, async t => {
    const { dir, state } = await setup(t);
    const source = `check:human-read-${timing.replaceAll(' ', '-')}`;
    let before = state;
    if (timing !== 'same write') before = await updateJournal(dir, 'c', update(1, { cards: [readAcknowledgment(source)] }));
    if (timing === 'replaced history') {
      before = await updateJournal(dir, 'c', update(2, { cards: [{ id: 'Q1', status: 'open', resolution: null }] }));
    }
    assert.equal(before.replies.length, 0);
    await assert.rejects(updateJournal(dir, 'c', update(before.revision, {
      ...(timing === 'same write' ? { cards: [readAcknowledgment(source)] } : {}),
      blockers: [resolution(source, 1)],
    })), error => error.code === 'BLOCKER_VERIFICATION_REQUIRED');
    assert.deepEqual(await readJournal(dir, 'c'), before);
  });
}

for (const timing of ['prior write', 'same write', 'replaced history']) {
  test(`a direct human dismissal source from ${timing} cannot become independent Blocker verification`, async t => {
    const { dir, state } = await setup(t);
    const source = `check:human-dismissal-${timing.replaceAll(' ', '-')}`;
    let before = state;
    if (timing !== 'same write') before = await updateJournal(dir, 'c', update(1, { cards: [dismissal(source)] }));
    if (timing === 'replaced history') {
      before = await updateJournal(dir, 'c', update(2, { cards: [dismissal('check:obsolete-explanation', 'agent')] }));
    }
    assert.equal(before.replies.length, 0);
    await assert.rejects(updateJournal(dir, 'c', update(before.revision, {
      ...(timing === 'same write' ? { cards: [dismissal(source)] } : {}),
      blockers: [resolution(source, 1)],
    })), error => error.code === 'BLOCKER_VERIFICATION_REQUIRED');
    assert.deepEqual(await readJournal(dir, 'c'), before);
  });
}

for (const actor of ['user', 'agent']) test(`independent agent verification remains valid after ${actor}-attributed dismissal`, async t => {
  const { dir } = await setup(t);
  const source = 'message:attributed-dismissal';
  const before = await updateJournal(dir, 'c', update(1, { cards: [dismissal(source, actor)] }));
  const evidence = actor === 'agent' ? source : 'check:account-read-succeeded';
  const saved = await updateJournal(dir, 'c', update(2, { blockers: [resolution(evidence, 1)] }));
  assert.equal(saved.blockers[0].status, 'resolved');
  assert.deepEqual(saved.cards, before.cards);
  assert.deepEqual(saved.history.slice(0, 2), before.history);
  assert.deepEqual(await readJournal(dir, 'c'), saved);
});

test('independent agent verification remains valid after a direct human read acknowledgment', async t => {
  const { dir } = await setup(t);
  const before = await updateJournal(dir, 'c', update(1, { cards: [readAcknowledgment('message:read')] }));
  const saved = await updateJournal(dir, 'c', update(2, { blockers: [resolution('check:account-read-succeeded', 1)] }));
  assert.equal(saved.blockers[0].status, 'resolved');
  assert.deepEqual(saved.cards, before.cards);
  assert.deepEqual(saved.history.slice(0, 2), before.history);
  assert.deepEqual(await readJournal(dir, 'c'), saved);
});

for (const kind of ['answer', 'Later']) test(`independent agent verification still resolves a Blocker after a direct ${kind} report`, async t => {
  const { dir } = await setup(t);
  const before = await updateJournal(dir, 'c', update(1, { blockers: [report(kind, 'message:human-recovery')] }));
  const saved = await updateJournal(dir, 'c', update(2, { blockers: [resolution('check:account-read-succeeded', 2)] }));
  assert.equal(saved.blockers[0].status, 'resolved');
  assert.equal(saved.blockers[0].resolution.actor, 'agent');
  assert.deepEqual(saved.history.slice(0, 2), before.history);
  assert.deepEqual(await readJournal(dir, 'c'), saved);
});

for (const kind of ['answer', 'read acknowledgment', 'dismissal']) test(`legacy resolution that reused a direct human ${kind} source remains readable without rewriting its history`, async t => {
  const { dir } = await setup(t);
  const source = 'message:legacy-choice';
  const legacy = await updateJournal(dir, 'c', update(1, kind === 'answer'
    ? { blockers: [report('answer', source)] }
    : { cards: [kind === 'read acknowledgment' ? readAcknowledgment(source) : dismissal(source)] }));
  const before = structuredClone(legacy.blockers[0]), turn = update(2).turn;
  const after = { ...before, ...resolution(source, kind === 'answer' ? 2 : 1), last_changed_turn: turn.id };
  legacy.blockers[0] = after;
  legacy.history.push({ revision: 3, turn_id: turn.id, changes: [
    { collection: 'blockers', id: 'B1', before, after },
    { collection: 'turn', id: turn.id, before: legacy.turn, after: turn },
  ] });
  legacy.turn = turn; legacy.revision = 3;
  await fs.writeFile(path.join(dir, 'c.json'), JSON.stringify(legacy));
  assert.deepEqual(await readJournal(dir, 'c'), legacy);
  const retained = await updateJournal(dir, 'c', update(3));
  assert.deepEqual(retained.blockers, legacy.blockers);
  assert.deepEqual(retained.history.slice(0, 3), legacy.history);
});
