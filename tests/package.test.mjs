import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const run = promisify(execFile);
const repositoryRoot = resolve('.');
const buildScript = resolve('scripts/build.mjs');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const runBuild = root => run(process.execPath, ['--input-type=module', '--eval',
  'const { buildPackage } = await import(process.argv[1]); await buildPackage(process.argv[2]);', pathToFileURL(buildScript).href, root], { windowsHide: true });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'journal-package-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function buildFixture(t) {
  const root = await fixture(t);
  await writeFile(join(root, 'LICENSE'), 'Fixture project license\n');
  for (const path of ['src', 'plugin/hooks', 'skills/request-journal', 'schema']) await mkdir(join(root, path), { recursive: true });
  for (const entry of ['server', 'hook', 'cli', 'app']) await writeFile(join(root, `src/${entry}.mjs`), `console.log('${entry}');`);
  await writeFile(join(root, 'src/app.html'), '<html><script>/* JOURNAL_SCRIPT */</script></html>');
  for (const path of ['plugin/plugin.json', 'plugin/mcp.json', 'plugin/hooks/hooks.json', 'skills/request-journal/SKILL.md', 'schema/journal.schema.json']) {
    await cp(join(repositoryRoot, path), join(root, path));
  }
  return root;
}

test('build distributes the project license and only the licenses of bundled dependency code', async t => {
  const root = await buildFixture(t), dependency = join(root, 'node_modules/@example/bundled');
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: '@example/bundled', version: '1.2.3', license: 'MIT', main: 'index.mjs' }));
  await writeFile(join(dependency, 'index.mjs'), 'export const marker = "bundled dependency";');
  const license = 'Copyright Example\r\nPermission text retained exactly.\r\n';
  const notice = 'Upstream attribution\nKeep this notice.\n';
  await writeFile(join(dependency, 'LICENSE.md'), license);
  await writeFile(join(dependency, 'NOTICE'), notice);
  for (const entry of ['server', 'app']) await writeFile(join(root, `src/${entry}.mjs`), "import { marker } from '@example/bundled'; console.log(marker);");
  const unused = join(root, 'node_modules/unused-dev-dependency');
  await mkdir(unused, { recursive: true });
  await writeFile(join(unused, 'package.json'), JSON.stringify({ name: 'unused-dev-dependency', version: '9.9.9', license: 'MIT' }));
  await writeFile(join(unused, 'LICENSE'), 'Unused dependency license');

  await runBuild(root);
  assert.equal(await readFile(join(root, 'plugin/LICENSE'), 'utf8'), 'Fixture project license\n');
  const notices = await readFile(join(root, 'plugin/THIRD_PARTY_NOTICES.txt'), 'utf8');
  assert.equal(notices.split('@example/bundled@1.2.3').length - 1, 1, 'a dependency shared by server and browser is listed once');
  assert.ok(notices.includes(license), 'preserves the upstream license text');
  assert.ok(notices.includes(notice), 'preserves the upstream notice text');
  assert.doesNotMatch(notices, /unused-dev-dependency|Unused dependency license/);
});

test('build refuses to distribute dependency code without its upstream license', async t => {
  const root = await buildFixture(t), dependency = join(root, 'node_modules/unlicensed');
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'unlicensed', version: '1.0.0', main: 'index.mjs', license: 'MIT' }));
  await writeFile(join(dependency, 'index.mjs'), 'console.log("dependency side effect");');
  await writeFile(join(root, 'src/server.mjs'), "import 'unlicensed';");
  await assert.rejects(runBuild(root), /upstream license.*unlicensed/i);
});

