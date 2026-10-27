import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..'), directory = resolve(root, 'dist/reverie-pi');
const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
for (const [name, expected] of Object.entries(manifest.files)) {
  if (createHash('sha256').update(await readFile(resolve(directory, name))).digest('hex') !== expected.sha256) throw new Error('Release content changed after build: ' + name);
}
const npm = process.env.npm_execpath ?? resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const packed = spawnSync(process.execPath, [npm, 'pack', directory, '--pack-destination', resolve(root, 'dist'), '--json'], { cwd: root, encoding: 'utf8', windowsHide: true });
if (packed.status !== 0) throw packed.error ?? new Error(packed.stderr);
const info = JSON.parse(packed.stdout)[0], archive = resolve(root, 'dist', info.filename);
const names = info.files.map(file => file.path);
if (names.some(name => /(?:\.sqlite|\.env|node_modules|^test\/|^\.work\/|cordis|locale\/)/i.test(name))) throw new Error('Unexpected release content');
const report = { version: manifest.version, piVersion: manifest.piVersion, archive: `dist/${info.filename}`, bytes: (await stat(archive)).size,
  sha256: createHash('sha256').update(await readFile(archive)).digest('hex'), files: names, platform: manifest.platform };
await writeFile(resolve(root, 'validation/pi-package.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Packaged ${report.archive} (${report.bytes} bytes).`);
