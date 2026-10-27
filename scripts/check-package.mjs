import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { checkRelocatedProtocol } from './check-local-install.mjs';

const portableSchema = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const mcpSchema = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const requireCheck = (condition, code) => { if (!condition) throw new Error(code); };

async function packagePath(root, declared, directory = false) {
  requireCheck(typeof declared === 'string' && declared.startsWith('./'), 'PACKAGE_PATH_MUST_BE_RELATIVE');
  const target = resolve(root, declared), inside = relative(root, target);
  requireCheck(inside && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside), 'PACKAGE_PATH_OUTSIDE_ROOT');
  let path = root;
  for (const part of inside.split(sep)) {
    path = join(path, part);
    const stat = await lstat(path);
    requireCheck(!stat.isSymbolicLink(), 'PACKAGE_SYMLINK');
    requireCheck(path === target ? (directory ? stat.isDirectory() : stat.isFile()) : stat.isDirectory(), 'PACKAGE_PATH_NOT_REGULAR');
  }
  return target;
}

export async function validatePackage(repositoryRoot = resolve('.')) {
  const root = resolve(repositoryRoot), plugin = join(root, 'plugin');
  requireCheck((await lstat(root)).isDirectory() && (await lstat(plugin)).isDirectory(), 'PACKAGE_ROOT_NOT_REGULAR');
  const metadata = await json(join(root, 'package.json'));
  const lock = await json(join(root, 'package-lock.json'));
  const manifest = await json(await packagePath(plugin, './plugin.json'));
  requireCheck(manifest.$schema === portableSchema, 'PACKAGE_PORTABLE_SCHEMA_MISMATCH');
  requireCheck(manifest.name === metadata.name && lock.name === metadata.name && lock.packages?.['']?.name === metadata.name, 'PACKAGE_NAME_MISMATCH');
  requireCheck(manifest.version === metadata.version && lock.version === metadata.version && lock.packages?.['']?.version === metadata.version, 'PACKAGE_VERSION_MISMATCH');
  requireCheck(metadata.engines?.node === '>=22' && lock.packages?.['']?.engines?.node === metadata.engines.node, 'PACKAGE_NODE_REQUIREMENT_MISMATCH');
  requireCheck(isDeepStrictEqual(lock.packages[''].dependencies, metadata.dependencies) && isDeepStrictEqual(lock.packages[''].devDependencies, metadata.devDependencies), 'PACKAGE_LOCK_DEPENDENCIES_MISMATCH');

  const extension = manifest.extensions?.['com.openai'];
  requireCheck(extension && typeof extension.interface?.displayName === 'string', 'PACKAGE_OPENAI_EXTENSION_MISSING');
  const hooks = await json(await packagePath(plugin, extension.hooks));
  requireCheck(hooks.hooks && typeof hooks.hooks === 'object', 'PACKAGE_HOOK_CONFIG_INVALID');
  for (const entries of Object.values(hooks.hooks)) for (const entry of entries) for (const hook of entry.hooks) {
    const command = /^node "\$\{PLUGIN_ROOT\}\/([^"\r\n]+)"$/.exec(hook.command);
    requireCheck(hook.type === 'command' && command, 'PACKAGE_HOOK_COMMAND_INVALID');
    await packagePath(plugin, `./${command[1]}`);
  }

  const mcp = await json(await packagePath(plugin, './mcp.json'));
  requireCheck(mcp.$schema === mcpSchema && mcp.mcpServers?.journal, 'PACKAGE_MCP_CONFIG_INVALID');
  for (const settings of Object.values(mcp.mcpServers)) {
    const entrypoint = /^\$\{PLUGIN_ROOT\}\/(.+)$/.exec(settings.args?.[0]);
    requireCheck(settings.type === 'stdio' && settings.command === 'node' && entrypoint, 'PACKAGE_MCP_COMMAND_INVALID');
    await packagePath(plugin, `./${entrypoint[1]}`);
  }
  const compatibility = await json(await packagePath(plugin, './.codex-plugin/plugin.json'));
  requireCheck(isDeepStrictEqual(compatibility, { name: manifest.name, version: manifest.version, description: manifest.description,
    skills: './skills/', mcpServers: './.mcp.json', ...extension }), 'PACKAGE_COMPATIBILITY_MANIFEST_MISMATCH');
  const compatibilityMcp = await json(await packagePath(plugin, compatibility.mcpServers));
  requireCheck(isDeepStrictEqual(compatibilityMcp, { mcpServers: Object.fromEntries(Object.entries(mcp.mcpServers).map(([name, { type, ...settings }]) => [name, settings])) }), 'PACKAGE_COMPATIBILITY_MCP_MISMATCH');
  await packagePath(plugin, compatibility.skills, true);
  for (const path of ['dist/server.mjs', 'dist/hook.mjs', 'dist/cli.mjs', 'dist/journal.html', 'skills/request-journal/SKILL.md', 'schema/journal.schema.json', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) {
    await packagePath(plugin, `./${path}`);
  }
  requireCheck((await readFile(join(root, 'LICENSE'))).equals(await readFile(join(plugin, 'LICENSE'))), 'PACKAGE_PROJECT_LICENSE_MISMATCH');
  for (const path of ['skills/request-journal/SKILL.md', 'schema/journal.schema.json']) {
    requireCheck((await readFile(join(root, path))).equals(await readFile(join(plugin, path))), 'PACKAGE_BUNDLED_SOURCE_MISMATCH');
  }
  const server = await readFile(join(root, 'src/server.mjs'), 'utf8');
  const app = await readFile(join(root, 'src/app.mjs'), 'utf8');
  requireCheck(/const runtimeVersion = ['"]([^'"]+)['"]/.exec(server)?.[1] === manifest.version &&
    /new App\(\{ name: ['"]Request Tracker['"], version: ['"]([^'"]+)['"]/.exec(app)?.[1] === manifest.version, 'PACKAGE_SOURCE_VERSION_MISMATCH');
  requireCheck(metadata.scripts.start === 'node plugin/dist/server.mjs', 'PACKAGE_START_ENTRYPOINT_MISMATCH');
  return { name: manifest.name, version: manifest.version, root: plugin };
}

export async function checkPackage(repositoryRoot = resolve('.')) {
  const { name, version, root } = await validatePackage(repositoryRoot);
  const protocol = await checkRelocatedProtocol(root);
  requireCheck(protocol.server.version === version, 'PACKAGE_RUNTIME_VERSION_MISMATCH');
  return { status: 'passed', package: { name, version }, protocol, native_ui: 'not_verified' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireCheck(process.argv.length === 2, 'UNSUPPORTED_ARGUMENTS');
    console.log(JSON.stringify(await checkPackage(), null, 2));
  } catch (error) {
    console.error(`Package check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
