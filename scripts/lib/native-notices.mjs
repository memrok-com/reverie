import { readFile, writeFile, mkdir, readdir, copyFile, cp } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { toolchains, rustToolchain } from './native-toolchain.mjs';

export async function nativeNotices(root, directory) {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/cargo.mjs'), 'metadata', '--format-version', '1', '--locked', '--offline', '--filter-platform', 'x86_64-pc-windows-gnu'],
    { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw result.error ?? new Error(result.stderr);
  const metadata = JSON.parse(result.stdout);
  const notices = resolve(directory, 'notices');
  await mkdir(notices, { recursive: true });
  const index = ['# Third-party notices', '', 'Reverie is licensed under Apache-2.0; see ../LICENSE and ../NOTICE.',
    'These notices cover the native dependency sources, including build dependencies. Third-party components retain their own licenses.', '',
    'The Rust standard library attribution and its referenced license texts are included in rust/. The compiler is not distributed.',
    'SQLite is public domain. Its amalgamation header notice is reproduced below.', '', '## Cargo dependency sources', ''];
  async function collect(folder, target, top = true) {
    let copied = 0;
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const source = resolve(folder, entry.name);
      if (entry.isDirectory() && /^(?:licenses?|third[_-]party)$/i.test(entry.name)) copied += await collect(source, resolve(target, entry.name), false);
      else if (entry.isFile() && (!top || /^(?:LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE|AUTHORS|UNLICENSE)(?:[._-]|$)/i.test(entry.name))) {
        await mkdir(target, { recursive: true }); await copyFile(source, resolve(target, entry.name)); copied++;
      }
    }
    return copied;
  }
  for (const pkg of metadata.packages.filter(pkg => pkg.source)) {
    const target = resolve(notices, 'crates', pkg.name + '-' + pkg.version);
    const count = await collect(dirname(pkg.manifest_path), target);
    if (!count) throw new Error('Missing native dependency notice: ' + pkg.name);
    index.push('- ' + pkg.name + ' ' + pkg.version + ': ' + pkg.license + ' (' + relative(notices, target).replaceAll('\\', '/') + ')');
    if (pkg.name === 'libsqlite3-sys') {
      const sqlite = await readFile(resolve(dirname(pkg.manifest_path), 'sqlite3/sqlite3.c'), 'utf8');
      await writeFile(resolve(notices, 'SQLite-header.txt'), sqlite.slice(0, sqlite.indexOf('*/') + 2) + '\n');
    }
  }
  const rust = resolve(toolchains, 'rustup/toolchains', rustToolchain, 'share/doc/rust');
  await mkdir(resolve(notices, 'rust'), { recursive: true });
  await copyFile(resolve(rust, 'COPYRIGHT-library.html'), resolve(notices, 'rust/COPYRIGHT-library.html'));
  await cp(resolve(rust, 'licenses'), resolve(notices, 'rust/licenses'), { recursive: true });
  for (const name of ['MinGW-w64-COPYING.txt', 'MinGW-w64-AUTHORS.txt', 'GCC-COPYING.RUNTIME.txt', 'GCC-COPYING3.txt']) {
    await copyFile(resolve(root, 'third_party', name), resolve(notices, name));
  }
  index.push('', '## Compiler runtime attribution', '',
    'MinGW-w64 14.0.0 notices: https://github.com/mingw-w64/mingw-w64/tree/v14.0.0',
    'GCC 16.2.0 runtime exception and GPL text: https://github.com/gcc-mirror/gcc/tree/releases/gcc-16.2.0', '',
    'The Pi extension uses Node built-ins at runtime. Pi supplies its own model and extension APIs; its distribution carries its own notices.', '');
  await writeFile(resolve(notices, 'README.md'), index.join('\n'));
}
