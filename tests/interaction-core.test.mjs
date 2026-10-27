import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import * as views from '../src/journal-views.mjs';
import { ReplyDrafts, hasChoices } from '../src/reply-ui.mjs';
import { formatReplyText } from '../src/reply-text.mjs';
import { evaluateStop, readJournal, updateJournal, validateJournal } from '../src/store.mjs';
import { legacyBlockerFixture } from './legacy-blocker-fixture.mjs';

const request = (id = 'R1', extra = {}) => ({ id, title: 'Deliver outcome', done_when: 'Verified output', source: 'user:1', status: 'active', ...extra });
const defined = record => Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
const decision = (extra = {}) => defined({ id: 'D1', request_id: 'R1', revision: 1, question: 'Which route?', why: 'Effects differ',
  options: [{ id: 'A', label: 'Route A', impact: 'First effect' }], no_answer_behavior: 'Wait for permission', status: 'open', required: true, ...extra });
const card = (id = 'C1', extra = {}) => defined({ id, request_id: 'R1', revision: 1, type: 'suggestion', title: 'Preference',
  body: 'An optional preference', source: 'agent:1', status: 'open', options: [{ id: 'A', label: 'A', impact: 'First effect' }], ...extra });
const blocker = (extra = {}) => ({ id: 'B1', request_id: 'R1', title: 'Access blocked', evidence: 'tool:denied', next_action: 'Grant access', owner: 'user', status: 'open', ...extra });
const update = (expected_revision, upsert = {}, end_reason = null) => ({ expected_revision,
  turn: { id: `T${expected_revision + 1}`, source: 'user:1', summary: 'Record interaction', end_reason }, upsert });
const receipt = (kind, collection = 'cards', id = 'C1', record_revision = 1, extra = {}) => ({
  id: `reply-${kind}`, source: `user:${kind}`, items: [{ collection, id, record_revision, kind, outcome: 'accepted', ...extra }],
});
async function inTemp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-interaction-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
async function initial(t, extra = {}) {
  const dir = await inTemp(t);
  await updateJournal(dir, 'c', update(0, { requests: [request()], decisions: [decision()], blockers: [blocker()], cards: [card()], ...extra }));
  return dir;
}
function fn(name) { assert.equal(typeof views[name], 'function', `${name} must be exported`); return views[name]; }
function storage() { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; }

test('terminal outcomes leave Attention without another acknowledgment; pending and postponed inputs stay distinct', () => {
  const state = fn('attentionState'), needs = fn('needsAttention');
  for (const record of [decision({ status: 'superseded' }), blocker({ status: 'resolved' }),
    card('C2', { type: 'qa', options: undefined, status: 'resolved' }), card('C3', { type: 'note', options: undefined, status: 'superseded' }),
    card('C4', { status: 'answered', resolution: { actor: 'agent', source: 'agent:1', note: 'Inferred preference', option_id: 'A' } })]) {
    assert.equal(state(record), 'pending'); assert.equal(needs(record), false);
  }
  assert.equal(needs(card()), true);
  assert.equal(needs(card('Q1', { type: 'qa', options: undefined, status: 'answered' })), true);
  assert.equal(state(card('C1', { user_answer: { revision: 1, source: 'user:1', option_id: 'A' } })), 'acknowledged');
  assert.equal(state(card('C1', { revision: 2, user_answer: { revision: 1, source: 'user:1', option_id: 'A' } })), 'pending');
  assert.equal(state(card('C1', { user_answer: { revision: 1, source: ' ', option_id: 'A' } })), 'pending');
  assert.equal(needs(card('C1', { user_answer: { revision: 1, source: 'user:1', option_id: 'A' } })), false);
  for (const attentionState of ['pending', 'later', 'acknowledged']) {
    const record = card('C1', { user_answer: { revision: 1, source: 'user:1', option_id: 'A' }, attention: { state: attentionState, actor: 'user', source: 'user:2' } });
    assert.equal(state(record), attentionState); assert.equal(needs(record), attentionState === 'pending');
  }
});

