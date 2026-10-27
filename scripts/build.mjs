import { build } from 'esbuild';
import { mkdir, readFile, writeFile, cp, lstat, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

async function rejectSymlinks(path) {
  let stat;
  try { stat = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink()) throw new Error('Build refused a symlink in the generated package paths');
  if (stat.isDirectory()) for (const name of await readdir(path)) await rejectSymlinks(join(path, name));
}

async function bundledNotices(root, metafiles) {
  const packages = new Set();
  for (const metafile of metafiles) for (const output of Object.values(metafile.outputs)) {
    for (const [input, details] of Object.entries(output.inputs)) {
      const dependency = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/.exec(input.replaceAll('\\', '/'));
      if (details.bytesInOutput > 0 && dependency) packages.add(dependency[1]);
    }
  }
  const sections = ['Third-party code included in the generated server and browser bundles.\n'];
  for (const dependency of [...packages].sort()) {
    const directory = resolve(root, dependency);
    const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const files = (await readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(name)).sort();
    if (!files.some(name => /^(?:licen[cs]e|copying)(?:\.|$)/i.test(name))) {
      throw new Error(`Missing upstream license for bundled dependency ${metadata.name}`);
    }
    const texts = [];
    for (const name of files) {
      await rejectSymlinks(join(directory, name));
      texts.push(`--- ${name} ---\n${await readFile(join(directory, name), 'utf8')}`);
    }
    sections.push(`${metadata.name}@${metadata.version}\nDeclared package license: ${metadata.license || 'See upstream license text'}\n\n${texts.join('\n')}`);
  }
  return sections.join('\n========================================\n\n') + '\n';
}

export async function buildPackage(repositoryRoot = fileURLToPath(new URL('../', import.meta.url))) {
  const root = resolve(repositoryRoot), pluginRoot = resolve(root, 'plugin');
  // Only these generated directories are replaced. Preflight every target before
  // deleting output; canonical manifests, hooks and assets are never cleaned.
  const generated = ['dist', 'skills', 'schema', '.codex-plugin'].map(name => resolve(pluginRoot, name));
  if ((await lstat(root)).isSymbolicLink() || (await lstat(pluginRoot)).isSymbolicLink()) {
    throw new Error('Build refused a symlink repository or plugin root');
  }
  for (const target of [...generated, ...['.mcp.json', 'LICENSE', 'THIRD_PARTY_NOTICES.txt'].map(name => resolve(pluginRoot, name))]) {
    const inside = relative(pluginRoot, target);
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('Build target is outside the plugin root');
    await rejectSymlinks(target);
  }
  const manifest = JSON.parse(await readFile(join(pluginRoot, 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(await readFile(join(pluginRoot, 'mcp.json'), 'utf8'));
  await rejectSymlinks(join(root, 'LICENSE'));
  const license = await readFile(join(root, 'LICENSE'), 'utf8');
  for (const target of generated) await rm(target, { recursive: true, force: true });
  await mkdir(join(pluginRoot, 'dist'), { recursive: true });
  const server = await build({ absWorkingDir: root, entryPoints: ['src/server.mjs','src/hook.mjs','src/cli.mjs'], outdir: join(pluginRoot, 'dist'), bundle: true, platform: 'node', target: 'node22', format: 'esm', metafile: true, outExtension: { '.js': '.mjs' }, banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  const bundle = await build({ absWorkingDir: root, entryPoints: ['src/app.mjs'], bundle: true, platform: 'browser', format: 'iife', write: false, minify: true, metafile: true });
  const shell = await readFile(join(root, 'src/app.html'), 'utf8');
  await writeFile(join(pluginRoot, 'dist/journal.html'), shell.replace('/* JOURNAL_SCRIPT */', () => bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')), 'utf8');
  await writeFile(join(pluginRoot, 'LICENSE'), license, 'utf8');
  await writeFile(join(pluginRoot, 'THIRD_PARTY_NOTICES.txt'), await bundledNotices(root, [server.metafile, bundle.metafile]), 'utf8');
  await cp(join(root, 'skills'), join(pluginRoot, 'skills'), { recursive: true });
  await cp(join(root, 'schema'), join(pluginRoot, 'schema'), { recursive: true });
  // Older Codex clients discover the documented compatibility layout only.
  // Generate it from the canonical portable package; do not maintain two configs.
  await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true });
  await writeFile(join(pluginRoot, '.codex-plugin/plugin.json'), JSON.stringify({ name: manifest.name, version: manifest.version, description: manifest.description, skills: './skills/', mcpServers: './.mcp.json', ...manifest.extensions['com.openai'] }, null, 2) + '\n');
  await writeFile(join(pluginRoot, '.mcp.json'), JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(mcp.mcpServers).map(([key, { type, ...settings }]) => [key, settings])) }, null, 2) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Unsupported build arguments');
  await buildPackage();
  console.log('Built local plugin (no installation or inference calls).');
}
