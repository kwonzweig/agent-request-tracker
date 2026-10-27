import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { readJournal, updateJournal } from '../src/store.mjs';
import { legacyDoneFixture } from './legacy-done-fixture.mjs';

const request = { id: 'R1', title: 'Prepare the report', done_when: 'The report is verified', source: 'user:1', status: 'active' };
const result = { id: 'R1', status: 'done', evidence: ['Verified the report.', 'Checked the source links.'],
  urls: [{ label: 'Report', url: 'https://example.com/report' }] };
const update = (revision, upsert = {}) => ({ expected_revision: revision,
  turn: { id: `T${revision + 1}`, source: `agent:${revision + 1}`, summary: 'Save the current result', end_reason: null }, upsert });
const completion = state => state.cards.filter(card => card.type === 'completion');
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'journal-completion-card-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function finished(t) {
  const dir = await directory(t);
  await updateJournal(dir, 'c', update(0, { requests: [request] }));
  const state = await updateJournal(dir, 'c', update(1, { requests: [result] }));
  assert.equal(completion(state).length, 1, 'the completion event creates one card');
  return { dir, state };
}
function acknowledgment(card, record_revision, id = 'seen-result', kind = 'resolve') {
  return { id, source: `user:${id}`, items: [{ collection: 'cards', id: card.id, record_revision, kind, outcome: 'accepted',
    ...(kind === 'comment' ? { text: 'I read the completed report.' } : {}) }] };
}

test('a newly done Request commits one open completion snapshot with readable evidence and result links', async t => {
  const { dir, state } = await finished(t), cards = completion(state);
  assert.equal(cards.length, 1);
  assert.match(cards[0].id, /^completion-[A-Za-z0-9.-]+$/);
  assert.deepEqual(cards[0], { id: cards[0].id, request_id: 'R1', revision: 1, type: 'completion', title: 'Prepare the report',
    body: '- Verified the report.\n- Checked the source links.', source: 'agent:2', status: 'open',
    completion: { request_revision: 2 }, urls: result.urls });
  assert.deepEqual(state.history.at(-1).changes.find(change => change.collection === 'cards').after, cards[0]);
  assert.deepEqual(await readJournal(dir, 'c'), state);
  const schema = JSON.parse(await readFile('schema/journal.schema.json', 'utf8'));
  const validate = new Ajv({ strict: false }).compile(schema);
  assert.equal(validate(state), true, JSON.stringify(validate.errors));
});

test('initial done Requests generate deterministic identities even with a maximum-length Request id', async t => {
  const a = await directory(t), b = await directory(t), id = 'R'.repeat(128);
  const initial = update(0, { requests: [{ ...request, id, status: 'done', evidence: 'The report is verified.' }] });
  const first = await updateJournal(a, 'c', initial), second = await updateJournal(b, 'c', initial);
  assert.equal(completion(first).length, 1);
  assert.deepEqual(completion(first), completion(second));
  assert.ok(completion(first)[0].id.length <= 128);
  assert.equal(completion(first)[0].body, 'The report is verified.');
});

for (const kind of ['resolve', 'comment']) test(`${kind} acknowledgment closes only the notification and repeated saves preserve it`, async t => {
  const { dir, state } = await finished(t), card = completion(state)[0], reply = acknowledgment(card, 2, `seen-${kind}`, kind);
  const seen = await updateJournal(dir, 'c', update(2, { replies: [reply], cards: [{ id: card.id, status: 'resolved',
    resolution: { actor: 'user', source: reply.source, note: 'The user read the completed result.' } }] }));
  assert.equal(seen.requests[0].status, 'done');
  assert.equal(completion(seen)[0].status, 'resolved');
  const repeated = await updateJournal(dir, 'c', update(3, { requests: [result] }));
  assert.deepEqual(completion(repeated), completion(seen));
  assert.equal(repeated.history.at(-1).changes.some(change => change.collection === 'cards'), false);
});

