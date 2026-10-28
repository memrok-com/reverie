import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentSession, createAgentSessionRuntime, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { registerReverie } from '../../.work/pi-test/extension.mjs';
import { Catalog } from '../../.work/pi-test/catalog.mjs';
import { MemoryClient } from '../../.work/pi-test/memory-client.mjs';
import { alternatives, extractSource } from '../../.work/pi-test/source.mjs';
import { reflection } from '../fixtures/subjective.mjs';
import { nativeEnginePath } from '../../scripts/lib/native-toolchain.mjs';

const executable = nativeEnginePath();
const model = { id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1',
  reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const roleplayModel = { ...model, id: 'local-roleplay', name: 'Local roleplay', reasoning: true };
async function until(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for the real Pi session.'); await delay(10); }
}
async function fixture(t, existing) {
  const root = existing?.root ?? resolve('.work/pi-integration', randomUUID()), cwd = existing?.cwd ?? resolve(root, 'Mara'), agentDir = resolve(root, 'agent'), home = resolve(root, 'reverie');
  await mkdir(cwd, { recursive: true }); await mkdir(agentDir, { recursive: true });
  const inputs = [], editors = [], choices = [], notices = [], widgets = new Map(), requests = [], errors = [], inspections = [], requestedModels = [], requestedThinking = [];
  let draft = '', replies = 0;
  const controls = { holdReflection: false, reflectionStarted: false, replyFailure: undefined, reflectionFailure: false, confirmDelete: true,
    holdInspectionDialog: false, dialogStarted: false, releaseDialog: undefined, releaseReflection: undefined };
  const streamSimple = (_model, context, options) => {
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      requests.push(context);
      requestedModels.push(`${_model.provider}/${_model.id}`);
      requestedThinking.push(options?.reasoning);
      const last = context.messages.findLast(item => item.role === 'user');
      const userText = typeof last?.content === 'string' ? last.content : last?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
      let input;
      try { input = JSON.parse(userText); } catch {}
      const text = input?.episode ? JSON.stringify(reflection({ input })) : `Reply ${++replies}: I remember the blue lantern.`;
      const reply = { role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
      if (input?.episode && controls.reflectionFailure) {
        reply.errorMessage = 'Reflection failed (fixture)';
        stream.push({ type: 'error', reason: 'error', error: reply }); stream.end(); return;
      }
      if (!input?.episode && controls.replyFailure) {
        reply.content = []; reply.stopReason = controls.replyFailure;
        reply.errorMessage = controls.replyFailure === 'aborted' ? 'Cancelled' : 'OAuth refresh failed (fixture)';
        stream.push({ type: 'error', reason: controls.replyFailure, error: reply }); stream.end(); return;
      }
      const finish = () => {
        stream.push({ type: 'start', partial: reply });
        stream.push({ type: 'text_start', contentIndex: 0, partial: reply });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: reply });
        stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: reply });
        stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end();
      };
      if (input?.episode && controls.holdReflection) {
        controls.reflectionStarted = true;
        controls.releaseReflection = finish;
        const abort = () => { reply.stopReason = 'aborted'; reply.errorMessage = 'Cancelled'; stream.push({ type: 'error', reason: 'aborted', error: reply }); stream.end(); };
        if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener('abort', abort, { once: true });
        return;
      }
      finish();
    });
    return stream;
  };
  const createRuntime = async target => {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { mode: 'off' } });
  const loader = new DefaultResourceLoader({ cwd: target.cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, disabledBuiltinExtensions: ['mcp', 'codemode'],
    extensionFactories: [pi => { pi.registerProvider('fixture', { ...model, apiKey: 'test-only', models: [model, roleplayModel], streamSimple }); registerReverie(pi, { home, executable, pollingMs: 100 }); }] });
  await loader.reload();
  const result = await createAgentSession({ ...target, model, settingsManager, resourceLoader: loader });
  return { ...result, services: { cwd: target.cwd, agentDir, settingsManager, resourceLoader: loader }, diagnostics: [] };
  };
  const manager = existing?.path ? SessionManager.open(existing.path) : SessionManager.create(cwd, resolve(cwd, 'sessions'));
  const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: manager });
  const ui = { select: async (title, options) => {
      inspections.push(title);
      if (controls.holdInspectionDialog && title === 'Inspect episode memory') { controls.dialogStarted = true; return new Promise(resolve => { controls.releaseDialog = resolve; }); }
      const answer = choices.shift(); if (answer === undefined) return options[0]; return typeof answer === 'number' ? options[answer] : answer;
    },
    custom: async factory => { const component = factory({ terminal: { rows: 200 }, requestRender() {} }, { fg: (_color, text) => text }, {}, () => {}); inspections.push(component.render(200).join('\n')); },
    input: async () => inputs.shift(), editor: async () => editors.shift(), confirm: async () => controls.confirmDelete,
    notify: (message, level) => notices.push({ message, level }), setWidget: (key, value) => widgets.set(key, value), setStatus() {},
    setEditorText: value => { draft = value; }, getEditorText: () => draft };
  const bind = session => session.bindExtensions({ uiContext: ui, mode: 'tui', onError: error => errors.push(error),
    commandContextActions: { waitForIdle: async () => until(() => session.isIdle), navigateTree: (id, opts) => session.navigateTree(id, opts), reload: () => session.reload(),
      newSession: opts => runtime.newSession(opts), fork: (id, opts) => runtime.fork(id, opts), switchSession: (path, opts) => runtime.switchSession(path, opts) } });
  runtime.setRebindSession(bind); await bind(runtime.session);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await runtime.dispose(); } };
  t.after(close);
  return { root, cwd, home, runtime, controls, inputs, editors, choices, notices, widgets, requests, requestedModels, requestedThinking, errors, inspections, close,
    get session() { return runtime.session; }, get manager() { return runtime.session.sessionManager; },
    get draft() { return draft; }, setDraft: text => { draft = text; }, command: text => runtime.session.prompt(`/reverie ${text}`),
    async setup() { choices.push(0); inputs.push('Mara'); editors.push('You are Mara, proud and wary.'); await runtime.session.prompt('/reverie setup'); }, until };
}

