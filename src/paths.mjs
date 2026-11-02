import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { legacyDataDirectory, legacyDataEnvironment } from './compatibility.mjs';

export const configuredDataDir = process.env.REQUEST_TRACKER_DATA_DIR || process.env[legacyDataEnvironment];
function defaultDataDir() {
  const current = join(homedir(), '.request-tracker', 'journals');
  const previous = join(homedir(), legacyDataDirectory, 'journals');
  if (existsSync(current) && existsSync(previous)) {
    throw new Error('Two Request Tracker data directories exist. Set REQUEST_TRACKER_DATA_DIR to the directory you want to use; no records were moved.');
  }
  // Reuse the whole existing store, including explicit OFF settings. Moving or
  // copying it here could split writes from an older, still-running host.
  return existsSync(previous) ? previous : current;
}
export const dataDir = configuredDataDir || defaultDataDir();
