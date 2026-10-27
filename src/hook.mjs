import { access, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJournal, evaluateStop } from './store.mjs';
import { dataDir } from './paths.mjs';
import { isJournalId } from './identity.mjs';

let input = '';
for await (const chunk of process.stdin) { input += chunk; if (input.length > 2_000_000) process.exit(1); }
const event = JSON.parse(input);
const id = event.session_id;
if (!isJournalId(id)) process.exit(0);
// Opt-in is per conversation: no journal file means no injected context or stop gate.
try { await access(join(dataDir, `${id}.json`)); } catch { process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value));
const marker = join(dataDir, `${id}.interrupted.json`);
if (event.hook_event_name === 'Interrupt') {
  await writeFile(marker, JSON.stringify({ turn_id: event.turn_id }), 'utf8');
  process.exit(0);
}
let state;
try { state = await readJournal(dataDir, id); }
catch (error) { send({ systemMessage: `Request Tracker could not read the last saved state: ${error.message}` }); process.exit(0); }
if (event.hook_event_name === 'UserPromptSubmit' || event.hook_event_name === 'SessionStart') {
  const active = state.requests.filter(r => ['active', 'waiting'].includes(r.status)).map(r => `${r.id}: ${r.title}`).join('; ');
  send({ hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: `Request Tracker is active for ${id}. Current turn: ${event.turn_id || 'not exposed'}. Reload journal_read for revision ${state.revision} before work; save concise changes with journal_update before final. Existing unfinished requests: ${active || 'none'}. A user's correction or question does not cancel the standing request. Resume authorized unfinished work after answering. A checkpoint alone is not a stopping condition. Never invent a blocker, decision, completion or background run to pass the gate. Render from saved JSON. User stop instructions take precedence.` } });
} else if (event.hook_event_name === 'Stop') {
  if (!event.turn_id) {
    send({systemMessage:'Request Tracker cannot verify this stop because this Codex version did not provide the current turn identifier. Automatic stop enforcement is unavailable for this event; this is not completion.'});
    process.exit(0);
  }
  let interrupted;
  try { interrupted = JSON.parse(await readFile(marker, 'utf8')); } catch {}
  if (interrupted?.turn_id === event.turn_id) process.exit(0);
  if (state.turn?.id===event.turn_id && state.turn.end_reason==='interrupted') {
    send({systemMessage:'Request Tracker records this turn as interrupted. It will not restart stopped work. Reconcile the last saved state on the next user turn.'});
    process.exit(0);
  }
  const gate = evaluateStop(state, { turnId: event.turn_id });
  if (gate.allowed) send({});
  else if (event.stop_hook_active) send({ systemMessage: `Request Tracker: unresolved stop-state mismatch (${gate.reason}). The host reports an active Stop-hook continuation; no further automatic continuation is requested. This is not completion.` });
  else send({ decision: 'block', reason: `Request Tracker exit check failed: ${gate.reason}. Reload the saved journal. Continue the original authorized work if it remains unblocked; do not end just to acknowledge a correction or report a checkpoint. Save accurate state and render the journal before a legitimate final. Do not restart anything the user stopped.` });
}
