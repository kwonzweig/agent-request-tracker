import { homedir } from 'node:os';
import { join } from 'node:path';
export const dataDir = process.env.REQUEST_JOURNAL_DATA_DIR || join(homedir(), '.request-journal', 'journals');
