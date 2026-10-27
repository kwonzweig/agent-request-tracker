#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { evaluateStop, readJournal, updateJournal, validateJournal } from './store.mjs';

function usage() {
  throw new Error('usage: node src/cli.mjs <read|update|validate> --conversation ID [--data-dir DIR] [--input PATH for update] [--turn ID for validate]');
}

function parse(argv) {
  const [command, ...rest] = argv;
  if (!['read', 'update', 'validate'].includes(command)) usage();
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!['--conversation', '--data-dir', '--input', '--turn'].includes(flag) || !value || value.startsWith('--') || options[flag]) usage();
    options[flag] = value;
  }
  if (!options['--conversation'] || !options['--data-dir'] && !process.env.REQUEST_JOURNAL_DATA_DIR) usage();
  if (command === 'update' && !options['--input']) usage();
  if (command !== 'update' && options['--input']) usage();
  if (command !== 'validate' && options['--turn']) usage();
  return { command, conversationId: options['--conversation'], dataDir: options['--data-dir'] ?? process.env.REQUEST_JOURNAL_DATA_DIR, input: options['--input'], turnId: options['--turn'] };
}

async function main() {
  const { command, conversationId, dataDir, input, turnId } = parse(process.argv.slice(2));
  if (command === 'read') {
    process.stdout.write(`${JSON.stringify(await readJournal(dataDir, conversationId), null, 2)}\n`);
  } else if (command === 'validate') {
    const state = validateJournal(await readJournal(dataDir, conversationId));
    const result = { valid: true, conversation_id: state.conversation_id, revision: state.revision };
    // Schema validity and a justified stop are intentionally separate results.
    // Exit 2: valid journal, but the requested turn cannot legitimately stop.
    if (turnId !== undefined) {
      result.stop = evaluateStop(state, { turnId });
      if (!result.stop.allowed) process.exitCode = 2;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const update = JSON.parse(await fs.readFile(input, 'utf8'));
    const state = await updateJournal(dataDir, conversationId, update);
    process.stdout.write(`${JSON.stringify({ conversation_id: state.conversation_id, revision: state.revision, turn_id: state.turn.id })}\n`);
  }
}

main().catch(error => {
  process.stderr.write(`${error.code ?? 'ERROR'}: ${error.message}\n`);
  process.exitCode = 1;
});
