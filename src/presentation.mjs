import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isJournalId } from './identity.mjs';

function receiptPath(dir, id) {
  if (!isJournalId(id)) throw new Error('Invalid conversation identifier');
  return join(dir, 'presentations', `${id}.json`);
}

// This records a display request, not proof that the host rendered the widget.
export async function recordPresentation(dir, state) {
  const file = receiptPath(dir, state.conversation_id);
  await mkdir(join(dir, 'presentations'), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ turn_id: state.turn?.id, revision: state.revision }), { flag: 'wx', mode: 0o600 });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}

function isReadAcknowledgment(event) {
  return event.changes.some(c => c.collection === 'cards') && event.changes.every(c =>
    c.collection === 'turn' ? isDeepStrictEqual(c.before, c.after) :
      c.collection === 'cards' && ['open', 'answered'].includes(c.before?.status) && c.after?.status === 'resolved' &&
        c.after.resolution?.source?.startsWith('app:journal_mark_read:'));
}

export async function wasPresented(dir, state, turnId) {
  let receipt;
  try { receipt = JSON.parse(await readFile(receiptPath(dir, state.conversation_id), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  if (!receipt || receipt.turn_id !== turnId || state.turn?.id !== turnId ||
      !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || receipt.revision > state.revision) return false;
  // Silent human reads can follow show; they do not require another widget.
  return state.history.slice(receipt.revision).every(isReadAcknowledgment);
}
