import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { needsAttention } from '../src/journal-views.mjs';
import { readJournal, updateJournal } from '../src/store.mjs';

const request = { id: 'R1', title: 'Explain the current state', done_when: 'The explanation is understood', source: 'user:1', status: 'active' };
const update = (expected_revision, upsert = {}) => ({ expected_revision,
  turn: { id: `T${expected_revision + 1}`, source: 'user:1', summary: 'Record the current explanation', end_reason: null }, upsert });
const acknowledgment = (id, record_revision) => ({ id, source: `user:${id}`, items: [
  { collection: 'cards', id: 'C1', record_revision, kind: 'resolve', outcome: 'accepted' },
] });
const resolution = source => ({ actor: 'user', source, note: 'The user understood the displayed explanation.' });

async function resolvedCard(t, type) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-card-resolution-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await updateJournal(dir, 'c', update(0, { requests: [request], cards: [{
    id: 'C1', request_id: 'R1', revision: 1, type, title: 'What does Open mean?',
    body: 'The item still needs a response.', source: 'agent:1', status: 'answered',
  }] }));
  const reply = acknowledgment('understood-original', 1);
  const state = await updateJournal(dir, 'c', update(1, { replies: [reply], cards: [
    { id: 'C1', status: 'resolved', resolution: resolution(reply.source) },
  ] }));
  assert.equal(needsAttention(state.cards[0]), false);
  return { dir, state, reply };
}

for (const type of ['qa', 'note']) {
  test(`${type}: changed content or revision cannot retain its old resolved acknowledgment`, async t => {
    const { dir, state } = await resolvedCard(t, type);
    const previous = state.cards[0];
    for (const patch of [
      { ...previous, revision: 2, body: 'The explanation now describes a different operation.' },
      { id: 'C1', revision: 2, body: 'The explanation now describes a different operation.', status: 'resolved', resolution: previous.resolution },
      { id: 'C1', revision: 2, status: 'resolved', resolution: previous.resolution },
      { ...previous, revision: 2, body: 'The explanation now describes a different operation.',
        resolution: { ...previous.resolution, note: 'Rewording the note does not acknowledge the new explanation.' } },
    ]) {
      await assert.rejects(updateJournal(dir, 'c', update(2, { cards: [patch] })), error => error.code === 'STALE_ACKNOWLEDGMENT');
      assert.deepEqual(await readJournal(dir, 'c'), state, 'a rejected update must preserve the saved card, receipt, and history');
    }
  });

  test(`${type}: unchanged and presentation-only updates preserve resolution`, async t => {
    const { dir, state } = await resolvedCard(t, type);
    const noOp = await updateJournal(dir, 'c', update(2, { cards: [state.cards[0]] }));
    assert.equal(noOp.history.at(-1).changes.some(change => change.collection === 'cards'), false);
    const presented = await updateJournal(dir, 'c', update(3, { cards: [{ id: 'C1',
      nudge: { text: 'Keep this explanation nearby.', priority: 'normal' },
      urls: [{ label: 'Context', url: 'https://example.com/context' }],
    }] }));
    assert.equal(presented.cards[0].revision, 1);
    assert.equal(presented.cards[0].status, 'resolved');
    assert.deepEqual(presented.cards[0].resolution, state.cards[0].resolution);
    assert.equal(needsAttention(presented.cards[0]), false);
  });

  test(`${type}: revised content cannot stay resolved after clearing its acknowledgment`, async t => {
    const { dir, state } = await resolvedCard(t, type);
    await assert.rejects(updateJournal(dir, 'c', update(2, { cards: [{ id: 'C1', revision: 2,
      body: 'The explanation now describes a different operation.', status: 'resolved',
    }] })), error => error.code === 'ACKNOWLEDGMENT_REQUIRED');
    assert.deepEqual(await readJournal(dir, 'c'), state);
  });

  test(`${type}: reopening changed content allows a fresh acknowledgment and retains the original history`, async t => {
    const { dir, state, reply } = await resolvedCard(t, type);
    const reopened = await updateJournal(dir, 'c', update(2, { cards: [{ id: 'C1', revision: 2,
      body: 'The explanation now describes a different operation.', status: 'answered',
    }] }));
    assert.equal(reopened.cards[0].resolution, null);
    assert.equal(needsAttention(reopened.cards[0]), true);
    await assert.rejects(updateJournal(dir, 'c', update(3, { cards: [{ id: 'C1', status: 'resolved',
      resolution: state.cards[0].resolution,
    }] })), error => error.code === 'REPLY_RESOLUTION_MISMATCH');
    const fresh = acknowledgment('understood-revised', 3);
    const acknowledged = await updateJournal(dir, 'c', update(3, { replies: [fresh], cards: [{ id: 'C1',
      status: 'resolved', resolution: resolution(fresh.source),
    }] }));
    assert.equal(needsAttention(acknowledged.cards[0]), false);
    assert.equal(acknowledged.cards[0].revision, 2);
    assert.deepEqual(acknowledged.replies, [reply, fresh]);
    assert.deepEqual(acknowledged.history.slice(0, 2), state.history);
    assert.deepEqual(await readJournal(dir, 'c'), acknowledged);
  });

  test(`${type}: a retained old resolution cannot reclose reopened content through a status-only patch`, async t => {
    const { dir, state } = await resolvedCard(t, type);
    const reopened = await updateJournal(dir, 'c', update(2, { cards: [{ id: 'C1', revision: 2,
      body: 'The explanation now describes a different operation.', status: 'answered', resolution: state.cards[0].resolution,
    }] }));
    assert.equal(needsAttention(reopened.cards[0]), true);
    await assert.rejects(updateJournal(dir, 'c', update(3, { cards: [{ id: 'C1', status: 'resolved' }] })),
      error => error.code === 'STALE_ACKNOWLEDGMENT');
    assert.deepEqual(await readJournal(dir, 'c'), reopened);
  });

  test(`${type}: historical resolved revisions remain readable without rewriting old receipts`, async t => {
    const { dir, state } = await resolvedCard(t, type);
    const legacy = structuredClone(state);
    const previous = legacy.cards[0];
    const revised = { ...previous, revision: 2, body: 'A revision saved by an older writer.' };
    const nextTurn = update(2).turn;
    legacy.cards[0] = revised;
    legacy.history.push({ revision: 3, turn_id: nextTurn.id, changes: [
      { collection: 'cards', id: 'C1', before: previous, after: revised },
      { collection: 'turn', id: nextTurn.id, before: legacy.turn, after: nextTurn },
    ] });
    legacy.turn = nextTurn;
    legacy.revision = 3;
    await fs.writeFile(path.join(dir, 'c.json'), JSON.stringify(legacy));
    assert.deepEqual(await readJournal(dir, 'c'), legacy);
    const retained = await updateJournal(dir, 'c', update(3, { cards: [revised] }));
    assert.deepEqual(retained.cards[0], revised);
    assert.deepEqual(retained.replies, state.replies);
  });
}