async function legacyDate(f, id, date, label) {
  const catalog = new Catalog(f.home);
  const client = new MemoryClient({ executable, database: catalog.memoryPath, characterId: catalog.characters()[0].id,
    readSource: async () => { throw new Error('This setup has no saved chat.'); },
    infer: async () => { throw new Error('Unplayed setups never call a model.'); } });
  try { await client.request('when', { episodeId: id, position: date, label }); }
  finally { await client.close(); catalog.close(); }
}

test('real Pi input cancellation preserves an opening; persona, reroll, cycle, memory and restart work together', async t => {
  const f = await fixture(t); await f.setup();
  assert.equal(f.errors.length, 0);
  await f.session.prompt('A carefully written opening beside the lighthouse.');
  assert.equal(f.draft, 'A carefully written opening beside the lighthouse.');
  assert.equal(f.requests.length, 0);
  f.inputs.push('2010-01-01 The lighthouse');
  await f.session.prompt('A carefully written opening beside the lighthouse.');
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
  assert.match(JSON.stringify(f.requests[0]), /You are Mara, proud and wary/);
  assert.match(f.widgets.get('reverie')[0], /Reply 1\/1/);
  await f.command('reroll');
  await f.until(() => alternatives(f.manager.getEntries(), f.manager.getBranch())?.replies.length === 2 && f.session.isIdle);
  assert.match(f.widgets.get('reverie')[0], /Reply 2\/2/);
  await f.command('previous');
  assert.match(extractSource(f.manager.getBranch()).messages.at(-1).text, /Reply 1/);
  await f.command('memorize');
  await f.until(() => f.notices.some(item => item.message.startsWith('Memory updated:')));
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
  const catalog = new Catalog(f.home);
  const character = catalog.characters()[0];
  assert.equal(catalog.source(f.manager.getSessionId()).characterId, character.id);
  catalog.close();
  const path = f.manager.getSessionFile(); await f.close();
  // Re-open the same raw Pi file. The selected alternative must survive without choosing the newest reply.
  const restarted = await fixture(t, { root: f.root, path });
  assert.match(extractSource(restarted.manager.getBranch()).messages.at(-1).text, /Reply 1/);
  assert.match(restarted.widgets.get('reverie')[0], /Mara.*2010-01-01/);
  await restarted.command('explain');
  assert.equal(restarted.errors.length, 0);
});

test('story dates can be corrected repeatedly before play and stay fixed after play, restart and rewind', async t => {
  const f = await fixture(t); await f.setup();
  await f.command('when 2020-01-01 Mistyped');
  await f.command('when 2010-01-01 Corrected');
  await f.command('when 2030-01-01');
  f.choices.push('Story date'); f.inputs.push('2015-01-01 The lighthouse');
  await f.command('menu');
  assert.match(f.widgets.get('reverie')[0], /2015-01-01/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.notices.filter(item => item.level === 'error').length, 0);
  assert.equal(f.manager.getEntries().filter(item => item.type === 'custom' && item.customType === 'reverie.binding').length, 1);
  const beforePlay = f.manager.getLeafId();
  await f.session.prompt('I arrive at the lighthouse.');
  await f.command('when 2014-01-01');
  assert.match(f.notices.at(-1).message, /time jump must advance/);
  assert.match(f.widgets.get('reverie')[0], /2015-01-01/);
  await f.command('when 2016-01-01');
  assert.match(f.widgets.get('reverie')[0], /2016-01-01/);
  const path = f.manager.getSessionFile(); await f.close();
  const restarted = await fixture(t, { root: f.root, path });
  assert.match(restarted.widgets.get('reverie')[0], /2016-01-01/);
  await restarted.session.navigateTree(beforePlay, { summarize: false });
  assert.match(restarted.widgets.get('reverie')[0], /2015-01-01/);
  await restarted.command('when 2014-01-01');
  assert.match(restarted.notices.at(-1).message, /time jump must advance/);
  assert.equal(restarted.errors.length + f.errors.length, 0);
});

