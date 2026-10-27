// Authored roleplay fixture for native and Pi acceptance suites.
export function reflection(request) {
  const episode = request.input.episode;
  const prior = request.input.eligibleEarlierEpisodes.map(item => item.id);
  const priorLabels = request.input.eligibleEarlierEpisodes.map(item => item.label);
  return {
    memories: [{ gist: 'I remember ' + episode.label + '.', detail: 'There was a blue lantern.', feeling: 'I felt unsettled.',
      cues: [episode.label, 'lighthouse', 'lantern'], salience: 0.8, confidence: 0.9,
      sourceMessageIds: [episode.messages[0].id] }],
    impressions: [{ text: priorLabels.includes('betrayal') ? 'I distrust him after the abandonment.' : 'I am curious about him.',
      sourceEpisodeIds: [...prior, episode.id] }],
  };
}

export function episodeSource(id) {
  return { foundation: 'You are Mara, a proud companion who fears rejection.',
    messages: [{ id: id + ':user', role: 'user', text: 'I hold a blue lantern beside the lighthouse. PRIVATE_TRANSCRIPT_MARKER_7f55' },
      { id: id + ':assistant', role: 'assistant', text: 'I accept your help, although I am wary.' }] };
}
