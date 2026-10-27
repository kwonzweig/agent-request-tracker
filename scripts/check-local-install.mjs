import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, cp, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const runFile = promisify(execFile);
const name = 'request-journal', marketplace = 'request-journal-local';
const packageRoot = fileURLToPath(new URL('../plugin/', import.meta.url));
const resourceUri = 'ui://request-journal/tracker.html';
const requestOptions = { timeout: 10_000 };
const safeSegment = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);

function requireCheck(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

async function exists(file) {
  try { await access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export function summarizePluginList(result) {
  requireCheck(result && Array.isArray(result.installed), 'PLUGIN_LIST_SHAPE_UNKNOWN');
  const matches = result.installed.filter(plugin => plugin?.name === name && plugin.marketplaceName === marketplace);
  requireCheck(matches.length <= 1, 'AMBIGUOUS_INSTALLATION');
  if (!matches.length) return { installed: false, enabled: false, version: null };
  const plugin = matches[0];
  requireCheck(plugin.installed === true && typeof plugin.enabled === 'boolean' && safeSegment(plugin.version), 'PLUGIN_LIST_SHAPE_UNKNOWN');
  return { installed: true, enabled: plugin.enabled, version: plugin.version };
}

async function packageFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    requireCheck(!entry.isSymbolicLink(), 'PACKAGE_SYMLINK');
    if (entry.isDirectory()) files.push(...await packageFiles(root, relative));
    else {
      requireCheck(entry.isFile(), 'PACKAGE_NONREGULAR_FILE');
      files.push(relative);
    }
  }
  return files.sort();
}

async function cachedFile(root, relative) {
  let file = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    file = join(file, part);
    let stat;
    try { stat = await lstat(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    requireCheck(!stat.isSymbolicLink(), 'CACHE_SYMLINK');
    requireCheck(index === parts.length - 1 ? stat.isFile() : stat.isDirectory(), 'CACHE_NONREGULAR_FILE');
  }
  return readFile(file);
}

export async function comparePackageFiles(builtRoot, cachedRoot) {
  if (!(await exists(cachedRoot))) return { status: 'not_discoverable', files_checked: 0, differences: [] };
  requireCheck(!(await lstat(cachedRoot)).isSymbolicLink(), 'CACHE_SYMLINK');
  const files = await packageFiles(builtRoot), differences = [];
  for (const file of files) {
    const cached = await cachedFile(cachedRoot, file);
    if (cached === null) differences.push({ file, reason: 'missing_from_cache' });
    else {
      const hash = bytes => createHash('sha256').update(bytes).digest('hex');
      if (hash(await readFile(join(builtRoot, file))) !== hash(cached)) differences.push({ file, reason: 'content_differs' });
    }
  }
  const expected = new Set(files);
  for (const file of await packageFiles(cachedRoot)) {
    if (!expected.has(file)) differences.push({ file, reason: 'unexpected_in_cache' });
  }
  return { status: differences.length ? 'mismatch' : 'match', files_checked: files.length, differences };
}

export async function checkPackagedProtocol(root, { dataDir = join(tmpdir(), `request-journal-preflight-${randomUUID()}`) } = {}) {
  // The missing directory is never created. No real conversation or journal is read.
  requireCheck(!(await exists(dataDir)), 'ISOLATED_DATA_PATH_ALREADY_EXISTS');
  const client = new Client({ name: 'request-journal-install-preflight', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(root, 'dist/server.mjs')], cwd: root,
    env: { ...getDefaultEnvironment(), REQUEST_JOURNAL_DATA_DIR: dataDir }, stderr: 'pipe',
  });
  // Drain diagnostics without forwarding potentially private output.
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport, requestOptions);
    const server = client.getServerVersion();
    requireCheck(server?.name === name && safeSegment(server.version), 'MCP_SERVER_IDENTITY_MISMATCH');
    const listed = await client.listTools({}, requestOptions);
    const tools = listed.tools.map(tool => tool.name).sort();
    requireCheck(isDeepStrictEqual(tools, ['journal_mark_read', 'journal_read', 'journal_show', 'journal_update']), 'MCP_TOOLS_MISMATCH');
    for (const tool of listed.tools) {
      if (tool.name === 'journal_show') {
        requireCheck(tool._meta?.ui?.resourceUri === resourceUri && tool._meta?.['ui/resourceUri'] === resourceUri, 'MCP_UI_BINDING_MISMATCH');
      } else {
        if (tool.name === 'journal_update' || tool.name === 'journal_mark_read') {
          const visibility = [tool.name === 'journal_update' ? 'model' : 'app'];
          requireCheck(isDeepStrictEqual(tool._meta?.ui?.visibility, visibility), 'MCP_TOOL_VISIBILITY_MISMATCH');
          requireCheck(isDeepStrictEqual(tool._meta.ui, { visibility }), 'MCP_UI_BINDING_MISMATCH');
        } else requireCheck(tool._meta?.ui === undefined, 'MCP_UI_BINDING_MISMATCH');
        requireCheck(tool._meta?.['ui/resourceUri'] === undefined, 'MCP_UI_BINDING_MISMATCH');
      }
    }
    const readSchema = listed.tools.find(tool => tool.name === 'journal_mark_read').inputSchema;
    const readKeys = ['card_id', 'conversation_id', 'record_revision'];
    requireCheck(readSchema?.type === 'object' && readSchema.additionalProperties !== true &&
      isDeepStrictEqual(Object.keys(readSchema.properties || {}).sort(), readKeys) &&
      isDeepStrictEqual([...(readSchema.required || [])].sort(), readKeys) &&
      ['card_id', 'conversation_id'].every(key => readSchema.properties[key].type === 'string' &&
        readSchema.properties[key].minLength === 1 && readSchema.properties[key].maxLength === 128) &&
      readSchema.properties.record_revision.type === 'integer' && readSchema.properties.record_revision.exclusiveMinimum === 0 &&
      readSchema.properties.record_revision.maximum === Number.MAX_SAFE_INTEGER,
    'MCP_READ_MUTATION_SCHEMA_MISMATCH');
    const read = await client.callTool({ name: 'journal_read', arguments: { conversation_id: 'request-journal-preflight' } }, undefined, requestOptions);
    const journal = read.structuredContent?.journal;
    requireCheck(!read.isError && journal?.schema_version === 1 && journal.conversation_id === 'request-journal-preflight' && journal.revision === 0 &&
      ['requests', 'decisions', 'blockers', 'history'].every(key => Array.isArray(journal[key]) && journal[key].length === 0) && journal.turn === null, 'MCP_READ_CHECK_FAILED');
    const resource = await client.readResource({ uri: resourceUri }, requestOptions);
    const html = resource.contents.find(content => content.uri === resourceUri);
    requireCheck(html?.mimeType === 'text/html;profile=mcp-app' && typeof html.text === 'string' && /Request Tracker/.test(html.text) && !/JOURNAL_SCRIPT/.test(html.text), 'MCP_UI_RESOURCE_CHECK_FAILED');
    requireCheck(!(await exists(dataDir)), 'MCP_READ_CREATED_STORAGE');
    return { status: 'passed', server: { name: server.name, version: server.version }, tools,
      journal_read: 'passed_empty_isolated_read', journal_update: 'advertised_not_invoked', journal_mark_read: 'advertised_app_only_not_invoked',
      ui_resource: { uri: resourceUri, mime_type: html.mimeType, status: 'served' } };
  } finally { await client.close(); }
}

