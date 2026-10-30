import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { MemoryClient } from '../../.work/pi-test/memory-client.mjs';
import { reflection, episodeSource } from '../fixtures/subjective.mjs';
import { nativeEnginePath } from '../../scripts/lib/native-toolchain.mjs';

function fixture(t, infer = async request => reflection(request)) {
  const sources = new Map();
  const database = resolve('.work/deletion-tests', randomUUID() + '.sqlite');
  const client = new MemoryClient({ executable: nativeEnginePath(),
    characterId: 'mara', database,
    readSource: async id => structuredClone(sources.get(id)), infer });
  t.after(() => client.close());
  return { client, sources, database, async episode(id, date) {
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

test('clear memory removes corrections and all published memory, keeps dates, and excludes old episodes from repair', async t => {
  let calls = 0;
  const f = fixture(t, async request => { calls++; return reflection(request); });
  await f.episode('first', '2000-01-01'); await f.episode('later', '2010-01-01');
  const inspection = await f.client.request('inspect');
  const replacement = { ...inspection.episodes[0].contribution.memories[0], gist: 'Reviewed lantern' };
  const preview = await f.client.request('previewCorrection', { episodeId: 'first', revision: inspection.revision, memoryIndex: 0, replacement });
  await f.client.request('applyCorrection', { token: preview.token });
  const before = await f.client.request('status');
  await assert.rejects(f.client.request('clearMemory', { revision: before.revision - 1 }), { code: 'STALE_OPERATION' });
  assert.deepEqual(await f.client.request('status'), before);
  await assert.rejects(f.client.request('clearMemory'), { code: 'INVALID_INPUT' });
  await f.client.request('clearMemory', { revision: before.revision });
  const after = await f.client.request('inspect');
  assert.equal(after.episodes.length, 2);
  for (const [i, item] of after.episodes.entries()) {
    assert.equal(item.episode.start, before.episodes[i].start);
    assert.equal(item.episode.now, before.episodes[i].now);
    assert.equal(item.episode.included, false);
    assert.equal(item.contribution, null); assert.equal(item.correction, null);
    assert.equal(item.episode.source_hash, null); assert.equal(item.episode.input_hash, null);
  }
  await f.client.request('rebuild');
  assert.equal(calls, 2);
  const recall = await f.client.request('retrieve', { at: '2030-01-01', episodeId: 'new', cue: 'lantern first later' });
  assert.equal(recall.text, ''); assert.deepEqual(recall.memories, []); assert.deepEqual(recall.impressions, []);
  // An explicit memorization is still possible after the reset.
  await f.client.request('memorize', { episodeId: 'first' });
  assert.equal(calls, 3);
  assert.ok((await f.client.request('status')).memories > 0);
});

test('clear memory prevents an in-flight reflection from restoring cleared data', async t => {
  let hold = false, ready, release;
  const started = new Promise(resolve => { ready = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async request => { if (hold) { ready(); await gate; } return reflection(request); });
  await f.episode('first', '2000-01-01');
  f.sources.set('later', episodeSource('later'));
  await f.client.request('when', { episodeId: 'later', position: '2010-01-01' });
  hold = true;
  const failure = assert.rejects(f.client.request('memorize', { episodeId: 'later' }), { code: 'CANCELLED' });
  await started;
  await f.client.request('clearMemory', { revision: (await f.client.request('status')).revision });
  release(); await failure;
  assert.equal((await f.client.request('status')).memories, 0);
});

test('clear memory persists across restart, isolates characters, and invalidates reflection in another process', async t => {
  let hold = false, ready, release;
  const started = new Promise(resolve => { ready = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async request => { if (hold) { ready(); await gate; } return reflection(request); });
  await f.episode('first', '2000-01-01');
  const connect = characterId => {
    const client = new MemoryClient({ executable: nativeEnginePath(), characterId, database: f.database,
      readSource: async id => episodeSource(id), infer: async request => reflection(request) });
    t.after(() => client.close()); return client;
  };
  const other = connect('other');
  await other.request('when', { episodeId: 'other-scene', position: '2000-01-01' });
  await other.request('memorize', { episodeId: 'other-scene' });
  const otherBefore = await other.request('inspect');
  f.sources.set('later', episodeSource('later'));
  await f.client.request('when', { episodeId: 'later', position: '2010-01-01' });
  hold = true;
  const failure = assert.rejects(f.client.request('memorize', { episodeId: 'later' }), { code: 'STALE_OPERATION' });
  await started;
  const clearer = connect('mara');
  await clearer.request('clearMemory', { revision: (await clearer.request('status')).revision });
  release(); await failure;
  assert.deepEqual(await other.request('inspect'), otherBefore);
  await f.client.close();
  const restarted = connect('mara');
  const status = await restarted.request('status');
  assert.equal(status.memories, 0); assert.ok(status.episodes.every(item => !item.included));
  await restarted.request('rebuild');
  assert.equal((await restarted.request('status')).memories, 0);
});
