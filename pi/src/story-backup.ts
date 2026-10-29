import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { unzipSync, zipSync } from 'fflate';
import type { Catalog, Character, FolderModel } from './catalog.js';
import { MemoryClient } from './memory-client.js';
import { branchOf, extractSource, ownerOf, readSourceFile } from './source.js';
import { record } from './errors.js';

type Row = Record<string, string | number | null>;
interface SavedSource { episodeId: string; file: string; leaf: string | null; sha256: string; parentEpisodeId?: string }
interface Story {
  format: 'reverie-story'; version: 1; createdAt: string; character: Character;
  roleplay: { enabled: boolean; model?: FolderModel }; sources: SavedSource[];
  native: { revision: number; episodes: Row[]; contributions: Row[]; memories: Row[]; corrections: Row[] };
  recalls: { episodeId: string; replyId: string; data: string }[];
}
export interface CurrentSession { id: string; leaf: string | null; rows: unknown[] }
const LIMIT = 256 * 1024 * 1024, FILE_LIMIT = 64 * 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const tables = ['episodes', 'contributions', 'memories', 'corrections'] as const;
function attach(catalog: Catalog): void {
  catalog.db.prepare('ATTACH DATABASE ? AS story_memory').run(catalog.memoryPath);
  if (catalog.db.prepare('PRAGMA story_memory.user_version').get()?.user_version !== 2) {
    catalog.db.exec('DETACH DATABASE story_memory');
    throw new Error('This backup workflow needs memory database version 2. Start the installed Reverie engine first, or use a matching newer release.');
  }
}
function rows(catalog: Catalog, table: typeof tables[number], character: string): Row[] {
  return catalog.db.prepare(`SELECT * FROM story_memory.${table} WHERE character_id=?${table === 'memories' ? ' ORDER BY id' : ''}`).all(character) as Row[];
}
function sourceRows(bytes: Uint8Array, id: string, character: string, leaf: string | null): Record<string, unknown>[] {
  const parsed: unknown[] = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  if (!parsed.length || !parsed.every(record) || parsed[0]!.type !== 'session' || parsed[0]!.id !== id) throw new Error(`Episode ${id} has a damaged or mismatched Pi session header.`);
  const entries = parsed.slice(1) as unknown as Parameters<typeof branchOf>[0];
  if (parsed[0]!.version !== 3 || !entries.every(entry => typeof entry.id === 'string' && (entry.parentId === null || typeof entry.parentId === 'string'))
    || new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error(`Episode ${id} uses an incompatible or damaged Pi session format.`);
  if (ownerOf(entries) !== character) throw new Error(`Episode ${id} does not belong to the archived character.`);
  extractSource(branchOf(entries, leaf));
  return parsed as Record<string, unknown>[];
}
async function writeDurable(path: string, text: string, created?: () => void): Promise<void> {
  const handle = await open(path, 'wx');
  created?.();
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
}

function captureStory(catalog: Catalog, characterId: string, cwd: string) {
  const character = catalog.character(characterId);
  if (!character) throw new Error('Choose a character before exporting its story.');
  return { character, binding: catalog.binding(cwd), model: catalog.folderModel(cwd),
    registered: catalog.sources().filter(source => source.characterId === characterId && !source.deleted),
    native: { revision: Number(catalog.db.prepare('SELECT revision FROM story_memory.characters WHERE id=?').get(characterId)?.revision ?? 0),
      episodes: rows(catalog, 'episodes', characterId), contributions: rows(catalog, 'contributions', characterId),
      memories: rows(catalog, 'memories', characterId), corrections: rows(catalog, 'corrections', characterId) },
    recalls: catalog.db.prepare('SELECT episodeId,replyId,data FROM recalls WHERE episodeId IN (SELECT episodeId FROM sources WHERE characterId=? AND deleted=0)').all(characterId) as unknown as Story['recalls'] };
}

/** Snapshot metadata briefly, read source without write locks, then recheck the complete snapshot. */
export async function exportStory(catalog: Catalog, characterId: string, destination: string, cwd: string, current?: CurrentSession): Promise<void> {
  attach(catalog);
  let locked = false;
  const archive: Record<string, Uint8Array> = {};
  try {
    catalog.db.exec('BEGIN IMMEDIATE'); locked = true;
    const snapshot = captureStory(catalog, characterId, cwd), signature = JSON.stringify(snapshot);
    catalog.db.exec('COMMIT'); locked = false;
    const { registered, character, binding, model, native, recalls } = snapshot;
    const ids = new Set([...registered.map(source => source.episodeId), ...native.episodes.map(episode => String(episode.id))]);
    if (current && ownerOf(current.rows.slice(1) as Parameters<typeof ownerOf>[0]) === characterId) ids.add(current.id);
    if (ids.size > 10000) throw new Error('This story exceeds the 10,000-source backup limit.');
    const sources: SavedSource[] = [], originals: { path: string; bytes: Buffer }[] = [];
    let totalBytes = 0;
    for (const id of ids) {
      const source = registered.find(source => source.episodeId === id), active = current?.id === id ? current : undefined;
      if (!source && !active) throw new Error(`Episode ${id} has no Pi source. Resume its setup or restore its original session file before backing up.`);
      const bytes = active ? Buffer.from(active.rows.map(row => JSON.stringify(row)).join('\n') + '\n') : await readFile(source!.path).catch(() => { throw new Error(`Cannot back up episode ${id}. Restore access to its Pi source and try again.`); });
      if (bytes.length > FILE_LIMIT) throw new Error(`Episode ${id} exceeds the 64 MiB backup source limit.`);
      const leaf = active ? active.leaf : source!.leaf;
      const parsed = sourceRows(bytes, id, characterId, leaf);
      // Only Pi's machine-specific header is relocated. Played entries stay unchanged.
      const { parentSession: _parent, ...header } = parsed[0]!;
      const parentEpisodeId = typeof _parent === 'string' ? registered.find(candidate => resolve(candidate.path) === resolve(_parent))?.episodeId : undefined;
      parsed[0] = { ...header, cwd: '.' };
      const file = `sources/${sources.length}.jsonl`, portable = Buffer.from(parsed.map(row => JSON.stringify(row)).join('\n') + '\n');
      totalBytes += portable.length;
      if (totalBytes > LIMIT) throw new Error('This story exceeds the 256 MiB backup limit.');
      archive[file] = portable; sources.push({ episodeId: id, file, leaf, sha256: hash(portable), ...(parentEpisodeId ? { parentEpisodeId } : {}) });
      if (!active) originals.push({ path: source!.path, bytes });
    }
    // Detect replacement/deletion or non-append source edits during capture.
    for (const source of originals) if (!(await readFile(source.path)).equals(source.bytes)) throw new Error('Played source changed during backup. Finish the current turn and try again.');
    const story: Story = { format: 'reverie-story', version: 1, createdAt: new Date().toISOString(), character,
      roleplay: { enabled: binding?.characterId === characterId ? binding.enabled : true, model }, sources, native, recalls };
    archive['story.json'] = Buffer.from(JSON.stringify(story));
    if (archive['story.json'].length > FILE_LIMIT) throw new Error('This story exceeds the 64 MiB manifest limit.');
    archive['checksums.json'] = Buffer.from(JSON.stringify({ storySha256: hash(archive['story.json']) }));
    if (Object.values(archive).reduce((total, data) => total + data.length, 0) > LIMIT) throw new Error('This story exceeds the 256 MiB backup limit.');
    catalog.db.exec('BEGIN IMMEDIATE'); locked = true;
    if (JSON.stringify(captureStory(catalog, characterId, cwd)) !== signature) throw new Error('Story memory or source selection changed during backup. Finish the current operation and try again.');
    catalog.db.exec('COMMIT'); locked = false;
  } finally { if (locked) catalog.db.exec('ROLLBACK'); catalog.db.exec('DETACH DATABASE story_memory'); }
  const bytes = zipSync(archive, { level: 6 });
  const handle = await open(destination, 'wx').catch(error => { throw new Error(`Cannot create backup at ${destination}. Choose a writable new filename. ${String(error)}`); });
  try { await handle.writeFile(bytes); await handle.sync(); }
  catch (error) { await handle.close(); await rm(destination, { force: true }); throw error; }
  await handle.close();
}

function parseArchive(bytes: Uint8Array): { story: Story; files: Record<string, Uint8Array> } {
  if (bytes.length > LIMIT) throw new Error('This backup exceeds the 256 MiB archive limit.');
  let size = 0; const names = new Set<string>();
  const files = unzipSync(bytes, { filter: file => {
    if (!/^(?:story\.json|checksums\.json|sources\/\d+\.jsonl)$/.test(file.name) || names.has(file.name) || names.size >= 10002) throw new Error('Unexpected or duplicate ZIP entry.');
    names.add(file.name); size += file.originalSize;
    if (file.originalSize > FILE_LIMIT || size > LIMIT) throw new Error('Expanded backup exceeds supported size limits.');
    return true;
  } });
  if (!files['story.json'] || !files['checksums.json']) throw new Error('The archive has no story manifest or integrity record.');
  const checksums: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files['checksums.json']));
  if (!record(checksums) || checksums.storySha256 !== hash(files['story.json'])) throw new Error('The story manifest failed its integrity check.');
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files['story.json']));
  if (!record(value) || value.format !== 'reverie-story' || value.version !== 1) throw new Error('Unsupported story backup format. Use a compatible Reverie release.');
  const story = value as unknown as Story;
  if (!record(story.character) || !uuid(story.character.id) || typeof story.character.name !== 'string' || !story.character.name.trim()
    || typeof story.character.persona !== 'string' || !story.character.persona.trim() || !record(story.roleplay) || typeof story.roleplay.enabled !== 'boolean'
    || !record(story.native) || !Number.isSafeInteger(story.native.revision) || !Array.isArray(story.sources) || !Array.isArray(story.recalls)) throw new Error('The story manifest is damaged.');
  const model = story.roleplay.model;
  if (model && (!record(model) || typeof model.provider !== 'string' || typeof model.modelId !== 'string'
    || (model.thinkingLevel !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(model.thinkingLevel)))) throw new Error('The saved model preference is invalid.');
  for (const table of tables) if (!Array.isArray(story.native[table]) || !story.native[table].every(row => record(row) && row.character_id === story.character.id)) throw new Error(`The archived ${table} are damaged or belong to another character.`);
  const ids = new Set<string>(), paths = new Set<string>();
  for (const source of story.sources) {
    if (!record(source) || !uuid(source.episodeId) || ids.has(source.episodeId) || typeof source.file !== 'string' || paths.has(source.file)
      || !/^sources\/\d+\.jsonl$/.test(source.file) || !(source.leaf === null || typeof source.leaf === 'string') || !files[source.file] || hash(files[source.file]!) !== source.sha256) throw new Error('An episode source is missing, duplicated or damaged.');
    ids.add(source.episodeId); paths.add(source.file);
    sourceRows(files[source.file]!, source.episodeId, story.character.id, source.leaf);
  }
  for (const source of story.sources) if (source.parentEpisodeId !== undefined && (!ids.has(source.parentEpisodeId) || source.parentEpisodeId === source.episodeId)) throw new Error('An archived Pi parent session is invalid.');
  for (const source of story.sources) {
    const ancestors = new Set<string>(); let parent: SavedSource | undefined = source;
    while (parent) {
      if (ancestors.has(parent.episodeId)) throw new Error('Archived Pi parent sessions form a cycle.');
      ancestors.add(parent.episodeId); parent = story.sources.find(candidate => candidate.episodeId === parent!.parentEpisodeId);
    }
  }
  if (Object.keys(files).length !== paths.size + 2 || !story.native.episodes.every(episode => ids.has(String(episode.id)))) throw new Error('The archive does not cover every episode source.');
  for (const recall of story.recalls) {
    if (!record(recall) || !ids.has(recall.episodeId) || typeof recall.replyId !== 'string' || typeof recall.data !== 'string') throw new Error('An archived reply explanation is invalid.');
    const data: unknown = JSON.parse(recall.data);
    if (!record(data) || data.characterId !== story.character.id || data.episodeId !== recall.episodeId) throw new Error('An archived reply explanation has the wrong owner.');
  }
  return { story, files };
}

