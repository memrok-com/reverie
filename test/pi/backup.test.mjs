import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { unzipSync, zipSync } from 'fflate';
import { Catalog } from '../../.work/pi-test/catalog.mjs';
import { MemoryService } from '../../.work/pi-test/service.mjs';
import { exportStory, restoreStory } from '../../.work/pi-test/story-backup.mjs';
import { extractSource, readBranchFile, readSourceFile, sourceHash } from '../../.work/pi-test/source.mjs';
import { recallHistory } from '../../.work/pi-test/recall-history.mjs';
import { nativeEnginePath } from '../../scripts/lib/native-toolchain.mjs';
import { reflection } from '../fixtures/subjective.mjs';

const executable = nativeEnginePath(), hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = resolve('.work/backup-tests', randomUUID()), cwd = join(root, 'original-folder');
  await mkdir(cwd, { recursive: true });
  const catalog = new Catalog(join(root, 'original-data')), character = catalog.create('Mara', 'You are Mara, proud and wary.');
  catalog.bind(cwd, character.id); catalog.setFolderModel(cwd, { provider: 'unavailable', modelId: 'local-roleplay', thinkingLevel: 'high' });
  const service = new MemoryService(catalog, executable, async request => JSON.stringify(reflection(request)));
  const client = service.client(character.id), managers = [];
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await service.close(); catalog.close(); } };
  t.after(close);
  const episode = async (label, date, alternatives = false) => {
    const manager = SessionManager.create(cwd, join(cwd, 'sessions'));
    manager.appendCustomEntry('reverie.binding', { characterId: character.id });
    manager.appendCustomEntry('reverie.foundation', { text: character.persona });
    const user = manager.appendMessage({ role: 'user', content: 'I offer a blue lantern.', timestamp: 1 });
    const selected = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'SELECTED: I accept.' }], stopReason: 'stop' });
    if (alternatives) {
      manager.branch(manager.getEntry(user).parentId);
      manager.appendMessage({ role: 'user', content: 'I offer a blue lantern.', timestamp: 2 });
      manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'REJECTED: I refuse.' }], stopReason: 'stop' });
      manager.branch(selected); if (alternatives !== 'bare') manager.appendCustomEntry('reverie.selection', { replyId: selected });
    }
    const id = manager.getSessionId(); managers.push(manager);
    catalog.remember({ characterId: character.id, episodeId: id, cwd, path: manager.getSessionFile(), leaf: manager.getLeafId() });
    await client.request('when', { episodeId: id, position: date, label });
    return id;
  };
  const first = await episode('The meeting', '2000-01-01');
  await client.request('when', { episodeId: first, position: '2001-01-01' });
  await client.request('memorize', { episodeId: first });
  const inspection = await client.request('inspect');
  const preview = await client.request('previewCorrection', { episodeId: first, revision: inspection.revision, memoryIndex: 0,
    replacement: { ...inspection.episodes[0].contribution.memories[0], gist: 'The player offered the lantern.' } });
  await client.request('applyCorrection', { token: preview.token }); await client.request('rebuild', { force: false });
  const withdrawn = await episode('Unmemorized scene', '2010-01-01');
  await client.request('memorize', { episodeId: withdrawn }); await client.request('unmemorize', { episodeId: withdrawn });
  const later = await episode('The reunion', '2030-01-01', 'bare'); await client.request('memorize', { episodeId: later });
  const recall = await client.request('retrieve', { episodeId: later, at: '2030-01-01', cue: 'lantern' });
  catalog.saveRecall(later, managers.at(-1).getBranch().findLast(entry => entry.type === 'message').id,
    { ...recall, playedPrefixHash: sourceHash(extractSource(managers.at(-1).getBranch())) });
  catalog.bind(cwd, character.id, false);
  const archive = join(root, 'story.zip');
  return { root, cwd, catalog, character, service, client, first, withdrawn, later, managers, archive, close };
}
async function destination(t, root) {
  const cwd = join(root, 'restored-folder'), home = join(root, 'restored-data'); await mkdir(cwd, { recursive: true });
  const catalog = new Catalog(home);
  const service = new MemoryService(catalog, executable, async request => JSON.stringify(reflection(request)));
  t.after(async () => { await service.close(); catalog.close(); });
  return { cwd, home, catalog, service };
}

