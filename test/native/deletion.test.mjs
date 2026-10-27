import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { MemoryClient } from '../../.work/pi-test/memory-client.mjs';
import { reflection, episodeSource } from '../fixtures/subjective.mjs';

function fixture(t, infer = async request => reflection(request)) {
  const sources = new Map();
  const client = new MemoryClient({ executable: resolve(process.env.REVERIE_TEST_ENGINE ?? 'engine/target/x86_64-pc-windows-gnu/release/reverie-engine.exe'),
    characterId: 'mara', database: resolve('.work/deletion-tests', randomUUID() + '.sqlite'),
    readSource: async id => structuredClone(sources.get(id)), infer });
  t.after(() => client.close());
  return { client, sources, async episode(id, date) {
    sources.set(id, episodeSource(id));
    await client.request('when', { episodeId: id, position: date, label: id });
    await client.request('memorize', { episodeId: id });
  } };
}
test('deletion immediately removes later derivatives without inference and preserves earlier memory and inclusion choices', async t => {
  const f = fixture(t);
  await f.episode('first', '2000-01-01'); await f.episode('deleted', '2010-01-01'); await f.episode('later', '2020-01-01');
  f.sources.delete('deleted');
  const result = await f.client.request('forget', { episodeId: 'deleted' });
  assert.equal(result.invalidatedEpisodes, 2);
  const status = await f.client.request('status');
  assert.deepEqual(status.episodes.map(item => item.id), ['first', 'later']);
  assert.ok(status.episodes.every(item => item.included));
  assert.equal(status.episodes[1].input_hash, null);
  const recall = await f.client.request('retrieve', { at: '2030-01-01', episodeId: 'new', cue: 'deleted later first' });
  assert.match(recall.text, /first/); assert.doesNotMatch(recall.text, /I remember deleted|I remember later/);
  assert.equal((await f.client.request('forget', { episodeId: 'deleted' })).invalidatedEpisodes, 0);
  await f.client.request('rebuild');
  const rebuilt = await f.client.request('retrieve', { at: '2030-01-01', episodeId: 'new', cue: 'later' });
  assert.match(rebuilt.text, /later/); assert.doesNotMatch(rebuilt.text, /I remember deleted/);
});

test('an in-flight reflection cannot republish data after source deletion', async t => {
  let hold = false, ready, release;
  const started = new Promise(resolve => { ready = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async request => { if (hold) { ready(); await gate; } return reflection(request); });
  await f.episode('first', '2000-01-01');
  f.sources.set('later', episodeSource('later'));
  await f.client.request('when', { episodeId: 'later', position: '2010-01-01' });
  hold = true;
  const failure = assert.rejects(f.client.request('memorize', { episodeId: 'later' }), { code: 'STALE_OPERATION' });
  await started;
  await f.client.request('forget', { episodeId: 'first' }); release(); await failure;
  const status = await f.client.request('status');
  assert.equal(status.memories, 0);
  assert.ok(!status.episodes.some(episode => episode.id === 'first'));
});
