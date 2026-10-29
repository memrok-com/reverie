import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { unzipSync } from 'fflate';
import { Catalog } from '../../.work/pi-test/catalog.mjs';
import { MemoryService } from '../../.work/pi-test/service.mjs';
import { extractSource, sourceHash } from '../../.work/pi-test/source.mjs';
import { recallHistory } from '../../.work/pi-test/recall-history.mjs';
import { exportStory } from '../../.work/pi-test/story-backup.mjs';
import { reflection } from '../fixtures/subjective.mjs';
import { nativeEnginePath } from '../../scripts/lib/native-toolchain.mjs';

async function fixture(t) {
  const root = resolve('.work/recall-deletion-tests', randomUUID()), home = join(root, 'data');
  await mkdir(root, { recursive: true });
  const catalog = new Catalog(home), character = catalog.create('Mara', 'You are Mara, proud and wary.'), calls = [];
  const infer = async request => {
    calls.push(request.input.episode.label);
    const result = reflection(request); result.memories[0].detail += ` sample ${calls.length}`;
    return JSON.stringify(result);
  };
  const service = new MemoryService(catalog, nativeEnginePath(), infer), client = service.client(character.id);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await service.close(); catalog.close(); } };
  t.after(close);
  const episode = async (label, date, { memorize = true, end = date, owner = character } = {}) => {
    const native = service.client(owner.id), manager = SessionManager.create(root, join(root, 'sessions'));
    const id = manager.getSessionId();
    manager.appendCustomEntry('reverie.binding', { characterId: owner.id });
    manager.appendCustomEntry('reverie.foundation', { text: owner.persona });
    const prompt = manager.appendMessage({ role: 'user', content: 'I offer a blue lantern.', timestamp: 1 });
    await native.request('when', { episodeId: id, position: date, label });
    if (end !== date) await native.request('when', { episodeId: id, position: end });
    const recall = await native.request('retrieve', { episodeId: id, at: end, cue: 'lantern' });
    const reply = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'I accept, though I am wary.' }], stopReason: 'stop' });
    const path = manager.getSessionFile();
    catalog.remember({ episodeId: id, characterId: owner.id, cwd: root, path, leaf: manager.getLeafId() });
    catalog.saveRecall(id, reply, { ...recall, playedPrefixHash: sourceHash(extractSource(manager.getBranch())) });
    if (memorize) await native.request('memorize', { episodeId: id });
    return { id, path, prompt, reply, manager, recall: catalog.recall(reply, id) };
  };
  const inspected = async id => (await client.request('inspect')).episodes.find(item => item.episode.id === id);
  return { root, home, catalog, character, service, client, calls, infer, close, episode, inspected };
}

for (const mode of ['integrated', 'external']) test(`${mode} deletion of a later episode preserves earlier published and ongoing recall history`, async t => {
  const f = await fixture(t);
  const a = await f.episode('A', '2000-01-01'), b = await f.episode('B', '2010-01-01');
  const ongoing = await f.episode('ongoing', '2015-01-01', { memorize: false });
  const later = await f.episode('C', '2020-01-01');
  const before = (await f.inspected(b.id)).contribution, count = f.calls.length;
  assert.ok(recallHistory(f.catalog, b.manager.getBranch(), b.id, f.character.id).length > 0);
  if (mode === 'integrated') await f.service.forget(later.id, f.character.id);
  else { await rm(later.path); await f.service.reconcile(); }
  for (const item of [a, b, ongoing]) assert.deepEqual(f.catalog.recall(item.reply, item.id), item.recall);
  assert.equal(f.catalog.recall(later.reply, later.id), undefined);
  f.catalog.acknowledgeDeletion(later.id); // Another reconciler can acknowledge the same tombstone.
  assert.equal(f.catalog.prepareRecallDeletion(later.id), undefined);
  const history = recallHistory(f.catalog, ongoing.manager.getBranch(), ongoing.id, f.character.id);
  assert.ok(history.length > 0);
  assert.ok((await f.client.request('retrieve', { episodeId: ongoing.id, at: '2015-01-01', recallHistory: history })).historicalContext.length > 0);
  assert.equal((await f.client.request('rebuild')).reflected, 0);
  assert.equal((await f.client.request('memorize', { episodeId: b.id })).status, 'current');
  assert.equal(f.calls.length, count);
  assert.deepEqual((await f.inspected(b.id)).contribution, before);
  assert.equal((await f.inspected(b.id)).freshness, 'current');
});