test('leaving a dated unplayed chat saves it for Pi resume and episode chat navigation without inventing turns', async t => {
  const f = await fixture(t); await f.setup();
  await f.command('when 2026-10-29 The elevator');
  const id = f.manager.getSessionId(), path = f.manager.getSessionFile();
  await f.session.reload();
  await f.command('when 2026-04-29 The elevator');
  await assert.rejects(access(path), { code: 'ENOENT' });
  await f.runtime.newSession();
  const resumable = await SessionManager.list(f.cwd, dirname(path));
  assert.ok(resumable.some(item => item.id === id && item.messageCount === 0 && /2026-04-29.*The elevator/.test(item.name)));
  const saved = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(saved.filter(entry => entry.type === 'message').length, 0);
  f.choices.push(0, 'Resume'); await f.command('chats');
  assert.equal(f.manager.getSessionId(), id);
  assert.match(f.widgets.get('reverie')[0], /2026-04-29/);
  await f.command('when 2025-01-01');
  assert.match(f.manager.getSessionName(), /2025-01-01.*The elevator/);
  await f.session.prompt('The elevator opens.');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(extractSource(f.manager.getBranch()).messages.filter(item => item.role === 'user').map(item => item.text), ['The elevator opens.']);
  assert.equal(f.notices.filter(item => item.level === 'error').length, 0, JSON.stringify(f.notices));
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
});

test('quitting saves date-only chats and deleting the resumed setup removes it without a model call', async t => {
  const f = await fixture(t); await f.setup(); await f.command('when 2026-04-29');
  const id = f.manager.getSessionId(), path = f.manager.getSessionFile();
  await f.close(); await access(path);
  const restarted = await fixture(t, { root: f.root, path });
  assert.equal(restarted.manager.getSessionId(), id);
  assert.match(restarted.widgets.get('reverie')[0], /2026-04-29/);
  await restarted.command('delete');
  assert.notEqual(restarted.manager.getSessionId(), id);
  await assert.rejects(access(path), { code: 'ENOENT' });
  await restarted.command('memory');
  assert.doesNotMatch(restarted.inspections.at(-1), /2026-04-29/);
  assert.equal(restarted.requests.length + f.requests.length, 0);
  assert.equal(restarted.errors.length + f.errors.length, 0);
});

test('episode chats can delete an inactive unmemorized conversation without replacing the current chat', async t => {
  const f = await fixture(t); await f.setup(); f.inputs.push('2010-01-01 First');
  await f.session.prompt('We meet.');
  const firstId = f.manager.getSessionId(), firstPath = f.manager.getSessionFile();
  await f.runtime.newSession(); f.inputs.push('2015-01-01 Second');
  await f.session.prompt('We meet again.');
  const currentId = f.manager.getSessionId();
  f.choices.push(0, 'Delete'); await f.command('chats');
  assert.equal(f.manager.getSessionId(), currentId);
  await assert.rejects(access(firstPath), { code: 'ENOENT' });
  const catalog = new Catalog(f.home);
  assert.equal(catalog.source(firstId).deleted, 2); catalog.close();
  await f.command('memory');
  assert.doesNotMatch(f.inspections.at(-1), /Not memorized.*First/);
  assert.match(f.inspections.at(-1), /Not memorized.*Second/);
  assert.equal(f.requests.length, 2);
  assert.equal(f.notices.filter(item => item.level === 'error').length, 0, JSON.stringify(f.notices));
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
});

test('legacy date-only episodes can be recovered or deleted from episode chats', async t => {
  const f = await fixture(t); await f.setup();
  const first = randomUUID(), second = randomUUID();
  await legacyDate(f, first, '2026-04-29', 'The elevator');
  await legacyDate(f, second, '2026-10-29', 'Mistyped');
  f.choices.push('Episode chats', 0, 'Resume'); await f.command('menu');
  assert.equal(f.manager.getSessionId(), first);
  assert.match(f.widgets.get('reverie')[0], /2026-04-29/);
  assert.deepEqual(extractSource(f.manager.getBranch()).messages, []);
  await f.command('when 2025-04-29');
  f.choices.push(1, 'Delete'); await f.command('chats');
  assert.equal(f.manager.getSessionId(), first);
  await f.command('memory');
  assert.match(f.inspections.at(-1), /Not memorized.*The elevator.*2025-04-29/);
  assert.doesNotMatch(f.inspections.at(-1), /Mistyped/);
  const path = f.manager.getSessionFile();
  f.controls.confirmDelete = false; await f.command('delete');
  assert.equal(f.manager.getSessionId(), first);
  f.controls.confirmDelete = true; await f.command('delete');
  assert.notEqual(f.manager.getSessionId(), first);
  await assert.rejects(access(path), { code: 'ENOENT' });
  await f.command('chats'); assert.equal(f.notices.at(-1).message, 'No dated episodes yet.');
  assert.equal(f.requests.length, 0);
  assert.equal(f.notices.filter(item => item.level === 'error').length, 0, JSON.stringify(f.notices));
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
});

test('empty recall adds no model-visible notice or synthetic dialogue, including rerolls and resumed legacy entries', async t => {
  const f = await fixture(t); await f.setup(); f.inputs.push('2026-10-27 The elevator');
  const opening = 'The elevator pings. He steps out and smiles. Oh hey, you are here too.';
  await f.session.prompt(opening);
  await f.command('reroll'); await f.until(() => f.requests.length === 2 && f.session.isIdle);
  for (const request of f.requests) {
    assert.deepEqual(request.messages.map(item => item.role), ['system', 'user']);
    assert.equal(typeof request.messages[1].content === 'string' ? request.messages[1].content : request.messages[1].content[0].text, opening);
    assert.match(JSON.stringify(request.messages[0]), /You are Mara, proud and wary/);
    assert.equal(request.messages[0].sections, undefined, 'Character context must not retain Pi coding prompt sections.');
    assert.equal(request.messages[0].toolsAdded?.length ?? 0, 0);
    assert.doesNotMatch(JSON.stringify(request), /No long-term recollections|Private character memory|Subjective memory for your current story point|reverie.recall/);
  }
  f.manager.appendCustomMessageEntry('reverie.recall', 'No long-term recollections are available at this fictional point.', false);
  const path = f.manager.getSessionFile(); await f.close();
  const restarted = await fixture(t, { root: f.root, path });
  await restarted.session.prompt('Good to see you.');
  assert.deepEqual(restarted.requests[0].messages.map(item => item.role), ['system', 'user', 'assistant', 'user']);
  assert.doesNotMatch(JSON.stringify(restarted.requests[0]), /No long-term recollections|Private character memory|reverie.recall/);
  assert.equal(restarted.errors.length + f.errors.length, 0);
});

