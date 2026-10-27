import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJournal, updateJournal } from '../src/store.mjs';

// Preserve reader fixtures from the old writer without allowing those retired
// actions or acknowledged open Blockers through the current write path.
export async function legacyBlockerFixture(dir, conversationId, checkpoint) {
  const previous = await readJournal(dir, conversationId), safe = structuredClone(checkpoint);
  const receipts = (safe.upsert.replies ?? []).filter(reply => reply.items.some(item =>
    item.collection === 'blockers' && ['resolve', 'acknowledge'].includes(item.kind)));
  const attention = (safe.upsert.blockers ?? []).filter(record => record.attention?.state === 'acknowledged')
    .map(record => ({ id: record.id, attention: record.attention }));
  safe.upsert.replies = (safe.upsert.replies ?? []).filter(reply => !receipts.includes(reply));
  for (const record of safe.upsert.blockers ?? []) if (attention.some(item => item.id === record.id)) delete record.attention;
  const state = await updateJournal(dir, conversationId, safe), entry = state.history.at(-1);
  for (const item of attention) {
    const record = state.blockers.find(record => record.id === item.id); record.attention = item.attention;
    const change = entry.changes.find(change => change.collection === 'blockers' && change.id === item.id);
    if (change) change.after = structuredClone(record);
    else entry.changes.push({ collection: 'blockers', id: item.id,
      before: previous.blockers.find(record => record.id === item.id) ?? null, after: structuredClone(record) });
  }
  for (const receipt of receipts) {
    state.replies.push(receipt);
    entry.changes.push({ collection: 'replies', id: receipt.id, before: null, after: receipt });
  }
  await writeFile(join(dir, `${conversationId}.json`), JSON.stringify(state));
  return readJournal(dir, conversationId);
}
