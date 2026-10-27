export interface SourceObservation { messages: { id: string; role: 'user' | 'assistant'; text: string }[]; foundation: string }
export interface ReflectionRequest { system: string; input: unknown; maxTokens: number }
export interface Episode { id: string; label: string; start: number; now: number; included: boolean; source_hash: string | null; input_hash: string | null; published_end: number | null }
export interface Recollection { id: number; episodeId: string; gist: string; detail: string; feeling: string; when: string; sourceMessageIds: string[] }
export interface Recall { characterId: string; episodeId: string; at: number; memories: Recollection[]; impressions: { text: string; sourceEpisodeIds: string[] }[]; sharedHistory: string; historySources: string[]; text: string; revision: number }
export interface UpdateResult { status: 'current' | 'published'; reflected: number; includedEpisodes: number; removedEpisodes?: string[] }
export interface MemoryStatus { characterId: string; revision: number; episodes: Episode[]; memories: number; operation: { kind: string; stage: string; completed: number; total: number } | null }
export interface EngineResults {
  ping: { version: string; characterId: string; protocol: number; runtime: string };
  when: Episode; status: MemoryStatus; retrieve: Recall; cancel: { cancelled: boolean };
  assertEpisode: { characterId: string; episodeId: string };
  forget: { episodeId: string; invalidatedEpisodes: number };
  memorize: UpdateResult; unmemorize: UpdateResult; rebuild: UpdateResult;
}
export type EngineMethod = keyof EngineResults;