const columns = {
  episodes: ['character_id', 'id', 'label', 'start', 'now', 'included', 'source_hash', 'input_hash', 'published_end'],
  contributions: ['character_id', 'episode_id', 'start', 'end', 'input_hash', 'state_hash', 'data'],
  memories: ['character_id', 'episode_id', 'available_at', 'gist', 'detail', 'feeling', 'cues', 'salience', 'confidence', 'source_ids'],
  corrections: ['character_id', 'episode_id', 'data'],
} as const;
function insertNative(db: DatabaseSync, prefix: string, story: Story): void {
  db.prepare(`INSERT INTO ${prefix}characters(id,revision) VALUES(?,?)`).run(story.character.id, story.native.revision);
  for (const table of tables) {
    const fields = columns[table], insert = db.prepare(`INSERT INTO ${prefix}${table}(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`);
    let rows = story.native[table];
    if (table === 'memories') {
      const ids = rows.map(row => row.id);
      if (!ids.every(id => typeof id === 'number' && Number.isSafeInteger(id) && id > 0) || new Set(ids).size !== ids.length) {
        throw new Error('Invalid archived memory row identities.');
      }
      // Imported row IDs are allocated anew. Preserve the original per-episode
      // ordinal even if an archive's memory array arrives in a different order.
      rows = [...rows].sort((a, b) => Number(a.id) - Number(b.id));
    }
    for (const row of rows) {
      if (!fields.every(field => row[field] === null || typeof row[field] === 'string' || (typeof row[field] === 'number' && Number.isFinite(row[field])))) throw new Error(`Invalid ${table} data in this backup.`);
      insert.run(...fields.map(field => row[field]!));
    }
  }
}

