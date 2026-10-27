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

const runtimeVersion = '0.6.0';
const server = new McpServer({ name: 'request-journal', version: runtimeVersion });
const uri = 'ui://request-journal/tracker.html';
const id = z.string().min(1).max(128).refine(isJournalId,'Use a safe journal identifier');
const ui = { resourceUri: uri };
function result(state) {
  return { content: [{ type: 'text', text: `Journal ${state.conversation_id}, revision ${state.revision}. ${evaluateStop(state, { turnId: state.turn?.id }).reason || ''}` }], structuredContent: { journal: state, runtime_version: runtimeVersion } };
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

server.registerTool('journal_update', {
  title: 'Update request tracker',
  description: 'Silently save concise changes without displaying another widget. Read first; pass expected revision. Omitted records remain. Reply receipts require the actual human message and original record revision. Blocker users report actions, choose alternatives or Later; only agent verification resolves the obstacle. Do not expose a user Blocker Resolve action or status picker. Q&A, Note and Complete use Mark as read for acknowledgment. Dismissed needs a reason and source. Use journal_show once before a legitimate final response. A checkpoint is not a stop reason.',
  inputSchema: { conversation_id: id, expected_revision: z.number().int().nonnegative(), turn: z.record(z.string(), z.unknown()), upsert: z.object({ requests: z.array(z.record(z.string(), z.unknown())).optional(), decisions: z.array(z.record(z.string(), z.unknown())).optional(), blockers: z.array(z.record(z.string(), z.unknown())).optional(), cards: z.array(z.record(z.string(), z.unknown())).optional(), replies: z.array(z.record(z.string(), z.unknown())).optional() }) },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { visibility: ['model'] } }
}, safe(async ({ conversation_id, ...update }) => result(await updateJournal(dataDir, conversation_id, update, { stampReplyRecordedAt: true }))));

registerAppTool(server, 'journal_mark_read', {
  title: 'Mark card as read',
  description: 'Silently record the user reading the current Q&A, Note or Complete card. Does not send a chat message or start agent work. Only the exact original card version is accepted; duplicate clicks are idempotent.',
  inputSchema: { conversation_id: id, card_id: id, record_revision: z.number().int().positive() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { visibility: ['app'] } }
}, safe(async ({ conversation_id, ...read }) => result(await markCardRead(dataDir, conversation_id, read))));

registerAppTool(server, 'journal_show', {
  title: 'Show request tracker',
  description: 'Display the latest saved journal once when the human should read it, usually just before the final response. Read-only: does not save, acknowledge, answer, or complete anything. Use journal_read and journal_update for intermediate work without extra widgets. Existing host messages cannot be hidden or removed by this tool.',
  inputSchema: { conversation_id: id },
  annotations: { readOnlyHint: true, openWorldHint: false },
  _meta: { ui }
}, safe(async ({ conversation_id }) => result(await readJournal(dataDir, conversation_id))));

registerAppResource(server, 'request-tracker', uri, {}, async () => ({ contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: await readFile(join(dirname(fileURLToPath(import.meta.url)), 'journal.html'), 'utf8'), _meta: { ui: { prefersBorder: false } } }] }));
await server.connect(new StdioServerTransport());
