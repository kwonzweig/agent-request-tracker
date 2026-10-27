import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJournal, updateJournal } from '../src/store.mjs';

// Older writers allowed contradictory Done records. Keep those reader/Stop
// fixtures in isolated test journals without asking the current writer to do so.
export async function legacyDoneFixture(dir, conversationId, checkpoint) {
  const previous = await readJournal(dir, conversationId), safe = structuredClone(checkpoint);
  const done = safe.upsert.requests.filter(request => request.status === 'done').map(request => request.id);
  for (const request of safe.upsert.requests) if (done.includes(request.id)) request.status = 'active';
  const state = await updateJournal(dir, conversationId, safe), entry = state.history.at(-1);
  for (const id of done) {
    const request = state.requests.find(record => record.id === id); request.status = 'done';
    const change = entry.changes.find(item => item.collection === 'requests' && item.id === id);
    if (change) change.after = structuredClone(request);
    else entry.changes.push({ collection: 'requests', id, before: previous.requests.find(record => record.id === id) ?? null, after: structuredClone(request) });
  }
  await writeFile(join(dir, `${conversationId}.json`), JSON.stringify(state));
  return readJournal(dir, conversationId);
}
