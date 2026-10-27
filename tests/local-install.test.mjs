import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

test('installation summary keeps only Request Tracker facts from CLI JSON', async () => {
  const { summarizePluginList } = await import('../scripts/check-local-install.mjs');
  const summary = summarizePluginList({ installed: [
    { name: 'other-plugin', version: '9', enabled: true, secret: 'do not display' },
    { name: 'request-journal', marketplaceName: 'request-journal-local', pluginId: 'request-journal@request-journal-local', installed: true, enabled: true, version: '0.1.0', unrelated: 'do not display' },
  ] });
  assert.deepEqual(summary, { installed: true, enabled: true, version: '0.1.0' });
  assert.deepEqual(summarizePluginList({ installed: [] }), { installed: false, enabled: false, version: null });
  assert.throws(() => summarizePluginList({ unexpected: [] }), error => error.code === 'PLUGIN_LIST_SHAPE_UNKNOWN');
});

test('package comparison reports stale and missing cache files without modifying either package', async t => {
  const { comparePackageFiles } = await import('../scripts/check-local-install.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'journal-install-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const built = join(dir, 'built'), cached = join(dir, 'cached');
  await mkdir(join(built, 'dist'), { recursive: true });
  await mkdir(join(cached, 'dist'), { recursive: true });
  await writeFile(join(built, 'plugin.json'), 'same');
  await writeFile(join(cached, 'plugin.json'), 'same');
  await writeFile(join(built, 'dist', 'server.mjs'), 'new build');
  await writeFile(join(cached, 'dist', 'server.mjs'), 'old cache');
  await writeFile(join(built, 'dist', 'journal.html'), 'current UI');
  const result = await comparePackageFiles(built, cached);
  assert.equal(result.status, 'mismatch');
  assert.equal(result.files_checked, 3);
  assert.deepEqual(result.differences, [
    { file: 'dist/journal.html', reason: 'missing_from_cache' },
    { file: 'dist/server.mjs', reason: 'content_differs' },
  ]);
  assert.equal(await readFile(join(built, 'dist', 'server.mjs'), 'utf8'), 'new build');
  assert.equal(await readFile(join(cached, 'dist', 'server.mjs'), 'utf8'), 'old cache');
});

test('package comparison rejects extra cached skills even when all expected files match', async t => {
  const { comparePackageFiles } = await import('../scripts/check-local-install.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'journal-install-extra-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const built = join(dir, 'built'), cached = join(dir, 'cached');
  await mkdir(built);
  await mkdir(join(cached, 'skills', 'removed-skill'), { recursive: true });
  await writeFile(join(built, 'plugin.json'), 'same');
  await writeFile(join(cached, 'plugin.json'), 'same');
  await writeFile(join(cached, 'skills', 'removed-skill', 'SKILL.md'), 'Old discoverable instructions');
  assert.deepEqual(await comparePackageFiles(built, cached), {
    status: 'mismatch', files_checked: 1,
    differences: [{ file: 'skills/removed-skill/SKILL.md', reason: 'unexpected_in_cache' }],
  });
});

test('packaged MCP preflight advertises writes but performs only reads and does not create journal storage', async t => {
  const { checkPackagedProtocol } = await import('../scripts/check-local-install.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'journal-preflight-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'not-created');
  const result = await checkPackagedProtocol(resolve('plugin'), { dataDir });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.tools, ['journal_mark_read', 'journal_read', 'journal_show', 'journal_update']);
  assert.equal(result.journal_read, 'passed_empty_isolated_read');
  assert.equal(result.journal_update, 'advertised_not_invoked');
  assert.equal(result.journal_mark_read, 'advertised_app_only_not_invoked');
  assert.equal(result.ui_resource.mime_type, 'text/html;profile=mcp-app');
  await assert.rejects(access(dataDir), error => error.code === 'ENOENT');
});

for (const [label, mutate, code] of [
  ['model-visible read mutation', tools => { tools.find(tool => tool.name === 'journal_mark_read')._meta.ui.visibility = ['model', 'app']; }, 'MCP_TOOL_VISIBILITY_MISMATCH'],
  ['app-visible generic update', tools => { tools.find(tool => tool.name === 'journal_update')._meta.ui.visibility = ['model', 'app']; }, 'MCP_TOOL_VISIBILITY_MISMATCH'],
  ['read mutation mounting a resource', tools => { tools.find(tool => tool.name === 'journal_mark_read')._meta.ui.resourceUri = 'ui://request-journal/tracker.html'; }, 'MCP_UI_BINDING_MISMATCH'],
  ['legacy resource mount on read mutation', tools => { tools.find(tool => tool.name === 'journal_mark_read')._meta['ui/resourceUri'] = 'ui://request-journal/tracker.html'; }, 'MCP_UI_BINDING_MISMATCH'],
  ['lost show resource binding', tools => { tools.find(tool => tool.name === 'journal_show')._meta.ui.resourceUri = 'ui://other/view.html'; }, 'MCP_UI_BINDING_MISMATCH'],
  ['broad read mutation input', tools => { tools.find(tool => tool.name === 'journal_mark_read').inputSchema.properties.upsert = { type: 'object' }; }, 'MCP_READ_MUTATION_SCHEMA_MISMATCH'],
]) test(`packaged preflight rejects ${label}`, async t => {
  const { checkPackagedProtocol } = await import('../scripts/check-local-install.mjs');
  const listTools = Client.prototype.listTools;
  t.mock.method(Client.prototype, 'listTools', async function (...args) {
    const listed = await listTools.apply(this, args);
    mutate(listed.tools); return listed;
  });
  const dir = await mkdtemp(join(tmpdir(), 'journal-preflight-scope-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'not-created');
  await assert.rejects(checkPackagedProtocol(resolve('plugin'), { dataDir }), error => error.code === code);
  await assert.rejects(access(dataDir), error => error.code === 'ENOENT');
});

test('Windows CLI resolution preserves PATH precedence between npm shims and native binaries', async t => {
  const { codexCommand } = await import('../scripts/check-local-install.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'journal-codex-path-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const earlier = join(dir, 'npm'), later = join(dir, 'native');
  const entry = join(earlier, 'node_modules/@openai/codex/bin/codex.js');
  await mkdir(join(earlier, 'node_modules/@openai/codex/bin'), { recursive: true });
  await mkdir(later);
  await writeFile(join(earlier, 'codex.cmd'), 'official npm shim');
  await writeFile(entry, 'official npm entrypoint');
  await writeFile(join(later, 'codex.exe'), 'native executable');
  assert.deepEqual(await codexCommand({ platform: 'win32', searchPath: `${earlier};${later}` }), {
    command: process.execPath, prefix: [entry],
  });
});
