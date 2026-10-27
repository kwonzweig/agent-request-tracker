import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { view, memoryStorage, tick } from './ui-harness.mjs';
import { ReplyDrafts, recordRevision } from '../src/reply-ui.mjs';
import { updateJournal, readJournal, markCardRead } from '../src/store.mjs';

const q = (ui, selector) => ui.document.querySelector(selector);
const read = (ui, id = 'Q1') => q(ui, `#jc-attention [data-record="${id}"] .jc-read-icon`);
const oldRead = { collection: 'cards', id: 'Q1', record_revision: 1, kind: 'resolve' };
const comment = { collection: 'cards', id: 'N1', record_revision: 1, kind: 'comment', text: 'Keep this unrelated comment unchanged.' };
const turn = { id: 'T1', source: 'user:1', summary: 'Saved notifications', end_reason: null };

async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'journal-read-retirement-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const journal = await updateJournal(dir, 'C1', { expected_revision: 0, turn, upsert: {
    requests: [{ id: 'R1', title: 'Current task', done_when: 'Verified result', source: 'user:1', status: 'active' }],
    cards: [
      { id: 'Q1', request_id: 'R1', revision: 1, type: 'qa', title: 'Answer', body: 'Original answer.', source: 'agent:1', status: 'open' },
      { id: 'N1', request_id: 'R1', revision: 1, type: 'note', title: 'Other note', body: 'Independent note.', source: 'agent:1', status: 'open' },
    ],
  } });
  let latest;
  const host = request => {
    const result = request.name === 'journal_mark_read'
      ? markCardRead(dir, 'C1', { card_id: request.arguments.card_id, record_revision: request.arguments.record_revision })
      : readJournal(dir, 'C1');
    return latest = result.then(saved => ({ structuredContent: { journal: saved } }));
  };
  const flush = async () => { await latest; await tick(); };
  const mark = async (ui, id = 'Q1') => { read(ui, id).click(); await flush(); };
  const revise = async () => {
    const saved = await readJournal(dir, 'C1');
    return updateJournal(dir, 'C1', { expected_revision: saved.revision, turn,
      upsert: { cards: [{ id: 'Q1', revision: 2, body: 'Materially revised answer.' }] } });
  };
  return { dir, journal, host, mark, revise, flush };
}

function enterComment(ui) {
  const input = q(ui, '#jc-attention [data-record="N1"] .jc-comment textarea');
  input.value = comment.text; input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
}

test('a legacy unsent read fulfilled by × cannot block an unrelated Comment after material reopen or reload', async t => {
  const { dir, journal, host, mark, revise, flush } = await fixture(t), storage = memoryStorage();
  new ReplyDrafts(storage, 'C1').set(oldRead, 'legacy-read');
  const unopenedStorage = memoryStorage();
  for (const [key, value] of storage.values) unopenedStorage.setItem(key, value);
  const ui = await view({ storage, toolImpl: host }); ui.show(journal);
  await mark(ui);
  const saved = await readJournal(dir, 'C1');
  assert.equal(saved.cards.find(card => card.id === 'Q1').resolution.record_revision, 1);
  assert.deepEqual(saved.replies, [], 'The app save must not manufacture a chat receipt');
  assert.equal(ui.sent.length, 0);
  const revised = await revise();
  assert.equal(revised.cards.find(card => card.id === 'Q1').status, 'open');
  assert.ok(recordRevision(revised, 'cards', 'Q1') > oldRead.record_revision);
  await ui.refresh(revised);
  const restored = await view({ storage: unopenedStorage, toolImpl: host }); restored.show(revised);
  for (const current of [ui, restored]) {
    assert.ok(read(current), 'The new content still needs its own read acknowledgment');
    enterComment(current);
    assert.equal(q(current, '#jc-send').disabled, false, 'The fulfilled old read must not block an unrelated comment');
    assert.equal(q(current, '#jc-attention .jc-warning'), null);
    q(current, '#jc-send').click(); await flush();
    assert.equal(current.sent.length, 1);
    assert.deepEqual(current.envelope().items, [comment]);
    assert.deepEqual((await readJournal(dir, 'C1')).replies, []);
  }
});

test('an app-only read preserves every byte of a pending legacy delivery and its drafts', async t => {
  const { journal, host, mark, revise } = await fixture(t), storage = memoryStorage(), editor = new ReplyDrafts(storage, 'C1');
  editor.set(oldRead, 'pending-read'); editor.set(comment, 'pending-comment');
  assert.equal(editor.stage('pending-legacy', [oldRead, comment]), true);
  const before = [...storage.values];
  const ui = await view({ storage, toolImpl: host }); ui.show(journal); await mark(ui);
  await ui.refresh(await revise());
  assert.deepEqual([...storage.values], before);
  assert.equal(new ReplyDrafts(storage, 'C1').delivery.id, 'pending-legacy');
  assert.equal(q(ui, '#jc-send').disabled, true);
  assert.equal(ui.sent.length, 0);
});

test('a historical app read cannot retire a newer-version read or an unrelated comment', async t => {
  const { journal, host, mark, revise } = await fixture(t), ui = await view({ toolImpl: host }); ui.show(journal);
  await mark(ui); const revised = await revise(), storage = memoryStorage(), editor = new ReplyDrafts(storage, 'C1');
  const next = { ...oldRead, record_revision: recordRevision(revised, 'cards', 'Q1') };
  editor.set(next, 'new-read'); editor.set(comment, 'separate-comment');
  const before = [...storage.values];
  const restored = await view({ storage, toolImpl: host }); restored.show(revised); await restored.refresh(revised);
  assert.deepEqual([...storage.values], before);
  assert.deepEqual([...new ReplyDrafts(storage, 'C1').drafts.values()], [
    { ...next, token: 'new-read' }, { ...comment, token: 'separate-comment' },
  ]);
  assert.ok(read(restored)); assert.equal(restored.sent.length, 0);
});

test('reading a different notification does not fulfill an old unsent read', async t => {
  const { journal, host, mark } = await fixture(t), storage = memoryStorage();
  new ReplyDrafts(storage, 'C1').set(oldRead, 'still-unread');
  const ui = await view({ storage, toolImpl: host }); ui.show(journal); await mark(ui, 'N1');
  assert.deepEqual([...new ReplyDrafts(storage, 'C1').drafts.values()], [{ ...oldRead, token: 'still-unread' }]);
  assert.ok(read(ui)); assert.equal(ui.sent.length, 0);
});
