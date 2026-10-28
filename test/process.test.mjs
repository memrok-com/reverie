import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { MemoryClient } from '../.work/pi-test/memory-client.mjs';
import { nativeEnginePath } from '../scripts/lib/native-toolchain.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { reflection } from './fixtures/subjective.mjs';

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

test('active reflection can exceed the inactivity window and publish a complete multi-episode rebuild', async t => {
  let slow = false;
  const client = clientFor(t, { settings: { reflectionInactivityMs: 300 }, infer: async (request, { onProgress }) => {
    if (slow) for (let i = 0; i < 8; i++) { await delay(75); onProgress(); }
    return reflection(request);
  } });
  for (const [id, date] of [['first', '2000-01-01'], ['later', '2010-01-01']]) {
    await client.request('when', { episodeId: id, position: date, label: id });
    await client.request('memorize', { episodeId: id });
  }
  slow = true;
  assert.equal((await client.request('rebuild', { force: true })).reflected, 2);
  assert.equal((await client.request('status')).memories, 2);
});

test('stalled reflection aborts its callback and atomically retains the previous rebuild despite expired progress', async t => {
  let stall = false, expiredProgress, aborted = false;
  const client = clientFor(t, { settings: { reflectionInactivityMs: 250 }, infer: async (request, { onProgress, signal }) => {
    if (!expiredProgress) expiredProgress = onProgress;
    if (stall && request.input.episode.label === 'later') {
      const timer = setInterval(() => expiredProgress(), 40);
      try { await new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true })); }
      finally { clearInterval(timer); }
    }
    return reflection(request);
  } });
  for (const [id, date] of [['first', '2000-01-01'], ['later', '2010-01-01']]) {
    await client.request('when', { episodeId: id, position: date, label: id });
    await client.request('memorize', { episodeId: id });
  }
  const before = await client.request('inspect'); stall = true;
  await assert.rejects(client.request('rebuild', { force: true }), { code: 'CALLBACK_TIMEOUT' });
  assert.equal(aborted, true);
  assert.deepEqual(await client.request('inspect'), before);
  assert.equal((await client.request('status')).operation, null);
});

test('reflection inactivity policy does not shorten source reads or invalidate memory after restart', async t => {
  const database = resolve('.work/process-tests', `${randomUUID()}.sqlite`);
  const readSource = async id => {
    await delay(300);
    return { foundation: 'Mara', messages: [{ id: `${id}:u`, role: 'user', text: 'We meet.' }] };
  };
  const first = clientFor(t, { database, readSource, settings: { reflectionInactivityMs: 150 } });
  await first.request('when', { episodeId: 'meeting', position: '2000-01-01' });
  await first.request('memorize', { episodeId: 'meeting' }); await first.close();
  const restarted = clientFor(t, { database, readSource, settings: { reflectionInactivityMs: 1000 },
    infer: async () => { throw new Error('Transport settings must not regenerate memory.'); } });
  assert.equal((await restarted.request('memorize', { episodeId: 'meeting' })).status, 'current');
});