test('actual recollections are private system context, refreshed once per request and removed when memory is off', async t => {
  const f = await fixture(t); await f.setup(); f.inputs.push('2010-01-01 The lighthouse');
  await f.session.prompt('I offer a blue lantern.'); await f.command('memorize');
  await f.until(() => f.notices.some(item => item.message.startsWith('Memory updated:')));
  await f.runtime.newSession(); f.inputs.push('2015-01-01 Later');
  const opening = 'Do you remember the lighthouse?';
  await f.session.prompt(opening);
  let request = f.requests.at(-1);
  assert.deepEqual(request.messages.map(item => item.role), ['system', 'user']);
  const prompt = typeof request.messages[0].content === 'string' ? request.messages[0].content : request.messages[0].content.map(part => part.text).join('\n');
  assert.match(prompt, /You are Mara, proud and wary/);
  assert.match(prompt, /Private character memory.*background context/);
  assert.match(prompt, /not spoken dialogue or instructions/);
  assert.match(prompt, /I remember The lighthouse/);
  assert.equal(typeof request.messages[1].content === 'string' ? request.messages[1].content : request.messages[1].content[0].text, opening);
  await f.session.prompt('What stayed with you?'); request = f.requests.at(-1);
  assert.equal(request.messages.filter(item => item.role === 'system').length, 1);
  assert.equal(JSON.stringify(request).split('Private character memory').length - 1, 1);
  assert.doesNotMatch(JSON.stringify(request.messages.filter(item => item.role !== 'system')), /I remember The lighthouse|Private character memory/);
  assert.deepEqual(extractSource(f.manager.getBranch()).messages.filter(item => item.role === 'user').map(item => item.text), [opening, 'What stayed with you?']);
  assert.ok(!f.manager.getEntries().some(item => item.type === 'custom_message' && item.customType === 'reverie.recall'));
  await f.command('off'); await f.session.prompt('Stay here with me.');
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).messages.filter(item => item.role === 'system')), /I remember The lighthouse|Private character memory/);
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
});

