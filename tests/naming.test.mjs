import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const json = async path => JSON.parse(await readFile(path, 'utf8'));

test('installation and skill discovery expose only Request Tracker', async () => {
  const manifest = await json('plugin/plugin.json');
  const marketplace = await json('.agents/plugins/marketplace.json');
  assert.equal(manifest.name, 'request-tracker');
  assert.equal((await json('package.json')).name, manifest.name);
  assert.equal(marketplace.name, 'request-tracker-local');
  assert.deepEqual(marketplace.plugins.map(plugin => plugin.name), ['request-tracker']);
  assert.deepEqual(await readdir('skills'), ['request-tracker']);
  assert.deepEqual(await readdir('plugin/skills'), ['request-tracker']);
  assert.match(await readFile('plugin/skills/request-tracker/SKILL.md', 'utf8'), /^name: request-tracker$/m);
  const schema = await json('schema/journal.schema.json');
  assert.equal(schema.title, 'Request Tracker saved state');
  assert.equal(schema.$id, 'https://github.com/kwonzweig/agent-request-tracker/schema/journal.schema.json');
});

test('retired branding is confined to upgrade compatibility and its tests', async () => {
  const permitted = new Set(['docs/install.md', 'src/compatibility.mjs', 'tests/data-paths.test.mjs']);
  const retired = new RegExp([['request', 'journal'].join('[-_ ]'), ['codex', 'request', 'tracker'].join('-')].join('|'), 'i');
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', windowsHide: true }).split('\0');
  for (const file of tracked) {
    if (permitted.has(file) || !/\.(?:md|mjs|json|ya?ml)$/.test(file)) continue;
    let text;
    try { text = await readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    assert.doesNotMatch(text, retired, `${file} reintroduces retired branding`);
  }
});
