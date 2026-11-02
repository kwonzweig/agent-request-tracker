import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readJournal, updateJournal, markCardRead, evaluateStop } from './store.mjs';
import { dataDir } from './paths.mjs';
import { isJournalId } from './identity.mjs';
import { isTrackingEnabled, setTrackingEnabled } from './tracking.mjs';
import { recordPresentation } from './presentation.mjs';
import { uiResourceUri } from './compatibility.mjs';

const runtimeVersion = '0.6.3';
const server = new McpServer({ name: 'request-tracker', version: runtimeVersion });
const uri = uiResourceUri;
const id = z.string().min(1).max(128).refine(isJournalId,'Use a safe journal identifier');
const ui = { resourceUri: uri };
async function result(state) {
  return { content: [{ type: 'text', text: `Journal ${state.conversation_id}, revision ${state.revision}. ${evaluateStop(state, { turnId: state.turn?.id }).reason || ''}` }], structuredContent: { journal: state, runtime_version: runtimeVersion, tracking_enabled: await isTrackingEnabled(dataDir, state.conversation_id) } };
}
async function requireTracking(conversationId) {
  if (!await isTrackingEnabled(dataDir, conversationId)) throw new Error('Request Tracker is OFF for this conversation. Use journal_tracking to turn it on only when the user requests tracking. Existing records are preserved.');
}
function safe(fn) {
  return async (args) => { try { return await fn(args); } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; } };
}

server.registerTool('journal_read', {
  title: 'Read request tracker',
  description: 'Silently reload this conversation’s committed journal before work. Does not display a widget or read conversation transcripts. Use journal_show once when the human should read the final journal.',
  inputSchema: { conversation_id: id },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, safe(async ({ conversation_id }) => result(await readJournal(dataDir, conversation_id))));

server.registerTool('journal_tracking', {
  title: 'Turn request tracker on or off',
  description: 'Persist ON or OFF for this conversation when the user requests it. New conversations default OFF. ON stays enabled across turns and restarts until OFF; OFF preserves existing records and disables tracking hooks. Does not change any other conversation or display a widget.',
  inputSchema: { conversation_id: id, enabled: z.boolean() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { visibility: ['model'] } }
}, safe(async ({ conversation_id, enabled }) => ({
  content: [{ type: 'text', text: `Request Tracker ${enabled ? 'ON' : 'OFF'} for this conversation. Existing records are preserved.` }],
  structuredContent: { conversation_id, tracking_enabled: await setTrackingEnabled(dataDir, conversation_id, enabled), runtime_version: runtimeVersion }
})));

server.registerTool('journal_update', {
  title: 'Update request tracker',
  description: 'Silently save concise changes without displaying another widget. Read first; pass expected revision. Omitted records remain. Reply receipts require the actual human message and original record revision. Blocker users report actions, choose alternatives or Later; only agent verification resolves the obstacle. Do not expose a user Blocker Resolve action or status picker. Q&A, Note and Complete use Mark as read for acknowledgment. Dismissed needs a reason and source. Use journal_show once before a legitimate final response. A checkpoint is not a stop reason.',
  inputSchema: { conversation_id: id, expected_revision: z.number().int().nonnegative(), turn: z.record(z.string(), z.unknown()), upsert: z.object({ requests: z.array(z.record(z.string(), z.unknown())).optional(), decisions: z.array(z.record(z.string(), z.unknown())).optional(), blockers: z.array(z.record(z.string(), z.unknown())).optional(), cards: z.array(z.record(z.string(), z.unknown())).optional(), replies: z.array(z.record(z.string(), z.unknown())).optional() }) },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { visibility: ['model'] } }
}, safe(async ({ conversation_id, ...update }) => {
  await requireTracking(conversation_id);
  return result(await updateJournal(dataDir, conversation_id, update, { stampReplyRecordedAt: true }));
}));

registerAppTool(server, 'journal_mark_read', {
  title: 'Mark card as read',
  description: 'Silently record the user reading the current Q&A, Note or Complete card. Does not send a chat message or start agent work. Only the exact original card version is accepted; duplicate clicks are idempotent.',
  inputSchema: { conversation_id: id, card_id: id, record_revision: z.number().int().positive() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { visibility: ['app'] } }
}, safe(async ({ conversation_id, ...read }) => result(await markCardRead(dataDir, conversation_id, read))));

registerAppTool(server, 'journal_show', {
  title: 'Show request tracker',
  description: 'Request display of the latest saved journal once before the final response in an ON conversation. Records that display was requested for the saved turn; this does not prove host rendering or change requests or cards. Use journal_read and journal_update for intermediate work without extra widgets. Existing host messages cannot be hidden or removed.',
  inputSchema: { conversation_id: id },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  _meta: { ui }
}, safe(async ({ conversation_id }) => {
  await requireTracking(conversation_id);
  const state = await readJournal(dataDir, conversation_id);
  await recordPresentation(dataDir, state);
  return result(state);
}));

registerAppResource(server, 'request-tracker', uri, {}, async () => ({ contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: await readFile(join(dirname(fileURLToPath(import.meta.url)), 'journal.html'), 'utf8'), _meta: { ui: { prefersBorder: false } } }] }));
await server.connect(new StdioServerTransport());
