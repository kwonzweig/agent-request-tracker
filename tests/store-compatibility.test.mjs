import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readJournal, updateJournal, validateJournal } from '../src/store.mjs';

// Generated with the actual eec40e2 (0.5.2) src/store.mjs writer and read back
// with that reader before saving. The original stale receipt remains immutable.
const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/legacy-cosmetic-stale.json', import.meta.url), 'utf8'));
const update = (expected_revision, upsert = {}) => ({ expected_revision,
  turn: { id: `T${expected_revision + 1}`, source: 'user:fixture', summary: 'Continue legacy journal', end_reason: null }, upsert });
async function isolated(t, journal = fixture) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-compat-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'legacy-cosmetic.json'), JSON.stringify(journal));
  return dir;
}

test('actual 0.5.2 cosmetic-stale receipt remains readable and unchanged after upgrade', async t => {
  const dir = await isolated(t);
  const saved = await readJournal(dir, 'legacy-cosmetic');
  assert.deepEqual(saved, fixture);
  assert.equal(saved.replies[0].items[0].outcome, 'stale');
  const continued = await updateJournal(dir, 'legacy-cosmetic', update(3));
  assert.deepEqual(continued.replies, fixture.replies);
  assert.equal(continued.decisions[0].user_answer, undefined);
});

test('historical conservative stale receipt cannot become permission', async t => {
  const dir = await isolated(t);
  await assert.rejects(updateJournal(dir, 'legacy-cosmetic', update(3, { decisions: [{ id: 'D1', status: 'answered',
    user_answer: { revision: 1, option_id: 'A', source: 'user:late' } }] })), error => error.code === 'REPLY_ANSWER_MISMATCH');
});

test('new writes still reject a stale outcome for the cosmetically unchanged current choice', async t => {
  const dir = await isolated(t);
  await assert.rejects(updateJournal(dir, 'legacy-cosmetic', update(3, { replies: [{ id: 'new-late', source: 'user:new',
    items: structuredClone(fixture.replies[0].items) }] })), error => error.code === 'INVALID_REPLY_OUTCOME');
});

test('historical replay still rejects stale outcomes bound to the then-current cosmetic version', () => {
  const invalid = structuredClone(fixture);
  invalid.replies[0].items[0].record_revision = 2;
  invalid.history[2].changes.find(change => change.collection === 'replies').after.items[0].record_revision = 2;
  assert.throws(() => validateJournal(invalid), error => error.code === 'INVALID_REPLY_OUTCOME');
});

test('a genuinely changed choice still rejects accepted older actions on new writes', async t => {
  const dir = await isolated(t);
  await updateJournal(dir, 'legacy-cosmetic', update(3, { decisions: [{ id: 'D1', revision: 2, question: 'A materially different route?' }] }));
  await assert.rejects(updateJournal(dir, 'legacy-cosmetic', update(4, { replies: [{ id: 'invalid-accepted', source: 'user:new',
    items: [{ ...fixture.replies[0].items[0], outcome: 'accepted' }] }] })), error => error.code === 'STALE_REPLY');
});
test('historical replay still rejects accepted actions made stale by a material revision', () => {
  const invalid = structuredClone(fixture);
  invalid.decisions[0].revision = 2;
  invalid.decisions[0].question = 'A materially different route?';
  Object.assign(invalid.history[1].changes.find(change => change.collection === 'decisions').after, invalid.decisions[0]);
  invalid.replies[0].items[0].outcome = 'accepted';
  invalid.history[2].changes.find(change => change.collection === 'replies').after.items[0].outcome = 'accepted';
  assert.throws(() => validateJournal(invalid), error => error.code === 'STALE_REPLY');
});
