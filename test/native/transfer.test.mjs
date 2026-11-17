import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { MemoryClient } from '../support/memory-client.mjs';
import { nativeEnginePath } from '../../scripts/lib/native-toolchain.mjs';

const source = id => ({ foundation: 'You are Mara.', messages: [{ id: `${id}:u`, role: 'user', text: 'I lend you my coat at the lighthouse.' }] });
function client(t, options = {}) {
  const result = new MemoryClient({ executable: nativeEnginePath(), characterId: 'mara', database: resolve('.work/transfer-tests', `${randomUUID()}.sqlite`),
    readSource: async id => source(id), infer: async () => { throw new Error('Transfer must never reflect.'); }, ...options });
  t.after(() => result.close()); return result;
}
function forming(t, options = {}) {
  return client(t, { infer: async request => ({ memories: [{ gist: 'I remember your kindness.', detail: 'Your coat was warm.', feeling: 'I felt safe.', cues: ['coat', 'lighthouse'], salience: 0.8, confidence: 0.9, sourceMessageIds: [request.input.episode.messages[0].id] }], impressions: [{ text: 'I feel I can trust you.', sourceEpisodeIds: [request.input.episode.id] }] }), ...options });
}
async function memorize(c, id = 'meeting', at = '2000-01-01') {
  await c.request('when', { episodeId: id, position: at, label: id });
  await c.request('memorize', { episodeId: id, modelKey: 'fixture-model' });
}
async function importParams(c, archive) {
  const preview = await c.request('previewImport', { archive });
  return { archive, revision: preview.revision, archiveHash: preview.archiveHash };
}

test('published recollections, impressions and provenance round trip without models and survive restart', async t => {
  const original = forming(t); await memorize(original);
  const { archive } = await original.request('exportMemory');
  assert.equal(archive.version, 1);
  assert.equal(archive.contributions[0].modelKey, 'fixture-model');
  const database = resolve('.work/transfer-tests', `${randomUUID()}.sqlite`);
  const restored = client(t, { database });
  const params = await importParams(restored, archive);
  assert.equal((await restored.request('importMemory', params)).status, 'imported');
  assert.deepEqual((await restored.request('exportMemory')).archive, archive);
  assert.equal((await restored.request('importMemory', params)).status, 'current');
  await restored.close();
  const restarted = client(t, { database });
  const recall = await restarted.request('retrieve', { at: '2001-01-01', cue: 'coat' });
  assert.equal(recall.memories.length, 1); assert.match(recall.text, /Your coat was warm/);
  assert.equal(recall.impressions[0].text, 'I feel I can trust you.');
  assert.deepEqual((await restarted.request('exportMemory')).archive, archive);
});

test('corrections, withdrawn episodes, date offsets and pending rebuilds preserve their saved state', async t => {
  const original = forming(t);
  await memorize(original, 'first'); await memorize(original, 'second', '2001-01-01');
  await memorize(original, 'withdrawn', '2002-01-01');
  await original.request('unmemorize', { episodeId: 'withdrawn' });
  const dates = await original.request('status');
  const move = await original.request('previewRedate', { episodeId: 'withdrawn', revision: dates.revision, position: '2003-01-01' });
  await original.request('applyRedate', { token: move.token });
  const inspection = await original.request('inspect', {});
  const correction = await original.request('previewCorrection', { episodeId: 'first', revision: inspection.revision, memoryIndex: 0,
    replacement: { gist: 'I remember reluctantly accepting the coat.', detail: '', feeling: 'Conflicted.', cues: ['coat'], salience: 0.8, confidence: 0.7, sourceMessageIds: ['first:u'] } });
  await original.request('applyCorrection', { token: correction.token });
  const { archive } = await original.request('exportMemory');
  assert.equal(archive.corrections.length, 1);
  assert.equal(archive.contributions.length, 1);
  assert.notEqual(archive.episodes.find(e => e.id === 'withdrawn').time_offset, 0);
  const restored = client(t);
  const preview = await restored.request('previewImport', { archive });
  assert.deepEqual(preview.pendingEpisodes, ['second']);
  await restored.request('importMemory', { archive, revision: preview.revision, archiveHash: preview.archiveHash });
  assert.deepEqual((await restored.request('exportMemory')).archive, archive);
  // A later host source edit can be backed up without making stale memory current.
  const changed = client(t, { readSource: async id => ({ ...source(id), foundation: 'A changed foundation.' }) });
  await assert.rejects(changed.request('importMemory', await importParams(changed, archive)), { code: 'STALE_SOURCE' });
  assert.equal((await changed.request('status')).memories, 0);
});

