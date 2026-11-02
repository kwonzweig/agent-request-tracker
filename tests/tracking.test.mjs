import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { isTrackingEnabled, setTrackingEnabled } from '../src/tracking.mjs';

const run = promisify(execFile);
const moduleUrl = new URL('../src/tracking.mjs', import.meta.url).href;

async function isolated(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-tracking-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function freshRead(dir, id) {
  const script = `import { isTrackingEnabled } from ${JSON.stringify(moduleUrl)};
    process.stdout.write(JSON.stringify(await isTrackingEnabled(process.argv[1], process.argv[2])));`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script, dir, id]);
  return JSON.parse(stdout);
}

test('a new conversation stays OFF without creating data', async t => {
  const dir = await isolated(t);
  assert.equal(await isTrackingEnabled(dir, 'new'), false);
  assert.equal(await isTrackingEnabled(path.join(dir, 'missing'), 'new'), false);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('ON and OFF persist across fresh processes without fake journal records', async t => {
  const dir = path.join(await isolated(t), 'data');
  assert.equal(await setTrackingEnabled(dir, 'chat-1', true), true);
  assert.equal(await freshRead(dir, 'chat-1'), true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'tracking', 'chat-1.json'), 'utf8')), { enabled: true });
  assert.deepEqual(await fs.readdir(dir), ['tracking']);
  assert.deepEqual(await fs.readdir(path.join(dir, 'tracking')), ['chat-1.json']);
  assert.equal(await setTrackingEnabled(dir, 'chat-1', false), false);
  assert.equal(await freshRead(dir, 'chat-1'), false);
  assert.equal(await setTrackingEnabled(dir, 'chat-1', true), true);
  assert.equal(await freshRead(dir, 'chat-1'), true);
});

test('legacy journals imply ON only when there is no explicit setting', async t => {
  const dir = await isolated(t);
  const journal = path.join(dir, 'legacy.json');
  const original = Buffer.from('{"requests":[]}\r\n');
  await fs.writeFile(journal, original);
  assert.equal(await isTrackingEnabled(dir, 'legacy'), true);
  assert.equal(await setTrackingEnabled(dir, 'legacy', false), false);
  assert.deepEqual(await fs.readFile(journal), original);
  assert.equal(await freshRead(dir, 'legacy'), false);
  await fs.writeFile(journal, '{"requests":[{"id":"R1"}]}\n');
  assert.equal(await isTrackingEnabled(dir, 'legacy'), false);
  const updated = await fs.readFile(journal);
  await setTrackingEnabled(dir, 'legacy', true);
  assert.deepEqual(await fs.readFile(journal), updated);
});

test('changing one conversation preserves the other conversation and its setting', async t => {
  const dir = await isolated(t);
  await fs.writeFile(path.join(dir, 'other.json'), 'existing journal bytes');
  await setTrackingEnabled(dir, 'other', true);
  const otherSetting = await fs.readFile(path.join(dir, 'tracking', 'other.json'));
  await setTrackingEnabled(dir, 'current', false);
  assert.equal(await isTrackingEnabled(dir, 'current'), false);
  assert.equal(await isTrackingEnabled(dir, 'other'), true);
  assert.deepEqual(await fs.readFile(path.join(dir, 'tracking', 'other.json')), otherSetting);
  assert.equal(await fs.readFile(path.join(dir, 'other.json'), 'utf8'), 'existing journal bytes');
});

test('each read honors the current explicit setting without cached activation', async t => {
  const dir = await isolated(t);
  await fs.mkdir(path.join(dir, 'tracking'));
  const file = path.join(dir, 'tracking', 'chat.json');
  await fs.writeFile(file, '{"enabled":false}');
  assert.equal(await isTrackingEnabled(dir, 'chat'), false);
  await fs.writeFile(file, '{"enabled":true}');
  assert.equal(await isTrackingEnabled(dir, 'chat'), true);
  await fs.writeFile(file, '{"enabled":false}');
  assert.equal(await isTrackingEnabled(dir, 'chat'), false);
});

test('malformed explicit settings throw even when a legacy journal exists', async t => {
  const dir = await isolated(t);
  await fs.writeFile(path.join(dir, 'chat.json'), '{}');
  await fs.mkdir(path.join(dir, 'tracking'));
  for (const value of ['{', 'null', '[]', '{}', 'true', '{"enabled":1}', '{"enabled":"false"}', '{"enabled":null}']) {
    await fs.writeFile(path.join(dir, 'tracking', 'chat.json'), value);
    await assert.rejects(isTrackingEnabled(dir, 'chat'), { code: 'INVALID_TRACKING_CONFIG' }, value);
  }
});

test('unsafe IDs and invalid directory inputs reject before touching files', async t => {
  const dir = await isolated(t);
  for (const id of ['', '.', '..', '../escape', 'x/y', 'x\\y', '/absolute', 'C:\\absolute', 'trailing.', 'a..b', 'x\n', 'a'.repeat(129), null, 1]) {
    await assert.rejects(isTrackingEnabled(dir, id), { code: 'INVALID_ID' });
    await assert.rejects(setTrackingEnabled(dir, id, true), { code: 'INVALID_ID' });
  }
  for (const invalid of ['', ' ', '\0', null, {}, 1]) {
    await assert.rejects(isTrackingEnabled(invalid, 'chat'), TypeError);
    await assert.rejects(setTrackingEnabled(invalid, 'chat', true), TypeError);
  }
  assert.deepEqual(await fs.readdir(dir), []);
});

test('enabled requires a boolean and invalid writes preserve the saved setting', async t => {
  const dir = await isolated(t);
  await setTrackingEnabled(dir, 'chat', false);
  const file = path.join(dir, 'tracking', 'chat.json');
  const original = await fs.readFile(file);
  for (const value of [undefined, null, 0, 1, 'true', 'false', {}, []]) {
    await assert.rejects(setTrackingEnabled(dir, 'chat', value), { code: 'INVALID_TRACKING_ENABLED' });
    assert.deepEqual(await fs.readFile(file), original);
  }
});

test('a failed atomic replacement leaves no temporary files', async t => {
  const dir = await isolated(t);
  const target = path.join(dir, 'tracking', 'chat.json');
  await fs.mkdir(target, { recursive: true });
  await assert.rejects(setTrackingEnabled(dir, 'chat', true));
  assert.deepEqual(await fs.readdir(path.join(dir, 'tracking')), ['chat.json']);
  assert.equal((await fs.stat(target)).isDirectory(), true);
});

test('new activation storage uses private modes on POSIX', { skip: process.platform === 'win32' }, async t => {
  const dir = path.join(await isolated(t), 'private');
  await setTrackingEnabled(dir, 'chat', true);
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(dir, 'tracking'))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(dir, 'tracking', 'chat.json'))).mode & 0o777, 0o600);
});

test('activation files cannot impersonate another conversation legacy journal', async t => {
  const dir = await isolated(t);
  await setTrackingEnabled(dir, 'chat', true);
  assert.equal(await isTrackingEnabled(dir, 'chat.tracking'), false);
  await fs.writeFile(path.join(dir, 'chat.tracking.json'), 'legacy records');
  await setTrackingEnabled(dir, 'chat.tracking', false);
  assert.equal(await isTrackingEnabled(dir, 'chat'), true);
  assert.equal(await isTrackingEnabled(dir, 'chat.tracking'), false);
  assert.equal(await fs.readFile(path.join(dir, 'chat.tracking.json'), 'utf8'), 'legacy records');
});
