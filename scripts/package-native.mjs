import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { nativeNotices } from './lib/native-notices.mjs';
import { nativeTarget } from './lib/native-toolchain.mjs';

const root = resolve(import.meta.dirname, '..');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native release packaging requires Windows x64.');
const manifest = await readFile(resolve(root, 'engine/Cargo.toml'), 'utf8');
const version = manifest.match(/^version = "(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)"$/m)?.[1];
if (!version) throw new Error('The engine needs a release version.');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, windowsHide: true, encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || `${command} failed.`);
  return result.stdout;
}
if (run('git', ['status', '--porcelain', '--untracked-files=normal']).trim())
  throw new Error('Commit the release source before packaging.');
const commit = run('git', ['rev-parse', 'HEAD']).trim();
run(process.execPath, ['scripts/cargo.mjs', 'build', '--release', '--locked'], { stdio: 'inherit' });
const name = `reverie-v${version}-windows-x64`;
const stagingRoot = resolve(root, '.work/native-packages');
await mkdir(stagingRoot, { recursive: true });
const staging = await mkdtemp(resolve(stagingRoot, 'build-'));
const directory = resolve(staging, name);
await mkdir(directory);
const executable = resolve(root, 'engine/target', nativeTarget(), 'release/reverie-engine.exe');
await copyFile(executable, resolve(directory, 'reverie-engine.exe'));
for (const file of ['LICENSE', 'NOTICE']) await copyFile(resolve(root, file), resolve(directory, file));
await nativeNotices(root, directory);
await writeFile(resolve(directory, 'README.md'), `# Reverie v${version}

Windows x64 memory engine, protocol 1.

Launch the engine from a host with a stable character ID and a writable database path.

\x60\x60\x60powershell
.\\reverie-engine.exe --stdio --character mara --database .\\mara.sqlite
\x60\x60\x60

The host supplies played source and model reflection over the JSON-lines connection.
See the [host protocol](https://github.com/memrok-com/reverie/blob/v${version}/docs/architecture.md).

Built from source commit ${commit} with Rust 1.99.1 for x86_64-pc-windows-gnu.
License and third-party attribution are included in LICENSE, NOTICE and notices/.
`);
const temporaryArchive = resolve(staging, name + '.zip');
run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  '$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:REVERIE_PACKAGE_SOURCE, $env:REVERIE_PACKAGE_ARCHIVE, [System.IO.Compression.CompressionLevel]::Optimal, $true)'],
{ env: { ...process.env, REVERIE_PACKAGE_SOURCE: directory, REVERIE_PACKAGE_ARCHIVE: temporaryArchive } });
const checksum = createHash('sha256').update(await readFile(temporaryArchive)).digest('hex');
const temporaryChecksum = temporaryArchive + '.sha256';
await writeFile(temporaryChecksum, checksum + '  ' + basename(temporaryArchive) + '\n');
const dist = resolve(root, 'dist');
await mkdir(dist, { recursive: true });
const archive = resolve(dist, name + '.zip');
await rename(temporaryArchive, archive);
await rename(temporaryChecksum, archive + '.sha256');
console.log(`Packaged ${archive}\nSHA256 ${checksum}`);
