import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryClient } from './memory-client.js';
import { Catalog, type SourceRecord } from './catalog.js';
import { readSourceFile } from './source.js';
import type { ReflectionRequest } from './contracts.js';

export function executablePath(packageRoot: string): string {
  const binary = process.platform === 'win32' ? 'reverie.exe' : 'reverie';
  const path = join(packageRoot, 'bin', `${process.platform}-${process.arch}`, binary);
  if (!existsSync(path)) throw new Error(`This Reverie package has no verified engine for ${process.platform}/${process.arch}. Install a matching release.`);
  return path;
}
export class MemoryService {
  private clients = new Map<string, MemoryClient>();
  private reconciling?: Promise<number>;
  constructor(readonly catalog: Catalog, readonly executable: string,
    private infer: (request: ReflectionRequest, options: { modelKey: string; signal: AbortSignal; onProgress(): void }) => Promise<string>,
    private onSourceUnavailable: (source: SourceRecord, error: unknown) => void = () => {}) {}
  client(characterId: string): MemoryClient {
    let client = this.clients.get(characterId);
    if (!client) {
      client = new MemoryClient({ executable: this.executable, characterId, database: this.catalog.memoryPath,
        ...(process.env.REVERIE_REFLECTION_INACTIVITY_SECONDS === undefined ? {} : {
          settings: { reflectionInactivityMs: Number(process.env.REVERIE_REFLECTION_INACTIVITY_SECONDS) * 1000 },
        }),
        readSource: async (id, signal) => {
          signal.throwIfAborted();
          const source = this.catalog.source(id);
          if (!source || source.characterId !== characterId || source.deleted) throw new Error('That episode is no longer available to this character.');
          return readSourceFile(source.path, source.leaf);
        }, infer: this.infer });
      this.clients.set(characterId, client);
    }
    return client;
  }
  /** Tombstones survive a crash between observing a deletion and invalidating the native database. */
  reconcile(): Promise<number> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = (async () => {
      let invalidated = 0;
      for (const source of await this.catalog.missingSources(this.onSourceUnavailable)) {
        const result = await this.client(source.characterId).request('forget', { episodeId: source.episodeId });
        invalidated += result.invalidatedEpisodes;
        this.catalog.acknowledgeDeletion(source.episodeId);
      }
      return invalidated;
    })().finally(() => { this.reconciling = undefined; });
    return this.reconciling;
  }
  async forget(id: string, characterId?: string): Promise<void> {
    const source = this.catalog.source(id);
    if (source && characterId && source.characterId !== characterId) throw new Error('This chat belongs to another character.');
    if (!source) {
      if (characterId) await this.client(characterId).request('forget', { episodeId: id });
      return;
    }
    this.catalog.tombstone(id);
    await this.reconcile();
  }
  async close(): Promise<void> {
    await this.reconciling;
    const clients = [...this.clients.values()]; this.clients.clear();
    await Promise.all(clients.map(client => client.close()));
  }
}
