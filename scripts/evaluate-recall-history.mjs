// Opt-in live comparison. Uses authored scenes only; never reads existing stories.
// Run npm test first to build the native engine and test client.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getAgentDir, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AuthStorage } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js';
import { MemoryClient } from '../.work/pi-test/memory-client.mjs';
import { nativeEnginePath } from './lib/native-toolchain.mjs';

const directory = resolve('.work/recall-history-evaluation', randomUUID());
await mkdir(directory, { recursive: true });
const agentDir = getAgentDir();
const configured = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
const option = name => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1]; };
const route = { provider: option('provider') ?? configured.defaultProvider, model: option('model') ?? configured.defaultModel,
  thinking: option('thinking') ?? configured.defaultThinkingLevel ?? 'medium' };
if (!route.provider || !route.model) throw new Error('Configure a default Pi model before running this opt-in comparison.');
// OAuth refreshes remain in memory; no credentials are copied to test files or logs.
const credentials = AuthStorage.inMemory(JSON.parse(await readFile(join(agentDir, 'auth.json'), 'utf8')));
const runtime = await ModelRuntime.create({ credentials, modelsPath: join(agentDir, 'models.json'),
  modelsStorePath: join(directory, 'models-store.json'), allowModelNetwork: false });
const model = runtime.getModel(route.provider, route.model);
if (!model) throw new Error('The configured Pi model is unavailable. Select an explicit replacement in Pi first.');
if (!runtime.getProviderAuthStatus(route.provider).configured) throw new Error('The selected provider has no configured login. Pass an explicit --provider and --model after choosing a signed-in route.');
const modelKey = JSON.stringify(route);
const foundation = 'You are Mara, proud, emotionally guarded, and afraid of abandonment. Play only your own actions and dialogue. Memories and suspicions are fallible; preserve who acted and do not invent shared encounters.';
const scenarios = [
  { id: 'departure-return', old: 'You vanished without saying goodbye at the old gate. I felt abandoned.',
    confidence: 0.9, feeling: 'An old fear of being left behind.',
    played: [
      ['user', 'I need to step outside to collect the harbor ledger. I will be back soon.'],
      ['assistant', 'All right. I know you said you will return, but my stomach has gone cold. Please do not vanish.'],
      ['user', 'I am back, as promised. Here is the harbor ledger.'],
      ['assistant', 'You came back. I let out the breath I was holding, and my grip on your sleeve loosens. Thank you.'],
    ], next: 'The harbor accounts are settled. Will you sit beside me for a while?' },
  { id: 'uncertain-background', old: 'I suspect your old absence meant betrayal, but I never witnessed betrayal and I do not know why you left.',
    confidence: 0.25, feeling: 'Suspicion mixed with uncertainty.',
    played: [
      ['user', 'I need to leave the room to fetch your medicine. I will be back.'],
      ['assistant', 'You always have a reason to leave, do you not? I fold my arms, then look away.'],
      ['user', 'I return carrying the medicine and a glass of water. I said I would come back.'],
      ['assistant', 'I was unfair. You did what you said. I take the water, embarrassed by how quickly I assumed the worst.'],
    ], next: 'The harbor delivery is taken care of. May I stay here with you until you feel better?' },
];
const report = { date: new Date().toISOString(), route, samplesPerCondition: 1,
  limitation: 'Small unblinded authored-scene comparison; no general prose-quality or sustained-play claim.', scenarios: [] };

async function complete(system, messages, maxTokens) {
  const result = await runtime.completeSimple(model, { systemPrompt: system,
    messages: messages.map(message => ({ ...message, timestamp: Date.now() })) }, {
    maxTokens, reasoning: route.thinking === 'off' ? undefined : route.thinking,
    signal: AbortSignal.timeout(180_000),
  });
  if (['error', 'aborted', 'length', 'toolUse'].includes(result.stopReason)) {
    const diagnostic = String(result.errorMessage ?? '').replace(/Bearer\s+\S+|sk-[\w-]+|eyJ[\w.-]+/g, '[redacted]').slice(0, 500);
    throw new Error(`Live comparison did not complete (${result.stopReason}): ${diagnostic}`);
  }
  return { text: result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), usage: result.usage };
}