test('deletion removes only affected later records, including ongoing episodes, and isolates characters', async t => {
  const f = await fixture(t);
  const a = await f.episode('A', '2000-01-01'), b = await f.episode('B', '2010-01-01');
  const c = await f.episode('C', '2020-01-01'), d = await f.episode('D', '2030-01-01');
  const ongoing = await f.episode('ongoing', '2040-01-01', { memorize: false });
  const other = f.catalog.create('Anya', 'You are Anya.');
  const foreign = await f.episode('foreign', '2030-01-01', { owner: other });
  const before = (await f.inspected(b.id)).contribution, calls = f.calls.length;
  await f.service.forget(c.id, f.character.id);
  for (const item of [a, b, foreign]) assert.deepEqual(f.catalog.recall(item.reply, item.id), item.recall);
  for (const item of [c, d, ongoing]) assert.equal(f.catalog.recall(item.reply, item.id), undefined);
  assert.equal((await f.client.request('rebuild')).reflected, 1);
  assert.deepEqual(f.calls.slice(calls), ['D']);
  assert.deepEqual((await f.inspected(b.id)).contribution, before);
});

test('deleting a never-memorized draft leaves every other recall and contribution intact', async t => {
  const f = await fixture(t);
  const a = await f.episode('A', '2000-01-01'), draft = await f.episode('draft', '2010-01-01', { memorize: false });
  const later = await f.episode('later', '2020-01-01');
  const before = (await f.inspected(later.id)).contribution, count = f.calls.length;
  await f.service.forget(draft.id, f.character.id);
  for (const item of [a, later]) assert.deepEqual(f.catalog.recall(item.reply, item.id), item.recall);
  assert.equal(f.catalog.recall(draft.reply, draft.id), undefined);
  assert.equal((await f.client.request('rebuild')).reflected, 0);
  assert.equal(f.calls.length, count);
  assert.deepEqual((await f.inspected(later.id)).contribution, before);
});

test('an earlier interval retains recall at a later episode shared endpoint', async t => {
  const f = await fixture(t);
  await f.episode('A', '2000-01-01');
  const b = await f.episode('B', '2010-01-01', { end: '2020-01-01' });
  const c = await f.episode('C', '2020-01-01');
  assert.equal(b.recall.at, Date.parse('2020-01-01'));
  await f.service.forget(c.id, f.character.id);
  assert.deepEqual(f.catalog.recall(b.reply, b.id), b.recall);
  assert.equal((await f.client.request('rebuild')).reflected, 0);
});

test('cleanup follows both published and current starts when episode dates have drifted', async t => {
  const f = await fixture(t);
  const b = await f.episode('B', '1995-01-01'), c = await f.episode('C', '2000-01-01');
  const d = await f.episode('D', '2010-01-01');
  await f.client.request('when', { episodeId: c.id, position: '2030-01-01', resetStart: true });
  await f.client.request('when', { episodeId: d.id, position: '1997-01-01', resetStart: true });
  await f.service.forget(c.id, f.character.id);
  assert.deepEqual(f.catalog.recall(b.reply, b.id), b.recall);
  assert.equal(f.catalog.recall(d.reply, d.id), undefined);
});

for (const format of ['current', 'legacy']) test(`a persisted ${format} cleanup plan survives restart between native deletion and catalog acknowledgment`, async t => {
  const f = await fixture(t);
  await f.episode('A', '2000-01-01');
  const b = await f.episode('B', '2010-01-01'), c = await f.episode('C', '2020-01-01');
  const d = await f.episode('D', '2030-01-01');
  const before = (await f.inspected(b.id)).contribution;
  f.catalog.acknowledgeDeletion = () => { throw new Error('Simulated interruption before acknowledgment'); };
  await assert.rejects(f.service.forget(c.id, f.character.id), /Simulated interruption/);
  assert.equal(f.catalog.source(c.id).deleted, 1);
  assert.ok(!(await f.client.request('status')).episodes.some(item => item.id === c.id));
  if (format === 'legacy') {
    const plan = JSON.parse(f.catalog.db.prepare('SELECT affected FROM recall_deletions WHERE episodeId=?').get(c.id).affected);
    f.catalog.db.prepare('UPDATE recall_deletions SET affected=? WHERE episodeId=?').run(JSON.stringify(plan.episodeIds), c.id);
  }
  await f.close();
  const catalog = new Catalog(f.home), service = new MemoryService(catalog, nativeEnginePath(), f.infer);
  t.after(async () => { await service.close(); catalog.close(); });
  assert.equal(await service.reconcile(), 0);
  assert.equal(catalog.source(c.id).deleted, 2);
  assert.deepEqual(catalog.recall(b.reply, b.id), b.recall);
  assert.equal(catalog.recall(c.reply, c.id), undefined); assert.equal(catalog.recall(d.reply, d.id), undefined);
  assert.equal(catalog.db.prepare('SELECT COUNT(*) AS count FROM recall_deletions').get().count, 0);
  const client = service.client(f.character.id), calls = f.calls.length;
  assert.equal((await client.request('rebuild')).reflected, 1);
  assert.deepEqual(f.calls.slice(calls), ['D']);
  assert.deepEqual((await client.request('inspect')).episodes.find(item => item.episode.id === b.id).contribution, before);
});

