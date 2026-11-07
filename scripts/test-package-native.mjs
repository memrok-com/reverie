import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Package verification requires Windows x64.');
const manifest = await readFile(resolve(root, 'engine/Cargo.toml'), 'utf8');
const releaseVersion = manifest.match(/^version = "([^"]+)"$/m)?.[1];
assert.ok(releaseVersion, 'Missing engine version');
const archive = resolve(process.argv[2] ?? resolve(root, `dist/reverie-v${releaseVersion}-windows-x64.zip`));
const expected = (await readFile(archive + '.sha256', 'utf8')).trim().split(/\s+/);
assert.equal(expected[1], basename(archive));
assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), expected[0]);
const temporaryRoot = resolve(root, '.work/package-smoke');
await mkdir(temporaryRoot, { recursive: true });
const temporary = await mkdtemp(resolve(temporaryRoot, 'extracted-'));
const extracted = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  '$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:REVERIE_PACKAGE_ARCHIVE, $env:REVERIE_PACKAGE_EXTRACTED)'],
{ windowsHide: true, env: { ...process.env, REVERIE_PACKAGE_ARCHIVE: archive, REVERIE_PACKAGE_EXTRACTED: temporary }, encoding: 'utf8' });
if (extracted.error || extracted.status !== 0) throw extracted.error ?? new Error(extracted.stderr);
const directory = resolve(temporary, basename(archive, '.zip'));
for (const file of ['LICENSE', 'NOTICE', 'README.md', 'notices/README.md', 'notices/rust/COPYRIGHT-library.html', 'notices/SQLite-header.txt'])
  assert.ok((await stat(resolve(directory, file))).isFile(), `Missing package file ${file}`);
const executable = resolve(directory, 'reverie-engine.exe');
const runtimeEnv = { SystemRoot: process.env.SystemRoot, PATH: resolve(process.env.SystemRoot, 'System32') };
const version = spawnSync(executable, ['--version'], { env: runtimeEnv, encoding: 'utf8', windowsHide: true });
assert.equal(version.status, 0, version.stderr);
assert.ok(version.stdout.includes(`Reverie ${releaseVersion} native memory engine`), version.stdout);
const probe = spawnSync(executable, ['--storage-probe'], { env: runtimeEnv, encoding: 'utf8', windowsHide: true });
assert.equal(probe.status, 0, probe.stderr);
assert.match(probe.stdout, /cedar coat/);
const tests = spawnSync(process.execPath, ['--test', 'test/process.test.mjs'], {
  cwd: root, windowsHide: true, stdio: 'inherit',
  env: { ...runtimeEnv, REVERIE_TEST_ENGINE: executable },
});
if (tests.error || tests.status !== 0) throw tests.error ?? new Error('Packaged engine process tests failed.');
console.log(`Verified extracted package ${archive}`);