test('build preflights generated license paths before replacing previous output', async t => {
  const root = await buildFixture(t), outside = join(root, 'outside');
  await mkdir(outside);
  await mkdir(join(root, 'plugin/dist'));
  await writeFile(join(root, 'plugin/dist/previous.txt'), 'previous output');
  await symlink(outside, join(root, 'plugin/THIRD_PARTY_NOTICES.txt'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runBuild(root), /symlink/i);
  assert.equal(await readFile(join(root, 'plugin/dist/previous.txt'), 'utf8'), 'previous output');
});

test('npm start serves the built UI resource from a cold isolated MCP process', async t => {
  const manifest = await readJson('package.json');
  const entrypoint = /^node (\S+)$/.exec(manifest.scripts.start)?.[1];
  assert.ok(entrypoint, 'start must be a direct Node server entrypoint');
  const root = await fixture(t), dataDir = join(root, 'not-created');
  const client = new Client({ name: 'journal-start-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(entrypoint)],
    env: { ...getDefaultEnvironment(), REQUEST_JOURNAL_DATA_DIR: dataDir }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport);
    const resource = await client.readResource({ uri: 'ui://request-journal/tracker.html' });
    assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.match(resource.contents[0].text, /Request Tracker/);
    await assert.rejects(access(dataDir), error => error.code === 'ENOENT');
  } finally { await client.close(); }
});

test('rebuild removes stale generated skills and schema while preserving package inputs', async t => {
  const root = await buildFixture(t), plugin = join(root, 'plugin');
  for (const name of ['dist', 'skills', 'schema', '.codex-plugin']) {
    await mkdir(join(plugin, name), { recursive: true });
    await writeFile(join(plugin, name, 'obsolete.txt'), 'must not be distributed');
  }
  const hooks = await readFile(join(plugin, 'hooks/hooks.json'), 'utf8');
  const manifest = await readFile(join(plugin, 'plugin.json'), 'utf8');
  await mkdir(join(plugin, 'assets'));
  await writeFile(join(plugin, 'assets/keep.txt'), 'canonical asset');
  await runBuild(root);
  for (const name of ['dist', 'skills', 'schema', '.codex-plugin']) {
    await assert.rejects(access(join(plugin, name, 'obsolete.txt')), error => error.code === 'ENOENT');
  }
  assert.equal(await readFile(join(plugin, 'hooks/hooks.json'), 'utf8'), hooks);
  assert.equal(await readFile(join(plugin, 'plugin.json'), 'utf8'), manifest);
  assert.equal(await readFile(join(plugin, 'assets/keep.txt'), 'utf8'), 'canonical asset');
});

test('build rejects generated-directory symlinks before writing outside the package', async t => {
  const root = await buildFixture(t), outside = join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(root, 'plugin/dist'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runBuild(root), /symlink/i);
  await assert.rejects(access(join(outside, 'server.mjs')), error => error.code === 'ENOENT');
});

test('build rejects a plugin-root junction before modifying its destination', async t => {
  const root = await buildFixture(t), outside = join(root, 'outside');
  await rename(join(root, 'plugin'), outside);
  await symlink(outside, join(root, 'plugin'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runBuild(root), /symlink/i);
  await assert.rejects(access(join(outside, 'dist')), error => error.code === 'ENOENT');
});

test('build checks every generated tree before deleting any previous output', async t => {
  const root = await buildFixture(t), outside = join(root, 'outside');
  await mkdir(outside);
  await mkdir(join(root, 'plugin/dist'));
  await writeFile(join(root, 'plugin/dist/keep-until-safe.txt'), 'previous output');
  await mkdir(join(root, 'plugin/skills'));
  await symlink(outside, join(root, 'plugin/skills/nested-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runBuild(root), /symlink/i);
  assert.equal(await readFile(join(root, 'plugin/dist/keep-until-safe.txt'), 'utf8'), 'previous output');
});

test('build rejects a generated MCP file symlink before overwriting its destination', async t => {
  const root = await buildFixture(t), outside = join(root, 'outside.json');
  await writeFile(outside, 'outside file');
  if (process.platform === 'win32') {
    // File symlinks require Developer Mode/admin rights on some Windows hosts.
    try { await symlink(outside, join(root, 'plugin/.mcp.json'), 'file'); }
    catch (error) { if (error.code === 'EPERM') return t.skip('Windows file symlink privilege unavailable'); throw error; }
  } else await symlink(outside, join(root, 'plugin/.mcp.json'));
  await assert.rejects(runBuild(root), /symlink/i);
  assert.equal(await readFile(outside, 'utf8'), 'outside file');
});

test('package check validates manifests and serves a cold built MCP resource without installation', async () => {
  const { checkPackage } = await import('../scripts/check-package.mjs');
  const report = await checkPackage(repositoryRoot);
  assert.equal(report.status, 'passed');
  assert.equal(report.protocol.status, 'passed');
  assert.equal(report.protocol.journal_update, 'advertised_not_invoked');
  assert.equal(report.protocol.journal_mark_read, 'advertised_app_only_not_invoked');
  assert.equal(report.protocol.execution, 'relocated_distributable_only');
  assert.equal(report.native_ui, 'not_verified');
});

test('relocation launches only distributable files outside the supplied package', async t => {
  const { checkRelocatedProtocol } = await import('../scripts/check-local-install.mjs');
  const root = await fixture(t), packageRoot = join(root, 'plugin');
  await cp(join(repositoryRoot, 'plugin'), packageRoot, { recursive: true });
  const entry = join(packageRoot, 'dist/server.mjs');
  const original = await readFile(entry, 'utf8');
  // These checks execute in the real cold server, not an injected test probe.
  await writeFile(entry, `import { existsSync as relocationExists } from 'node:fs';
import { resolve as relocationResolve, dirname as relocationDirname } from 'node:path';
import { fileURLToPath as relocationFile } from 'node:url';
if (process.cwd() === ${JSON.stringify(packageRoot)} || process.cwd() !== relocationResolve(relocationDirname(relocationFile(import.meta.url)), '..')) throw new Error('NOT_RELOCATED');
for (const path of ['src', 'node_modules', 'package.json', 'scripts']) {
  if (relocationExists(relocationResolve(process.cwd(), '..', path))) throw new Error('SOURCE_DEPENDENCY_COPIED');
}
${original}`);
  const report = await checkRelocatedProtocol(packageRoot);
  assert.equal(report.status, 'passed');
  assert.equal(report.execution, 'relocated_distributable_only');
  assert.ok(report.files_copied > 0);
  // A runtime dependency present only beside the original package must fail.
  await writeFile(join(root, 'checkout-only.mjs'), 'export default 1;');
  await writeFile(entry, `import '../../checkout-only.mjs';\n${original}`);
  await assert.rejects(checkRelocatedProtocol(packageRoot));
});

test('package validation rejects version drift and escaping manifest paths', async t => {
  const { validatePackage } = await import('../scripts/check-package.mjs');
  const root = await fixture(t);
  for (const path of ['package.json', 'package-lock.json', 'plugin', 'src', 'skills', 'schema']) {
    await cp(join(repositoryRoot, path), join(root, path), { recursive: true });
  }
  const path = join(root, 'plugin/plugin.json'), manifest = await readJson(path);
  await writeFile(path, JSON.stringify({ ...manifest, version: '0.0.0' }));
  await assert.rejects(validatePackage(root), /PACKAGE_VERSION_MISMATCH/);
  await writeFile(path, JSON.stringify({ ...manifest, extensions: { 'com.openai': { ...manifest.extensions['com.openai'], hooks: './../../../outside.json' } } }));
  await assert.rejects(validatePackage(root), /PACKAGE_PATH_OUTSIDE_ROOT/);
});

test('package validation rejects a different project license and missing dependency notices', async t => {
  const { validatePackage } = await import('../scripts/check-package.mjs');
  const root = await fixture(t);
  for (const path of ['package.json', 'package-lock.json', 'LICENSE', 'plugin', 'src', 'skills', 'schema']) {
    await cp(join(repositoryRoot, path), join(root, path), { recursive: true });
  }
  await validatePackage(root);
  await writeFile(join(root, 'plugin/LICENSE'), 'different project license');
  await assert.rejects(validatePackage(root), /PACKAGE_PROJECT_LICENSE_MISMATCH/);
  await cp(join(root, 'LICENSE'), join(root, 'plugin/LICENSE'));
  await rm(join(root, 'plugin/THIRD_PARTY_NOTICES.txt'));
  await assert.rejects(validatePackage(root), error => error.code === 'ENOENT' && error.path.endsWith('THIRD_PARTY_NOTICES.txt'));
});