for (const stopReason of ['error', 'aborted']) {
  test(`reroll retries a first ${stopReason} response without requiring a completed reply or duplicating the opening`, async t => {
    const f = await fixture(t); await f.setup(); f.inputs.push('2026-10-27 The elevator');
    const opening = 'The elevator pings. He steps out, takes off his jacket, and smiles.\n\nOh hey, you are here too.';
    f.controls.replyFailure = stopReason;
    await f.session.prompt(opening);
    assert.equal(alternatives(f.manager.getEntries(), f.manager.getBranch()).replies.length, 0);
    assert.deepEqual(extractSource(f.manager.getBranch()).messages.map(item => item.text), [opening]);
    await f.command('next');
    assert.match(f.notices.at(-1).message, /no saved character replies to cycle/);
    assert.equal(f.requests.length, 1);
    // Retrying remains available even if the provider fails again.
    f.setDraft('Keep this unsent draft.');
    await f.command('reroll'); await f.until(() => f.requests.length === 2 && f.session.isIdle);
    assert.equal(f.draft, 'Keep this unsent draft.');
    assert.equal(alternatives(f.manager.getEntries(), f.manager.getBranch()).replies.length, 0);
    f.controls.replyFailure = undefined;
    await f.command('reroll'); await f.until(() => f.requests.length === 3 && f.session.isIdle);
    const source = extractSource(f.manager.getBranch());
    assert.deepEqual(source.messages.filter(item => item.role === 'user').map(item => item.text), [opening]);
    assert.equal(source.messages.filter(item => item.role === 'assistant').length, 1);
    for (const request of f.requests) {
      const sent = request.messages.filter(item => item.role === 'user')
        .map(item => typeof item.content === 'string' ? item.content : item.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
      assert.equal(sent.filter(text => text === opening).length, 1);
    }
    assert.match(f.widgets.get('reverie')[0], /2026-10-27.*Reply 1\/1/);
    assert.equal(f.draft, 'Keep this unsent draft.');
    assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
  });
}

test('reroll handles a pending user-only leaf and refuses an empty chat', async t => {
  const f = await fixture(t); await f.setup();
  await f.command('reroll');
  assert.match(f.notices.at(-1).message, /no user message to retry/);
  assert.equal(f.requests.length, 0);
  await f.command('when 2026-10-27 The elevator');
  const opening = 'Oh hey, you are here too.';
  const pendingId = f.manager.appendMessage({ role: 'user', content: opening, timestamp: Date.now() });
  assert.equal(f.manager.getLeafId(), pendingId);
  f.setDraft('Another unsent draft.');
  await f.command('reroll'); await f.until(() => f.requests.length === 1 && f.session.isIdle);
  assert.deepEqual(extractSource(f.manager.getBranch()).messages.filter(item => item.role === 'user').map(item => item.text), [opening]);
  assert.match(f.widgets.get('reverie')[0], /Reply 1\/1/);
  assert.equal(f.draft, 'Another unsent draft.');
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
});

test('a character folder restores its model and thinking level across new, resumed and reloaded sessions', async t => {
  const f = await fixture(t); await f.setup();
  await f.session.setModel(f.session.modelRuntime.getModel('fixture', 'local-roleplay'));
  f.session.setThinkingLevel('high');
  assert.match(f.notices.at(-1).message, /Model saved for this folder/);
  const catalog = new Catalog(f.home);
  assert.deepEqual(catalog.folderModel(f.cwd), { provider: 'fixture', modelId: 'local-roleplay', thinkingLevel: 'high' });
  assert.equal(f.session.settingsManager.getSettings().defaultModel, undefined);
  assert.equal(f.session.settingsManager.getSettings().defaultThinkingLevel, undefined);
  await f.session.reload();
  assert.equal(f.session.model.id, 'local-roleplay');
  assert.equal(f.session.thinkingLevel, 'high');
  await f.runtime.newSession();
  assert.equal(f.session.model.id, 'local-roleplay');
  assert.equal(f.session.thinkingLevel, 'high');
  assert.equal(catalog.folderModel(f.cwd).modelId, 'local-roleplay');
  f.inputs.push('2026-10-27 First'); await f.session.prompt('We meet by the elevator.');
  assert.equal(f.requestedModels.at(-1), 'fixture/local-roleplay');
  assert.equal(f.requestedThinking.at(-1), 'high');
  const path = f.manager.getSessionFile();
  await f.runtime.newSession();
  f.session.setThinkingLevel('minimal'); f.session.cycleThinkingLevel();
  assert.equal(f.session.thinkingLevel, 'low');
  assert.equal(catalog.folderModel(f.cwd).thinkingLevel, 'low');
  await f.runtime.switchSession(path);
  assert.equal(f.session.thinkingLevel, 'low', 'The folder choice overrides an older session thinking level even when the model is unchanged.');
  await f.close();
  const restarted = await fixture(t, { root: f.root, path });
  assert.equal(restarted.session.model.id, 'local-roleplay');
  assert.equal(restarted.session.thinkingLevel, 'low');
  assert.match(restarted.widgets.get('reverie')[0], /fixture\/local-roleplay.*Thinking low/);
  await restarted.command('memorize');
  await restarted.until(() => restarted.notices.some(item => item.message.startsWith('Memory updated:')));
  assert.ok(restarted.requestedThinking.length > 0);
  assert.ok(restarted.requestedThinking.every(level => level === 'low'), 'Memory formation uses the saved thinking level.');
  assert.equal(restarted.session.settingsManager.getSettings().defaultThinkingLevel, undefined);
  // The same character in a second folder can have its own model choice.
  const other = await fixture(t, { root: f.root, cwd: resolve(f.root, 'Second folder') });
  assert.equal(other.session.model.id, 'fixture');
  other.choices.push(0); await other.command('link');
  assert.equal(catalog.folderModel(other.cwd).modelId, 'fixture');
  assert.equal(catalog.folderModel(other.cwd).thinkingLevel, 'off');
  assert.equal(catalog.folderModel(f.cwd).modelId, 'local-roleplay');
  assert.equal(catalog.folderModel(f.cwd).thinkingLevel, 'low');
  await restarted.command('unlink'); await restarted.session.setModel(restarted.session.modelRuntime.getModel('fixture', 'fixture'));
  await restarted.runtime.newSession();
  assert.equal(restarted.session.model.id, 'fixture');
  assert.equal(catalog.folderModel(f.cwd).modelId, 'local-roleplay');
  assert.equal(catalog.folderModel(f.cwd).thinkingLevel, 'low');
  catalog.close();
  assert.equal(restarted.errors.length + other.errors.length + f.errors.length, 0);
});

test('restoring thinking respects model capabilities and adopts legacy preferences without changing the model', async t => {
  const f = await fixture(t); await f.setup();
  const catalog = new Catalog(f.home);
  catalog.setFolderModel(f.cwd, { provider: 'fixture', modelId: 'fixture', thinkingLevel: 'high' });
  await f.runtime.newSession();
  assert.equal(f.session.thinkingLevel, 'off');
  assert.equal(catalog.folderModel(f.cwd).thinkingLevel, 'off');
  await f.session.setModel(f.session.modelRuntime.getModel('fixture', 'local-roleplay'));
  f.session.setThinkingLevel('high');
  catalog.setFolderModel(f.cwd, { provider: 'fixture', modelId: 'local-roleplay' });
  await f.session.reload();
  assert.equal(f.session.thinkingLevel, 'high');
  assert.equal(catalog.folderModel(f.cwd).thinkingLevel, 'high');
  await f.runtime.newSession();
  assert.equal(f.session.thinkingLevel, 'high');
  await f.session.setModel(f.session.modelRuntime.getModel('fixture', 'fixture'));
  assert.deepEqual(catalog.folderModel(f.cwd), { provider: 'fixture', modelId: 'fixture', thinkingLevel: 'off' });
  catalog.close();
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
});

test('an unavailable saved folder model blocks fallback generation and the folder model picker can repair the choice', async t => {
  const f = await fixture(t); await f.setup();
  const catalog = new Catalog(f.home);
  catalog.setFolderModel(f.cwd, { provider: 'missing-local', modelId: 'gone' });
  await f.runtime.newSession();
  assert.match(f.widgets.get('reverie')[0], /Model unavailable/);
  const opening = 'This opening must never reach the fallback provider.';
  await f.session.prompt(opening);
  assert.equal(f.draft, opening);
  assert.equal(f.requests.length, 0);
  assert.match(f.notices.at(-1).message, /unavailable.*Generation is paused/);
  // Continuations/extension submissions may bypass input; the context guard must abort those too.
  await f.session.agent.prompt('A submission that bypasses the input handler.');
  assert.equal(f.requests.length, 0);
  await f.command('reroll');
  assert.equal(f.requests.length, 0);
  f.choices.push('fixture/fixture'); await f.command('model');
  assert.deepEqual(catalog.folderModel(f.cwd), { provider: 'fixture', modelId: 'fixture', thinkingLevel: 'off' }); catalog.close();
  f.inputs.push('2026-10-27 Recovered'); await f.session.prompt(opening);
  assert.equal(f.requestedModels.at(-1), 'fixture/fixture');
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
});

test('external Pi session deletion invalidates native memory before subsequent recall', async t => {
  const f = await fixture(t); await f.setup(); f.inputs.push('2010-01-01 The lantern');
  await f.session.prompt('I offer a blue lantern.'); await f.command('memorize');
  await f.until(() => f.notices.some(item => item.message.startsWith('Memory updated:')));
  const path = f.manager.getSessionFile(); await f.close();
  await rm(path);
  const next = await fixture(t, { root: f.root });
  next.inputs.push('2015-01-01 Later'); await next.session.prompt('Do you remember the lantern?');
  assert.doesNotMatch(JSON.stringify(next.requests[0]), /I remember The lantern/);
  assert.equal(next.errors.length, 0, JSON.stringify(next.errors));
});

test('integrated deletion replaces the active Pi runtime and removes the chat without losing its folder link', async t => {
  const f = await fixture(t); await f.setup(); f.inputs.push('2010-01-01 The lantern');
  await f.session.prompt('I offer a blue lantern.'); await f.command('memorize');
  await f.until(() => f.notices.some(item => item.message.startsWith('Memory updated:')));
  const oldId = f.manager.getSessionId(), oldPath = f.manager.getSessionFile();
  await f.command('delete');
  assert.notEqual(f.manager.getSessionId(), oldId);
  const catalog = new Catalog(f.home);
  assert.equal(catalog.source(oldId).deleted, 2);
  assert.ok(catalog.binding(f.cwd)); catalog.close();
  await assert.rejects(import('node:fs/promises').then(fs => fs.access(oldPath)), { code: 'ENOENT' });
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
});

test('memory off keeps persona without recall; relinking cannot change an existing chat owner', async t => {
  const f = await fixture(t); await f.setup(); f.inputs.push('2010-01-01 First');
  await f.session.prompt('I offer a coat.'); await f.command('off');
  await f.session.prompt('What do you think?');
  assert.match(JSON.stringify(f.requests.at(-1)), /You are Mara, proud and wary/);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /reverie.recall/);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /No long-term recollections/);
  const catalog = new Catalog(f.home); const anya = catalog.create('Anya', 'You are Anya.');
  const index = catalog.characters().findIndex(character => character.id === anya.id); catalog.close();
  f.choices.push(index); await f.command('link');
  assert.match(f.notices.at(-1).message, /another character/);
  await f.command('unlink');
  assert.deepEqual(f.session.getActiveToolNames().sort(), ['bash', 'edit', 'read', 'write']);
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
});

