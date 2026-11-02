import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { isTrackingEnabled } from '../src/tracking.mjs';

const run = promisify(execFile);
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'tracker-paths-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.REQUEST_TRACKER_DATA_DIR;
  delete env.REQUEST_JOURNAL_DATA_DIR;
  return { home, env, current: join(home, '.request-tracker', 'journals'), legacy: join(home, '.request-journal', 'journals') };
}
const loadedPath = async env => (await run(process.execPath, ['--input-type=module', '--eval',
  `console.log((await import(${JSON.stringify(pathToFileURL(resolve('src/paths.mjs')).href)})).dataDir)`], { env, windowsHide: true })).stdout.trim();

test('fresh installs use the Request Tracker directory and environment setting', async t => {
  const f = await fixture(t);
  assert.equal(await loadedPath(f.env), f.current);
  assert.equal(await loadedPath({ ...f.env, REQUEST_TRACKER_DATA_DIR: join(f.home, 'chosen') }), join(f.home, 'chosen'));
});

test('upgrades keep the existing records and explicit OFF setting in one directory', async t => {
  const f = await fixture(t);
  await mkdir(join(f.legacy, 'tracking'), { recursive: true });
  await writeFile(join(f.legacy, 'c.json'), JSON.stringify({ revision: 4 }));
  await writeFile(join(f.legacy, 'tracking', 'c.json'), JSON.stringify({ version: 1, conversation_id: 'c', enabled: false }));
  assert.equal(await loadedPath(f.env), f.legacy);
  assert.equal(await isTrackingEnabled(await loadedPath(f.env), 'c'), false);
  assert.equal(await loadedPath({ ...f.env, REQUEST_JOURNAL_DATA_DIR: join(f.home, 'old-setting') }), join(f.home, 'old-setting'));
  assert.equal(await loadedPath({ ...f.env, REQUEST_TRACKER_DATA_DIR: f.current, REQUEST_JOURNAL_DATA_DIR: f.legacy }), f.current);
});

test('two saved-data locations require an explicit choice instead of hiding records', async t => {
  const f = await fixture(t);
  await mkdir(f.current, { recursive: true });
  await mkdir(f.legacy, { recursive: true });
  await assert.rejects(loadedPath(f.env), /REQUEST_TRACKER_DATA_DIR/);
  assert.equal(await loadedPath({ ...f.env, REQUEST_TRACKER_DATA_DIR: f.legacy }), f.legacy);
});