interface RestoreJournal { characterId: string; directory: string; cwd: string; previousModel?: FolderModel; pid: number }
function importPath(catalog: Catalog, id: string): string {
  const root = resolve(catalog.directory, 'restored'), target = resolve(root, id);
  if (!uuid(id) || dirname(target) !== root) throw new Error('Invalid restore staging directory.');
  return target;
}
function lockRestore(catalog: Catalog, characterId: string): DatabaseSync | undefined {
  if (!uuid(characterId)) throw new Error('Invalid restore identity.');
  const lock = new DatabaseSync(join(catalog.directory, `restore-lock-${characterId}.sqlite`));
  try { lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); return lock; }
  catch (error) {
    lock.close();
    if (record(error) && (error.errcode === 5 || error.errcode === 6)) return;
    throw new Error('Cannot acquire the story restore lock. Check access to the Reverie data directory.', { cause: error });
  }
}
function unlockRestore(lock: DatabaseSync): void {
  try { lock.exec('ROLLBACK'); } finally { lock.close(); }
}
/** Recover only interrupted restores; live processes retain their import locks. */
export function recoverStoryRestores(catalog: Catalog): void {
  for (const name of readdirSync(catalog.directory).filter(name => /^restore-[\da-f-]{36}\.json$/.test(name))) {
    const characterId = name.slice('restore-'.length, -'.json'.length), owner = lockRestore(catalog, characterId);
    if (!owner) continue;
    try {
      const marker = join(catalog.directory, name);
      let value: unknown;
      try { value = JSON.parse(readFileSync(marker, 'utf8')); }
      catch (error) {
        if (error instanceof SyntaxError) { unlinkSync(marker); continue; }
        if (record(error) && error.code === 'ENOENT') continue;
        throw new Error('Cannot read the story restore journal. Check access to the Reverie data directory.', { cause: error });
      }
      if (!record(value) || value.characterId !== characterId || !uuid(value.directory) || typeof value.cwd !== 'string' || !Number.isInteger(value.pid) || Number(value.pid) <= 0) throw new Error('A story restore journal is damaged. Preserve the data folder and recover it before restoring another story.');
      const journal = value as unknown as RestoreJournal;
      attach(catalog); let locked = false;
      try {
        catalog.db.exec('BEGIN IMMEDIATE'); locked = true;
        const complete = catalog.character(journal.characterId) && catalog.db.prepare('SELECT id FROM story_memory.characters WHERE id=?').get(journal.characterId);
        if (!complete) {
          for (const table of ['memories', 'contributions', 'corrections', 'episodes']) catalog.db.prepare(`DELETE FROM story_memory.${table} WHERE character_id=?`).run(journal.characterId);
          catalog.db.prepare('DELETE FROM story_memory.characters WHERE id=?').run(journal.characterId);
          catalog.db.prepare('DELETE FROM recalls WHERE episodeId IN (SELECT episodeId FROM sources WHERE characterId=?)').run(journal.characterId);
          catalog.db.prepare('DELETE FROM sources WHERE characterId=?').run(journal.characterId);
          catalog.db.prepare('DELETE FROM folders WHERE characterId=?').run(journal.characterId);
          catalog.db.prepare('DELETE FROM characters WHERE id=?').run(journal.characterId);
          if (journal.previousModel) catalog.db.prepare('INSERT OR REPLACE INTO folder_models VALUES(?,?,?,?)').run(journal.cwd, journal.previousModel.provider, journal.previousModel.modelId, journal.previousModel.thinkingLevel ?? null);
          else catalog.db.prepare('DELETE FROM folder_models WHERE cwd=?').run(journal.cwd);
          // The journal stores only a validated UUID, never an archive-controlled path.
          rmSync(importPath(catalog, journal.directory), { recursive: true, force: true });
        }
        catalog.db.exec('COMMIT'); locked = false; unlinkSync(marker);
      } finally { if (locked) catalog.db.exec('ROLLBACK'); catalog.db.exec('DETACH DATABASE story_memory'); }
    } finally { unlockRestore(owner); }
  }
}

