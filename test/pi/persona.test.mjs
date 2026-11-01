import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, readlink, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readPersona, savePersona } from '../../.work/pi-test/persona.mjs';

async function linkedFolders(t) {
  const root = resolve('.work/persona-tests', randomUUID()), first = join(root, 'first'), second = join(root, 'second'), shared = join(root, 'shared.md');
  await mkdir(first, { recursive: true }); await mkdir(second); await writeFile(shared, 'A shared personality.'); await chmod(shared, 0o644);
  try {
    await symlink(shared, join(first, 'CHARACTER.md'), 'file');
    await symlink(shared, join(second, 'CHARACTER.md'), 'file');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows does not permit file symlink creation in this test environment.'); return; }
    throw error;
  }
  return { root, first, second, shared, path: join(first, 'CHARACTER.md') };
}

test('saving through a symlink preserves both folder links, edits the shared target and retains its mode', async t => {
  const f = await linkedFolders(t); if (!f) return;
  const previous = readPersona(f.first), link = await readlink(f.path), mode = (await stat(f.shared)).mode & 0o777;
  savePersona(f.first, 'The revised shared personality.', previous);
  assert.equal((await lstat(f.path)).isSymbolicLink(), true); assert.equal(await readlink(f.path), link);
  assert.equal((await lstat(join(f.second, 'CHARACTER.md'))).isSymbolicLink(), true);
  assert.equal(await readFile(f.shared, 'utf8'), 'The revised shared personality.');
  assert.equal(readPersona(f.second), 'The revised shared personality.');
  assert.equal((await stat(f.shared)).mode & 0o777, mode);
  assert.deepEqual((await readdir(f.root)).sort(), ['first', 'second', 'shared.md']);
});

test('saving a regular prompt retains its existing permissions', async () => {
  const cwd = resolve('.work/persona-tests', randomUUID()); await mkdir(cwd, { recursive: true });
  const path = join(cwd, 'CHARACTER.md'); await writeFile(path, 'Original personality.'); await chmod(path, 0o640);
  const mode = (await stat(path)).mode & 0o777;
  savePersona(cwd, 'Revised personality.', readPersona(cwd));
  assert.equal(readPersona(cwd), 'Revised personality.'); assert.equal((await stat(path)).mode & 0o777, mode);
});

test('external edits to a linked target prevent saving a stale draft without changing the link or target', async t => {
  const f = await linkedFolders(t); if (!f) return;
  const previous = readPersona(f.first); await writeFile(f.shared, 'An external revision.');
  assert.throws(() => savePersona(f.first, 'A stale revision.', previous), /changed while the editor was open/);
  assert.equal((await lstat(f.path)).isSymbolicLink(), true);
  assert.equal(readPersona(f.second), 'An external revision.');
  assert.deepEqual((await readdir(f.root)).sort(), ['first', 'second', 'shared.md']);
});

test('a dangling prompt symlink is retained and explains how to recover', async t => {
  const f = await linkedFolders(t); if (!f) return;
  await rm(f.shared);
  assert.throws(() => savePersona(f.first, 'A replacement personality.', undefined), /symbolic link points to a missing file.*Repair the link/);
  assert.equal((await lstat(f.path)).isSymbolicLink(), true);
  await assert.rejects(readFile(f.shared), { code: 'ENOENT' });
  assert.deepEqual((await readdir(f.root)).sort(), ['first', 'second']);
});
