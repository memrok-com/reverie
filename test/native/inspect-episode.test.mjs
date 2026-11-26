import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryClient } from '../support/memory-client.mjs';
import { nativeEnginePath } from '../../scripts/lib/native-toolchain.mjs';

// Authored saved data, independent of reflection/rebuild and any real host data.
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'reverie-inspect-episode-'));
  const database = join(directory, 'synthetic.sqlite');
  const source = { messages: [{ id: 'target:u', role: 'user', text: 'SOURCE_ONLY_SENTINEL' }], foundation: 'Synthetic Mara' };
  const sourceHash = createHash('sha256').update(JSON.stringify(source)).digest('hex');
  const memories = [0, 1].map(i => ({ gist: `Saved gist ${i}`, detail: `Saved detail ${i}`, feeling: 'Hopeful', confidence: 0.7,
    cues: ['PRIVATE_CUE'], salience: 0.8, sourceMessageIds: ['PRIVATE_SOURCE_ID'] }));
  const db = new DatabaseSync(database);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(readFileSync(new URL('../../engine/resources/schema.sql', import.meta.url), 'utf8'));
  db.exec('ALTER TABLE episodes ADD COLUMN time_offset INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=3;');
  db.exec("INSERT INTO characters VALUES('mara',17),('other',9)");
  const episode = db.prepare('INSERT INTO episodes(character_id,id,label,start,now,included,source_hash,input_hash,published_end) VALUES(?,?,?,?,?,?,?,?,?)');
  const contribution = db.prepare('INSERT INTO contributions VALUES(?,?,?,?,?,?,?)');
  const memory = db.prepare('INSERT INTO memories(character_id,episode_id,available_at,gist,detail,feeling,cues,salience,confidence,source_ids) VALUES(?,?,?,?,?,?,?,?,?,?)');
  for (const [character, id, included, saved] of [
    ['mara', 'target', 1, true], ['mara', 'empty', 1, true], ['mara', 'invalidated', 1, false],
    ['mara', 'excluded', 0, true], ['mara', 'other-episode', 1, true], ['other', 'foreign', 1, true],
  ]) {
    episode.run(character, id, id, 100, 200, included, saved ? sourceHash : null, saved ? '' : null, saved ? 200 : null);
    if (saved) contribution.run(character, id, 100, 200, '', 'synthetic-state',
      ['other-episode', 'foreign'].includes(id) ? 'UNREADABLE_FOREIGN_CONTRIBUTION' : JSON.stringify({
        episodeId: id, label: id, start: 100, end: 200, sourceHash, inputHash: '', dependencies: ['PRIVATE_DEPENDENCY'],
        stateHash: 'synthetic-state', memories: id === 'empty' ? [] : memories,
        impressions: [{ text: 'IMPRESSION_ONLY_SENTINEL', sourceEpisodeIds: ['foreign'] }],
      }));
    if (saved && id !== 'empty') for (const item of memories) {
      memory.run(character, id, 200, item.gist, item.detail, item.feeling, item.cues.join(' '), item.salience,
        item.confidence, JSON.stringify(item.sourceMessageIds));
    }
  }
  db.exec("INSERT INTO corrections VALUES('mara','target','UNREADABLE_CORRECTION_SENTINEL')");
  db.close();
  const calls = [], modelCalls = [];
  let readSource = () => structuredClone(source);
  const clients = [];
  const open = (characterId = 'mara') => {
    const client = new MemoryClient({ executable: nativeEnginePath('debug'), database, characterId,
      readSource: async id => { calls.push(id); return readSource(id); },
      infer: async () => { modelCalls.push(true); assert.fail('Inspection must never call the model'); } });
    clients.push(client);
    return client;
  };
  t.after(async () => {
    for (const client of clients) await client.close();
    rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(modelCalls, [], 'Inspection must never call the model, even if its failure is caught.');
  });
  const snapshot = () => {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const schema = db.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
      return { schema, version: db.prepare('PRAGMA user_version').get(), tables: schema.filter(s => s.type === 'table').map(s =>
        [s.name, db.prepare(`SELECT * FROM "${s.name.replaceAll('"', '""')}"`).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]) };
    } finally { db.close(); }
  };
  return { database, calls, source, open, snapshot, memories: memories.map(({ gist, detail, feeling, confidence }) => ({ gist, detail, feeling, confidence })),
    setReader: fn => { readSource = fn; } };
}

test('inspectEpisode projects only the saved target, survives restart and makes no storage changes', async t => {
  const f = fixture(t), before = f.snapshot(), bytes = readFileSync(f.database);
  const first = f.open();
  const expected = { characterId: 'mara', episodeId: 'target', revision: 17, state: 'published', memories: f.memories };
  assert.deepEqual(await first.request('inspectEpisode', { episodeId: 'target' }), expected);
  assert.deepEqual(f.calls, ['target']);
  await first.close();
  const restarted = f.open();
  assert.deepEqual(await restarted.request('inspectEpisode', { episodeId: 'target' }), expected);
  assert.deepEqual(f.calls, ['target', 'target']);
  assert.deepEqual(f.snapshot(), before);
  await restarted.close();
  assert.deepEqual(readFileSync(f.database), bytes);
});

