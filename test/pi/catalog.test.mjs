import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Catalog } from '../../.work/pi-test/catalog.mjs';

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
