import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { MemoryClient } from '../../.work/pi-test/memory-client.mjs';
import { fingerprint, reflectionRequest } from '../support/reflection.mjs';
import { episodeSource, reflection } from '../fixtures/subjective.mjs';

const executable = resolve(process.env.REVERIE_TEST_ENGINE ?? 'engine/target/x86_64-pc-windows-gnu/debug/reverie-engine.exe');

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
  await assert.rejects(f.request('rebuild'), { code: 'STALE_SOURCE' });
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
  const pending = f.request('rebuild');
  const failure = assert.rejects(pending, { code: 'CANCELLED' });
  await ready;
  await assert.rejects(f.request('rebuild'), { code: 'OPERATION_IN_PROGRESS' });
  assert.ok((await f.request('retrieve', { at: '2011-01-01' })).text.includes('first'));
  assert.ok((await f.request('status')).operation);
  assert.equal((await f.request('cancel')).cancelled, true);
  await failure;
  assert.deepEqual(f.contributions(), before);
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
