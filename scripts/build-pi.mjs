import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { nativeNotices } from './lib/native-notices.mjs';

const root = resolve(import.meta.dirname, '..');
const metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
for (const args of [['scripts/cargo.mjs', 'build', '--release', '--locked'], ['node_modules/typescript/bin/tsc', '-p', 'pi/tsconfig.json']]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw result.error ?? new Error('Build validation failed.');
}
const directory = resolve(root, process.env.REVERIE_PACKAGE_DIR ?? 'dist/reverie-pi');
for (const folder of ['lib', 'bin/win32-x64']) await mkdir(resolve(directory, folder), { recursive: true });
await build({ entryPoints: ['pi/src/extension.ts'], outfile: resolve(directory, 'lib/extension.js'), bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['@earendil-works/pi-tui'] });
const engineSource = resolve(root, 'engine/target/x86_64-pc-windows-gnu/release/reverie-engine.exe');
const engineTarget = resolve(directory, 'bin/win32-x64/reverie.exe');
// An active Windows Pi session holds the executable open. Extension-only fixes
// can update in place without overwriting its identical native engine.
let engineUnchanged = false;
try { engineUnchanged = (await readFile(engineSource)).equals(await readFile(engineTarget)); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!engineUnchanged) await copyFile(engineSource, engineTarget);
await copyFile(resolve(root, 'docs/quickstart.md'), resolve(directory, 'README.md'));
await copyFile(resolve(root, 'docs/user-controls.md'), resolve(directory, 'CONTROLS.md'));
for (const name of ['LICENSE', 'NOTICE']) await copyFile(resolve(root, name), resolve(directory, name));
await nativeNotices(root, directory);
await writeFile(resolve(directory, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, private: true,
  description: metadata.description, type: 'module', license: metadata.license, repository: metadata.repository,
  keywords: ['pi-package', 'roleplay', 'memory'],
  engines: { node: metadata.engines.node }, os: ['win32'], cpu: ['x64'], pi: { extensions: ['./lib/extension.js'] },
  files: ['lib', 'bin', 'notices', 'LICENSE', 'NOTICE', 'README.md', 'CONTROLS.md', 'manifest.json'] }, null, 2) + '\n');
const files = {};
async function scan(folder = '') {
  for (const entry of await readdir(resolve(directory, folder), { withFileTypes: true })) {
    const name = (folder ? folder + '/' : '') + entry.name;
    if (entry.isDirectory()) await scan(name);
    else if (name !== 'manifest.json') files[name] = { bytes: (await stat(resolve(directory, name))).size,
      sha256: createHash('sha256').update(await readFile(resolve(directory, name))).digest('hex') };
  }
}
await scan();
await writeFile(resolve(directory, 'manifest.json'), JSON.stringify({ version: metadata.version, piVersion: '1.3.0', platform: 'win32-x64', files }, null, 2) + '\n');
console.log(`Built ${metadata.name} ${metadata.version} for Pi 1.3.0: ${directory}`);