test('attention queue hides Later and preserves stable priority; workspace inheritance stops at explicit null', () => {
  const journal = { requests: [request('R1', { workspace: { id: 'PR #1', url: 'https://example.com/pr/1' } }),
    request('R2', { parent_id: 'R1' }), request('R3', { parent_id: 'R2', workspace: null }),
    request('R4', { parent_id: 'R3' }), request('R5', { parent_id: 'R2', workspace: { id: 'Ticket #2', url: 'https://example.com/ticket/2' } })],
    decisions: [decision()], blockers: [blocker({ nudge: { text: 'Access still needed', priority: 'high' } })],
    cards: [card('C1', { attention: { state: 'later', actor: 'user', source: 'user:2' }, nudge: { text: 'Check this', priority: 'high' } }),
      card('C2', { attention: { state: 'acknowledged', actor: 'user', source: 'user:3' } }), card('C3')] };
  assert.deepEqual(fn('attentionItems')(journal).map(item => [item.collection, item.record.id]),
    [['blockers', 'B1'], ['decisions', 'D1'], ['cards', 'C3']]);
  assert.deepEqual(fn('inheritedWorkspace')(journal, 'R2'), journal.requests[0].workspace);
  assert.equal(fn('inheritedWorkspace')(journal, 'R4'), null);
  assert.deepEqual(fn('inheritedWorkspace')(journal, 'R5'), journal.requests[4].workspace);
  assert.equal(fn('inheritedWorkspace')(journal, 'missing'), null);
});

test('attention and nudge persist across turns; agent cannot claim user acknowledgment or Later', async t => {
  const dir = await initial(t);
  const later = await updateJournal(dir, 'c', update(1, { cards: [{ id: 'C1', attention: { state: 'later', actor: 'user', source: 'user:later', reason: 'Read next time' },
    nudge: { text: 'Still relevant', priority: 'high' } }] }));
  const next = await updateJournal(dir, 'c', update(2));
  assert.deepEqual(next.cards[0], later.cards[0]);
  assert.equal(fn('needsAttention')(next.cards[0]), false);
  for (const attention of [{ state: 'acknowledged', actor: 'agent', source: 'agent:3' },
    { state: 'later', actor: 'agent', source: 'agent:3' }, { state: 'pending', actor: 'agent', source: ' ' },
    { state: 'pending', actor: 'user', source: 'user:3', reason: ' ' }, { state: 'seen', actor: 'user', source: 'user:3' }]) {
    await assert.rejects(updateJournal(dir, 'c', update(3, { cards: [{ id: 'C1', attention }] })), error => error.code === 'INVALID_ATTENTION');
  }
  for (const nudge of [{ text: '', priority: 'high' }, { text: 'Read', priority: 'urgent' }, []]) {
    await assert.rejects(updateJournal(dir, 'c', update(3, { cards: [{ id: 'C1', nudge }] })), error => error.code === 'INVALID_NUDGE');
  }
  const reopened = await updateJournal(dir, 'c', update(3, { cards: [{ id: 'C1', attention: { state: 'pending', actor: 'agent', source: 'agent:4', reason: 'New context' } }] }));
  assert.equal(fn('attentionState')(reopened.cards[0]), 'pending');
});

test('Later receipts alone do not mutate cards; atomic user attention preserves status and allows a later answer', async t => {
  const dir = await initial(t);
  const deferred = receipt('defer');
  const received = await updateJournal(dir, 'c', update(1, { replies: [deferred] }));
  assert.equal(Object.hasOwn(received.cards[0], 'attention'), false);
  const later = await updateJournal(dir, 'c', update(2, { replies: [deferred], cards: [{ id: 'C1', attention: { state: 'later', actor: 'user', source: deferred.source } }] }));
  assert.equal(later.cards[0].status, 'open'); assert.equal(later.cards[0].revision, 1);
  assert.equal(fn('attentionState')(later.cards[0]), 'later');
  assert.equal(hasChoices('cards', later.cards[0]), true);
  const answer = { ...receipt('answer', 'cards', 'C1', 3, { option_id: 'A' }), source: 'user:answer-later' };
  const answered = await updateJournal(dir, 'c', update(3, { replies: [answer], cards: [{ id: 'C1', status: 'answered',
    user_answer: { revision: 1, source: answer.source, option_id: 'A' } }] }));
  assert.equal(fn('attentionState')(answered.cards[0]), 'acknowledged');
  assert.equal(answered.cards[0].user_answer.source, answer.source);
});

