import type { InspectedEpisode, MemoryInspection, StoredMemory } from './contracts.js';

export function stateLabel(item: InspectedEpisode): string {
  return ({ 'not-memorized': 'Not memorized', invalidated: 'Invalidated · needs rebuild', stale: 'Stale · unmemorized changes', empty: 'Memorized · empty contribution', published: 'Memorized' })[item.state]
    + (item.freshness === 'unavailable' ? ' · source unavailable' : '')
    + (item.correction ? item.correctionStale ? ' · stale correction' : ' · corrected' : '')
    + (item.needsRebuild && item.state !== 'invalidated' ? ' · impressions need rebuild' : '');
}

export function memoryText(memory: StoredMemory, index: number): string {
  return [`${index + 1}. Remembered meaning: ${memory.gist}`, `Retained detail: ${memory.detail || '(none)'}`,
    `Emotional residue: ${memory.feeling || '(none)'}`, `Confidence: ${memory.confidence} · Salience: ${memory.salience}`,
    `Supporting message IDs: ${memory.sourceMessageIds.join(', ')}`].join('\n');
}

export function episodeText(item: InspectedEpisode): string {
  const lines = [stateLabel(item), 'Stored recollections · complete published contribution',
    'Player inspection does not supply these memories to the character.',
    item.eligible === null ? 'No story point selected.' : `Chronologically eligible at selected point: ${item.eligible ? 'yes' : 'no'}. Eligibility does not mean supplied to a reply.`];
  if (item.sourceError) lines.push(`Played source unavailable: ${item.sourceError}`);
  if (item.freshness === 'stale') lines.push('Supporting text is the current selected branch; it differs from the published source. Missing IDs cannot be resolved here.');
  if (!item.contribution) lines.push(item.state === 'invalidated' ? 'Published contribution was invalidated. Rebuild to form it again.' : 'No published contribution.');
  else if (!item.contribution.memories.length) lines.push('No recollections were retained in this published contribution.');
  else lines.push(...item.contribution.memories.map(memoryText));
  return lines.join('\n\n');
}

export function impressionsText(item: InspectedEpisode, inspection: MemoryInspection): string {
  const label = (id: string) => inspection.episodes.find(item => item.episode.id === id)?.episode.label ?? id;
  return [stateLabel(item), 'Broader impressions · snapshot formed with this episode',
    item.impressionsEligible === null ? 'No story point selected.' : item.impressionsEligible ? 'This is the impression snapshot eligible at the selected point.' : 'This snapshot is not selected at the current story point.',
    ...(item.contribution?.impressions.map(impression => `“${impression.text}”\nContributing episodes: ${impression.sourceEpisodeIds.map(id => `${label(id)} [${id}]`).join(', ')}`) ?? []),
    !item.contribution?.impressions.length ? 'No published impressions. They may need rebuilding.' : '',
    'Use Supporting played source to follow episode references.'].filter(Boolean).join('\n\n');
}

export function sourcesText(item: InspectedEpisode, characterName: string, ids?: string[]): string {
  const messages = ids ? item.sources.filter(message => ids.includes(message.id)) : item.sources;
  const references = ids ?? item.contribution?.memories.flatMap(memory => memory.sourceMessageIds) ?? [];
  return [`Played source · ${item.episode.label} · ${item.freshness}`,
    'Authorship is explicit below. Actions and spoken dialogue remain exactly as played; quotation and narration are not reinterpreted.',
    item.sourceError ?? '',
    ...messages.map(message => `[${message.id}] ${message.role === 'user' ? 'Player' : characterName + ' (companion)'}:\n${message.text}`),
    ...[...new Set(references)].filter(id => !messages.some(message => message.id === id)).map(id => `[${id}] Missing from the current selected branch.`),
    !messages.length ? 'No supporting played text is available.' : ''].filter(Boolean).join('\n\n');
}
