export interface SourceObservation { messages: { id: string; role: 'user' | 'assistant'; text: string }[]; foundation: string }
export interface ReflectionRequest { system: string; input: unknown; maxTokens: number }
export interface Episode { id: string; label: string; start: number; now: number; included: boolean; source_hash: string | null; input_hash: string | null; published_end: number | null }
export interface Recollection { id: number; episodeId: string; gist: string; detail: string; feeling: string; when: string; sourceMessageIds: string[] }
export interface Recall { characterId: string; episodeId: string; at: number; memories: Recollection[]; impressions: { text: string; sourceEpisodeIds: string[] }[]; sharedHistory: string; historySources: string[]; text: string; revision: number }
export interface UpdateResult { status: 'current' | 'published'; reflected: number; includedEpisodes: number; removedEpisodes?: string[] }
export interface MemoryStatus { characterId: string; revision: number; episodes: Episode[]; memories: number; operation: { kind: string; stage: string; completed: number; total: number } | null }
export interface StoredMemory { gist: string; detail: string; feeling: string; cues: string[]; salience: number; confidence: number; sourceMessageIds: string[] }
export interface Contribution { episodeId: string; label: string; start: number; end: number; sourceHash: string; inputHash: string; reuseHash?: string; modelKey?: string; stateHash: string; dependencies: string[]; memories: StoredMemory[]; impressions: { text: string; sourceEpisodeIds: string[] }[] }
export interface InspectedEpisode {
  episode: Episode; state: 'not-memorized' | 'invalidated' | 'stale' | 'empty' | 'published';
  freshness: 'current' | 'stale' | 'deleted' | 'unavailable'; sourceError: string | null;
  contribution: Contribution | null; sources: SourceObservation['messages']; eligible: boolean | null;
  impressionsEligible: boolean | null; needsRebuild: boolean;
  correction: { episodeId: string; sourceHash: string; memories: StoredMemory[] } | null; correctionStale: boolean | null;
}
export interface MemoryInspection { characterId: string; revision: number; at: number | null; activeEpisodeId: string; episodes: InspectedEpisode[] }
export interface CorrectionPreview { token: string; revision: number; episodeId: string; release: boolean; before: Contribution; after: Contribution; affected: Contribution[]; releasedPins: string[] }
export interface EngineResults {
  ping: { version: string; characterId: string; protocol: number; runtime: string };
  when: Episode; status: MemoryStatus; retrieve: Recall; cancel: { cancelled: boolean };
  inspect: MemoryInspection; previewCorrection: CorrectionPreview;
  applyCorrection: { episodeId: string; invalidatedEpisodes: number; released: boolean };
  assertEpisode: { characterId: string; episodeId: string };
  forget: { episodeId: string; invalidatedEpisodes: number };
  memorize: UpdateResult; unmemorize: UpdateResult; rebuild: UpdateResult;
}
export type EngineMethod = keyof EngineResults;
