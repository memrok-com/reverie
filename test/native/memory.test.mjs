import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { MemoryClient } from '../../.work/pi-test/memory-client.mjs';
import { fingerprint, reflectionRequest } from '../support/reflection.mjs';
import { episodeSource, reflection } from '../fixtures/subjective.mjs';
import { nativeEnginePath } from '../../scripts/lib/native-toolchain.mjs';

const executable = nativeEnginePath('debug');

function fixture(t, { infer = reflection, database = resolve('.work/native-tests', randomUUID() + '.sqlite'), characterId = 'mara', settings } = {}) {
  const sources = new Map();
  const calls = [];
  const live = new Set();
  const f = { sources, calls, database, characterId };
  f.open = () => {
    const client = new MemoryClient({ executable, database, characterId, settings,
      readSource: async id => {
        const source = sources.get(id);
        if (source instanceof Error) throw source;
        if (!source) throw new Error('source unavailable');
        return structuredClone(source);
      },
      infer: async (request, context) => { calls.push({ request, context }); return infer(request, context); },
    });
    live.add(client);
    return client;
  };
  f.client = f.open();
  f.request = (method, params = {}) => f.client.request(method, params);
  f.close = async () => { live.delete(f.client); await f.client.close(); };
  f.restart = async () => { await f.close(); f.client = f.open(); };
  f.episode = async (id, date, label = id) => {
    sources.set(id, episodeSource(id));
    return f.request('when', { episodeId: id, position: date, label });
  };
  f.rows = table => {
    assert.ok(['episodes', 'contributions', 'memories'].includes(table));
    const db = new DatabaseSync(database, { readOnly: true });
    try { return db.prepare('SELECT * FROM ' + table + ' WHERE character_id=?').all(characterId); }
    finally { db.close(); }
  };
  f.contributions = () => f.rows('contributions').map(row => JSON.parse(row.data));
  t.after(async () => { for (const client of live) await client.close(); });
  return f;
}

test('native episode ownership protects placement, retrieval and source access across characters', async t => {
  const database = resolve('.work/native-tests', randomUUID() + '.sqlite');
  const mara = fixture(t, { database });
  const anya = fixture(t, { database, characterId: 'anya' });
  await mara.episode('owned-scene', '2010-01-01');
  for (const [method, params] of [
    ['assertEpisode', { episodeId: 'owned-scene' }],
    ['when', { episodeId: 'owned-scene', position: '2010-01-01' }],
    ['retrieve', { episodeId: 'owned-scene', at: '2020-01-01' }],
    ['memorize', { episodeId: 'owned-scene' }],
  ]) await assert.rejects(anya.request(method, params), { code: method === 'memorize' ? 'EPISODE_TIME_REQUIRED' : 'EPISODE_CHARACTER_MISMATCH' });
  assert.equal(anya.calls.length, 0);
  assert.equal((await anya.request('status')).episodes.length, 0);
});