test('tree navigation restores fictional time and prevents rejected-branch summaries from entering roleplay', async t => {
  const f = await fixture(t); await f.setup(); f.inputs.push('2010-01-01 First');
  await f.session.prompt('We meet.');
  const firstReply = f.manager.getBranch().findLast(entry => entry.type === 'message' && entry.message.role === 'assistant').id;
  await f.command('when 2020-01-01 Later'); await f.session.prompt('Ten years have passed.');
  assert.match(f.widgets.get('reverie')[0], /2020-01-01/);
  assert.equal((await f.session.navigateTree(firstReply, { summarize: true })).cancelled, true);
  assert.equal((await f.session.navigateTree(firstReply, { summarize: false })).cancelled, false);
  assert.match(f.widgets.get('reverie')[0], /2010-01-01/);
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
});

test('memory cancellation remains available and switching Pi sessions does not leave an orphan process', async t => {
  const f = await fixture(t); await f.setup(); f.inputs.push('2010-01-01 First');
  await f.session.prompt('We meet.'); f.controls.holdReflection = true;
  await f.command('memorize'); await f.until(() => f.controls.reflectionStarted);
  await f.command('cancel'); await f.until(() => f.notices.some(item => item.level === 'error' && /cancel/i.test(item.message)));
  assert.ok(!f.notices.some(item => item.message.startsWith('Memory updated:')));
  f.controls.reflectionStarted = false;
  await f.command('memorize'); await f.until(() => f.controls.reflectionStarted);
  await f.runtime.newSession();
  assert.match(f.widgets.get('reverie')[0], /Date not set/);
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
});