test('acknowledgment binds current closed cards and does not resolve underlying work', async t => {
  const dir = await initial(t);
  await updateJournal(dir, 'c', update(1, { blockers: [{ id: 'B1', status: 'resolved', resolution: { actor: 'agent', source: 'tool:access', note: 'Access now works', record_revision: 1 } }] }));
  const ack = receipt('acknowledge', 'blockers', 'B1', 2);
  const seen = await legacyBlockerFixture(dir, 'c', update(2, { replies: [ack], blockers: [{ id: 'B1', attention: { state: 'acknowledged', actor: 'user', source: ack.source } }] }, 'complete'));
  assert.equal(seen.blockers[0].status, 'resolved');
  assert.equal(fn('needsAttention')(seen.blockers[0]), false);
  assert.equal(seen.requests[0].status, 'active');
  assert.equal(evaluateStop(seen, { turnId: 'T3' }).allowed, false);
});

test('new actions reject invalid target types, conflicting actions, and stale acceptance', async t => {
  const dir = await initial(t, { cards: [card(), card('N1', { type: 'note', options: undefined })] });
  for (const invalid of [receipt('acknowledge', 'requests', 'R1'), receipt('resolve', 'decisions', 'D1'),
    receipt('resolve', 'cards', 'C1'), receipt('dismiss', 'blockers', 'B1'),
    receipt('defer', 'cards', 'N1'), { ...receipt('defer'), items: [receipt('defer').items[0], receipt('acknowledge').items[0]] }]) {
    await assert.rejects(updateJournal(dir, 'c', update(1, { replies: [invalid] })), error => error.code === 'INVALID_REPLY');
  }
  await updateJournal(dir, 'c', update(1, { cards: [{ id: 'C1', revision: 2, title: 'Changed preference' }] }));
  await assert.rejects(updateJournal(dir, 'c', update(2, { replies: [receipt('defer')] })), error => error.code === 'STALE_REPLY');
  const stale = receipt('defer'); stale.items[0].outcome = 'stale';
  const saved = await updateJournal(dir, 'c', update(2, { replies: [stale] }));
  assert.equal(saved.replies[0].items[0].outcome, 'stale');
  assert.equal(fn('attentionState')(saved.cards[0]), 'pending');
  await assert.rejects(updateJournal(dir, 'c', update(3, { replies: [stale], cards: [{ id: 'C1', attention: { state: 'later', actor: 'user', source: stale.source } }] })), error => error.code === 'REPLY_ATTENTION_MISMATCH');
});

test('atomic attention rejects unrelated receipts and Later cannot change semantic choices or permission', async t => {
  const dir = await initial(t);
  const defer = receipt('defer', 'decisions', 'D1');
  for (const patch of [{ attention: { state: 'acknowledged', actor: 'user', source: defer.source } },
    { attention: { state: 'later', actor: 'user', source: defer.source }, status: 'deferred' },
    { attention: { state: 'later', actor: 'user', source: defer.source }, revision: 2, required: false },
    { attention: { state: 'later', actor: 'user', source: defer.source }, revision: 2, question: 'New question?' }]) {
    await assert.rejects(updateJournal(dir, 'c', update(1, { replies: [defer], decisions: [{ id: 'D1', ...patch }] })),
      error => error.code === 'REPLY_ATTENTION_MISMATCH');
  }
  const later = await updateJournal(dir, 'c', update(1, { replies: [defer], decisions: [{ id: 'D1', attention: { state: 'later', actor: 'user', source: defer.source } }] }, 'decision'));
  assert.equal(later.decisions[0].required, true); assert.equal(later.decisions[0].status, 'open');
  assert.equal(evaluateStop(later, { turnId: 'T2' }).allowed, false); // the hidden constraint needs a dependency reopening before handback
  const comment = receipt('comment', 'cards', 'C1', 1, { text: 'A comment, not an acknowledgment' });
  const received = await updateJournal(dir, 'c', update(2, { replies: [comment] }));
  assert.equal(fn('attentionState')(received.cards[0]), 'pending');
  assert.equal(received.cards[0].status, 'open'); // receipt alone never interprets the comment
});