for (const cause of ['withdrawal', 'correction', 'native deletion']) test(`deleting an episode after ${cause} removes its saved prose from explanations and backup`, async t => {
  const f = await fixture(t);
  const root = await f.episode('Root', '1990-01-01'), a = await f.episode('A', '2000-01-01');
  const b = await f.episode('B', '2010-01-01', { memorize: false });
  assert.ok(JSON.stringify(b.recall).includes('I remember A.'));
  if (cause === 'withdrawal') await f.client.request('unmemorize', { episodeId: a.id });
  else if (cause === 'native deletion') await f.client.request('forget', { episodeId: root.id });
  else {
    const inspection = await f.client.request('inspect');
    const memory = inspection.episodes.find(item => item.episode.id === root.id).contribution.memories[0];
    const preview = await f.client.request('previewCorrection', { episodeId: root.id, revision: inspection.revision,
      memoryIndex: 0, replacement: { ...memory, gist: 'The player brought the lantern; I accepted it.' } });
    await f.client.request('applyCorrection', { token: preview.token });
  }
  assert.equal((await f.inspected(a.id)).contribution, null);
  const calls = f.calls.length;
  await f.service.forget(a.id, f.character.id);
  assert.equal(f.catalog.recall(b.reply, b.id), undefined);
  assert.equal(f.catalog.db.prepare('SELECT COUNT(*) AS count FROM recalls WHERE replyId=?').get(b.reply).count, 0);
  assert.deepEqual(f.catalog.recall(root.reply, root.id), root.recall);
  assert.equal(f.calls.length, calls);
  const archive = join(f.root, 'deleted-story.zip');
  await exportStory(f.catalog, f.character.id, archive, f.root);
  const files = unzipSync(await readFile(archive));
  assert.ok(Object.values(files).every(bytes => !Buffer.from(bytes).toString('utf8').includes('I remember A.')));
});

for (const field of ['historicalContext', 'impressions', 'historySources']) test(`deletion follows ${field} references after withdrawal`, async t => {
  const f = await fixture(t), a = await f.episode('A', '2000-01-01');
  const b = await f.episode('B', '2010-01-01', { memorize: false });
  const activated = await f.client.request('retrieve', { episodeId: b.id, at: '2010-01-01',
    recallHistory: recallHistory(f.catalog, b.manager.getBranch(), b.id, f.character.id) });
  const record = { ...b.recall, memories: [], historicalContext: [], impressions: [], historySources: [] };
  if (field === 'historicalContext') record.historicalContext = activated.historicalContext;
  else if (field === 'impressions') record.impressions = [{ text: 'I remember A.', sourceEpisodeIds: [a.id] }];
  else record.historySources = [a.id];
  f.catalog.saveRecall(b.id, b.reply, record);
  await f.client.request('unmemorize', { episodeId: a.id });
  await f.service.forget(a.id, f.character.id);
  assert.equal(f.catalog.recall(b.reply, b.id), undefined);
});

test('reference cleanup preserves unrelated replies in the same re-dated episode and isolates other characters', async t => {
  const f = await fixture(t);
  const root = await f.episode('Root', '1980-01-01'), a = await f.episode('A', '2000-01-01');
  const b = await f.episode('B', '2010-01-01', { memorize: false });
  const other = f.catalog.create('Anya', 'You are Anya.'), foreign = await f.episode('foreign', '2010-01-01', { owner: other, memorize: false });
  // Even a foreign record naming A is outside this character's cleanup scope.
  const foreignRecord = { ...foreign.recall, memories: [{ episodeId: a.id, gist: 'I remember A.' }] };
  f.catalog.saveRecall(foreign.id, foreign.reply, foreignRecord);
  await f.client.request('unmemorize', { episodeId: a.id });
  await f.client.request('when', { episodeId: b.id, position: '1990-01-01', resetStart: true });
  b.manager.appendMessage({ role: 'user', content: 'We stay together.', timestamp: 2 });
  const recall = await f.client.request('retrieve', { episodeId: b.id, at: '1990-01-01', cue: 'lantern' });
  assert.deepEqual(recall.memories.map(memory => memory.episodeId), [root.id]);
  const reply = b.manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'I stay.' }], stopReason: 'stop' });
  f.catalog.remember({ episodeId: b.id, characterId: f.character.id, cwd: f.root, path: b.path, leaf: b.manager.getLeafId() });
  const unrelated = { ...recall, playedPrefixHash: sourceHash(extractSource(b.manager.getBranch())) };
  f.catalog.saveRecall(b.id, reply, unrelated);
  await f.service.forget(a.id, f.character.id);
  assert.equal(f.catalog.recall(b.reply, b.id), undefined);
  assert.deepEqual(f.catalog.recall(reply, b.id), unrelated);
  assert.deepEqual(f.catalog.recall(foreign.reply, foreign.id), foreignRecord);
  assert.deepEqual(recallHistory(f.catalog, b.manager.getBranch(), b.id, f.character.id).map(item => item.replyId), [reply]);
});

