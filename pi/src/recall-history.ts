import type { Catalog } from './catalog.js';
import type { Recall, RecallActivation } from './contracts.js';
import { extractSource, sourceHash, type Entry } from './source.js';

/** Selected, successfully played replies are the only authority for activation history.
 * Historical sections in saved records are deliberately not recursively expanded. */
export function recallHistory(catalog: Catalog, branch: Entry[], episodeId: string, characterId: string): RecallActivation[] {
  const history: RecallActivation[] = [];
  const source = extractSource(branch);
  let promptId: string | undefined;
  for (const [position, message] of source.messages.entries()) {
    if (message.role === 'user') { promptId = message.id; continue; }
    if (!promptId) continue;
    const recall = catalog.recall(message.id, episodeId) as Recall | undefined;
    if (!recall || recall.characterId !== characterId || recall.episodeId !== episodeId
      || !Number.isSafeInteger(recall.at) || !Array.isArray(recall.memories)) continue;
    if (recall.playedPrefixHash !== sourceHash({ foundation: source.foundation, messages: source.messages.slice(0, position + 1) })) continue;
    const memories = recall.memories.filter(memory => typeof memory.episodeId === 'string'
      && typeof memory.contributionHash === 'string' && Number.isSafeInteger(memory.memoryIndex) && memory.memoryIndex >= 0)
      .map(memory => ({ episodeId: memory.episodeId, contributionHash: memory.contributionHash,
        memoryIndex: memory.memoryIndex, detailSupplied: Boolean(memory.detail) }));
    if (memories.length) history.push({ replyId: message.id, promptId, at: recall.at, memories });
  }
  return history;
}