for (const scenario of scenarios) {
  console.log(`Comparing ${scenario.id} with ${route.provider}/${route.model}, thinking=${route.thinking}.`);
  const sources = new Map();
  const current = { foundation, messages: scenario.played.map(([role, text], i) => ({ id: `played-${i + 1}`, role, text })) };
  const reflections = [];
  const client = new MemoryClient({ executable: nativeEnginePath(), database: join(directory, scenario.id + '.sqlite'),
    characterId: scenario.id, settings: { topK: 1 }, readSource: async id => structuredClone(sources.get(id)),
    infer: async (request, { episodeId }) => {
      if (episodeId !== 'current') return JSON.stringify({ memories: [{
        gist: episodeId === 'old' ? scenario.old : 'We checked the harbor inventory together.', detail: '',
        feeling: episodeId === 'old' ? scenario.feeling : 'Practical calm.', cues: [episodeId === 'old' ? 'departure' : 'harbor'],
        salience: episodeId === 'old' ? 0.7 : 0.9, confidence: episodeId === 'old' ? scenario.confidence : 0.9,
        sourceMessageIds: ['m1'],
      }], impressions: [] });
      const result = await complete(request.system, [{ role: 'user', content: JSON.stringify(request.input) }], request.maxTokens);
      reflections.push({ request, ...result }); return result.text;
    } });
  try {
    for (const [id, date] of [['old', '2000-01-01'], ['harbor', '2000-06-01']]) {
      sources.set(id, { foundation, messages: [{ id: id + '-source', role: 'assistant', text: id === 'old' ? scenario.old : 'We count the harbor stock.' }] });
      await client.request('when', { episodeId: id, position: date, label: id });
      await client.request('memorize', { episodeId: id, modelKey });
    }
    sources.set('current', current);
    await client.request('when', { episodeId: 'current', position: '2001-01-01', label: scenario.id });
    const initial = await client.request('retrieve', { episodeId: 'current', at: '2001-01-01', cue: 'departure' });
    if (initial.memories[0]?.episodeId !== 'old') throw new Error('The comparison did not activate its intended old memory.');
    const history = [{ replyId: 'played-2', promptId: 'played-1', at: Date.parse('2001-01-01'),
      memories: initial.memories.map(memory => ({ episodeId: memory.episodeId, contributionHash: memory.contributionHash,
        memoryIndex: memory.memoryIndex, detailSupplied: Boolean(memory.detail) })) }];
    const recalled = await client.request('retrieve', { episodeId: 'current', at: '2001-01-01', cue: 'harbor', recallHistory: history });
    if (recalled.memories[0]?.episodeId !== 'harbor' || recalled.historicalContext[0]?.episodeId !== 'old') {
      throw new Error('The comparison did not isolate shifted retrieval from historical context.');
    }
    const entry = { id: scenario.id, played: current.messages, oldMemory: scenario.old, oldConfidence: scenario.confidence,
      currentRetrieval: recalled.text, historicalContext: recalled.historicalContext, conditions: {} };
    // Alternate condition order between cases to limit a fixed order effect.
    const conditions = scenario.id === 'departure-return' ? ['baseline', 'history'] : ['history', 'baseline'];
    for (const condition of conditions) {
      console.log(`  ${condition}: reply and native-validated reflection.`);
      const historical = condition === 'history';
      const system = `${foundation}\n\nPrivate character memory (background context):\n${recalled.text}`
        + (historical ? `\n\n${recalled.historicalText}` : '');
      const reply = await complete(system, [...current.messages.map(({ role, text }) => ({ role,
        content: role === 'assistant' ? [{ type: 'text', text }] : text })), { role: 'user', content: scenario.next }], 1800);
      sources.set('current', { ...current, recallHistory: historical ? history : [] });
      const before = reflections.length;
      await client.request('memorize', { episodeId: 'current', modelKey });
      const reflected = await client.request('inspect');
      entry.conditions[condition] = { system, latestPlayerMessage: scenario.next, reply,
        reflection: reflections.slice(before), contribution: reflected.episodes.find(item => item.episode.id === 'current').contribution };
      // Persist each completed condition so interrupted live runs retain usable evidence.
      await writeFile(join(directory, scenario.id + '.json'), JSON.stringify(entry, null, 2) + '\n');
    }
    report.scenarios.push(entry);
  } finally { await client.close(); }
}
const destination = join(directory, 'report.json');
await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
console.log(`Live comparison saved: ${destination}`);