test('an already stale contribution can be exported and restored against its actual archived source', async t => {
  let edited = false;
  const readSource = async id => ({ ...source(id), foundation: edited ? 'Revised foundation.' : 'You are Mara.' });
  const original = forming(t, { readSource }); await memorize(original); edited = true;
  const { archive } = await original.request('exportMemory');
  assert.notEqual(archive.sources.meeting, archive.contributions[0].sourceHash);
  const restored = client(t, { readSource });
  const preview = await restored.request('previewImport', { archive });
  assert.deepEqual(preview.pendingEpisodes, ['meeting']);
  await restored.request('importMemory', { archive, revision: preview.revision, archiveHash: preview.archiveHash });
  assert.deepEqual((await restored.request('exportMemory')).archive, archive);
});

test('invalid, unsupported, wrong-character and occupied imports leave memory unchanged', async t => {
  const original = forming(t); await memorize(original);
  const { archive } = await original.request('exportMemory');
  const target = client(t);
  const damaged = structuredClone(archive); damaged.contributions[0].memories[0].gist = 'forged';
  await assert.rejects(target.request('previewImport', { archive: damaged }), { code: 'INVALID_ARCHIVE' });
  await assert.rejects(target.request('previewImport', { archive: { ...archive, version: 999 } }), { code: 'UNSUPPORTED_ARCHIVE' });
  await assert.rejects(target.request('previewImport', { archive: { ...archive, extra: true } }), { code: 'INVALID_ARCHIVE' });
  const other = client(t, { characterId: 'anya' });
  await assert.rejects(other.request('previewImport', { archive }), { code: 'CHARACTER_MISMATCH' });
  const params = await importParams(target, archive);
  await target.request('when', { episodeId: 'existing', position: '2003-01-01' });
  await assert.rejects(target.request('importMemory', params), { code: 'IMPORT_CONFLICT' });
  assert.equal((await target.request('status')).episodes.length, 1);
});

