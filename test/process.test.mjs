import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { MemoryClient } from '../.work/pi-test/memory-client.mjs';
import { nativeEnginePath } from '../scripts/lib/native-toolchain.mjs';

function clientFor(t, options = {}) {
  const client = new MemoryClient({ executable: nativeEnginePath(),
    database: resolve('.work/process-tests', `${randomUUID()}.sqlite`), characterId: 'mara',
    readSource: async id => ({ foundation: 'You are Mara.', messages: [{ id: `${id}:u`, role: 'user', text: 'I lend you my coat by the old lighthouse.' }] }),
    infer: async request => ({ memories: [{ gist: 'I remember your kindness at the lighthouse.', detail: 'Your coat was warm.', feeling: 'I felt safe.',
      cues: ['lighthouse', 'coat', 'kindness'], salience: 0.8, confidence: 0.9, sourceMessageIds: [request.input.episode.messages[0].id] }],
    impressions: [{ text: 'I feel I can trust you.', sourceEpisodeIds: [request.input.episode.id] }] }),
    ...options });
  t.after(() => client.close());
  return client;
}

test('a separate memory process calls back for source and inference and serves retrieval locally', async t => {
  const client = clientFor(t);
  assert.equal((await client.request('ping')).characterId, 'mara');
  await client.request('when', { episodeId: 'meeting', position: '2010-01-01', label: 'The lighthouse' });
  const result = await client.request('memorize', { episodeId: 'meeting', modelKey: 'test-model' });
  assert.equal(result.status, 'published');
  const recall = await client.request('retrieve', { at: '2015-01-01', cue: 'coat', episodeId: 'new' });
  assert.match(recall.text, /kindness at the lighthouse/);
  await assert.rejects(client.request('status', { characterId: 'anya' }), { code: 'CHARACTER_MISMATCH' });
  await client.request('unmemorize', { episodeId: 'meeting', modelKey: 'test-model' });
  assert.equal((await client.request('status')).memories, 0);
});

test('cancellation crosses the process interface and aborts the model callback', async t => {
  let started;
  let aborted = false;
  const ready = new Promise(resolve => { started = resolve; });
  const client = clientFor(t, { infer: async (request, { signal }) => {
    started();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
  } });
  await client.request('when', { episodeId: 'meeting', position: '2010-01-01' });
  const operation = client.request('memorize', { episodeId: 'meeting', modelKey: 'test-model' });
  await ready;
  assert.equal((await client.request('cancel')).cancelled, true);
  await assert.rejects(operation, { code: 'CANCELLED' });
  assert.equal(aborted, true);
  assert.equal((await client.request('status')).memories, 0);
});

test('an unavailable executable reports a bounded failure rather than hanging shutdown', async t => {
  const client = new MemoryClient({ executable: resolve('.work/nonexistent-memory.exe'), characterId: 'mara',
    database: resolve('.work/no-memory.sqlite'), readSource: () => {}, infer: () => {} });
  t.after(() => client.close());
  await assert.rejects(client.request('ping'), { code: 'MEMORY_PROCESS_UNAVAILABLE' });
});