test('native competing processes cannot claim the same conversation for different characters', async t => {
  const database = resolve('.work/native-tests', randomUUID() + '.sqlite');
  const mara = fixture(t, { database });
  const anya = fixture(t, { database, characterId: 'anya' });
  await mara.request('ping'); await anya.request('ping');
  const results = await Promise.allSettled([mara.episode('same-scene', '2010-01-01'), anya.episode('same-scene', '2010-01-01')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'EPISODE_CHARACTER_MISMATCH');
});

test('native memory persists after restart without a duplicate transcript archive', async t => {
  const f = fixture(t);
  await f.episode('meeting', '2010-01-01', 'our meeting');
  await f.request('memorize', { episodeId: 'meeting' });
  assert.equal((await f.request('ping')).runtime, 'rust');
  const source = f.sources.get('meeting');
  assert.equal((await f.request('status')).episodes[0].source_hash, fingerprint({ messages: source.messages, foundation: source.foundation }));
  const expected = reflectionRequest({ id: 'meeting', label: 'our meeting', start: Date.UTC(2010, 0, 1), now: Date.UTC(2010, 0, 1) }, source, [], { priorMemoryLimit: 64, reflectionMaxTokens: 4096 });
  assert.equal(f.calls[0].request.system, expected.system);
  await f.restart();
  assert.equal((await f.request('retrieve', { at: '2010-01-02', cue: 'lighthouse' })).memories[0].gist, 'I remember our meeting.');
  for (const table of ['episodes', 'contributions', 'memories']) assert.ok(!JSON.stringify(f.rows(table)).includes('PRIVATE_TRANSCRIPT_MARKER_7f55'));
});

test('native origin and earlier points exclude later interpretations as well as events', async t => {
  const f = fixture(t);
  await f.episode('childhood', '2000-01-01', 'a warm childhood');
  await f.episode('betrayal', '2020-01-01', 'betrayal');
  await f.request('memorize', { episodeId: 'childhood' });
  await f.request('memorize', { episodeId: 'betrayal' });
  const before = await f.request('retrieve', { at: '2010-01-01', cue: 'abandonment lighthouse' });
  assert.deepEqual(before.memories.map(item => item.episodeId), ['childhood']);
  assert.ok(!before.text.includes('distrust'));
  assert.equal((await f.request('retrieve', { at: '1990-01-01' })).text, '');
});

test('native retroactive earlier play rebuilds later contributions in canonical order', async t => {
  const f = fixture(t);
  await f.episode('reunion', '2020-01-01');
  await f.request('memorize', { episodeId: 'reunion' });
  await f.episode('betrayal', '2005-01-01');
  assert.equal((await f.request('memorize', { episodeId: 'betrayal' })).reflected, 2);
  assert.deepEqual(f.calls.slice(-2).map(item => item.context.episodeId), ['betrayal', 'reunion']);
  assert.deepEqual(f.calls.at(-2).request.input.earlierRecollections, []);
  assert.deepEqual(f.contributions().find(item => item.episodeId === 'reunion').dependencies, ['betrayal']);
  assert.ok((await f.request('retrieve', { at: '2021-01-01' })).text.includes('distrust'));
});

test('native continued play replaces once, while unchanged memorization calls no model', async t => {
  const f = fixture(t);
  await f.episode('meeting', '2010-01-01');
  await f.request('memorize', { episodeId: 'meeting' });
  const count = f.calls.length;
  assert.equal((await f.request('memorize', { episodeId: 'meeting' })).status, 'current');
  assert.equal(f.calls.length, count);
  f.sources.get('meeting').messages.push({ id: 'meeting:later', role: 'user', text: 'We stay until dawn.' });
  await f.request('when', { episodeId: 'meeting', position: '2010-01-02' });
  assert.equal((await f.request('memorize', { episodeId: 'meeting' })).reflected, 1);
  assert.equal(f.contributions().length, 1);
  assert.equal((await f.request('status')).memories, 1);
  assert.equal(f.calls.at(-1).request.input.episode.messages.length, 3);
  assert.deepEqual(f.calls.at(-1).request.input.earlierRecollections, []);
  assert.equal((await f.request('retrieve', { episodeId: 'meeting', at: '2010-01-02' })).text, '');
});

test('native source edits refresh dependent later reflection', async t => {
  const f = fixture(t);
  await f.episode('first', '2010-01-01');
  await f.episode('later', '2015-01-01');
  await f.request('memorize', { episodeId: 'first' });
  await f.request('memorize', { episodeId: 'later' });
  const before = f.calls.length;
  f.sources.get('first').messages[0].text = 'The lantern is red in the corrected source.';
  assert.equal((await f.request('rebuild', { force: false })).reflected, 2);
  assert.equal(f.calls.length, before + 2);
});

test('native withdrawal preserves source and stays excluded from rebuilding', async t => {
  const f = fixture(t);
  await f.episode('betrayal', '2010-01-01');
  await f.episode('reunion', '2020-01-01');
  await f.request('memorize', { episodeId: 'betrayal' });
  await f.request('memorize', { episodeId: 'reunion' });
  assert.ok((await f.request('retrieve', { at: '2021-01-01' })).text.includes('distrust'));
  await f.request('unmemorize', { episodeId: 'betrayal' });
  await f.request('rebuild');
  assert.ok(!(await f.request('retrieve', { at: '2021-01-01' })).text.includes('distrust'));
  assert.deepEqual(f.contributions().map(item => item.episodeId), ['reunion']);
  assert.ok((await f.request('status')).episodes.some(item => item.id === 'betrayal'));
  assert.ok(f.sources.has('betrayal'));
  await f.request('memorize', { episodeId: 'betrayal' });
  assert.equal(f.contributions().length, 2);
});

test('native explicit deletion differs from temporarily unavailable source', async t => {
  const f = fixture(t);
  await f.episode('meeting', '2010-01-01');
  await f.request('memorize', { episodeId: 'meeting' });
  const before = f.contributions();
  f.sources.set('meeting', new Error('Storage temporarily unavailable'));
  await assert.rejects(f.request('rebuild'), /temporarily unavailable/);
  assert.deepEqual(f.contributions(), before);
  f.sources.set('meeting', { deleted: true });
  await f.request('rebuild');
  const status = await f.request('status');
  assert.equal(status.memories, 0);
  assert.equal(status.episodes.length, 0);
});

test('native model failure retains the last published state and inclusion', async t => {
  let fail = false;
  const f = fixture(t, { infer: request => { if (fail) throw new Error('Model unavailable'); return reflection(request); } });
  await f.episode('first', '2010-01-01');
  await f.episode('new', '2012-01-01');
  await f.request('memorize', { episodeId: 'first' });
  const before = f.contributions();
  fail = true;
  await assert.rejects(f.request('memorize', { episodeId: 'new' }), /Model unavailable/);
  assert.deepEqual(f.contributions(), before);
  const status = await f.request('status');
  assert.equal(status.episodes.find(item => item.id === 'new').included, false);
  assert.equal(status.operation, null);
});

test('native source revision changes during inference reject stale replacement', async t => {
  let change = false;
  const f = fixture(t, { infer: request => {
    if (change) f.sources.get('first').messages[0].text += ' More play arrived.';
    return reflection(request);
  } });
  await f.episode('first', '2010-01-01');
  await f.request('memorize', { episodeId: 'first' });
  const before = f.contributions();
  change = true;
  await assert.rejects(f.request('rebuild', { force: true }), { code: 'STALE_SOURCE' });
  assert.deepEqual(f.contributions(), before);
});

test('native cancellation and busy checks preserve memory while recall remains available', async t => {
  let hold = false;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { infer: async (request, { signal }) => {
    if (hold) { started(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    return reflection(request);
  } });
  await f.episode('first', '2010-01-01');
  await f.request('memorize', { episodeId: 'first' });
  const before = f.contributions();
  hold = true;
  const pending = f.request('rebuild', { force: true });
  const failure = assert.rejects(pending, { code: 'CANCELLED' });
  await ready;
  await assert.rejects(f.request('rebuild'), { code: 'OPERATION_IN_PROGRESS' });
  assert.ok((await f.request('retrieve', { at: '2011-01-01' })).text.includes('first'));
  assert.ok((await f.request('status')).operation);
  assert.equal((await f.request('cancel')).cancelled, true);
  await failure;
  assert.deepEqual(f.contributions(), before);
});

test('placement previews validate complete intervals without changing chronology or revision', async t => {
  const f = fixture(t);
  await f.episode('first', '2000-01-01');
  await f.request('when', { episodeId: 'first', position: '2010-01-01' });
  const before = await f.request('status');
  const preview = await f.request('when', { episodeId: 'preview', position: '2015-01-01', label: 'In between', preview: true });
  assert.equal(preview.start, Date.UTC(2015, 0, 1));
  assert.deepEqual(await f.request('status'), before);
  await assert.rejects(f.request('when', { episodeId: 'overlap', position: '2005-01-01', preview: true }), { code: 'INTERLEAVING_EPISODES' });
  assert.deepEqual(await f.request('status'), before);
});

test('native date corrections replace both endpoints, persist and still enforce valid episode slots', async t => {
  const f = fixture(t);
  await f.episode('played', '2010-01-01');
  await f.request('when', { episodeId: 'played', position: '2010-01-03' });
  await f.request('when', { episodeId: 'draft', position: '2020-01-01', label: 'Mistyped' });
  for (const position of ['2015-01-01', '2030-01-01', '2012-01-01']) {
    const episode = await f.request('when', { episodeId: 'draft', position, resetStart: true });
    assert.equal(episode.start, Date.parse(position));
    assert.equal(episode.now, episode.start);
    assert.equal(episode.label, 'Mistyped');
  }
  await f.restart();
  const before = await f.request('when', { episodeId: 'draft' });
  assert.equal(before.start, Date.parse('2012-01-01'));
  await assert.rejects(f.request('when', { episodeId: 'draft', position: '2010-01-02', resetStart: true }), { code: 'INTERLEAVING_EPISODES' });
  await assert.rejects(f.request('when', { episodeId: 'draft', position: '2012-02-30', resetStart: true }), { code: 'INVALID_TIME' });
  assert.deepEqual(await f.request('when', { episodeId: 'draft' }), before);
  await assert.rejects(f.request('when', { episodeId: 'draft', position: '2011-01-01' }), { code: 'BACKWARD_TIME_JUMP' });
  assert.equal(f.calls.length, 0);
});

test('native time changes enforce episode slots and invalidate in-flight work', async t => {
  const f = fixture(t, { infer: async request => {
    await f.request('when', { episodeId: 'first', position: '2010-01-03' });
    return reflection(request);
  } });
  await f.episode('first', '2010-01-01');
  await f.episode('later', '2011-01-01');
  await f.request('when', { episodeId: 'first', position: '2010-01-02' });
  await assert.rejects(f.request('when', { episodeId: 'first', position: '2012-01-01' }), { code: 'INTERLEAVING_EPISODES' });
  await assert.rejects(f.request('when', { episodeId: 'first', position: '2009-01-01' }), { code: 'BACKWARD_TIME_JUMP' });
  await assert.rejects(f.request('memorize', { episodeId: 'first' }), { code: 'STALE_OPERATION' });
  assert.equal(f.contributions().length, 0);
});

test('native processes sharing a database isolate characters across reflection and recall', async t => {
  const mara = fixture(t);
  await mara.episode('secret', '2010-01-01', 'a secret belonging to Mara');
  await mara.request('memorize', { episodeId: 'secret' });
  const anya = fixture(t, { database: mara.database, characterId: 'anya' });
  await anya.episode('other', '2020-01-01', 'a different life');
  await anya.request('memorize', { episodeId: 'other' });
  assert.ok(!(await anya.request('retrieve', { at: '2021-01-01', cue: 'secret Mara' })).text.includes('secret belonging to Mara'));
  assert.deepEqual(anya.calls.at(-1).request.input.earlierRecollections, []);
  await assert.rejects(anya.request('rebuild', { characterId: 'mara' }), { code: 'CHARACTER_MISMATCH' });
});

test('native temporal projection fades detail while preserving gist, emotion and years', async t => {
  const f = fixture(t);
  await f.episode('first', '2000-01-01', 'the lighthouse meeting');
  await f.request('memorize', { episodeId: 'first' });
  const fresh = await f.request('retrieve', { at: '2000-01-02', cue: 'lantern' });
  const old = await f.request('retrieve', { at: '2020-01-01', cue: 'lantern' });
  assert.ok(fresh.text.includes('blue lantern'));
  assert.ok(!old.text.includes('blue lantern'));
  assert.ok(old.text.includes('lighthouse meeting') && old.text.includes('unsettled'));
  assert.match(old.sharedHistory, /about 20 years/);
  assert.deepEqual(old.historySources, ['first']);
});

test('native malformed output and unsupported citations fail without publication', async t => {
  let malformed = true;
  const f = fixture(t, { infer: request => {
    if (malformed) return { memories: [null], impressions: [] };
    const value = reflection(request); value.memories[0].sourceMessageIds = ['future:secret']; return value;
  } });
  await f.episode('first', '2010-01-01');
  await assert.rejects(f.request('memorize', { episodeId: 'first' }), { code: 'INVALID_REFLECTION' });
  malformed = false;
  await assert.rejects(f.request('memorize', { episodeId: 'first' }), { code: 'INVALID_REFLECTION' });
  assert.equal((await f.request('status')).memories, 0);
  assert.equal(f.calls.length, 6);
});

test('native bounded correction resolves short references to canonical source identities', async t => {
  let attempt = 0;
  const f = fixture(t, { infer: request => {
    const value = reflection(request);
    if (attempt++ === 0) value.memories[0].sourceMessageIds = ['not-in-this-episode'];
    return JSON.stringify(value);
  } });
  await f.episode('first', '2010-01-01');
  await f.request('memorize', { episodeId: 'first' });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.contributions()[0].memories[0].sourceMessageIds, ['first:user']);
});

test('native cue retrieval finds low-salience memory without reflection', async t => {
  const f = fixture(t, { settings: { topK: 2 }, infer: request => {
    const value = reflection(request);
    const lighthouse = request.input.episode.label === 'lighthouse';
    value.memories[0].gist = lighthouse ? 'I remember the lighthouse.' : 'I remember a market conversation.';
    value.memories[0].detail = '';
    value.memories[0].cues = lighthouse ? ['lighthouse'] : ['market'];
    value.memories[0].salience = lighthouse ? 0.01 : 1;
    return value;
  } });
  await f.episode('lighthouse', '2000-01-01');
  await f.request('memorize', { episodeId: 'lighthouse' });
  for (let index = 2; index < 12; index++) {
    const id = 'market-' + index;
    await f.episode(id, '2000-01-' + String(index).padStart(2, '0'));
    await f.request('memorize', { episodeId: id });
  }
  const count = f.calls.length;
  assert.ok(!(await f.request('retrieve', { at: '2020-01-01', cue: 'our travel plans' })).memories.some(item => item.episodeId === 'lighthouse'));
  assert.equal((await f.request('retrieve', { at: '2020-01-01', cue: 'I point toward the lighthouse.' })).memories[0].episodeId, 'lighthouse');
  assert.equal(f.calls.length, count);
});

test('native adjacent episode boundaries do not leak later experience into continued earlier play', async t => {
  const f = fixture(t);
  await f.episode('first', '2010-01-01');
  await f.request('when', { episodeId: 'first', position: '2011-01-01' });
  await f.request('memorize', { episodeId: 'first' });
  await f.episode('betrayal', '2011-01-01');
  await f.request('memorize', { episodeId: 'betrayal' });
  const earlier = await f.request('retrieve', { episodeId: 'first', at: '2011-01-01', cue: 'betrayal' });
  assert.equal(earlier.text, '');
  assert.deepEqual(earlier.impressions, []);
  assert.deepEqual(earlier.historySources, []);
});

test('native cancellation immediately after queuing cannot miss the operation', async t => {
  const f = fixture(t);
  await f.episode('first', '2010-01-01');
  const operation = f.request('memorize', { episodeId: 'first' });
  const failure = assert.rejects(operation, { code: 'CANCELLED' });
  assert.equal((await f.request('cancel')).cancelled, true);
  await failure;
  assert.equal((await f.request('status')).memories, 0);
});

test('native disconnect aborts reflection and closes the executable cleanly', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { infer: async (request, { signal }) => {
    started();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  await f.episode('first', '2010-01-01');
  const failure = assert.rejects(f.request('memorize', { episodeId: 'first' }), { code: 'CANCELLED' });
  await ready;
  await f.close();
  await failure;
  assert.equal(f.client.child.exitCode, 0);
  assert.equal(f.rows('memories').length, 0);
});

test('complete inspection is independent of cue, budgets, fading and fictional eligibility', async t => {
  const f = fixture(t, { settings: { topK: 1, memoryBudget: 512 }, infer: request => {
    const value = reflection(request);
    value.memories = Array.from({ length: 12 }, (_, index) => ({ ...value.memories[0], gist: `Unique recollection ${index}`, detail: `Full stored detail ${index}` }));
    return value;
  } });
  await f.episode('first', '2000-01-01'); await f.request('memorize', { episodeId: 'first' });
  await f.episode('future', '2020-01-01'); await f.request('memorize', { episodeId: 'future' });
  const before = await f.request('status'), calls = f.calls.length;
  const inspection = await f.request('inspect', { activeEpisodeId: 'first', at: '2000-01-01' });
  assert.equal(inspection.episodes.length, 2);
  for (const item of inspection.episodes) {
    assert.equal(item.contribution.memories.length, 12);
    assert.equal(item.contribution.memories.at(-1).detail, 'Full stored detail 11');
    assert.equal(item.eligible, false);
    assert.deepEqual(item.sources.map(message => message.role), ['user', 'assistant']);
    assert.equal(item.sources[0].id, item.contribution.memories[0].sourceMessageIds[0]);
    assert.ok(item.sources[0].text.includes('PRIVATE_TRANSCRIPT_MARKER'));
  }
  assert.equal(f.calls.length, calls);
  assert.deepEqual(await f.request('status'), before);
  assert.equal((await f.request('retrieve', { episodeId: 'first', at: '2000-01-01' })).text, '');
  const eligible = await f.request('inspect', { at: '2010-01-01' });
  assert.deepEqual(eligible.episodes.map(item => item.eligible), [true, false]);
  assert.deepEqual(eligible.episodes.map(item => item.impressionsEligible), [true, false]);
});

test('inspection distinguishes empty, not memorized, stale, unavailable and invalidated contributions', async t => {
  const f = fixture(t, { infer: request => request.input.episode.label === 'empty' ? { memories: [], impressions: [] } : reflection(request) });
  await f.episode('empty', '2000-01-01'); await f.request('memorize', { episodeId: 'empty' });
  await f.episode('draft', '2001-01-01');
  await f.episode('later', '2010-01-01'); await f.request('memorize', { episodeId: 'later' });
  let inspection = await f.request('inspect');
  assert.deepEqual(inspection.episodes.map(item => item.state), ['empty', 'not-memorized', 'published']);
  f.sources.get('empty').messages[0].text += ' A new action.';
  inspection = await f.request('inspect');
  assert.equal(inspection.episodes[0].state, 'stale');
  assert.equal(inspection.episodes[2].state, 'stale');
  f.sources.set('empty', new Error('Temporarily offline'));
  inspection = await f.request('inspect');
  assert.equal(inspection.episodes[0].freshness, 'unavailable');
  assert.match(inspection.episodes[0].sourceError, /Temporarily offline/);
  await f.request('forget', { episodeId: 'empty' });
  inspection = await f.request('inspect');
  assert.equal(inspection.episodes.find(item => item.episode.id === 'later').state, 'invalidated');
});

async function correctionPreview(f, id, changes = {}, extra = {}) {
  const inspection = await f.request('inspect');
  const item = inspection.episodes.find(item => item.episode.id === id);
  return f.request('previewCorrection', { episodeId: id, revision: inspection.revision, memoryIndex: 0,
    replacement: { ...item.contribution.memories[0], gist: 'The companion carried the lantern; the player spoke.', ...changes }, ...extra });
}

test('model and thinking changes preserve earlier samples and reviewed corrections across restart', async t => {
  let sample = 0;
  const f = fixture(t, { infer: request => {
    const result = reflection(request); result.memories[0].detail += ` sample ${++sample}`; return result;
  } });
  const low = JSON.stringify({ provider: 'p', model: 'm', thinking: 'low' });
  for (const [id, date] of [['first', '2000-01-01'], ['corrected', '2010-01-01']]) {
    await f.episode(id, date); await f.request('memorize', { episodeId: id, modelKey: low });
  }
  const preview = await correctionPreview(f, 'corrected');
  await f.request('applyCorrection', { token: preview.token });
  await f.request('rebuild', { modelKey: low });
  const before = f.contributions(), calls = f.calls.length;
  await f.restart();
  const medium = JSON.stringify({ provider: 'p', model: 'm', thinking: 'medium' });
  await f.episode('new', '2020-01-01');
  assert.equal((await f.request('memorize', { episodeId: 'new', modelKey: medium })).reflected, 1);
  assert.equal(f.calls.length, calls + 1);
  assert.deepEqual(f.contributions().slice(0, 2), before);
  assert.equal(f.contributions()[2].modelKey, medium);
  const other = JSON.stringify({ provider: 'other', model: 'other', thinking: 'high' });
  assert.equal((await f.request('rebuild', { modelKey: other })).status, 'current');
  assert.equal((await f.request('memorize', { episodeId: 'corrected', modelKey: other })).status, 'current');
  assert.equal(f.calls.length, calls + 1);
});

test('changed source refreshes only its contribution and dependents using the new model; forced rebuild remains explicit', async t => {
  const f = fixture(t);
  for (const [id, date] of [['first', '2000-01-01'], ['middle', '2010-01-01'], ['last', '2020-01-01']]) {
    await f.episode(id, date); await f.request('memorize', { episodeId: id, modelKey: 'old' });
  }
  const first = f.contributions()[0], calls = f.calls.length;
  f.sources.get('middle').messages[0].text += ' A real new experience.';
  assert.equal((await f.request('memorize', { episodeId: 'middle', modelKey: 'new' })).reflected, 2);
  assert.deepEqual(f.contributions()[0], first);
  assert.deepEqual(f.calls.slice(calls).map(item => [item.context.episodeId, item.context.modelKey]), [['middle', 'new'], ['last', 'new']]);
  assert.equal((await f.request('rebuild', { force: true, modelKey: 'explicit' })).reflected, 3);
  assert.ok(f.contributions().every(item => item.modelKey === 'explicit'));
});

test('legacy contributions acquire independent validation without resampling or changing correction prefixes', async t => {
  const f = fixture(t);
  for (const [id, date] of [['first', '2000-01-01'], ['corrected', '2010-01-01']]) {
    await f.episode(id, date); await f.request('memorize', { episodeId: id, modelKey: 'old' });
  }
  const preview = await correctionPreview(f, 'corrected');
  await f.request('applyCorrection', { token: preview.token });
  await f.request('rebuild', { modelKey: 'old' });
  const before = f.contributions(), calls = f.calls.length;
  await f.close();
  const db = new DatabaseSync(f.database);
  try {
    for (const original of before) {
      const item = { ...original }; delete item.reuseHash; delete item.modelKey;
      db.prepare('UPDATE contributions SET data=? WHERE character_id=? AND episode_id=?').run(JSON.stringify(item), f.characterId, item.episodeId);
    }
  } finally { db.close(); }
  f.client = f.open();
  assert.equal((await f.request('rebuild', { modelKey: 'old' })).reflected, 0);
  assert.deepEqual(f.contributions(), before);
  await f.restart();
  assert.equal((await f.request('rebuild', { modelKey: 'new' })).status, 'current');
  assert.equal(f.calls.length, calls);
});

test('legacy contributions with an unknown original model are conservatively refreshed', async t => {
  const f = fixture(t);
  await f.episode('legacy', '2000-01-01'); await f.request('memorize', { episodeId: 'legacy', modelKey: 'old' });
  const item = f.contributions()[0]; delete item.reuseHash; delete item.modelKey;
  await f.close();
  const db = new DatabaseSync(f.database);
  try { db.prepare('UPDATE contributions SET data=?').run(JSON.stringify(item)); } finally { db.close(); }
  f.client = f.open();
  assert.equal((await f.request('rebuild', { modelKey: 'new' })).reflected, 1);
  assert.equal(f.contributions()[0].modelKey, 'new');
});

test('repair rebuild preserves a later correction without resampling unchanged earlier memory', async t => {
  let sample = 0;
  const f = fixture(t, { infer: request => {
    const result = reflection(request); result.memories[0].detail += ` (sample ${++sample})`; return result;
  } });
  for (const [id, date] of [['first', '2000-01-01'], ['corrected', '2010-01-01'], ['later', '2020-01-01']]) {
    await f.episode(id, date); await f.request('memorize', { episodeId: id });
  }
  const first = f.contributions()[0];
  const preview = await correctionPreview(f, 'corrected');
  await f.request('applyCorrection', { token: preview.token });
  await f.restart();
  const calls = f.calls.length;
  assert.equal((await f.request('rebuild')).reflected, 2);
  assert.deepEqual(f.calls.slice(calls).map(item => item.context.episodeId), ['corrected', 'later']);
  assert.deepEqual(f.contributions()[0], first);
  assert.deepEqual(f.contributions()[1].memories, preview.after.memories);
  assert.equal(f.contributions()[1].impressions.length, 1);
  assert.deepEqual(f.calls.at(-1).request.input.earlierRecollections[1].gist, preview.after.memories[0].gist);
  assert.equal((await f.request('rebuild')).status, 'current');
  assert.equal(f.calls.length, calls + 2);

  const published = f.contributions();
  await assert.rejects(f.request('rebuild', { force: true }), { code: 'CORRECTION_DEPENDENCIES_CHANGED' });
  assert.deepEqual(f.contributions(), published);
});

test('reviewed correction is atomic, preserves played source and survives restart and forced rebuilding', async t => {
  const f = fixture(t);
  await f.episode('first', '2000-01-01'); await f.request('memorize', { episodeId: 'first' });
  await f.episode('later', '2010-01-01'); await f.request('memorize', { episodeId: 'later' });
  const source = structuredClone(f.sources.get('first')), original = f.contributions(), calls = f.calls.length;
  const preview = await correctionPreview(f, 'first', { sourceMessageIds: ['first:assistant'] });
  assert.deepEqual(preview.affected.map(item => item.episodeId), ['later']);
  assert.equal(preview.before.impressions.length, 1);
  assert.deepEqual(f.contributions(), original);
  await f.request('applyCorrection', { token: preview.token });
  assert.equal(f.calls.length, calls);
  assert.deepEqual(f.sources.get('first'), source);
  assert.equal(f.contributions().length, 1);
  assert.deepEqual(f.contributions()[0].impressions, []);
  assert.equal((await f.request('inspect')).episodes[1].state, 'invalidated');
  assert.equal((await f.request('retrieve', { at: '1999-01-01' })).text, '');
  assert.equal((await f.request('retrieve', { episodeId: 'first', at: '2000-01-01' })).text, '');
  await f.restart();
  await f.request('rebuild', { force: true });
  assert.equal(f.contributions()[0].memories[0].gist, preview.after.memories[0].gist);
  assert.deepEqual(f.contributions()[0].memories[0].sourceMessageIds, ['first:assistant']);
  assert.equal(f.calls.at(-2).request.input.reviewedRecollections.memories[0].gist, preview.after.memories[0].gist);
  assert.equal(f.calls.at(-1).request.input.earlierRecollections[0].gist, preview.after.memories[0].gist);
  const second = await correctionPreview(f, 'first', { detail: 'He, not I, spoke.' });
  await f.request('applyCorrection', { token: second.token });
  await f.request('unmemorize', { episodeId: 'first' });
  await f.request('memorize', { episodeId: 'first' });
  assert.equal(f.contributions()[0].memories[0].detail, 'He, not I, spoke.');
  assert.equal(f.contributions()[0].memories[0].feeling, original[0].memories[0].feeling);
});

test('correction preview rejects stale revisions, changed source, unsupported provenance and cross-character access', async t => {
  const f = fixture(t);
  await f.episode('first', '2000-01-01'); await f.request('memorize', { episodeId: 'first' });
  await assert.rejects(correctionPreview(f, 'first', { sourceMessageIds: ['future:secret'] }), { code: 'INVALID_REFLECTION' });
  const preview = await correctionPreview(f, 'first');
  f.sources.get('first').messages[0].text += ' Continued play.';
  await assert.rejects(f.request('applyCorrection', { token: preview.token }), { code: 'STALE_SOURCE' });
  await f.request('memorize', { episodeId: 'first' });
  const next = await correctionPreview(f, 'first');
  await f.episode('another', '2001-01-01');
  await assert.rejects(f.request('applyCorrection', { token: next.token }), { code: 'STALE_OPERATION' });
  const other = fixture(t, { database: f.database, characterId: 'anya' });
  assert.deepEqual((await other.request('inspect')).episodes, []);
  await assert.rejects(other.request('inspect', { activeEpisodeId: 'first' }), { code: 'EPISODE_CHARACTER_MISMATCH' });
  await assert.rejects(other.request('previewCorrection', { episodeId: 'first', revision: 0 }), { code: 'EPISODE_CHARACTER_MISMATCH' });
  await assert.rejects(other.request('applyCorrection', { token: next.token }), { code: 'STALE_OPERATION' });
});

test('changed source blocks a durable correction until its release is previewed and applied', async t => {
  const f = fixture(t);
  await f.episode('first', '2000-01-01'); await f.request('memorize', { episodeId: 'first' });
  const preview = await correctionPreview(f, 'first'); await f.request('applyCorrection', { token: preview.token });
  await f.restart();
  f.sources.get('first').messages[0].text += ' More play.';
  await assert.rejects(f.request('rebuild'), { code: 'CORRECTION_SOURCE_CHANGED' });
  const inspection = await f.request('inspect');
  assert.equal(inspection.episodes[0].correctionStale, true);
  const release = await f.request('previewCorrection', { episodeId: 'first', revision: inspection.revision, release: true });
  assert.ok((await f.request('inspect')).episodes[0].correction);
  await f.request('applyCorrection', { token: release.token });
  assert.equal((await f.request('inspect')).episodes[0].state, 'invalidated');
  await f.request('rebuild');
  assert.equal((await f.request('inspect')).episodes[0].correction, null);
});

test('corrections cannot preserve an obsolete prefix after earlier memory changes or deletion', async t => {
  const f = fixture(t);
  await f.episode('first', '2000-01-01'); await f.request('memorize', { episodeId: 'first' });
  await f.episode('later', '2010-01-01'); await f.request('memorize', { episodeId: 'later' });
  const preview = await correctionPreview(f, 'later'); await f.request('applyCorrection', { token: preview.token });
  const before = f.contributions();
  f.sources.get('first').messages[0].text += ' Changed past.';
  await assert.rejects(f.request('rebuild'), { code: 'CORRECTION_DEPENDENCIES_CHANGED' });
  assert.deepEqual(f.contributions(), before);
  await f.request('forget', { episodeId: 'first' });
  assert.equal((await f.request('inspect')).episodes[0].correction, null);
  await f.request('rebuild');
  assert.equal(f.contributions()[0].episodeId, 'later');
});

test('correcting an adjacent later episode preserves earlier memory at their shared endpoint', async t => {
  const f = fixture(t);
  await f.episode('first', '2000-01-01'); await f.request('when', { episodeId: 'first', position: '2010-01-01' });
  await f.request('memorize', { episodeId: 'first' });
  await f.episode('later', '2010-01-01'); await f.request('memorize', { episodeId: 'later' });
  const first = f.contributions()[0];
  const preview = await correctionPreview(f, 'later'); await f.request('applyCorrection', { token: preview.token });
  assert.deepEqual(f.contributions()[0], first);
  assert.equal((await f.request('status')).memories, 2);
  await f.request('unmemorize', { episodeId: 'later' });
  const inspection = await f.request('inspect');
  await assert.rejects(f.request('previewCorrection', { episodeId: 'later', revision: inspection.revision,
    memoryIndex: 0, replacement: preview.after.memories[0] }), { code: 'INVALID_INPUT' });
  assert.equal((await f.request('retrieve', { at: '2020-01-01' })).memories.length, 1);
});

test('deleting an adjacent later episode preserves earlier memory and its reviewed correction', async t => {
  const f = fixture(t);
  await f.episode('first', '2000-01-01');
  await f.request('when', { episodeId: 'first', position: '2010-01-01' });
  await f.request('memorize', { episodeId: 'first' });
  const preview = await correctionPreview(f, 'first');
  await f.request('applyCorrection', { token: preview.token });
  await f.request('rebuild');
  await f.episode('deleted', '2010-01-01');
  await f.request('memorize', { episodeId: 'deleted' });
  await f.episode('later', '2020-01-01');
  await f.request('memorize', { episodeId: 'later' });
  const laterCorrection = await correctionPreview(f, 'later');
  await f.request('applyCorrection', { token: laterCorrection.token });
  const first = (await f.request('inspect')).episodes[0];
  const calls = f.calls.length;

  assert.equal((await f.request('forget', { episodeId: 'deleted' })).invalidatedEpisodes, 2);
  assert.equal(f.calls.length, calls);
  await f.restart();
  const inspection = await f.request('inspect');
  assert.deepEqual(inspection.episodes.map(item => item.episode.id), ['first', 'later']);
  assert.deepEqual(inspection.episodes[0], first);
  assert.equal(inspection.episodes[1].state, 'invalidated');
  assert.equal(inspection.episodes[1].episode.included, true);
  assert.equal(inspection.episodes[1].correction, null);
  assert.deepEqual((await f.request('retrieve', { at: '2030-01-01' })).memories.map(item => item.episodeId), ['first']);
  assert.equal((await f.request('forget', { episodeId: 'deleted' })).invalidatedEpisodes, 0);
  await f.request('rebuild', { force: false });
  assert.deepEqual(f.contributions()[0], first.contribution);
  assert.deepEqual(f.contributions().map(item => item.episodeId), ['first', 'later']);
});

test('deleting a never-memorized draft preserves later published memory and corrections', async t => {
  const f = fixture(t);
  await f.episode('draft', '2000-01-01'); await f.episode('later', '2010-01-01');
  await f.request('memorize', { episodeId: 'later' });
  const preview = await correctionPreview(f, 'later'); await f.request('applyCorrection', { token: preview.token });
  const before = (await f.request('inspect')).episodes[1], calls = f.calls.length;
  assert.equal((await f.request('forget', { episodeId: 'draft' })).invalidatedEpisodes, 0);
  await f.restart();
  assert.deepEqual((await f.request('inspect')).episodes, [before]);
  assert.equal(f.calls.length, calls);
});

test('deletion selects memories and contributions by the same published starts after direct date drift', async t => {
  const f = fixture(t);
  await f.episode('mid', '2010-01-01'); await f.request('memorize', { episodeId: 'mid' });
  await f.episode('moved', '2020-01-01'); await f.request('memorize', { episodeId: 'moved' });
  await f.request('when', { episodeId: 'moved', position: '2000-01-01', resetStart: true });
  assert.equal((await f.request('forget', { episodeId: 'mid' })).invalidatedEpisodes, 2);
  assert.equal(f.contributions().length, 0);
  assert.equal((await f.request('retrieve', { at: '2040-01-01' })).memories.length, 0);
});

test('deleting a source moved later removes dependents formed in its original slot', async t => {
  const f = fixture(t);
  await f.episode('gone', '2000-01-01'); await f.request('memorize', { episodeId: 'gone' });
  await f.episode('dependent', '2010-01-01'); await f.request('memorize', { episodeId: 'dependent' });
  const preview = await correctionPreview(f, 'dependent'); await f.request('applyCorrection', { token: preview.token });
  await f.request('when', { episodeId: 'gone', position: '2030-01-01', resetStart: true });
  assert.equal((await f.request('forget', { episodeId: 'gone' })).invalidatedEpisodes, 2);
  assert.equal(f.contributions().length, 0);
  assert.equal((await f.request('inspect')).episodes[0].correction, null);
  assert.equal((await f.request('retrieve', { at: '2040-01-01' })).memories.length, 0);
});

test('v1 databases migrate without changing existing published memory', async t => {
  const f = fixture(t);
  await f.episode('first', '2000-01-01'); await f.request('memorize', { episodeId: 'first' });
  const original = f.contributions(); await f.close();
  const db = new DatabaseSync(f.database);
  try { db.exec('DROP TABLE corrections; PRAGMA user_version=1;'); } finally { db.close(); }
  f.client = f.open();
  assert.deepEqual((await f.request('inspect')).episodes[0].contribution, original[0]);
  const preview = await correctionPreview(f, 'first'); await f.request('applyCorrection', { token: preview.token });
  await f.restart(); assert.ok((await f.request('inspect')).episodes[0].correction);
});