test('callback failure, cancellation and source drift never publish partial imported memory', async t => {
  const original = forming(t); await memorize(original);
  const { archive } = await original.request('exportMemory');
  const failing = client(t, { readSource: async () => { throw Object.assign(new Error('Source unavailable.'), { code: 'SOURCE_OFFLINE' }); } });
  await assert.rejects(failing.request('importMemory', await importParams(failing, archive)), { code: 'SOURCE_OFFLINE' });
  assert.equal((await failing.request('status')).memories, 0);
  let calls = 0;
  const drifting = client(t, { readSource: async id => ++calls === 1 ? source(id) : { ...source(id), foundation: 'Edited during restore.' } });
  await assert.rejects(drifting.request('importMemory', await importParams(drifting, archive)), { code: 'STALE_SOURCE' });
  assert.equal((await drifting.request('status')).memories, 0);
  let notify;
  const started = new Promise(resolve => { notify = resolve; });
  const cancelling = client(t, { readSource: async (_id, signal) => { notify(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  const operation = cancelling.request('importMemory', await importParams(cancelling, archive));
  await started; assert.equal((await cancelling.request('cancel')).cancelled, true);
  await assert.rejects(operation, { code: 'CANCELLED' });
  assert.equal((await cancelling.request('status')).memories, 0);
});

test('source and destination revisions are checked again after callbacks', async t => {
  const original = forming(t); await memorize(original);
  const { archive } = await original.request('exportMemory');
  let notify, release;
  const started = new Promise(resolve => { notify = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const target = client(t, { readSource: async id => { notify(); await waiting; return source(id); } });
  const operation = target.request('importMemory', await importParams(target, archive));
  await started; await target.request('when', { episodeId: 'concurrent', position: '2005-01-01' }); release();
  await assert.rejects(operation, { code: 'STALE_OPERATION' });
  assert.equal((await target.request('status')).memories, 0);
});

test('preview carries an earlier stale source through later included episodes', async t => {
  let edited = false;
  const readSource = async id => ({ ...source(id), foundation: edited && id === 'first' ? 'Revised foundation.' : 'You are Mara.' });
  const original = forming(t, { readSource });
  await memorize(original, 'first'); await memorize(original, 'second', '2001-01-01');
  await original.request('when', { episodeId: 'unplayed', position: '1999-01-01' });
  edited = true;
  const { archive } = await original.request('exportMemory');
  const restored = client(t, { readSource });
  const preview = await restored.request('previewImport', { archive });
  assert.deepEqual(preview.pendingEpisodes, ['first', 'second']);
  await restored.request('importMemory', { archive, revision: preview.revision, archiveHash: preview.archiveHash });
  const inspection = await restored.request('inspect');
  assert.deepEqual(inspection.episodes.filter(e => e.state === 'stale').map(e => e.episode.id), preview.pendingEpisodes);
});

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function scaleArchive(seed, count) {
  const archive = { ...seed, episodes: [], contributions: [], sources: {}, checksum: '' };
  const previous = [];
  for (let index = 0; index < count; index++) {
    const id = '00000000-0000-0000-0000-' + String(index).padStart(12, '0');
    const at = Date.UTC(2000, 0, 1) + index * 86400000;
    const observation = source(id);
    const sourceHash = fingerprint({ messages: observation.messages, foundation: observation.foundation });
    const contribution = { ...seed.contributions[0], episodeId: id, label: id, start: at, end: at, sourceHash,
      dependencies: [...previous], memories: seed.contributions[0].memories.map(m => ({ ...m, sourceMessageIds: [id + ':u'] })),
      impressions: seed.contributions[0].impressions.map(i => ({ ...i, sourceEpisodeIds: [id] })) };
    // Match the engine's existing ordered-map swap removal, preserving the
    // published state-hash contract rather than redefining it for the fixture.
    const state = Object.entries(contribution);
    for (const key of ['stateHash', 'reuseHash', 'modelKey']) {
      const index = state.findIndex(([name]) => name === key);
      if (index >= 0) { const last = state.pop(); if (index < state.length) state[index] = last; }
    }
    contribution.stateHash = fingerprint(Object.fromEntries(state));
    contribution.dependencies = { prefix: index };
    archive.contributions.push(contribution);
    archive.episodes.push({ ...seed.episodes[0], id, label: id, start: at, now: at, source_hash: sourceHash, published_end: at });
    archive.sources[id] = sourceHash;
    previous.push(id);
  }
  const data = { ...archive }; delete data.checksum;
  archive.checksum = fingerprint(data);
  return archive;
}

test('2,000 UUID episodes round trip compactly while validation remains cancellable and the reader stays available', { timeout: 120000 }, async t => {
  const original = forming(t); await memorize(original);
  const seed = (await original.request('exportMemory')).archive;
  const archive = scaleArchive(seed, 2000);
  // Full dependency IDs alone would require over 64 MiB. Prefixes keep the
  // entire archive small, while state hashes still bind the exact expanded IDs.
  assert.ok(2000 * 1999 / 2 * 39 > 64 * 1024 * 1024);
  const encodedBytes = Buffer.byteLength(JSON.stringify(archive));
  assert.ok(encodedBytes < 5 * 1024 * 1024);
  const restored = client(t);
  for (const method of ['previewImport', 'importMemory']) {
    const outcome = restored.request(method, { archive, revision: 0, archiveHash: archive.checksum }).then(value => ({ value }), error => ({ error }));
    const status = await restored.request('status');
    assert.equal(status.operation.kind, method);
    await assert.rejects(restored.request('importMemory', { archive: null }), { code: 'OPERATION_IN_PROGRESS' });
    await assert.rejects(restored.request('previewImport', { archive: null }), { code: 'OPERATION_IN_PROGRESS' });
    assert.equal((await restored.request('cancel')).cancelled, true);
    assert.equal((await outcome).error.code, 'CANCELLED');
    assert.equal((await restored.request('status')).memories, 0);
  }
  const previewStarted = performance.now();
  const preview = await restored.request('previewImport', { archive });
  t.diagnostic(`2,000 episodes: ${encodedBytes} encoded bytes; preview ${Math.round(performance.now() - previewStarted)} ms.`);
  assert.equal(preview.episodes, 2000); assert.deepEqual(preview.pendingEpisodes, []);
  const imported = await restored.request('importMemory', { archive, revision: preview.revision, archiveHash: preview.archiveHash });
  assert.equal(imported.status, 'imported');
  const exported = await restored.request('exportMemory');
  assert.deepEqual(exported.archive, archive);
  assert.equal((await restored.request('retrieve', { at: '2010-01-01', cue: 'coat' })).memories.length, 6);
});