/** Validate in an isolated native database before publishing the restored story. */
export async function restoreStory(catalog: Catalog, archive: string, cwd: string, executable: string): Promise<Character> {
  let loaded: ReturnType<typeof parseArchive>;
  try { loaded = parseArchive(await readFile(archive)); }
  catch (error) { throw new Error(`Cannot read story backup: ${String(error)} No story was restored.`); }
  const { story, files } = loaded;
  if (catalog.character(story.character.id)) throw new Error('This character already exists here. Restore into another installation or data directory; existing stories are never overwritten.');
  if (catalog.binding(cwd)) throw new Error('This folder is already linked. Open an unlinked folder before restoring a story.');
  const directory = randomUUID(), target = importPath(catalog, directory), database = join(target, 'validation.sqlite');
  await mkdir(target, { recursive: true });
  let committed = false, journal: string | undefined, journalOwned = false, owner: DatabaseSync | undefined;
  try {
    const paths = new Map(story.sources.map((source, index) => [source.episodeId, join(target, `${index}.jsonl`)]));
    for (const source of story.sources) {
      const parsed = sourceRows(files[source.file]!, source.episodeId, story.character.id, source.leaf);
      parsed[0] = { ...parsed[0], cwd: resolve(cwd), ...(source.parentEpisodeId ? { parentSession: paths.get(source.parentEpisodeId) } : {}) };
      if (source.leaf && parsed.at(-1)?.id !== source.leaf) parsed.push({ id: randomUUID(), parentId: source.leaf, type: 'custom',
        customType: 'reverie.selection', data: { replyId: source.leaf }, timestamp: new Date().toISOString() });
      const path = paths.get(source.episodeId)!;
      await writeDurable(path, parsed.map(row => JSON.stringify(row)).join('\n') + '\n');
    }
    const client = new MemoryClient({ executable, characterId: story.character.id, database,
      readSource: async id => { const source = story.sources.find(source => source.episodeId === id); if (!source) throw new Error('Archived source missing.'); return readSourceFile(paths.get(id)!, source.leaf); },
      infer: async () => { throw new Error('Restore validation never calls a model.'); } });
    try {
      await client.request('ping');
      const staged = new DatabaseSync(database);
      try {
        staged.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
        insertNative(staged, '', story); staged.exec('COMMIT');
      } finally { staged.close(); }
      const inspected = await client.request('inspect');
      if (inspected.episodes.some(item => item.freshness === 'unavailable' || item.freshness === 'deleted')) throw new Error('An archived episode cannot resolve its selected source.');
      // Native date validation checks every full interval, without writing.
      for (const episode of story.native.episodes) await client.request('when', { episodeId: episode.id, position: episode.now, preview: true });
    } finally { await client.close(); }
    for (const suffix of ['', '-wal', '-shm']) await rm(database + suffix, { force: true });
    const initializer = new MemoryClient({ executable, characterId: story.character.id, database: catalog.memoryPath,
      readSource: async () => { throw new Error('Source is not read during database initialization.'); },
      infer: async () => { throw new Error('Restore does not call a model.'); } });
    try { await initializer.request('ping'); } finally { await initializer.close(); }
    owner = lockRestore(catalog, story.character.id);
    if (!owner) throw new Error('Another restore of this character is running. Wait for it to finish before retrying.');
    attach(catalog); let locked = false;
    try {
      catalog.db.exec('BEGIN IMMEDIATE'); locked = true;
      if (catalog.character(story.character.id) || catalog.db.prepare('SELECT id FROM story_memory.characters WHERE id=?').get(story.character.id) || catalog.binding(cwd)) throw new Error('The restore destination changed or this character already exists. Nothing was overwritten.');
      for (const source of story.sources) if (catalog.source(source.episodeId) || catalog.db.prepare('SELECT id FROM story_memory.episodes WHERE id=?').get(source.episodeId)) throw new Error('An episode identity already exists here. Restore into a separate installation.');
      for (const recall of story.recalls) if (catalog.db.prepare('SELECT replyId FROM recalls WHERE replyId=?').get(recall.replyId)) throw new Error('A reply identity already exists here. Restore into a separate installation.');
      const real = realpathSync(cwd), canonical = process.platform === 'win32' ? real.toLocaleLowerCase('en-US') : real;
      journal = join(catalog.directory, `restore-${story.character.id}.json`);
      const marker: RestoreJournal = { characterId: story.character.id, directory, cwd: canonical, previousModel: catalog.folderModel(cwd), pid: process.pid };
      await writeDurable(journal, JSON.stringify(marker), () => { journalOwned = true; });
      insertNative(catalog.db, 'story_memory.', story);
      catalog.db.prepare('INSERT INTO characters VALUES(?,?,?)').run(story.character.id, story.character.name, story.character.persona);
      for (const source of story.sources) catalog.remember({ episodeId: source.episodeId, characterId: story.character.id, path: paths.get(source.episodeId)!, cwd: resolve(cwd), leaf: source.leaf });
      for (const recall of story.recalls) catalog.db.prepare('INSERT INTO recalls VALUES(?,?,?)').run(recall.episodeId, recall.replyId, recall.data);
      catalog.bind(cwd, story.character.id, story.roleplay.enabled);
      if (story.roleplay.model) catalog.setFolderModel(cwd, story.roleplay.model);
      catalog.db.exec('COMMIT'); locked = false; committed = true;
    } finally { if (locked) catalog.db.exec('ROLLBACK'); catalog.db.exec('DETACH DATABASE story_memory'); }
    await rm(journal, { force: true }); journal = undefined;
    return story.character;
  } catch (error) { throw new Error(`Restore failed: ${String(error)}${committed ? ' The story was saved; its restore journal will be checked on restart.' : ' No story was restored.'}`); }
  finally {
    try { if (!committed) { await rm(importPath(catalog, directory), { recursive: true, force: true }); if (journal && journalOwned) await rm(journal, { force: true }); } }
    finally { if (owner) unlockRestore(owner); }
  }
}