test('inspectEpisode distinguishes empty publication, invalidation, exclusion and unknown IDs', async t => {
  const f = fixture(t), client = f.open();
  for (const [episodeId, state] of [['empty', 'published'], ['invalidated', 'invalidated'], ['excluded', 'not-memorized'], ['unknown', 'not-memorized']]) {
    assert.deepEqual(await client.request('inspectEpisode', { episodeId }), { characterId: 'mara', episodeId, revision: 17, state, memories: [] });
  }
  assert.deepEqual(f.calls, ['empty']);
});

test('inspectEpisode validates required identity and character ownership before callbacks', async t => {
  const f = fixture(t), client = f.open();
  for (const params of [{}, { episodeId: null }, { episodeId: 1 }, { episodeId: '' }, { episodeId: 'a'.repeat(513) }]) {
    await assert.rejects(client.request('inspectEpisode', params), { code: 'INVALID_INPUT' });
  }
  await assert.rejects(client.request('inspectEpisode', { episodeId: 'target', characterId: 'other' }), { code: 'CHARACTER_MISMATCH' });
  await assert.rejects(client.request('inspectEpisode', { episodeId: 'foreign' }), { code: 'EPISODE_CHARACTER_MISMATCH' });
  await assert.rejects(f.open('other').request('inspectEpisode', { episodeId: 'target' }), { code: 'EPISODE_CHARACTER_MISMATCH' });
  assert.deepEqual(f.calls, []);
});

test('inspectEpisode fails closed on changed, deleted, malformed or unavailable target source', async t => {
  const f = fixture(t), client = f.open(), before = f.snapshot();
  for (const reader of [
    () => ({ ...f.source, foundation: 'Changed foundation' }),
    () => ({ ...f.source, messages: [{ ...f.source.messages[0], text: 'Changed branch' }] }),
    () => ({ deleted: true }), () => null,
    () => { throw new Error('SOURCE_ERROR_PRIVATE_SENTINEL'); },
  ]) {
    f.setReader(reader);
    assert.deepEqual(await client.request('inspectEpisode', { episodeId: 'target' }),
      { characterId: 'mara', episodeId: 'target', revision: 17, state: 'stale', memories: [] });
  }
  assert.deepEqual(f.calls, Array(5).fill('target'));
  assert.deepEqual(f.snapshot(), before);
  f.setReader(() => f.source);
  assert.equal((await client.request('inspectEpisode', { episodeId: 'target' })).state, 'published');
});

test('inspectEpisode rejects a revision changed during its source callback and safely retries', async t => {
  const f = fixture(t), client = f.open();
  f.setReader(() => {
    const db = new DatabaseSync(f.database);
    db.exec("UPDATE characters SET revision=revision+1 WHERE id='mara'");
    db.close();
    return f.source;
  });
  await assert.rejects(client.request('inspectEpisode', { episodeId: 'target' }), { code: 'STALE_OPERATION' });
  assert.deepEqual(f.calls, ['target']);
  f.setReader(() => f.source);
  assert.deepEqual(await client.request('inspectEpisode', { episodeId: 'target' }),
    { characterId: 'mara', episodeId: 'target', revision: 18, state: 'published', memories: f.memories });
});

test('inspectEpisode respects changed saved chronology without reading other episodes', async t => {
  const f = fixture(t), client = f.open();
  const db = new DatabaseSync(f.database);
  db.exec("UPDATE episodes SET now=201 WHERE character_id='mara' AND id='target'; UPDATE characters SET revision=18 WHERE id='mara'");
  db.close();
  const before = f.snapshot();
  assert.deepEqual(await client.request('inspectEpisode', { episodeId: 'target' }),
    { characterId: 'mara', episodeId: 'target', revision: 18, state: 'stale', memories: [] });
  assert.deepEqual(f.calls, ['target']);
  assert.deepEqual(f.snapshot(), before);
});

test('inspectEpisode checks revision even if the source callback fails', async t => {
  const f = fixture(t), client = f.open();
  f.setReader(() => {
    const db = new DatabaseSync(f.database);
    db.exec("UPDATE characters SET revision=revision+1 WHERE id='mara'");
    db.close();
    throw new Error('PRIVATE_CALLBACK_FAILURE');
  });
  await assert.rejects(client.request('inspectEpisode', { episodeId: 'target' }), { code: 'STALE_OPERATION' });
  assert.deepEqual(f.calls, ['target']);
});