test('agent resolution is distinct from human answers and only explicitly optional decisions allow inferred answers', async t => {
  const dir = await initial(t, { decisions: [decision({ required: false })] });
  const resolution = { actor: 'agent', source: 'agent:2', note: 'Used the stated default', option_id: 'A' };
  const saved = await updateJournal(dir, 'c', update(1, { decisions: [{ id: 'D1', status: 'answered', resolution }],
    cards: [{ id: 'C1', status: 'answered', resolution }] }, 'decision'));
  assert.equal(saved.decisions[0].user_answer, undefined);
  assert.deepEqual(saved.decisions[0].resolution, resolution);
  assert.equal(fn('attentionState')(saved.decisions[0]), 'pending');
  assert.equal(evaluateStop(saved, { turnId: 'T2' }).allowed, false);
  await assert.rejects(updateJournal(dir, 'c', update(2, { decisions: [{ id: 'D1', user_answer: { revision: 1, source: 'user:3', option_id: 'A' } }] })), error => error.code === 'INVALID_DECISION');
  for (const required of [true, null, undefined]) {
    const other = await inTemp(t); await updateJournal(other, 'c', update(0, { requests: [request()], decisions: [decision({ required })] }));
    await assert.rejects(updateJournal(other, 'c', update(1, { decisions: [{ id: 'D1', status: 'answered', resolution }] })), error => error.code === 'MISSING_PERMISSION');
  }
});

test('resolution validates provenance and choices, is cleared on material choice revision, and user answer does not become agent consent', async t => {
  const dir = await initial(t);
  for (const resolution of [{ actor: 'agent', source: ' ', note: 'Default', option_id: 'A' },
    { actor: 'bot', source: 'agent:2', note: 'Default', option_id: 'A' },
    { actor: 'agent', source: 'agent:2', note: ' ', option_id: 'A' },
    { actor: 'agent', source: 'agent:2', note: 'Default', option_id: 'missing' }]) {
    await assert.rejects(updateJournal(dir, 'c', update(1, { cards: [{ id: 'C1', status: 'answered', resolution }] })), error => ['INVALID_RESOLUTION', 'INVALID_CARD'].includes(error.code));
  }
  await updateJournal(dir, 'c', update(1, { cards: [{ id: 'C1', status: 'answered', resolution: { actor: 'agent', source: 'agent:2', note: 'Default', text: 'Other inference' } }] }));
  const revised = await updateJournal(dir, 'c', update(2, { cards: [{ id: 'C1', revision: 2, body: 'New effects' }] }));
  assert.equal(revised.cards[0].resolution, null); assert.equal(revised.cards[0].status, 'open');
  assert.equal(fn('attentionState')(revised.cards[0]), 'pending');
});

test('shared labeled URLs validate all record types, clear with null, and reject credentials or unsafe text', async t => {
  const dir = await initial(t);
  const urls = [{ label: 'Evidence', url: 'HTTPS://EXAMPLE.COM:443/evidence?x=1#log' }];
  const linked = await updateJournal(dir, 'c', update(1, { requests: [{ id: 'R1', urls }], decisions: [{ id: 'D1', urls }], blockers: [{ id: 'B1', urls }], cards: [{ id: 'C1', urls }] }));
  for (const collection of ['requests', 'decisions', 'blockers', 'cards']) assert.deepEqual(linked[collection][0].urls, urls);
  for (const invalid of [[{ label: ' ', url: 'https://example.com' }], [{ label: 'Link', url: 'javascript:alert(1)' }],
    [{ label: 'Link', url: 'https://user:password@example.com' }], [{ label: 'Link', url: 'https://example.com/\\path' }],
    [{ label: 'Link', url: 'https://example.com/\npath' }], {}, [{ url: 'https://example.com' }]]) {
    await assert.rejects(updateJournal(dir, 'c', update(2, { cards: [{ id: 'C1', urls: invalid }] })), error => error.code === 'INVALID_URLS');
  }
  const cleared = await updateJournal(dir, 'c', update(2, { requests: [{ id: 'R1', urls: null }], decisions: [{ id: 'D1', urls: null }], blockers: [{ id: 'B1', urls: null }], cards: [{ id: 'C1', urls: null }] }));
  for (const collection of ['requests', 'decisions', 'blockers', 'cards']) assert.equal(cleared[collection][0].urls, null);
});

