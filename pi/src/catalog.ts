import { DatabaseSync } from 'node:sqlite';
import { constants, mkdirSync, realpathSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { recoverStoryRestores } from './story-backup.js';

export interface Character { id: string; name: string; persona: string }
export interface Binding { characterId: string; enabled: boolean }
export interface FolderModel { provider: string; modelId: string; thinkingLevel?: ThinkingLevel }
export interface SourceRecord { episodeId: string; characterId: string; path: string; cwd: string; leaf: string | null; deleted: number }
function directoryKey(cwd: string): string {
  const canonical = realpathSync(cwd);
  return process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical;
}
/** SQLite serializes writes across simultaneous Pi windows without rewriting a shared JSON file. */
export class Catalog {
  readonly db: DatabaseSync;
  readonly memoryPath: string;
  private unavailableSources = new Set<string>();
  constructor(readonly directory: string, private sourceAccess: typeof access = access) {
    mkdirSync(directory, { recursive: true }); this.memoryPath = join(directory, 'memory.sqlite');
    this.db = new DatabaseSync(join(directory, 'catalog.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS characters(id TEXT PRIMARY KEY,name TEXT NOT NULL,persona TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS folders(cwd TEXT PRIMARY KEY,characterId TEXT NOT NULL,enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(episodeId TEXT PRIMARY KEY,characterId TEXT NOT NULL,path TEXT NOT NULL,cwd TEXT NOT NULL,leaf TEXT,deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS recalls(episodeId TEXT NOT NULL,replyId TEXT PRIMARY KEY,data TEXT NOT NULL);');
    this.db.exec('CREATE TABLE IF NOT EXISTS folder_models(cwd TEXT PRIMARY KEY,provider TEXT NOT NULL,modelId TEXT NOT NULL,thinkingLevel TEXT);');
    if (!this.db.prepare('PRAGMA table_info(folder_models)').all().some(column => column.name === 'thinkingLevel')) {
      this.db.exec('ALTER TABLE folder_models ADD COLUMN thinkingLevel TEXT');
    }
    try { recoverStoryRestores(this); } catch (error) { this.db.close(); throw error; }
  }
  characters(): Character[] { return this.db.prepare('SELECT * FROM characters ORDER BY name,id').all() as unknown as Character[]; }
  character(id: string): Character | undefined { return this.db.prepare('SELECT * FROM characters WHERE id=?').get(id) as unknown as Character | undefined; }
  create(name: string, persona: string): Character {
    if (!name.trim() || name.length > 100 || !persona.trim()) throw new Error('A character needs a name and personality.');
    const character = { id: randomUUID(), name: name.trim(), persona };
    this.db.prepare('INSERT INTO characters VALUES(?,?,?)').run(character.id, character.name, persona); return character;
  }
  setPersona(id: string, persona: string): void {
    if (!persona.trim() || persona.length > 100_000) throw new Error('Enter a personality of at most 100,000 characters.');
    this.db.prepare('UPDATE characters SET persona=? WHERE id=?').run(persona, id);
  }
  binding(cwd: string): Binding | undefined {
    const row = this.db.prepare('SELECT characterId,enabled FROM folders WHERE cwd=?').get(directoryKey(cwd));
    return row ? { characterId: String(row.characterId), enabled: Boolean(row.enabled) } : undefined;
  }
  bind(cwd: string, characterId: string, enabled = true): void {
    if (!this.character(characterId)) throw new Error('That character memory does not exist.');
    this.db.prepare('INSERT INTO folders VALUES(?,?,?) ON CONFLICT(cwd) DO UPDATE SET characterId=excluded.characterId,enabled=excluded.enabled')
      .run(directoryKey(cwd), characterId, +enabled);
  }
  unlink(cwd: string): void { this.db.prepare('DELETE FROM folders WHERE cwd=?').run(directoryKey(cwd)); }
  folderModel(cwd: string): FolderModel | undefined {
    const row = this.db.prepare('SELECT provider,modelId,thinkingLevel FROM folder_models WHERE cwd=?').get(directoryKey(cwd));
    return row ? { provider: String(row.provider), modelId: String(row.modelId),
      ...(typeof row.thinkingLevel === 'string' ? { thinkingLevel: row.thinkingLevel as ThinkingLevel } : {}) } : undefined;
  }
  setFolderModel(cwd: string, model: FolderModel): void {
    if (!this.binding(cwd)) throw new Error('Link this folder before saving its model.');
    this.db.prepare('INSERT INTO folder_models(cwd,provider,modelId,thinkingLevel) VALUES(?,?,?,?) ON CONFLICT(cwd) DO UPDATE SET provider=excluded.provider,modelId=excluded.modelId,thinkingLevel=excluded.thinkingLevel')
      .run(directoryKey(cwd), model.provider, model.modelId, model.thinkingLevel ?? null);
  }
  remember(source: Omit<SourceRecord, 'deleted'>): void {
    const previous = this.source(source.episodeId);
    if (previous && (previous.characterId !== source.characterId || previous.deleted)) throw new Error('This conversation cannot be reassigned or resurrected. Start a new chat.');
    this.db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,0) ON CONFLICT(episodeId) DO UPDATE SET path=excluded.path,cwd=excluded.cwd,leaf=excluded.leaf')
      .run(source.episodeId, source.characterId, resolve(source.path), source.cwd, source.leaf);
  }
  source(id: string): SourceRecord | undefined { return this.db.prepare('SELECT * FROM sources WHERE episodeId=?').get(id) as unknown as SourceRecord | undefined; }
  sources(): SourceRecord[] { return this.db.prepare('SELECT * FROM sources').all() as unknown as SourceRecord[]; }
  tombstone(id: string): void { this.db.prepare('UPDATE sources SET deleted=1 WHERE episodeId=?').run(id); }
  acknowledgeDeletion(id: string): void {
    this.db.prepare('DELETE FROM recalls WHERE episodeId IN (SELECT episodeId FROM sources WHERE characterId=(SELECT characterId FROM sources WHERE episodeId=?))').run(id);
    this.db.prepare('UPDATE sources SET deleted=2 WHERE episodeId=? AND deleted=1').run(id);
  }
  saveRecall(episodeId: string, replyId: string, data: unknown): void {
    this.db.prepare('INSERT INTO recalls VALUES(?,?,?) ON CONFLICT(replyId) DO UPDATE SET data=excluded.data').run(episodeId, replyId, JSON.stringify(data));
  }
  recall(replyId: string): unknown { const row = this.db.prepare('SELECT data FROM recalls WHERE replyId=?').get(replyId); return row ? JSON.parse(String(row.data)) : undefined; }
  preference(key: string, fallback: string): string { return String(this.db.prepare('SELECT value FROM preferences WHERE key=?').get(key)?.value ?? fallback); }
  setPreference(key: string, value: string): void { this.db.prepare('INSERT INTO preferences VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  async missingSources(onUnavailable: (source: SourceRecord, error: unknown) => void = () => {}): Promise<SourceRecord[]> {
    const pending: SourceRecord[] = [];
    for (const source of this.sources()) {
      if (source.deleted === 2) continue;
      if (!source.deleted) {
        try { await this.sourceAccess(source.path, constants.R_OK); this.unavailableSources.delete(source.episodeId); }
        catch (error) {
          let confirmedDeletion = false;
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            // A disconnected drive or renamed directory also reports ENOENT.
            // Only a missing file in an accessible parent establishes deletion.
            try { await this.sourceAccess(dirname(source.path), constants.R_OK); confirmedDeletion = true; }
            catch { /* Keep the source registered until its directory is accessible. */ }
          }
          if (!confirmedDeletion) {
            if (!this.unavailableSources.has(source.episodeId)) {
              try { onUnavailable(source, error); this.unavailableSources.add(source.episodeId); }
              catch { /* Notification failures must neither block reconciliation nor suppress its retry. */ }
            }
            continue;
          }
          this.unavailableSources.delete(source.episodeId);
          this.tombstone(source.episodeId); source.deleted = 1;
        }
      }
      if (source.deleted === 1) pending.push(source);
    }
    return pending;
  }
  close(): void { this.db.close(); }
}