export async function checkRelocatedProtocol(builtRoot) {
  // Enumerate first to reject symlinks before copying distributable contents.
  requireCheck(!(await lstat(builtRoot)).isSymbolicLink(), 'PACKAGE_SYMLINK');
  const files = await packageFiles(builtRoot);
  const isolatedRoot = await mkdtemp(join(tmpdir(), 'request-journal-relocated-'));
  try {
    const copiedRoot = join(isolatedRoot, 'plugin');
    await cp(builtRoot, copiedRoot, { recursive: true });
    const protocol = await checkPackagedProtocol(copiedRoot, { dataDir: join(isolatedRoot, 'journal-not-created') });
    return { ...protocol, execution: 'relocated_distributable_only', files_copied: files.length };
  } finally { await rm(isolatedRoot, { recursive: true, force: true }); }
}

export async function codexCommand({ platform = process.platform, searchPath = process.env.PATH || '' } = {}) {
  if (platform !== 'win32') return { command: 'codex', prefix: [] };
  const directories = searchPath.split(';').filter(Boolean).map(dir => dir.replace(/^"|"$/g, ''));
  for (const directory of directories) {
    const binary = join(directory, 'codex.exe');
    if (await exists(binary)) return { command: binary, prefix: [] };
    // Execute the official npm CLI entrypoint without a shell or .cmd quoting.
    // Keep this within the same PATH walk so a later native binary cannot replace an earlier shim.
    const entry = join(directory, 'node_modules/@openai/codex/bin/codex.js');
    if (await exists(join(directory, 'codex.cmd')) && await exists(entry)) return { command: process.execPath, prefix: [entry] };
  }
  requireCheck(false, 'CODEX_CLI_NOT_FOUND');
}