test('story ZIP round trip relocates Pi source, preserves selected branches, corrections, withdrawal and provenance', async t => {
  const f = await fixture(t), original = await f.client.request('inspect');
  const latestPath = f.catalog.source(f.later).path, lines = (await readFile(latestPath, 'utf8')).trim().split('\n');
  const header = JSON.parse(lines[0]); header.parentSession = f.catalog.source(f.first).path;
  lines[0] = JSON.stringify(header); await writeFile(latestPath, lines.join('\n') + '\n');
  await writeFile(join(f.root, 'auth.json'), '{"apiKey":"PROVIDER_SECRET_MUST_NOT_EXPORT"}');
  await exportStory(f.catalog, f.character.id, f.archive, f.cwd);
  const zip = unzipSync(await readFile(f.archive)), story = JSON.parse(Buffer.from(zip['story.json']).toString());
  assert.equal(story.version, 1); assert.equal(story.sources.length, 3);
  assert.doesNotMatch(JSON.stringify(story), /PROVIDER_SECRET_MUST_NOT_EXPORT/);
  assert.ok(!Object.keys(zip).some(name => /auth|credentials/.test(name)));
  for (const source of story.sources) assert.equal(JSON.parse(Buffer.from(zip[source.file]).toString().split('\n')[0]).cwd, '.');
  const selectedBefore = await readSourceFile(f.catalog.source(f.later).path, f.catalog.source(f.later).leaf);
  await f.close();
  // Remove the original source location: restoration must not rely on it.
  assert.ok(resolve(f.cwd).startsWith(resolve('.work/backup-tests') + '\\') || resolve(f.cwd).startsWith(resolve('.work/backup-tests') + '/'));
  await rm(f.cwd, { recursive: true });
  const d = await destination(t, f.root);
  const other = d.catalog.create('Other story', 'You are another character.');
  const restored = await restoreStory(d.catalog, f.archive, d.cwd, executable);
  assert.deepEqual(restored, f.character); assert.deepEqual({ ...d.catalog.character(other.id) }, other);
  assert.deepEqual(d.catalog.binding(d.cwd), { characterId: restored.id, enabled: false });
  assert.deepEqual(d.catalog.folderModel(d.cwd), { provider: 'unavailable', modelId: 'local-roleplay', thinkingLevel: 'high' });
  const after = await d.service.client(restored.id).request('inspect');
  assert.deepEqual(after, original);
  const source = d.catalog.source(f.later);
  assert.ok(source.path.startsWith(d.home));
  assert.deepEqual(await readSourceFile(source.path, source.leaf), selectedBefore);
  assert.match(JSON.stringify(selectedBefore), /SELECTED/); assert.doesNotMatch(JSON.stringify(selectedBefore), /REJECTED/);
  const resumed = SessionManager.open(source.path);
  assert.deepEqual(extractSource(resumed.getBranch()), selectedBefore);
  assert.equal(resumed.getHeader().parentSession, d.catalog.source(f.first).path);
  assert.equal(resumed.getSessionId(), f.later); assert.equal(resumed.getCwd(), d.cwd);
  assert.ok(d.catalog.recall(resumed.getBranch().findLast(entry => entry.type === 'message').id));
  const historical = recallHistory(d.catalog, await readBranchFile(source.path, source.leaf), f.later, restored.id);
  assert.equal(historical.length, 1);
  const recalledAfterRestore = await d.service.client(restored.id).request('retrieve', { episodeId: f.later, at: '2030-01-01', recallHistory: historical });
  assert.equal(recalledAfterRestore.historicalContext[0].episodeId, f.first);
  const rebuilt = await d.service.client(restored.id).request('rebuild', { force: true });
  assert.equal(rebuilt.reflected, 2);
  assert.equal((await d.service.client(restored.id).request('status')).episodes.find(episode => episode.id === f.withdrawn).included, false);
  const marker = join(d.home, `restore-${restored.id}.json`), directory = source.path.split(/[\\/]/).at(-2);
  await writeFile(marker, JSON.stringify({ characterId: restored.id, directory, cwd: d.cwd, pid: 2147483647 }));
  const checked = new Catalog(d.home);
  try { assert.equal(checked.character(restored.id).name, 'Mara'); await readFile(source.path); }
  finally { checked.close(); }
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('backup includes an active unplayed Pi setup without creating a live transcript file', async t => {
  const f = await fixture(t), manager = SessionManager.create(f.cwd, join(f.cwd, 'sessions'));
  manager.appendCustomEntry('reverie.binding', { characterId: f.character.id });
  manager.appendCustomEntry('reverie.time', { now: Date.UTC(2040, 0, 1) });
  await f.client.request('when', { episodeId: manager.getSessionId(), position: '2040-01-01', label: 'Unplayed' });
  await exportStory(f.catalog, f.character.id, f.archive, f.cwd, { id: manager.getSessionId(), leaf: manager.getLeafId(), rows: [manager.getHeader(), ...manager.getEntries()] });
  await assert.rejects(readFile(manager.getSessionFile()), { code: 'ENOENT' });
  const d = await destination(t, f.root); await restoreStory(d.catalog, f.archive, d.cwd, executable);
  const source = d.catalog.source(manager.getSessionId());
  assert.deepEqual((await readSourceFile(source.path, source.leaf)).messages, []);
});

test('restore rejects identity collisions, missing source and damaged or incompatible archives without partial data', async t => {
  const f = await fixture(t); await exportStory(f.catalog, f.character.id, f.archive, f.cwd);
  await assert.rejects(restoreStory(f.catalog, f.archive, f.cwd, executable), /already exists/);
  const existing = await readFile(f.archive);
  await assert.rejects(exportStory(f.catalog, f.character.id, f.archive, f.cwd), /writable new filename/);
  assert.deepEqual(await readFile(f.archive), existing);
  const d = await destination(t, f.root), base = unzipSync(existing);
  for (const mode of ['truncated', 'missing', 'checksum', 'version', 'path']) {
    const files = structuredClone(base);
    if (mode === 'missing') delete files['sources/0.jsonl'];
    if (mode === 'checksum') files['sources/0.jsonl'][0] ^= 1;
    if (mode === 'path') files['../outside.txt'] = Buffer.from('unsafe');
    if (mode === 'version') {
      const story = JSON.parse(Buffer.from(files['story.json']).toString()); story.version = 999;
      files['story.json'] = Buffer.from(JSON.stringify(story)); files['checksums.json'] = Buffer.from(JSON.stringify({ storySha256: hash(files['story.json']) }));
    }
    const path = join(f.root, `${mode}.zip`); await writeFile(path, mode === 'truncated' ? existing.subarray(0, 20) : zipSync(files));
    await assert.rejects(restoreStory(d.catalog, path, d.cwd, executable), /Cannot read story backup/);
    assert.deepEqual(d.catalog.characters(), []); assert.deepEqual(d.catalog.sources(), []);
  }
  await rm(f.catalog.source(f.first).path);
  await assert.rejects(exportStory(f.catalog, f.character.id, join(f.root, 'missing-source.zip'), f.cwd), /Restore access/);
  await assert.rejects(readFile(join(f.root, 'missing-source.zip')), { code: 'ENOENT' });
});

test('restore rolls back both databases and removes staged files when publication fails', async t => {
  const f = await fixture(t); await exportStory(f.catalog, f.character.id, f.archive, f.cwd);
  const d = await destination(t, f.root);
  d.catalog.db.exec("CREATE TRIGGER reject_import BEFORE INSERT ON sources BEGIN SELECT RAISE(ABORT, 'simulated publication failure'); END;");
  await assert.rejects(restoreStory(d.catalog, f.archive, d.cwd, executable), /simulated publication failure/);
  assert.deepEqual(d.catalog.characters(), []); assert.deepEqual(d.catalog.sources(), []);
  assert.deepEqual(await readdir(join(d.home, 'restored')), []);
  assert.ok(!(await readdir(d.home)).some(name => /^restore-.*\.json$/.test(name)));
  const db = new DatabaseSync(d.catalog.memoryPath);
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM characters').get().n, 0); } finally { db.close(); }
});

test('a live restore journal is never overwritten or removed by a second import', async t => {
  const f = await fixture(t); await exportStory(f.catalog, f.character.id, f.archive, f.cwd);
  const d = await destination(t, f.root), marker = join(d.home, `restore-${f.character.id}.json`);
  const value = JSON.stringify({ characterId: f.character.id, directory: randomUUID(), cwd: d.cwd, pid: process.pid });
  const owner = new DatabaseSync(join(d.home, `restore-lock-${f.character.id}.sqlite`));
  owner.exec('BEGIN EXCLUSIVE');
  try {
    await writeFile(marker, value);
    await assert.rejects(restoreStory(d.catalog, f.archive, d.cwd, executable), /Another restore/);
  } finally { owner.exec('ROLLBACK'); owner.close(); }
  assert.equal(await readFile(marker, 'utf8'), value);
  assert.deepEqual(d.catalog.characters(), []); assert.deepEqual(d.catalog.sources(), []);
  assert.deepEqual(await readdir(join(d.home, 'restored')), []);
});

test('startup recovers an interrupted restore even if its recorded PID is now alive', async t => {
  const f = await fixture(t), home = join(f.root, 'interrupted-data'), cwd = join(f.root, 'interrupted-folder');
  await mkdir(cwd); const catalog = new Catalog(home), service = new MemoryService(catalog, executable, async () => { throw new Error('No model'); });
  await service.client(f.character.id).request('ping'); await service.close();
  const directory = randomUUID(), target = join(home, 'restored', directory); await mkdir(target, { recursive: true }); await writeFile(join(target, '0.jsonl'), 'partial');
  const db = new DatabaseSync(catalog.memoryPath);
  db.prepare('INSERT INTO characters(id,revision) VALUES(?,0)').run(f.character.id); db.close();
  await writeFile(join(home, `restore-${f.character.id}.json`), JSON.stringify({ characterId: f.character.id, directory, cwd, pid: process.pid }));
  catalog.close();
  const recovered = new Catalog(home);
  try {
    assert.deepEqual(recovered.characters(), []);
    const native = new DatabaseSync(recovered.memoryPath);
    try { assert.equal(native.prepare('SELECT COUNT(*) AS n FROM characters').get().n, 0); } finally { native.close(); }
    assert.deepEqual(await readdir(join(home, 'restored')), []);
    assert.ok(!(await readdir(home)).some(name => /^restore-.*\.json$/.test(name)));
  } finally { recovered.close(); }
});

test('startup discards empty or truncated pre-commit journals without blocking ordinary catalog use', async () => {
  const home = resolve('.work/backup-tests', randomUUID(), 'data');
  const first = new Catalog(home), character = first.create('Existing', 'Preserve this story.'); first.close();
  for (const partial of ['', '{', '{"characterId":']) await writeFile(join(home, `restore-${randomUUID()}.json`), partial);
  const recovered = new Catalog(home);
  try {
    assert.equal(recovered.character(character.id).persona, character.persona);
    assert.ok(!(await readdir(home)).some(name => /^restore-.*\.json$/.test(name)));
  } finally { recovered.close(); }
});

test('a live ownership lock protects a journal while its JSON is still being written', async () => {
  const home = resolve('.work/backup-tests', randomUUID(), 'data'), id = randomUUID();
  const initial = new Catalog(home); initial.close();
  const owner = new DatabaseSync(join(home, `restore-lock-${id}.sqlite`)), marker = join(home, `restore-${id}.json`);
  owner.exec('BEGIN EXCLUSIVE');
  try {
    await writeFile(marker, '{');
    const observer = new Catalog(home); observer.close();
    assert.equal(await readFile(marker, 'utf8'), '{');
  } finally { owner.exec('ROLLBACK'); owner.close(); }
  const recovered = new Catalog(home); recovered.close();
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('source reads during export do not hold database write locks against unrelated writers', async t => {
  const f = await fixture(t), pending = exportStory(f.catalog, f.character.id, f.archive, f.cwd);
  const native = new DatabaseSync(f.catalog.memoryPath), catalog = new DatabaseSync(join(f.catalog.directory, 'catalog.sqlite'));
  let writerError;
  try {
    native.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    native.prepare('INSERT INTO characters(id,revision) VALUES(?,0)').run(randomUUID()); native.exec('COMMIT');
    catalog.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; INSERT INTO preferences VALUES('unrelated-window','ok'); COMMIT");
  } catch (error) { writerError = error; }
  finally { native.close(); catalog.close(); }
  await pending;
  assert.equal(writerError, undefined);
});

test('export detects memory changes during unlocked source capture and publishes no archive', async t => {
  const f = await fixture(t), pending = exportStory(f.catalog, f.character.id, f.archive, f.cwd), native = new DatabaseSync(f.catalog.memoryPath);
  let writerError;
  try {
    native.exec('PRAGMA busy_timeout=0');
    native.prepare('UPDATE characters SET revision=revision+1 WHERE id=?').run(f.character.id);
  } catch (error) { writerError = error; }
  finally { native.close(); }
  const [result] = await Promise.allSettled([pending]);
  assert.equal(writerError, undefined);
  assert.equal(result.status, 'rejected'); assert.match(result.reason.message, /Story memory or source selection changed/);
  await assert.rejects(readFile(f.archive), { code: 'ENOENT' });
});