test('reply cleanup survives interruption and catches a referencing context saved after planning', async t => {
  const f = await fixture(t), a = await f.episode('A', '2000-01-01');
  const b = await f.episode('B', '2010-01-01', { memorize: false });
  await f.client.request('unmemorize', { episodeId: a.id });
  const acknowledge = f.catalog.acknowledgeDeletion.bind(f.catalog);
  f.catalog.acknowledgeDeletion = () => { throw new Error('Interrupted reference cleanup'); };
  await assert.rejects(f.service.forget(a.id, f.character.id), /Interrupted reference cleanup/);
  const plan = JSON.parse(f.catalog.db.prepare('SELECT affected FROM recall_deletions WHERE episodeId=?').get(a.id).affected);
  assert.ok(plan.replyIds.includes(b.reply));
  // Simulate a legacy writer that did not yet guard contexts saved during deletion.
  f.catalog.db.prepare('INSERT INTO recalls VALUES(?,?,?)').run(b.id, 'late-context', JSON.stringify(b.recall));
  f.catalog.acknowledgeDeletion = acknowledge;
  await f.close();
  const catalog = new Catalog(f.home), service = new MemoryService(catalog, nativeEnginePath(), f.infer);
  t.after(async () => { await service.close(); catalog.close(); });
  await service.reconcile();
  assert.equal(catalog.recall(b.reply, b.id), undefined);
  assert.equal(catalog.recall('late-context', b.id), undefined);
  assert.equal(catalog.source(a.id).deleted, 2);
});

test('a late reply cannot restore deleted recall prose while unrelated context can still be saved', async t => {
  const f = await fixture(t);
  await f.episode('Root', '1980-01-01');
  const a = await f.episode('A', '2000-01-01'), b = await f.episode('B', '2010-01-01', { memorize: false });
  await f.client.request('unmemorize', { episodeId: a.id });
  f.catalog.tombstone(a.id);
  f.catalog.saveRecall(b.id, 'during-deletion', b.recall);
  assert.equal(f.catalog.recall('during-deletion', b.id), undefined);
  await f.service.reconcile();
  f.catalog.saveRecall(b.id, 'after-deletion', b.recall);
  f.catalog.saveRecall(a.id, 'deleted-owner', a.recall);
  f.catalog.saveRecall('unregistered-source', 'late-unregistered', b.recall);
  assert.equal(f.catalog.recall('after-deletion', b.id), undefined);
  assert.equal(f.catalog.recall('deleted-owner', a.id), undefined);
  assert.equal(f.catalog.recall('late-unregistered'), undefined);
  const fresh = await f.client.request('retrieve', { episodeId: b.id, at: '2010-01-01' });
  f.catalog.saveRecall(b.id, 'unrelated-context', fresh);
  assert.deepEqual(f.catalog.recall('unrelated-context', b.id), fresh);
});

test('a chronology race cannot delete using an obsolete cleanup plan', async t => {
  const f = await fixture(t);
  const a = await f.episode('A', '2000-01-01'), b = await f.episode('B', '2010-01-01');
  const c = await f.episode('C', '2020-01-01');
  const request = f.client.request.bind(f.client); let move = true;
  f.client.request = async (method, params, ...options) => {
    if (method === 'forget' && move) {
      move = false;
      await request('when', { episodeId: c.id, position: '2005-01-01', resetStart: true });
    }
    return request(method, params, ...options);
  };
  await assert.rejects(f.service.forget(c.id, f.character.id), { code: 'STALE_OPERATION' });
  assert.equal(f.catalog.source(c.id).deleted, 1);
  assert.deepEqual(f.catalog.recall(b.reply, b.id), b.recall);
  assert.ok((await request('status')).episodes.some(item => item.id === c.id));
  assert.equal(await f.service.reconcile(), 2);
  assert.deepEqual(f.catalog.recall(a.reply, a.id), a.recall);
  assert.equal(f.catalog.recall(b.reply, b.id), undefined);
  assert.equal(f.catalog.recall(c.reply, c.id), undefined);
});