test('draft actions replace one another while comments coexist; stale actions need review after lost acknowledgment', () => {
  const saved = storage(), drafts = new ReplyDrafts(saved, 'c');
  const item = { collection: 'cards', id: 'C1', record_revision: 1 };
  drafts.set({ ...item, kind: 'answer', option_id: 'A' }, 'answer');
  drafts.set({ ...item, kind: 'comment', text: 'Retain this context' }, 'comment');
  drafts.set({ ...item, kind: 'defer' }, 'later');
  assert.deepEqual([...drafts.drafts.values()].map(draft => draft.kind), ['comment', 'defer']);
  const journal = { conversation_id: 'c', revision: 1, history: [{ revision: 1, changes: [{ collection: 'cards', id: 'C1' }] }],
    cards: [card()], decisions: [], blockers: [], requests: [], replies: [] };
  assert.equal(drafts.inspect(journal).items.length, 2);
  drafts.set({ ...item, kind: 'acknowledge' }, 'ack');
  assert.deepEqual([...drafts.drafts.values()].map(draft => draft.kind), ['comment', 'acknowledge']);
  const items = drafts.inspect(journal).items;
  assert.equal(drafts.stage('delivery', items), true);
  const reloaded = new ReplyDrafts(saved, 'c');
  assert.equal(reloaded.delivery.status, 'uncertain');
  assert.equal(reloaded.stage('duplicate', items), false);
  const acknowledged = { ...journal, replies: [{ id: 'delivery', source: 'user:reply', items: items.map(value => ({ ...value, outcome: value.kind === 'comment' ? 'accepted' : 'stale' })) }] };
  assert.equal(reloaded.reconcile(acknowledged), true);
  assert.equal(reloaded.inspect(acknowledged).stale.length, 1);
  assert.equal(reloaded.inspect(acknowledged).items.length, 0);
  reloaded.set({ ...item, kind: 'defer' }, 'reviewed');
  assert.equal(reloaded.inspect(journal).stale.length, 0);
  assert.equal(reloaded.inspect(journal).items[0].kind, 'defer');
});

test('drafts and reply text support current deferred choices, action labels, and safe display', () => {
  assert.equal(hasChoices('decisions', decision({ status: 'deferred' })), true);
  const saved = storage();
  saved.setItem('request-journal:replies:v1:c', JSON.stringify({ version: 1, delivery: null,
    drafts: [{ collection: 'blockers', id: 'B1', record_revision: 1, kind: 'acknowledge', token: 'ack' }] }));
  const restored = new ReplyDrafts(saved, 'c');
  assert.equal(restored.storageAvailable, true);
  const journal = { revision: 2, history: [{ revision: 1, changes: [{ collection: 'blockers', id: 'B1' }] },
    { revision: 2, changes: [{ collection: 'blockers', id: 'B1' }] }], blockers: [blocker()], cards: [], decisions: [], requests: [] };
  assert.equal(restored.inspect(journal).stale.length, 1);
  const text = formatReplyText([{ collection: 'cards', id: 'C1', kind: 'defer' },
    { collection: 'blockers', id: 'B1', kind: 'acknowledge' }], () => ({ title: '<unsafe>\nCard' }));
  assert.match(text, /Action: Later/); assert.match(text, /Action: Acknowledge/);
  assert.equal(text.includes('<unsafe>'), false);
});

