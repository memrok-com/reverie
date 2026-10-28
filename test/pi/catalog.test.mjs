import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Catalog } from '../../.work/pi-test/catalog.mjs';
import { MemoryService } from '../../.work/pi-test/service.mjs';
import { reflection } from '../fixtures/subjective.mjs';
import { nativeEnginePath } from '../../scripts/lib/native-toolchain.mjs';

test('catalogs created before thinking preferences retain their saved model during migration', async () => {
  const root = resolve('.work/catalog-tests', randomUUID());
  await mkdir(root, { recursive: true });
  const cwd = await realpath(root), key = process.platform === 'win32' ? cwd.toLocaleLowerCase('en-US') : cwd;
  const old = new DatabaseSync(resolve(root, 'catalog.sqlite'));
  old.exec('CREATE TABLE folder_models(cwd TEXT PRIMARY KEY,provider TEXT NOT NULL,modelId TEXT NOT NULL)');
  old.prepare('INSERT INTO folder_models VALUES(?,?,?)').run(key, 'local', 'roleplay');
  old.close();
  const catalog = new Catalog(root);
  try {
    assert.deepEqual(catalog.folderModel(cwd), { provider: 'local', modelId: 'roleplay' });
    const character = catalog.create('Mara', 'You are Mara.'); catalog.bind(cwd, character.id);
    catalog.setFolderModel(cwd, { provider: 'local', modelId: 'roleplay', thinkingLevel: 'off' });
  } finally { catalog.close(); }
  const reopened = new Catalog(root);
  try { assert.deepEqual(reopened.folderModel(cwd), { provider: 'local', modelId: 'roleplay', thinkingLevel: 'off' }); }
  finally { reopened.close(); }
});

test('a missing parent directory is unavailable until it returns, while a deleted file in that directory is reconciled', async t => {
  const root = resolve('.work/catalog-tests', randomUUID()), parent = resolve(root, 'removable-drive'), offline = resolve(root, 'offline');
  await mkdir(parent, { recursive: true }); const path = resolve(parent, 'scene.jsonl');
  await writeFile(path, JSON.stringify({ id: 'm1', parentId: null, type: 'message', message: { role: 'user', content: 'We meet.' } }) + '\n');
  const catalog = new Catalog(resolve(root, 'data')), character = catalog.create('Mara', 'You are Mara.'), warnings = [];
  const service = new MemoryService(catalog, nativeEnginePath(),
    async request => JSON.stringify(reflection(request)), (source, error) => warnings.push({ source, error }));
  t.after(async () => { await service.close(); catalog.close(); });
  catalog.remember({ characterId: character.id, episodeId: 'scene', cwd: root, path, leaf: 'm1' });
  await service.client(character.id).request('when', { episodeId: 'scene', position: '2000-01-01' });
  await service.client(character.id).request('memorize', { episodeId: 'scene' });
  await rename(parent, offline);
  assert.equal(await service.reconcile(), 0); assert.equal(catalog.source('scene').deleted, 0);
  assert.equal(warnings.length, 1);
  assert.equal((await service.client(character.id).request('retrieve', { at: '2010-01-01' })).memories.length, 1);
  await rename(offline, parent); await service.reconcile();
  catalog.remember({ characterId: character.id, episodeId: 'scene', cwd: root, path, leaf: 'm1' });
  await rm(path); assert.equal(await service.reconcile(), 1);
  assert.equal(catalog.source('scene').deleted, 2);
});

test('a failed warning callback does not block reconciliation or permanently suppress its retry', async t => {
  const root = resolve('.work/catalog-tests', randomUUID());
  const catalog = new Catalog(root, async () => { throw Object.assign(new Error('Unreadable'), { code: 'EACCES' }); });
  t.after(() => catalog.close());
  const character = catalog.create('Mara', 'You are Mara.');
  catalog.remember({ characterId: character.id, episodeId: 'scene', cwd: root, path: resolve(root, 'scene.jsonl'), leaf: null });
  await catalog.missingSources(() => { throw new Error('Notification failed'); });
  let warnings = 0;
  await catalog.missingSources(() => { warnings++; }); await catalog.missingSources(() => { warnings++; });
  assert.equal(warnings, 1); assert.equal(catalog.source('scene').deleted, 0);
});