test('an unacknowledged completion retires on reopening and completing again creates a new event', async t => {
  const { dir, state } = await finished(t), first = completion(state)[0];
  const reopened = await updateJournal(dir, 'c', update(2, { requests: [{ id: 'R1', status: 'active' }] }));
  const old = completion(reopened)[0];
  assert.equal(old.status, 'superseded');
  assert.equal(old.resolution.actor, 'agent');
  assert.equal(old.resolution.source, 'agent:3');
  assert.ok(old.resolution.note.trim());
  const again = await updateJournal(dir, 'c', update(3, { requests: [result] }));
  assert.equal(completion(again).length, 2);
  assert.equal(completion(again)[0].status, 'superseded');
  assert.notEqual(completion(again)[1].id, first.id);
  assert.deepEqual(completion(again)[1].completion, { request_revision: 4 });
  assert.equal(completion(again)[1].status, 'open');
});

test('reopening preserves an acknowledged historical completion', async t => {
  const { dir, state } = await finished(t), card = completion(state)[0];
  const seen = await updateJournal(dir, 'c', update(2, { cards: [{ id: card.id, status: 'resolved',
    resolution: { actor: 'user', source: 'user:read-in-chat', note: 'The user read the result in the chat.' } }] }));
  const reopened = await updateJournal(dir, 'c', update(3, { requests: [{ id: 'R1', status: 'waiting' }] }));
  assert.deepEqual(completion(reopened), completion(seen));
});

test('a substantive changed done outcome creates a fresh snapshot while evidence and link edits alone do not', async t => {
  const { dir, state } = await finished(t);
  const wording = await updateJournal(dir, 'c', update(2, { requests: [{ id: 'R1', evidence: 'A clearer verification citation.',
    urls: [{ label: 'Report', url: 'https://example.com/new-report' }] }] }));
  assert.deepEqual(completion(wording), completion(state));
  const changed = await updateJournal(dir, 'c', update(3, { requests: [{ id: 'R1', title: 'Prepare the expanded report', evidence: 'The expanded report is verified.' }] }));
  assert.equal(completion(changed).length, 2);
  assert.equal(completion(changed)[0].status, 'superseded');
  assert.equal(completion(changed)[1].title, 'Prepare the expanded report');
  assert.equal(completion(changed)[1].body, 'The expanded report is verified.');
  assert.deepEqual(completion(changed)[1].urls, [{ label: 'Report', url: 'https://example.com/new-report' }]);
});

test('legacy already-done Requests are not backfilled by reading or an unrelated save', async t => {
  const { dir, state } = await finished(t), legacy = structuredClone(state);
  legacy.cards = []; legacy.history.forEach(entry => { entry.changes = entry.changes.filter(change => change.collection !== 'cards'); });
  await writeFile(join(dir, 'c.json'), JSON.stringify(legacy));
  const read = await readJournal(dir, 'c'); assert.deepEqual(read, legacy);
  const unrelated = await updateJournal(dir, 'c', update(2, { requests: [{ ...request, id: 'R2' }] }));
  assert.equal(completion(unrelated).length, 0);
});

test('invalid evidence and unfinished child outcomes fail atomically without a notification', async t => {
  const dir = await directory(t), before = await updateJournal(dir, 'c', update(0, { requests: [request, { ...request, id: 'R2', parent_id: 'R1' }] }));
  await assert.rejects(updateJournal(dir, 'c', update(1, { requests: [{ id: 'R1', status: 'done' }] })), error => error.code === 'MISSING_EVIDENCE');
  assert.deepEqual(await readJournal(dir, 'c'), before);
  await assert.rejects(updateJournal(dir, 'c', update(1, { requests: [result] })), error => error.code === 'UNFINISHED_CHILD');
  assert.deepEqual(await readJournal(dir, 'c'), before);
});

test('generated completion identity and result content cannot be spoofed or edited through card patches', async t => {
  const { dir, state } = await finished(t), card = completion(state)[0];
  for (const patch of [{ ...card, id: 'forged-completion' }, { id: card.id, revision: 2, body: 'An invented result.' },
    { id: card.id, completion: { request_revision: 1 } }, { id: card.id, request_id: 'R2' }]) {
    await assert.rejects(updateJournal(dir, 'c', update(2, { cards: [patch] })), error => error.code === 'GENERATED_COMPLETION_IMMUTABLE');
    assert.deepEqual(await readJournal(dir, 'c'), state);
  }
  await assert.rejects(updateJournal(dir, 'c', update(2, { cards: [{ id: card.id, status: 'resolved',
    resolution: { actor: 'agent', source: 'agent:request-done', note: 'The Request is done.' } }] })), error => error.code === 'ACKNOWLEDGMENT_REQUIRED');
  assert.deepEqual(await readJournal(dir, 'c'), state);
});