test('schema validates new interaction shapes and stored history; legacy files remain readable', async t => {
  const schema = JSON.parse(await fs.readFile(new URL('../schema/journal.schema.json', import.meta.url), 'utf8'));
  const ajv = new Ajv({ strict: false }), validate = ajv.compile(schema);
  const legacy = await initial(t);
  assert.equal(validate(await readJournal(legacy, 'c')), true, JSON.stringify(validate.errors));
  for (const collection of ['cards', 'decisions', 'blockers']) {
    const shape = ajv.compile({ $defs: schema.$defs, $ref: `#/$defs/${collection === 'cards' ? 'card' : collection.slice(0, -1)}` });
    const record = collection === 'cards' ? card() : collection === 'decisions' ? decision() : blocker();
    assert.equal(shape({ ...record, attention: { state: 'later', actor: 'agent', source: 'agent:2' } }), false);
    assert.equal(shape({ ...record, urls: [{ label: 'Evidence', url: 'https://user:pass@example.com' }] }), false);
    assert.equal(shape({ ...record, resolution: { actor: 'agent', source: 'agent:2', note: ' ' } }), false);
    const history = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/history' });
    assert.equal(history({ revision: 1, turn_id: 'T1', changes: [{ collection, id: record.id, before: null,
      after: { ...record, attention: { state: 'acknowledged', actor: 'agent', source: 'agent:1' } } }] }), false);
  }
  const items = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/reply_item' });
  assert.equal(items(receipt('defer').items[0]), true, JSON.stringify(items.errors));
  assert.equal(items(receipt('acknowledge', 'blockers', 'B1').items[0]), true, JSON.stringify(items.errors));
  assert.equal(items(receipt('acknowledge', 'requests', 'R1').items[0]), false);
  assert.equal(items(receipt('defer', 'blockers', 'B1').items[0]), true);
  assert.equal(items(receipt('resolve', 'blockers', 'B1').items[0]), true);
  assert.equal(items(receipt('resolve', 'decisions', 'D1').items[0]), false);
  assert.equal(items(receipt('dismiss', 'blockers', 'B1').items[0]), false);
  const agent = card('C1', { status: 'answered', resolution: { actor: 'agent', source: 'agent:2', note: 'Default used', option_id: 'A' } });
  const cardShape = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/card' });
  assert.equal(cardShape(agent), true, JSON.stringify(cardShape.errors));
  assert.equal(cardShape({ ...agent, user_answer: { revision: 1, source: 'user:2', option_id: 'A' } }), false);
  const ack = receipt('acknowledge');
  const journal = await updateJournal(legacy, 'c', update(1, { replies: [ack], cards: [{ id: 'C1', attention: { state: 'acknowledged', actor: 'user', source: ack.source } }] }));
  assert.equal(validate(journal), true, JSON.stringify(validate.errors));
  const forged = structuredClone(journal);
  for (const location of [forged.cards[0], forged.history[1].changes.find(change => change.collection === 'cards').after]) location.attention.actor = 'agent';
  assert.throws(() => validateJournal(forged), error => error.code === 'INVALID_ATTENTION');
});

test('acknowledgment survives presentation updates, while materially new content invalidates prior acknowledgment and answers', async t => {
  const dir = await initial(t);
  await updateJournal(dir, 'c', update(1, { cards: [{ id: 'C1', attention: { state: 'acknowledged', actor: 'user', source: 'user:2' } }] }));
  const cosmetic = await updateJournal(dir, 'c', update(2, { cards: [{ id: 'C1', nudge: { text: 'Keep this nearby', priority: 'normal' },
    urls: [{ label: 'Context', url: 'https://example.com/context' }] }] }));
  assert.equal(fn('attentionState')(cosmetic.cards[0]), 'acknowledged');
  const changed = await updateJournal(dir, 'c', update(3, { cards: [{ id: 'C1', revision: 2, body: 'Materially new effects' }] }));
  assert.equal(fn('attentionState')(changed.cards[0]), 'pending');
  await updateJournal(dir, 'c', update(4, { cards: [{ id: 'C1', status: 'answered', user_answer: { revision: 2, source: 'user:5', option_id: 'A' } }] }));
  const changedAnswer = await updateJournal(dir, 'c', update(5, { cards: [{ id: 'C1', revision: 3, options: [{ id: 'B', label: 'B', impact: 'New choice' }] }] }));
  assert.equal(changedAnswer.cards[0].user_answer, null); assert.equal(fn('attentionState')(changedAnswer.cards[0]), 'pending');
});