function failure(error) {
  const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'CHECK_FAILED';
  return { status: 'failed', code };
}

export async function checkLocalInstall() {
  const report = { plugin: name, checks_passed: false,
    native_ui: { status: 'not_verified', reason: 'This checks the PATH Codex CLI and built MCP package. The running desktop may use a different CLI version or loaded cache; native UI mounting is not verified.' } };
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(packageRoot, 'plugin.json'), 'utf8'));
    requireCheck(manifest.name === name && safeSegment(manifest.version), 'PACKAGE_MANIFEST_MISMATCH');
    for (const file of ['dist/server.mjs', 'dist/hook.mjs', 'dist/cli.mjs', 'dist/journal.html', 'schema/journal.schema.json', 'skills/request-journal/SKILL.md', '.codex-plugin/plugin.json', '.mcp.json', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) {
      requireCheck(await exists(join(packageRoot, file)), 'PACKAGE_BUILD_INCOMPLETE');
    }
    report.package = { version: manifest.version, status: 'built' };
  } catch (error) { report.package = failure(error); return report; }
  try {
    const { command, prefix } = await codexCommand();
    const run = async args => (await runFile(command, [...prefix, ...args], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })).stdout;
    const help = await run(['plugin', 'list', '--help']);
    requireCheck(help.includes('--json') && help.includes('--marketplace'), 'CLI_JSON_PLUGIN_LIST_UNSUPPORTED');
    const version = (await run(['--version'])).trim();
    requireCheck(/^codex-cli [A-Za-z0-9._-]+$/.test(version), 'CLI_VERSION_SHAPE_UNKNOWN');
    report.codex = { cli_version: version, ...summarizePluginList(JSON.parse(await run(['plugin', 'list', '--marketplace', marketplace, '--json']))) };
    if (report.codex.installed) {
      const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
      const cachedRoot = join(codexHome, 'plugins/cache', marketplace, name, report.codex.version);
      report.cache = { discovery: 'local_codex_cache_layout', ...await comparePackageFiles(packageRoot, cachedRoot) };
    } else report.cache = { status: 'not_installed', files_checked: 0, differences: [] };
  } catch (error) { report.codex = failure(error); }
  try {
    report.protocol = await checkRelocatedProtocol(packageRoot);
    requireCheck(report.protocol.server.version === manifest.version, 'MCP_PACKAGE_VERSION_MISMATCH');
  } catch (error) { report.protocol = failure(error); }
  report.checks_passed = report.codex?.installed === true && report.codex.enabled === true && report.codex.version === manifest.version &&
    report.protocol.status === 'passed' && report.cache?.status === 'match';
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = process.argv.length === 2 ? await checkLocalInstall() : { plugin: name, checks_passed: false, error: 'UNSUPPORTED_ARGUMENTS' };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.checks_passed ? 0 : 1;
}