test('a late resolve receipt for a retired completion is stale and cannot acknowledge a new event', async t => {
  const { dir, state } = await finished(t), card = completion(state)[0];
  await updateJournal(dir, 'c', update(2, { requests: [{ id: 'R1', status: 'active' }] }));
  const again = await updateJournal(dir, 'c', update(3, { requests: [result] })), late = acknowledgment(card, 2, 'late-result');
  await assert.rejects(updateJournal(dir, 'c', update(4, { replies: [late] })), error => error.code === 'STALE_REPLY');
  late.items[0].outcome = 'stale';
  const recorded = await updateJournal(dir, 'c', update(4, { replies: [late] }));
  assert.deepEqual(completion(recorded), completion(again));
  assert.deepEqual(await readJournal(dir, 'c'), recorded);
});

for (const collection of ['decisions', 'blockers']) test(`a contradictory Done with an unresolved ${collection} item fails atomically`, async t => {
  const dir = await directory(t);
  const item = collection === 'decisions' ? { id: 'D1', request_id: 'R1', revision: 1, question: 'Which source?', why: 'The source needs approval',
    options: [{ id: 'A', label: 'Use source A', impact: 'Uses A' }], no_answer_behavior: 'Wait', status: 'open', required: true }
    : { id: 'B1', request_id: 'R1', title: 'Source unavailable', evidence: 'tool:denied', next_action: 'Restore access', owner: 'user', status: 'open',
      attention: { state: 'later', actor: 'user', source: 'user:later' } };
  const before = await updateJournal(dir, 'c', update(0, { requests: [request], [collection]: [item] }));
  await assert.rejects(updateJournal(dir, 'c', update(1, { requests: [result] })), error =>
    error.code === (collection === 'decisions' ? 'UNRESOLVED_DECISION' : 'UNRESOLVED_BLOCKER'));
  assert.deepEqual(await readJournal(dir, 'c'), before);
  const independent = await updateJournal(dir, 'c', update(1, { requests: [{ ...request, ...result, id: 'R2' }] }));
  assert.equal(completion(independent).length, 1);
  assert.equal(completion(independent)[0].request_id, 'R2');
});

test('reopening and completing within the same turn produces a new commit-bound notification', async t => {
  const { dir, state } = await finished(t), old = completion(state)[0];
  const reopen = update(2, { requests: [{ id: 'R1', status: 'active' }] }); reopen.turn.id = 'T2';
  await updateJournal(dir, 'c', reopen);
  const again = update(3, { requests: [result] }); again.turn.id = 'T2';
  const saved = await updateJournal(dir, 'c', again);
  assert.equal(completion(saved).length, 2);
  assert.notEqual(completion(saved)[1].id, old.id);
  assert.deepEqual(completion(saved)[1].completion, { request_revision: 4 });
  assert.deepEqual(saved.history.slice(1).map(entry => entry.turn_id), ['T2', 'T2', 'T2']);
});

test('a completed parent checks included descendant inputs while explicitly excluded descendants remain independent', async t => {
  const dir = await directory(t);
  const child = { ...request, id: 'R2', parent_id: 'R1', status: 'done', evidence: 'The child artifact was saved by an older writer.' };
  const blocker = { id: 'B2', request_id: 'R2', title: 'Child verification missing', evidence: 'tool:denied', next_action: 'Verify child', owner: 'user', status: 'open' };
  const legacy = await legacyDoneFixture(dir, 'c', update(0, { requests: [request, child], blockers: [blocker] }));
  await assert.rejects(updateJournal(dir, 'c', update(1, { requests: [result] })), error => error.code === 'UNRESOLVED_BLOCKER');
  assert.deepEqual(await readJournal(dir, 'c'), legacy);
  const excluded = await updateJournal(dir, 'c', update(1, { requests: [{ id: 'R2', scope_exclusion_source: 'user:exclude-child' }, result] }));
  assert.equal(completion(excluded).length, 1);
  assert.equal(completion(excluded)[0].request_id, 'R1');
});