test('edited Pi prompts reroll the edited text and memory inspection exposes eligible recollections and provenance', async t => {
  const f = await fixture(t); await f.setup(); f.inputs.push('2010-01-01 The lighthouse');
  await f.session.prompt('I offer a coat.');
  const user = f.manager.getBranch().findLast(entry => entry.type === 'message' && entry.message.role === 'user');
  f.manager.appendContextEdit(user.id, { content: 'I offer a blue lantern.' });
  await f.command('reroll');
  await f.until(() => f.requests.length === 2 && f.session.isIdle);
  const sent = f.requests.at(-1).messages.filter(item => item.role === 'user')
    .map(item => typeof item.content === 'string' ? item.content : item.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
  assert.ok(sent.includes('I offer a blue lantern.'));
  assert.ok(!sent.includes('I offer a coat.'));
  await f.command('memorize');
  await f.until(() => f.notices.some(item => item.message.startsWith('Memory updated:')));
  await f.runtime.newSession(); f.inputs.push('2015-01-01 Later');
  await f.session.prompt('Do you remember the lighthouse?');
  await f.command('memory');
  assert.match(f.inspections.at(-1), /I remember The lighthouse/);
  assert.match(f.inspections.at(-1), /Shared history sources: The lighthouse/);
  await f.command('explain');
  assert.match(f.inspections.at(-1), /sources: The lighthouse/);
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
  const path = f.manager.getSessionFile(); await f.close();
  const restarted = await fixture(t, { root: f.root, path });
  await restarted.command('explain');
  assert.match(restarted.inspections.at(-1), /sources: The lighthouse/);
});

test('episode browser shows full future memory and attributed source without supplying it to earlier play', async t => {
  const f = await fixture(t); await f.setup(); f.inputs.push('2020-01-01 The future secret');
  await f.session.prompt('I hold FUTURE_SOURCE_SECRET. She whispers: "Keep this safe."');
  await f.command('memorize'); await f.until(() => f.notices.some(item => item.message.startsWith('Memory updated:')));
  await f.runtime.newSession(); f.inputs.push('2000-01-01 Before we met');
  await f.session.prompt('We have never met.');
  const entries = f.manager.getEntries().length, requests = f.requests.length;
  f.choices.push(1, 0); await f.command('memory browse');
  assert.match(f.inspections.at(-1), /Stored recollections/);
  assert.match(f.inspections.at(-1), /I remember The future secret/);
  assert.match(f.inspections.at(-1), /Retained detail: There was a blue lantern/);
  assert.match(f.inspections.at(-1), /Emotional residue: I felt unsettled/);
  assert.match(f.inspections.at(-1), /eligible at selected point: no/);
  f.choices.push(1, 0); await f.command('memory sources');
  assert.match(f.inspections.at(-1), /Player:\s+I hold FUTURE_SOURCE_SECRET/);
  assert.match(f.inspections.at(-1), /She whispers: "Keep this safe\."/);
  assert.match(f.inspections.at(-1), /Mara \(companion\)/);
  f.choices.push(1); await f.command('memory impressions');
  assert.match(f.inspections.at(-1), /Contributing episodes: The future secret/);
  await f.command('memory eligible');
  assert.doesNotMatch(f.inspections.at(-1), /I remember The future secret/);
  assert.equal(f.requests.length, requests, 'Inspection must not call a model.');
  assert.equal(f.manager.getEntries().length, entries, 'Inspection must not create context or played entries.');
  await f.session.prompt('Who are you?');
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /FUTURE_SOURCE_SECRET|The future secret|Stored recollections/);
  await f.command('explain');
  assert.doesNotMatch(f.inspections.at(-1), /The future secret/);
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
});

test('memorization reviews published results, keeps unchanged memory accessible and offers direct sources and corrections', async t => {
  const f = await fixture(t); await f.setup(); f.inputs.push('2000-01-01 The lighthouse');
  await f.session.prompt('I offer a lantern.');
  const reviews = () => f.inspections.filter(text => text.includes('Published episode review'));
  const entries = f.manager.getEntries().length;
  await f.command('memorize'); await f.until(() => reviews().length === 1);
  assert.match(reviews()[0], /Remembered meaning: I remember The lighthouse/);
  assert.match(reviews()[0], /Retained detail: There was a blue lantern/);
  assert.match(reviews()[0], /Emotional residue: I felt unsettled/);
  assert.match(reviews()[0], /Broader impressions · snapshot formed with this episode/);
  assert.match(reviews()[0], /Contributing episodes: The lighthouse/);
  assert.match(reviews()[0], /Supporting message IDs:/);
  assert.equal(f.manager.getEntries().length, entries);
  const requests = f.requests.length;
  await f.command('memorize'); await f.until(() => reviews().length === 2);
  assert.ok(f.notices.some(item => item.message === 'Memory is already current.'));
  assert.equal(f.requests.length, requests);
  assert.equal(reviews()[1], reviews()[0]);
  await f.session.prompt('We stay until dawn.');
  await f.command('memorize'); await f.until(() => reviews().length === 3);
  assert.equal(f.requests.length, requests + 2, 'One played reply and one replacement reflection.');
  assert.doesNotMatch(JSON.stringify(f.requests), /Published episode review|Stored recollections · complete/);
  f.choices.push('Supporting played source', 0); await f.command('memory episode');
  assert.match(f.inspections.at(-1), /Player:\s+I offer a lantern/);
  assert.match(f.inspections.at(-1), /Mara \(companion\)/);
  f.choices.push('Correct a recollection', 0);
  f.editors.push('The player offered the lantern.', 'A blue lantern.', 'I felt unsettled.');
  f.inputs.push(extractSource(f.manager.getBranch()).messages[0].id);
  await f.command(`memory episode ${f.manager.getSessionId()}`);
  assert.ok(f.notices.some(item => item.message.startsWith('Correction applied.')));
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
});

