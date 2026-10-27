import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyDrafts, draftKey } from '../src/reply-ui.mjs';
import { memoryStorage, testLocks, previewState, commit, tick } from './ui-harness.mjs';

const items = [
  { collection: 'cards', id: 'Q1', record_revision: 3, kind: 'resolve' },
  { collection: 'blockers', id: 'B1', record_revision: 3, kind: 'comment', text: 'Original comment\nwith original context' },
];
function reopen(storage) { const drafts = new ReplyDrafts(storage, 'C1'); drafts.lockManager = testLocks; return drafts; }
function pending(outbound) {
  const storage = memoryStorage(), drafts = reopen(storage);
  items.forEach((item, index) => assert.equal(drafts.set(item, `token-${index}`), true));
  assert.equal(drafts.stage('original-delivery', items, outbound), true);
  assert.equal(drafts.deliveryStatus('uncertain', 'original-delivery'), true);
  return { storage, drafts };
}
function receipt(delivery, replacementItems = delivery.items) {
  return commit(previewState(), { replies: [{ id: delivery.id, source: 'user:4',
    items: replacementItems.map(item => ({ ...item, outcome: 'accepted' })) }] });
}
const options = (sent, journal = previewState()) => ({ getLatestJournal: async () => journal,
  transmit: async (delivery, generation) => { sent.push({ delivery: structuredClone(delivery), generation }); } });

test('an explicit retry preserves the original delivery, ordered items, tokens and frozen outbound request', async () => {
  const outbound = { role: 'user', content: [{ type: 'text', text: 'The exact original human summary' }],
    _meta: { 'openai/message': { target: 'active', send: true } } };
  const { storage, drafts } = pending(outbound), sent = [], frozen = storage.getItem(drafts.deliveryKey);
  const review = drafts.pendingReview();
  assert.equal(review.canRetry, true);
  assert.deepEqual(review.delivery.items, items);
  assert.deepEqual(review.delivery.tokens, ['token-0', 'token-1']);
  assert.deepEqual(review.delivery.outbound, outbound);
  review.delivery.items[1].text = 'A changed review';
  assert.equal((await drafts.retryDelivery(review, options(sent))).status, 'changed');
  assert.equal(sent.length, 0);
  const result = await drafts.retryDelivery(drafts.pendingReview(), options(sent));
  assert.equal(result.status, 'sent');
  assert.equal(result.generation, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].delivery.id, 'original-delivery');
  assert.equal(sent[0].delivery.conversation_id, 'C1');
  assert.deepEqual(sent[0].delivery.items, items);
  assert.deepEqual(sent[0].delivery.tokens, ['token-0', 'token-1']);
  assert.deepEqual(sent[0].delivery.outbound, outbound);
  assert.equal(storage.getItem(drafts.deliveryKey), frozen);
});

test('a render snapshot neither reads storage nor invisibly imports another surface edits', () => {
  const { storage, drafts } = pending(), other = reopen(storage);
  const observed = [...drafts.drafts], review = drafts.pendingReview();
  assert.equal(other.set({ ...items[1], text: 'A shared edit not yet rendered' }, 'new-token'), true);
  const read = storage.getItem; let reads = 0;
  storage.getItem = () => { reads++; throw Error('render must not read storage'); };
  assert.deepEqual(drafts.pendingReview({ refresh: false }), review);
  assert.equal(reads, 0);
  assert.deepEqual([...drafts.drafts], observed);
  assert.equal(drafts.storageAvailable, true);
  storage.getItem = read;
  assert.equal(drafts.pendingReview().canRetry, true);
  assert.equal(drafts.drafts.get(draftKey(items[1])).text, 'A shared edit not yet rendered');
  storage.getItem = () => { throw Error('storage unavailable'); };
  assert.equal(drafts.pendingReview().canRetry, false);
  reads = 0; storage.getItem = () => { reads++; throw Error('render must not retry failed reads'); };
  assert.equal(drafts.pendingReview({ refresh: false }).canRetry, false);
  assert.equal(reads, 0, 'an existing storage failure remains fail closed without another render read');
});