test('presentation-only card edits retain acknowledgment and reject an old receipt being reused as a new result', async t => {
  const { dir, state } = await finished(t), card = completion(state)[0], reply = acknowledgment(card, 2);
  const seen = await updateJournal(dir, 'c', update(2, { replies: [reply], cards: [{ id: card.id, status: 'resolved',
    resolution: { actor: 'user', source: reply.source, note: 'The user read this result.' } }] }));
  const presented = await updateJournal(dir, 'c', update(3, { cards: [{ id: card.id, nudge: { text: 'Keep the report nearby.', priority: 'normal' } }] }));
  assert.equal(completion(presented)[0].status, 'resolved');
  assert.deepEqual(completion(presented)[0].resolution, completion(seen)[0].resolution);
  const revised = await updateJournal(dir, 'c', update(4, { requests: [{ id: 'R1', title: 'Prepare the revised report', evidence: 'The revised report is verified.' }] }));
  const next = completion(revised)[1];
  await assert.rejects(updateJournal(dir, 'c', update(5, { cards: [{ id: next.id, status: 'resolved',
    resolution: completion(seen)[0].resolution }] })), error => error.code === 'REPLY_RESOLUTION_MISMATCH');
  assert.deepEqual(await readJournal(dir, 'c'), revised);
});

for (const state of ['active', 'recompleted']) test(`a retired completion cannot become pending while its Request is ${state}`, async t => {
  const { dir, state: done } = await finished(t), old = completion(done)[0];
  let saved = await updateJournal(dir, 'c', update(2, { requests: [{ id: 'R1', status: 'active' }] }));
  if (state === 'recompleted') saved = await updateJournal(dir, 'c', update(3, { requests: [result] }));
  for (const patch of [
    { id: old.id, status: 'open' },
    { id: old.id, status: 'answered' },
    { id: old.id, status: 'deferred' },
    { id: old.id, status: 'answered', attention: { state: 'pending', actor: 'agent', source: 'agent:old-result', reason: 'Review the old result' } },
    { id: old.id, attention: { state: 'pending', actor: 'agent', source: 'agent:old-result', reason: 'Review the old result' } },
  ]) {
    await assert.rejects(updateJournal(dir, 'c', update(saved.revision, { cards: [patch] })), error => error.code === 'RETIRED_COMPLETION_EVENT');
    assert.deepEqual(await readJournal(dir, 'c'), saved, 'retired completion and current result remain unchanged');
  }
  if (state === 'recompleted') {
    const current = completion(saved)[1];
    const later = await updateJournal(dir, 'c', update(4, { cards: [{ id: current.id,
      attention: { state: 'later', actor: 'user', source: 'user:current-later' } }] }));
    assert.equal(completion(later)[1].attention.state, 'later');
    const reply = acknowledgment(completion(later)[1], 5, 'current-result');
    const seen = await updateJournal(dir, 'c', update(5, { replies: [reply], cards: [{ id: current.id, status: 'resolved',
      resolution: { actor: 'user', source: reply.source, note: 'The user read the current completed result.' } }] }));
    assert.equal(completion(seen)[1].status, 'resolved');
    assert.equal(completion(seen)[0].status, 'superseded');
  }
});

for (const kind of ['resolved', 'acknowledged']) test(`${kind} completion history remains readable but cannot be reopened after the Request stops being Done`, async t => {
  const { dir, state } = await finished(t), card = completion(state)[0];
  const closure = kind === 'resolved' ? { status: 'resolved',
    resolution: { actor: 'user', source: 'user:read-original', note: 'The user read the original result.' } }
    : { attention: { state: 'acknowledged', actor: 'user', source: 'user:read-original' } };
  const acknowledged = await updateJournal(dir, 'c', update(2, { cards: [{ id: card.id, ...closure }] }));
  const active = await updateJournal(dir, 'c', update(3, { requests: [{ id: 'R1', status: 'active' }] }));
  assert.deepEqual(completion(active), completion(acknowledged));
  assert.deepEqual(await readJournal(dir, 'c'), active);
  const reopen = kind === 'resolved' ? { status: 'open' } : { attention: {
    state: 'pending', actor: 'agent', source: 'agent:old-result', reason: 'Review the old result' } };
  await assert.rejects(updateJournal(dir, 'c', update(4, { cards: [{ id: card.id, ...reopen }] })), error => error.code === 'RETIRED_COMPLETION_EVENT');
  assert.deepEqual(await readJournal(dir, 'c'), active);
});