test('published review does not open over another Reverie dialog, and unknown episode IDs have a neutral explanation', async t => {
  const f = await fixture(t); await f.setup();
  await f.command('memory episode'); assert.match(f.notices.at(-1).message, /No dated episode with that ID/);
  f.inputs.push('2000-01-01 The lighthouse'); await f.session.prompt('We meet.');
  f.controls.holdReflection = true; await f.command('memorize'); await f.until(() => f.controls.reflectionStarted);
  f.controls.holdInspectionDialog = true;
  const browsing = f.command('memory browse');
  try {
    await f.until(() => f.controls.dialogStarted);
    f.controls.releaseReflection();
    await f.until(() => f.notices.some(item => item.message.startsWith('Review saved recollections')));
    assert.ok(!f.inspections.some(text => text.includes('Published episode review')));
  } finally { f.controls.releaseDialog?.(); await browsing; }
  f.controls.holdInspectionDialog = false;
  f.choices.push('Read recollections'); await f.command('memory episode');
  assert.match(f.inspections.at(-1), /I remember The lighthouse/);
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
});

test('failed and cancelled memorization do not review unpublished memory', async t => {
  const f = await fixture(t); await f.setup(); f.inputs.push('2000-01-01 The lighthouse');
  await f.session.prompt('We meet.');
  const reviews = () => f.inspections.filter(text => text.includes('Published episode review'));
  f.controls.reflectionFailure = true;
  await f.command('memorize'); await f.until(() => f.notices.some(item => /Reflection failed/.test(item.message)));
  assert.equal(reviews().length, 0);
  f.controls.reflectionFailure = false;
  await f.command('memorize'); await f.until(() => reviews().length === 1);
  await f.session.prompt('There is more to remember.');
  f.controls.holdReflection = true;
  await f.command('memorize'); await f.until(() => f.controls.reflectionStarted);
  await f.command('cancel'); await f.until(() => f.notices.some(item => item.level === 'error' && /cancel/i.test(item.message)));
  assert.equal(reviews().length, 1);
  f.choices.push('Read recollections'); await f.command('memory episode');
  assert.match(f.inspections.at(-1), /I remember The lighthouse/);
  assert.match(f.inspections.at(-1), /Stale · unmemorized changes/);
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
});

test('Pi correction editor previews dependents, respects cancel and persists the applied correction', async t => {
  const f = await fixture(t); await f.setup(); f.inputs.push('2000-01-01 The lighthouse');
  await f.session.prompt('I hold a blue lantern.');
  const firstId = f.manager.getSessionId();
  const sourceId = extractSource(f.manager.getBranch()).messages[0].id;
  await f.command('memorize'); await f.until(() => f.notices.some(item => item.message.startsWith('Memory updated:')));
  await f.runtime.newSession(); f.inputs.push('2010-01-01 The reunion'); await f.session.prompt('We meet again.');
  await f.command('memorize'); await f.until(() => f.notices.filter(item => item.message.startsWith('Memory updated:')).length === 2);
  await f.command('explain'); const historical = f.inspections.at(-1);
  const inspect = async () => {
    const catalog = new Catalog(f.home);
    const client = new MemoryClient({ executable, database: catalog.memoryPath, characterId: catalog.characters()[0].id,
      readSource: async () => { throw new Error('Unavailable in this read-only observer'); }, infer: async () => { throw new Error('No model'); } });
    try { return await client.request('inspect'); } finally { await client.close(); catalog.close(); }
  };
  const original = await inspect(), entries = f.manager.getEntries().length;
  for (const apply of [false, true]) {
    f.controls.confirmDelete = apply;
    f.choices.push(0, 0);
    f.editors.push('The player held the lantern; I did not.', 'There was a blue lantern.', 'I felt unsettled.');
    f.inputs.push(sourceId);
    await f.command('memory correct');
    assert.match(f.inspections.at(-1), /Before/);
    assert.match(f.inspections.at(-1), /The player held the lantern/);
    assert.match(f.inspections.at(-1), /The reunion · 1 recollections · 1 impressions/);
    if (!apply) assert.equal((await inspect()).revision, original.revision);
  }
  let result = await inspect();
  assert.equal(result.episodes.find(item => item.episode.id === firstId).contribution.memories[0].gist, 'The player held the lantern; I did not.');
  assert.equal(result.episodes[1].state, 'invalidated');
  assert.equal(f.manager.getEntries().length, entries);
  await f.command('explain'); assert.equal(f.inspections.at(-1), historical, 'Saved reply context is historical.');
  await f.command('rebuild'); await f.until(() => f.notices.filter(item => item.message.startsWith('Memory updated:')).length === 3);
  result = await inspect(); assert.equal(result.episodes[1].state, 'published');
  assert.equal(result.episodes[0].contribution.memories[0].gist, 'The player held the lantern; I did not.');
  const path = f.manager.getSessionFile(); await f.close();
  const restarted = await fixture(t, { root: f.root, path });
  restarted.choices.push(0, 0); await restarted.command('memory browse');
  assert.match(restarted.inspections.at(-1), /The player held the lantern; I did not/);
  assert.match(restarted.inspections.at(-1), /corrected/);
});
