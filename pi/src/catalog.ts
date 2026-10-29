import { DatabaseSync } from 'node:sqlite';
import { constants, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { recoverStoryRestores } from './story-backup.js';
import { record } from './errors.js';

export interface Character { id: string; name: string; persona: string }
export interface Binding { characterId: string; enabled: boolean }
export interface FolderModel { provider: string; modelId: string; thinkingLevel?: ThinkingLevel }
export interface SourceRecord { episodeId: string; characterId: string; path: string; cwd: string; leaf: string | null; deleted: number }
interface RecallDeletionScope { episodeIds: string[]; replyIds: string[] }
function deletionScope(text: string): RecallDeletionScope {
  const saved: unknown = JSON.parse(text);
  // Plans written before reply-level cleanup contained only episode IDs.
  const scope = Array.isArray(saved) ? { episodeIds: saved, replyIds: [] } : saved;
  if (!record(scope) || !Array.isArray(scope.episodeIds) || !scope.episodeIds.every(id => typeof id === 'string')
    || !Array.isArray(scope.replyIds) || !scope.replyIds.every(id => typeof id === 'string')) throw new Error('Invalid pending recall cleanup plan.');
  return { episodeIds: scope.episodeIds, replyIds: scope.replyIds };
}
function recallEpisodeIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  if (!record(value)) return ids;
  if (typeof value.impressionEpisodeId === 'string') ids.add(value.impressionEpisodeId);
  for (const items of [value.memories, value.historicalContext]) if (Array.isArray(items)) {
    for (const item of items) if (record(item) && typeof item.episodeId === 'string') ids.add(item.episodeId);
  }
  const lists: unknown[] = [value.historySources];
  if (Array.isArray(value.impressions)) for (const item of value.impressions) if (record(item)) lists.push(item.sourceEpisodeIds);
  for (const list of lists) if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') ids.add(id);
  return ids;
}
function unattributedImpressions(value: unknown): boolean {
  return record(value) && Array.isArray(value.impressions) && value.impressions.length > 0
    && (typeof value.impressionEpisodeId !== 'string' || !value.impressionEpisodeId);
}
function withoutLegacyImpressions(value: Record<string, unknown>): Record<string, unknown> {
  // Preserve fresh-memory activations: removing the entire legacy reply could
  // change earlier episodes' reflection inputs on the next rebuild.
  return { ...value, impressions: [], impressionEpisodeId: null, text: '', legacyImpressionsRemoved: true };
}
function directoryKey(cwd: string): string {
  const canonical = realpathSync(cwd);
  return process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical;
}
/** SQLite serializes writes across simultaneous Pi windows without rewriting a shared JSON file. */
export class Catalog {
  readonly db: DatabaseSync;
  readonly memoryPath: string;
  private unavailableSources = new Set<string>();
  /** Diagnostic count for late/obsolete contexts rejected in this process. */
  discardedRecallCount = 0;
  constructor(readonly directory: string, private sourceAccess: typeof access = access) {
    mkdirSync(directory, { recursive: true }); this.memoryPath = join(directory, 'memory.sqlite');
    this.db = new DatabaseSync(join(directory, 'catalog.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS characters(id TEXT PRIMARY KEY,name TEXT NOT NULL,persona TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS folders(cwd TEXT PRIMARY KEY,characterId TEXT NOT NULL,enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(episodeId TEXT PRIMARY KEY,characterId TEXT NOT NULL,path TEXT NOT NULL,cwd TEXT NOT NULL,leaf TEXT,deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS recalls(episodeId TEXT NOT NULL,replyId TEXT PRIMARY KEY,data TEXT NOT NULL);');
    this.db.exec('CREATE TABLE IF NOT EXISTS recall_deletions(episodeId TEXT PRIMARY KEY,affected TEXT NOT NULL);');
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
  tombstone(id: string): void { this.db.prepare('UPDATE sources SET deleted=1 WHERE episodeId=? AND deleted=0').run(id); }
  private referencingRecalls(id: string): string[] {
    return this.db.prepare(`SELECT r.replyId,r.data FROM recalls r JOIN sources s ON s.episodeId=r.episodeId
      WHERE s.characterId=(SELECT characterId FROM sources WHERE episodeId=?)`).all(id)
      .filter(row => recallEpisodeIds(JSON.parse(String(row.data))).has(id)).map(row => String(row.replyId));
  }
  /** Save the cleanup scope before native deletion removes its chronology. Retries
   * retain this plan even after the native episode and contributions are gone. */
  prepareRecallDeletion(id: string): number | undefined {
    const source = this.source(id);
    if (source?.deleted === 2) return undefined;
    if (!source || source.deleted !== 1) throw new Error('Prepare recall cleanup only for a pending source deletion.');
    const affected = new Set<string>();
    let revision = 0;
    affected.add(id);
    if (existsSync(this.memoryPath)) {
      const memory = new DatabaseSync(this.memoryPath, { readOnly: true });
      try {
        memory.exec('BEGIN');
        revision = Number(memory.prepare('SELECT revision FROM characters WHERE id=?').get(source.characterId)?.revision ?? 0);
        const target = memory.prepare(`SELECT e.start,c.start AS publishedStart FROM episodes e
          LEFT JOIN contributions c ON c.character_id=e.character_id AND c.episode_id=e.id
          WHERE e.character_id=? AND e.id=?`).get(source.characterId, id);
        // A never-memorized episode cannot have contributed to other recall.
        if (target?.publishedStart !== null && target?.publishedStart !== undefined) {
          const cutoff = Math.min(Number(target.start), Number(target.publishedStart));
          for (const episode of memory.prepare(`SELECT e.id FROM episodes e
            LEFT JOIN contributions c ON c.character_id=e.character_id AND c.episode_id=e.id
            WHERE e.character_id=? AND (e.start>=? OR c.start>=?)`).all(source.characterId, cutoff, cutoff)) {
            affected.add(String(episode.id));
          }
        }
        memory.exec('COMMIT');
      } finally { memory.close(); }
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.source(id)?.deleted === 2) { this.db.exec('COMMIT'); return undefined; }
      const previous = this.db.prepare('SELECT affected FROM recall_deletions WHERE episodeId=?').get(id);
      const scope = previous ? deletionScope(String(previous.affected)) : { episodeIds: [], replyIds: [] };
      for (const episodeId of scope.episodeIds) affected.add(episodeId);
      // Withdrawn/invalidated contributions have no native row, but their supplied
      // prose can still exist in saved contexts, including re-dated episodes.
      const replyIds = new Set([...scope.replyIds, ...this.referencingRecalls(id)]);
      this.db.prepare('INSERT INTO recall_deletions VALUES(?,?) ON CONFLICT(episodeId) DO UPDATE SET affected=excluded.affected')
        .run(id, JSON.stringify({ episodeIds: [...affected], replyIds: [...replyIds] }));
      this.db.exec('COMMIT'); return revision;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  acknowledgeDeletion(id: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const plan = this.db.prepare('SELECT affected FROM recall_deletions WHERE episodeId=?').get(id);
      if (!plan) {
        if (this.source(id)?.deleted === 2) { this.db.exec('COMMIT'); return; }
        throw new Error('Prepare recall cleanup before acknowledging source deletion.');
      }
      const scope = deletionScope(String(plan.affected));
      const remove = this.db.prepare('DELETE FROM recalls WHERE episodeId=?');
      for (const episodeId of scope.episodeIds) remove.run(episodeId);
      const removeReply = this.db.prepare(`DELETE FROM recalls WHERE replyId=? AND episodeId IN
        (SELECT episodeId FROM sources WHERE characterId=(SELECT characterId FROM sources WHERE episodeId=?))`);
      // Include contexts saved after planning but before acknowledgment.
      for (const replyId of new Set([...scope.replyIds, ...this.referencingRecalls(id)])) removeReply.run(replyId, id);
      // An old record may not name its impression author anywhere. Remove only
      // that ambiguous prose and its rendered copy, retaining unrelated memory
      // references and played-prefix evidence needed by surviving reflection.
      const redact = this.db.prepare('UPDATE recalls SET data=? WHERE replyId=?');
      for (const row of this.db.prepare(`SELECT r.replyId,r.data FROM recalls r JOIN sources s ON s.episodeId=r.episodeId
        WHERE s.characterId=(SELECT characterId FROM sources WHERE episodeId=?)`).all(id)) {
        const data: unknown = JSON.parse(String(row.data));
        if (record(data) && unattributedImpressions(data)) redact.run(JSON.stringify(withoutLegacyImpressions(data)), row.replyId);
      }
      this.db.prepare('UPDATE sources SET deleted=2 WHERE episodeId=? AND deleted=1').run(id);
      this.db.prepare('DELETE FROM recall_deletions WHERE episodeId=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveRecall(episodeId: string, replyId: string, data: unknown): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const source = this.source(episodeId);
      const owner = source?.characterId ?? (record(data) && typeof data.characterId === 'string' ? data.characterId : undefined);
      let obsolete = Boolean(source?.deleted);
      if (owner && !obsolete) {
        const deleted = this.db.prepare('SELECT 1 FROM sources WHERE episodeId=? AND characterId=? AND deleted<>0');
        for (const reference of recallEpisodeIds(data)) if (deleted.get(reference, owner)) { obsolete = true; break; }
        if (!obsolete && record(data) && unattributedImpressions(data) && this.db.prepare(
          'SELECT 1 FROM sources WHERE characterId=? AND deleted<>0 LIMIT 1').get(owner)) data = withoutLegacyImpressions(data);
      }
      // A reply started before deletion may finish after cleanup. Never save its
      // removed background again, or write new records for a deleted source.
      if (!obsolete) this.db.prepare('INSERT INTO recalls VALUES(?,?,?) ON CONFLICT(replyId) DO UPDATE SET data=excluded.data')
        .run(episodeId, replyId, JSON.stringify(data));
      else this.discardedRecallCount++;
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recall(replyId: string, episodeId?: string): unknown {
    const row = episodeId === undefined ? this.db.prepare('SELECT data FROM recalls WHERE replyId=?').get(replyId)
      : this.db.prepare('SELECT data FROM recalls WHERE replyId=? AND episodeId=?').get(replyId, episodeId);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
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