test('malformed timeout preferences warn once and retain usable engines; fractional seconds are rounded safely', async () => {
  const previous = process.env.REVERIE_REFLECTION_INACTIVITY_SECONDS;
  try {
    for (const [raw, warning] of [['ten', true], ['30m', true], ['', true], ['Infinity', true], ['-1', true], ['86401', true], ['1.0005', false], ['0.1', false], ['86400', false]]) {
      process.env.REVERIE_REFLECTION_INACTIVITY_SECONDS = raw;
      const catalog = new Catalog(resolve('.work/catalog-tests', randomUUID())), messages = [];
      const service = new MemoryService(catalog, nativeEnginePath(), async () => { throw new Error('No model should be called'); }, undefined, message => messages.push(message));
      try {
        assert.equal((await service.client('one').request('ping')).runtime, 'rust');
        assert.equal((await service.client('two').request('ping')).runtime, 'rust');
        assert.equal(messages.length, warning ? 1 : 0, raw);
        if (warning) assert.match(messages[0], /REVERIE_REFLECTION_INACTIVITY_SECONDS.*default ten-minute/);
      } finally { await service.close(); catalog.close(); }
    }
  } finally {
    if (previous === undefined) delete process.env.REVERIE_REFLECTION_INACTIVITY_SECONDS;
    else process.env.REVERIE_REFLECTION_INACTIVITY_SECONDS = previous;
  }
});

for (const code of ['EACCES', 'EPERM', 'EIO', 'EBUSY']) {
  test(`source reconciliation isolates ${code}, warns once, recovers and still processes deletions`, async t => {
    const root = resolve('.work/catalog-tests', randomUUID()), blockedPath = resolve(root, 'blocked.jsonl');
    let unavailable = true;
    const catalog = new Catalog(root, async (path, mode) => {
      assert.equal(mode, constants.R_OK);
      if (path === blockedPath && unavailable) throw Object.assign(new Error('Source temporarily unavailable'), { code });
      return access(path, mode);
    });
    const warnings = [];
    const service = new MemoryService(catalog,
      nativeEnginePath(),
      async request => JSON.stringify(reflection(request)), (source, error) => warnings.push({ source, error }));
    t.after(async () => { await service.close(); catalog.close(); });
    const blocked = catalog.create('Blocked', 'You are wary.'), healthy = catalog.create('Healthy', 'You are hopeful.');
    for (const [character, id, path] of [[blocked, 'blocked', blockedPath], [healthy, 'healthy', resolve(root, 'healthy.jsonl')],
      [healthy, 'deleted', resolve(root, 'deleted.jsonl')]]) {
      await writeFile(path, JSON.stringify({ id: 'm1', parentId: null, type: 'message', message: { role: 'user', content: 'We meet at the lighthouse.' } }) + '\n');
      catalog.remember({ characterId: character.id, episodeId: id, cwd: root, path, leaf: 'm1' });
      await service.client(character.id).request('when', { episodeId: id, position: id === 'deleted' ? '2020-01-01' : '2000-01-01', label: id });
      await service.client(character.id).request('memorize', { episodeId: id });
    }
    const saved = (await service.client(blocked.id).request('inspect')).episodes[0].contribution;
    await rm(resolve(root, 'deleted.jsonl'));
    assert.equal(await service.reconcile(), 1);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].source.episodeId, 'blocked');
    assert.equal(warnings[0].error.code, code);
    assert.equal(catalog.source('blocked').deleted, 0);
    assert.equal(catalog.source('deleted').deleted, 2);
    assert.deepEqual((await service.client(blocked.id).request('inspect')).episodes[0].contribution, saved);
    assert.equal((await service.client(healthy.id).request('retrieve', { at: '2030-01-01' })).memories.length, 1);
    assert.equal((await service.client(healthy.id).request('memorize', { episodeId: 'healthy' })).status, 'current');
    await Promise.all([service.reconcile(), service.reconcile()]);
    assert.equal(warnings.length, 1);
    unavailable = false; await service.reconcile();
    unavailable = true; await service.reconcile();
    assert.equal(warnings.length, 2);
    unavailable = false; await rm(blockedPath); await service.reconcile();
    assert.equal(catalog.source('blocked').deleted, 2);
    assert.equal((await service.client(blocked.id).request('status')).episodes.length, 0);
  });
}