test('agent inference can cite a human message but keeps its own actor and Later; acknowledgment cannot close work', async t => {
  const dir = await initial(t);
  await updateJournal(dir, 'c', update(1, { cards: [{ id: 'C1', attention: { state: 'later', actor: 'user', source: 'user:earlier-later' } }] }));
  const comment = receipt('comment', 'cards', 'C1', 2, { text: 'The usual default may be enough.' });
  const inferred = await updateJournal(dir, 'c', update(2, { replies: [comment], cards: [{ id: 'C1', status: 'answered',
    resolution: { actor: 'agent', source: comment.source, note: 'Inferred an optional preference from context', option_id: 'A' } }] }));
  assert.equal(inferred.cards[0].user_answer, undefined); assert.equal(fn('attentionState')(inferred.cards[0]), 'later');
  const ack = receipt('acknowledge', 'cards', 'C1', 3);
  await assert.rejects(updateJournal(dir, 'c', update(3, { replies: [ack], cards: [{ id: 'C1', status: 'resolved',
    attention: { state: 'acknowledged', actor: 'user', source: ack.source },
    resolution: { actor: 'agent', source: 'tool:verification', note: 'Verified a separate effect' } }] })), error => error.code === 'REPLY_ATTENTION_MISMATCH');
  await assert.rejects(updateJournal(dir, 'c', update(3, { replies: [ack], cards: [{ id: 'C1',
    resolution: { actor: 'user', source: ack.source, note: 'Claimed user closure' } }] })), error => error.code === 'REPLY_RESOLUTION_MISMATCH');
});

test('history replay rejects forged accepted stale actions and invented receipt-bound attention', async t => {
  const dir = await initial(t);
  await updateJournal(dir, 'c', update(1, { cards: [{ id: 'C1', revision: 2, body: 'Changed preference' }] }));
  const stale = receipt('defer'); stale.items[0].outcome = 'stale';
  const saved = await updateJournal(dir, 'c', update(2, { replies: [stale] }));
  const forged = structuredClone(saved);
  forged.replies[0].items[0].outcome = 'accepted';
  forged.history[2].changes.find(change => change.collection === 'replies').after.items[0].outcome = 'accepted';
  assert.throws(() => validateJournal(forged), error => error.code === 'STALE_REPLY');
  const other = await initial(t), ack = receipt('acknowledge');
  await updateJournal(other, 'c', update(1, { replies: [ack], cards: [{ id: 'C1', attention: { state: 'acknowledged', actor: 'user', source: ack.source } }] }));
  const changed = await updateJournal(other, 'c', update(2, { cards: [{ id: 'C1', revision: 2, body: 'Changed effects' }] }));
  const invalidAttention = structuredClone(changed);
  invalidAttention.history[1].changes.find(change => change.collection === 'cards').after.attention.state = 'later';
  invalidAttention.history[2].changes.find(change => change.collection === 'cards').before.attention.state = 'later';
  assert.throws(() => validateJournal(invalidAttention), error => error.code === 'REPLY_ATTENTION_MISMATCH');
});

test('new blocker evidence reopens historical acknowledgment while presentation updates preserve it', async t => {
  const dir = await initial(t);
  await legacyBlockerFixture(dir, 'c', update(1, { blockers: [{ id: 'B1', attention: { state: 'acknowledged', actor: 'user', source: 'user:2' } }] }));
  const cosmetic = await updateJournal(dir, 'c', update(2, { blockers: [{ id: 'B1', nudge: { text: 'Still relevant', priority: 'high' },
    urls: [{ label: 'Access', url: 'https://example.com/access' }] }] }));
  assert.equal(fn('attentionState')(cosmetic.blockers[0]), 'acknowledged');
  const changed = await updateJournal(dir, 'c', update(3, { blockers: [{ id: 'B1', evidence: 'tool:new-denial', next_action: 'Grant a different role' }] }));
  assert.equal(fn('attentionState')(changed.blockers[0]), 'pending');
});

test('a full-record material update cannot carry its unchanged old acknowledgment into the new version', async t => {
  const dir = await initial(t);
  const seen = await updateJournal(dir, 'c', update(1, { cards: [{ id: 'C1', attention: { state: 'acknowledged', actor: 'user', source: 'user:2' } }] }));
  const revised = await updateJournal(dir, 'c', update(2, { cards: [{ ...seen.cards[0], revision: 2, body: 'Different effects' }] }));
  assert.equal(fn('attentionState')(revised.cards[0]), 'pending');
  const forged = structuredClone(revised);
  forged.cards[0].attention = seen.cards[0].attention;
  forged.history[2].changes.find(change => change.collection === 'cards').after.attention = seen.cards[0].attention;
  assert.throws(() => validateJournal(forged), error => error.code === 'STALE_ATTENTION');
});