test('confirmed host success waits for a receipt in the same surface and only reopening becomes uncertain', async () => {
  const { storage, drafts } = pending(), sent = [], uncertainReview = drafts.pendingReview();
  assert.equal(drafts.deliveryStatus('waiting', 'original-delivery'), true);
  const waitingReview = drafts.pendingReview();
  assert.equal(waitingReview.status, 'waiting');
  assert.equal(waitingReview.canRetry, false);
  assert.equal((await drafts.retryDelivery(waitingReview, options(sent))).status, 'changed');
  assert.equal((await drafts.retryDelivery(uncertainReview, options(sent))).status, 'changed');
  assert.equal(sent.length, 0, 'a previously uncertain review cannot override known host success');
  const reopened = reopen(storage), reopenedReview = reopened.pendingReview();
  assert.equal(reopenedReview.status, 'uncertain');
  assert.equal(reopenedReview.canRetry, true);
  assert.equal((await reopened.retryDelivery(reopenedReview, options(sent))).status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(reopened.pendingReview().status, 'waiting');
  assert.equal(reopened.pendingReview().canRetry, false, 'a successful retry also waits for its receipt');
  assert.equal((await reopened.retryDelivery(reopened.pendingReview(), options(sent))).status, 'changed');
  assert.equal(sent.length, 1);
});

test('host success observed while retry reads the journal prevents reservation and transmission', async () => {
  const { storage, drafts } = pending(), review = drafts.pendingReview(), sent = [], before = [...storage.values];
  const result = await drafts.retryDelivery(review, { ...options(sent), getLatestJournal: async () => {
    assert.equal(drafts.deliveryStatus('waiting', 'original-delivery'), true);
    return previewState();
  } });
  assert.equal(result.status, 'changed');
  assert.equal(sent.length, 0);
  assert.deepEqual([...storage.values], before);
  assert.equal(drafts.delivery.status, 'waiting');
});

test('settlement can be checked for its originating delivery after a newer delivery settles', () => {
  const { storage, drafts } = pending(), original = drafts.pendingReview().delivery;
  assert.equal(drafts.reconcile(receipt(original)), true);
  const next = { collection: 'requests', id: 'R1', record_revision: 1, kind: 'comment', text: 'A later reply' };
  assert.equal(drafts.set(next, 'later-token'), true);
  assert.equal(drafts.stage('later-delivery', [next]), true);
  assert.equal(drafts.reconcile(receipt(drafts.pendingReview().delivery)), true);
  assert.equal(drafts.settledDeliveryId, 'later-delivery');
  const before = [...storage.values];
  assert.equal(drafts.isDeliverySettled('original-delivery'), true);
  assert.equal(drafts.isDeliverySettled('later-delivery'), true);
  assert.equal(drafts.isDeliverySettled('missing-delivery'), false);
  assert.equal(drafts.isDeliverySettled(''), false);
  assert.equal(drafts.isDeliverySettled(null), false);
  assert.deepEqual([...storage.values], before, 'checking settlement never writes or fabricates a receipt');
  const read = storage.getItem;
  storage.getItem = key => { if (key.endsWith(':receipt:original-delivery')) throw Error('receipt marker denied'); return read(key); };
  assert.equal(drafts.isDeliverySettled('original-delivery'), false);
  assert.equal(drafts.storageAvailable, false);
  assert.equal(drafts.storageFailure, 'access');
  assert.deepEqual([...storage.values], before);
});

test('simultaneous views and repeated clicks consume one reviewed retry opportunity', async () => {
  const { storage, drafts: a } = pending(), b = reopen(storage), sent = [];
  const first = a.pendingReview(), second = b.pendingReview();
  const results = await Promise.all([
    a.retryDelivery(first, options(sent)), b.retryDelivery(second, options(sent)), a.retryDelivery(first, options(sent)),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), ['changed', 'changed', 'sent']);
  assert.equal(sent.length, 1);
  assert.equal((await b.retryDelivery(second, options(sent))).status, 'changed');
  assert.equal(sent.length, 1);
  assert.equal(reopen(storage).pendingReview().generation, 1);
});

test('a snapshot observed during reservation cannot send again after that attempt finishes', async () => {
  const { storage, drafts: a } = pending(), sent = []; let finish;
  const retry = a.retryDelivery(a.pendingReview(), { getLatestJournal: async () => previewState(),
    transmit: (delivery, generation) => { sent.push({ delivery, generation }); return new Promise(resolve => { finish = resolve; }); } });
  await tick();
  const b = reopen(storage), whileSending = b.pendingReview();
  assert.equal(whileSending.attempt.status, 'reserved');
  const queued = b.retryDelivery(whileSending, options(sent));
  finish();
  assert.equal((await retry).status, 'sent');
  assert.equal((await queued).status, 'changed');
  assert.equal(sent.length, 1);
});

test('confirmed retry success stays waiting when only its completion record cannot be written', async () => {
  const { storage, drafts } = pending(), sent = [], write = storage.setItem, frozen = storage.getItem(drafts.deliveryKey);
  storage.setItem = (key, value) => {
    if (key.includes(':attempt:') && JSON.parse(value).status === 'waiting') throw Error('completion write failed');
    return write(key, value);
  };
  const result = await drafts.retryDelivery(drafts.pendingReview(), options(sent));
  assert.equal(result.status, 'sent', 'known host success is independent of completion bookkeeping');
  assert.equal(drafts.delivery.status, 'waiting');
  assert.equal(drafts.storageAvailable, false);
  assert.equal(drafts.storageFailure, 'write');
  assert.equal(drafts.pendingReview().canRetry, false);
  storage.setItem = write;
  const newer = { ...items[1], text: 'A new unsent comment after host success' };
  assert.equal(drafts.set(newer, 'new-token'), true);
  assert.equal(drafts.storageAvailable, true);
  assert.equal(drafts.pendingReview().status, 'waiting');
  assert.equal(drafts.pendingReview().canRetry, false);
  assert.equal((await drafts.retryDelivery(drafts.pendingReview(), options(sent))).status, 'changed');
  assert.equal(sent.length, 1);
  assert.equal(storage.getItem(drafts.deliveryKey), frozen);
  assert.deepEqual(drafts.drafts.get(draftKey(newer)), { ...newer, token: 'new-token' });
});

test('a second surface reservation review cannot retry after a completion write failure', async () => {
  const { storage, drafts: a } = pending(), sent = [], write = storage.setItem; let finish;
  storage.setItem = (key, value) => {
    if (key.includes(':attempt:') && JSON.parse(value).status === 'waiting') throw Error('completion write failed');
    return write(key, value);
  };
  const retry = a.retryDelivery(a.pendingReview(), { getLatestJournal: async () => previewState(),
    transmit: (delivery, generation) => { sent.push({ delivery, generation }); return new Promise(resolve => { finish = resolve; }); } });
  await tick();
  const b = reopen(storage), duringReservation = b.pendingReview();
  assert.equal(duringReservation.attempt.status, 'reserved');
  const queued = b.retryDelivery(duringReservation, options(sent));
  finish();
  await retry;
  assert.equal((await queued).status, 'changed');
  storage.setItem = write;
  assert.equal((await b.retryDelivery(duringReservation, options(sent))).status, 'changed');
  assert.equal((await b.retryDelivery({ ...duringReservation, canRetry: true }, options(sent))).status, 'changed',
    'a reserved phase cannot authorize transmission even if its snapshot advertises retry');
  assert.equal(b.pendingReview().canRetry, false, 'an incomplete reserved attempt cannot prove whether transmission occurred');
  assert.equal(sent.length, 1);
});

test('an exact receipt before retry settles without transmitting and preserves newer drafts', async () => {
  const { storage, drafts } = pending(), review = drafts.pendingReview(), sent = [];
  const other = reopen(storage), newer = { ...items[1], text: 'A newer unsent comment' };
  assert.equal(other.set(newer, 'new-token'), true);
  const result = await drafts.retryDelivery(review, options(sent, receipt(review.delivery)));
  assert.equal(result.status, 'settled');
  assert.equal(sent.length, 0);
  const saved = reopen(storage);
  assert.equal(saved.delivery, null);
  assert.deepEqual(saved.drafts.get(draftKey(newer)), { ...newer, token: 'new-token' });
});

test('a mismatched receipt prevents retry without consuming an opportunity', async () => {
  const { storage, drafts } = pending(), review = drafts.pendingReview(), sent = [], before = [...storage.values];
  const changed = [items[0], { ...items[1], text: 'Different submitted text' }];
  assert.equal((await drafts.retryDelivery(review, options(sent, receipt(review.delivery, changed)))).status, 'mismatch');
  assert.equal(sent.length, 0);
  assert.deepEqual([...storage.values], before);
  assert.equal(drafts.receiptMismatch, true);
});

test('journal read failure prevents retry and keeps the original pending delivery', async () => {
  const { storage, drafts } = pending(), review = drafts.pendingReview(), sent = [], before = [...storage.values];
  const result = await drafts.retryDelivery(review, { ...options(sent), getLatestJournal: async () => { throw Error('read failed'); } });
  assert.equal(result.status, 'read_failed');
  assert.equal(sent.length, 0);
  assert.deepEqual([...storage.values], before);
  assert.equal(drafts.delivery.id, 'original-delivery');
});

for (const afterWrite of [false, true]) test(`reservation failure ${afterWrite ? 'after' : 'before'} durable write never transmits`, async () => {
  const { storage, drafts } = pending(), review = drafts.pendingReview(), sent = [], write = storage.setItem;
  const frozen = storage.getItem(drafts.deliveryKey);
  storage.setItem = (key, value) => {
    if (key.includes(':attempt:')) {
      if (afterWrite) write(key, value);
      throw Error('reservation write failed');
    }
    return write(key, value);
  };
  assert.equal((await drafts.retryDelivery(review, options(sent))).status, 'storage_failed');
  assert.equal(sent.length, 0);
  assert.equal(storage.getItem(drafts.deliveryKey), frozen);
  storage.setItem = write;
  if (afterWrite) {
    assert.equal((await drafts.retryDelivery(review, options(sent))).status, 'changed');
    assert.equal(sent.length, 0, 'the pre-crash review cannot reuse its reserved opportunity');
    assert.equal(reopen(storage).pendingReview().generation, 1);
    assert.equal(drafts.pendingReview().canRetry, false);
    assert.equal((await drafts.retryDelivery(drafts.pendingReview(), options(sent))).status, 'changed');
    assert.equal(sent.length, 0, 'an incomplete reservation remains pending until receipt or diagnosis');
    return;
  }
  const result = await drafts.retryDelivery(drafts.pendingReview(), options(sent));
  assert.equal(result.status, 'sent', 'only a fresh explicit attempt sends after write access recovers');
  assert.equal(result.generation, 1);
  assert.equal(sent.length, 1);
});

test('receipt cleanup write failure prevents retry', async () => {
  const { storage, drafts } = pending(), review = drafts.pendingReview(), sent = [], frozen = storage.getItem(drafts.deliveryKey);
  storage.setItem = () => { throw Error('cleanup write failed'); };
  assert.equal((await drafts.retryDelivery(review, options(sent, receipt(review.delivery)))).status, 'storage_failed');
  assert.equal(sent.length, 0);
  assert.equal(storage.getItem(drafts.deliveryKey), frozen);
  assert.equal(drafts.delivery.id, 'original-delivery');
});

test('reservation readback failure consumes the opportunity but never transmits', async () => {
  const { storage, drafts } = pending(), review = drafts.pendingReview(), sent = [], read = storage.getItem, write = storage.setItem;
  let reserved = false;
  storage.setItem = (key, value) => { write(key, value); if (key.includes(':attempt:')) reserved = true; };
  storage.getItem = key => { if (reserved && key.includes(':attempt:')) throw Error('readback failed'); return read(key); };
  assert.equal((await drafts.retryDelivery(review, options(sent))).status, 'storage_failed');
  assert.equal(sent.length, 0);
  assert.equal(!!drafts.coordinationUnavailable, false);
  storage.getItem = read; storage.setItem = write;
  assert.equal((await drafts.retryDelivery(review, options(sent))).status, 'changed');
  assert.equal(sent.length, 0);
  assert.equal(reopen(storage).pendingReview().generation, 1);
});

test('a genuine retry lock failure sends nothing and leaves storage unchanged', async () => {
  const { storage, drafts } = pending(), review = drafts.pendingReview(), sent = [], before = [...storage.values];
  drafts.lockManager = { request: async () => { throw Error('Web Locks denied'); } };
  assert.equal((await drafts.retryDelivery(review, options(sent))).status, 'coordination_failed');
  assert.equal(sent.length, 0);
  assert.deepEqual([...storage.values], before);
  assert.equal(drafts.coordinationUnavailable, true);
});

test('initial and earlier retry callbacks cannot change a newer attempt sharing the delivery ID', async () => {
  const { storage, drafts: a } = pending(), b = reopen(storage), sent = [];
  const rejected = await a.retryDelivery(a.pendingReview(), { ...options(sent), transmit: async () => { throw Error('lost acknowledgement'); } });
  assert.equal(rejected.status, 'uncertain');
  assert.equal(rejected.generation, 1);
  let finish;
  const next = a.retryDelivery(a.pendingReview(), { getLatestJournal: async () => previewState(),
    transmit: () => new Promise(resolve => { finish = resolve; }) });
  await tick();
  for (const surface of [a, b]) {
    assert.equal(surface.deliveryStatus('waiting', 'original-delivery'), false);
    assert.equal(surface.deliveryStatus('uncertain', 'original-delivery', 1), false);
  }
  assert.equal(a.delivery.status, 'sending');
  finish();
  assert.equal((await next).generation, 2);
  assert.equal(a.delivery.status, 'waiting');
  assert.equal(a.deliveryStatus('uncertain', 'original-delivery', 1), false);
});

test('legacy pending delivery retries with the same ID, original versions and tokens without invented outbound bytes', async () => {
  const storage = memoryStorage();
  const legacyItems = [{ collection: 'blockers', id: 'B1', record_revision: 1, kind: 'resolve' }, items[1]];
  const delivery = { id: 'legacy-delivery', conversation_id: 'C1', items: legacyItems, tokens: ['legacy-action', 'legacy-comment'], status: 'sending' };
  storage.setItem('request-journal:replies:v1:C1', JSON.stringify({ version: 1,
    drafts: legacyItems.map((item, index) => ({ ...item, token: delivery.tokens[index] })), delivery }));
  const drafts = reopen(storage), sent = [], frozen = storage.getItem(drafts.key), review = drafts.pendingReview();
  assert.equal(review.generation, 0);
  assert.equal(review.delivery.outbound, undefined);
  assert.equal((await drafts.retryDelivery(review, options(sent))).status, 'sent');
  assert.deepEqual(sent[0].delivery, { id: delivery.id, conversation_id: delivery.conversation_id, items: legacyItems, tokens: delivery.tokens });
  assert.equal(storage.getItem(drafts.key), frozen);
  assert.equal(storage.getItem(drafts.deliveryKey), null, 'legacy frozen storage is not migrated or rewritten');
});

test('retry preserves newer same-card edits and unrelated unsent drafts', async () => {
  const { storage, drafts } = pending(), review = drafts.pendingReview(), other = reopen(storage), sent = [];
  const newer = { ...items[1], text: 'New current-card comment' };
  const unrelated = { collection: 'requests', id: 'R1', record_revision: 1, kind: 'comment', text: 'Unrelated draft' };
  other.set(newer, 'new-token'); other.set(unrelated, 'unrelated-token');
  const before = [...reopen(storage).drafts];
  assert.equal((await drafts.retryDelivery(review, options(sent))).status, 'sent');
  assert.deepEqual([...reopen(storage).drafts], before);
  assert.deepEqual(sent[0].delivery.items, items);
  assert.deepEqual(sent[0].delivery.tokens, ['token-0', 'token-1']);
});

test('a late retry failure cannot resurrect a settled delivery or affect its replacement', async () => {
  const { storage, drafts } = pending(), review = drafts.pendingReview();
  const replacement = { collection: 'requests', id: 'R1', record_revision: 1, kind: 'comment', text: 'A replacement reply' };
  const result = await drafts.retryDelivery(review, { getLatestJournal: async () => previewState(), transmit: async delivery => {
    assert.equal(drafts.reconcile(receipt(delivery)), true);
    const other = reopen(storage);
    assert.equal(other.set(replacement, 'replacement-token'), true);
    assert.equal(other.stage('replacement-delivery', [replacement]), true);
    throw Error('late retry rejection');
  } });
  assert.equal(result.status, 'changed');
  const current = reopen(storage);
  assert.equal(current.delivery.id, 'replacement-delivery');
  assert.deepEqual(current.delivery.items, [replacement]);
  assert.equal(current.pendingReview().generation, 0);
  assert.equal(drafts.deliveryStatus('uncertain', 'original-delivery', 1), false);
});
