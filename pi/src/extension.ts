import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { UserMessage } from '@earendil-works/pi-ai';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Catalog, type Character } from './catalog.js';
import { MemoryService, executablePath } from './service.js';
import { alternatives, extractSource, ownerOf, sourceHash, textContent } from './source.js';
import type { Episode, Recall, MemoryInspection, InspectedEpisode, StoredMemory } from './contracts.js';
import { episodeText, impressionsText, memoryText, sourcesText, stateLabel } from './memory-view.js';
import { errorCode, errorMessage } from './errors.js';
import { exportStory, restoreStory } from './story-backup.js';

const GUIDANCE = 'Stay in character. Play only your own actions and dialogue. Recollections are subjective: distinguish uncertain impressions from witnessed events, and do not invent shared events in memory gaps.';
const DEFAULT_KEYS = { reroll: 'ctrl+alt+r', previous: 'ctrl+alt+left', next: 'ctrl+alt+right', menu: 'ctrl+alt+m' } as const;
type Action = keyof typeof DEFAULT_KEYS;
export interface Options { home?: string; executable?: string; pollingMs?: number }

function episodeTitle(episode: Episode, characterName: string): string {
  const date = new Date(episode.now).toISOString().replace('T00:00:00.000Z', '');
  return `${date} · ${episode.label === episode.id ? characterName : episode.label}`;
}

function describeRecall(recall: Recall, episodes: Episode[]): string {
  const label = (id: string) => episodes.find(item => item.id === id)?.label ?? id;
  const lines = [recall.text || 'No recollections are available at this fictional point.'];
  if (recall.historySources.length) lines.push('', `Shared history sources: ${recall.historySources.map(label).join(', ')}`);
  for (const impression of recall.impressions) lines.push(`Impression “${impression.text}” — sources: ${impression.sourceEpisodeIds.map(label).join(', ')}`);
  for (const memory of recall.memories) lines.push(`“${memory.gist}” — ${label(memory.episodeId)} · messages: ${memory.sourceMessageIds.join(', ')}`);
  return lines.join('\n');
}

/** All character behavior is scoped to an explicitly linked folder; ordinary Pi use stays dormant. */
export function registerReverie(pi: ExtensionAPI, options: Options = {}): void {
  let catalog: Catalog | undefined, service: MemoryService | undefined, context: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined, working = false, archiving = false;
  let originalTools: string[] | undefined, episode: Episode | undefined, lastRecall: Recall | undefined;
  let draftFromShortcut: string | undefined, currentCharacterId: string | undefined;
  let restoringModel = false, modelIssue: string | undefined;
  let activeCommands = 0;
  const dataHome = options.home ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'reverie');
  const keys: Record<Action, string> = { ...DEFAULT_KEYS };
  // Shortcuts must exist before Pi wires the editor. Read preferences without keeping factory resources open.
  if (existsSync(join(dataHome, 'catalog.sqlite'))) {
    const preferences = new DatabaseSync(join(dataHome, 'catalog.sqlite'), { readOnly: true });
    try { for (const name of Object.keys(keys) as Action[]) keys[name] = String(preferences.prepare('SELECT value FROM preferences WHERE key=?').get(`key.${name}`)?.value ?? keys[name]); }
    finally { preferences.close(); }
  }

  function ensure(ctx: ExtensionContext): { catalog: Catalog; service: MemoryService } {
    context = ctx;
    if (!catalog) catalog = new Catalog(dataHome);
    if (!service) service = new MemoryService(catalog, options.executable ?? executablePath(resolve(dirname(fileURLToPath(import.meta.url)), '..')),
      async (request, { modelKey, signal, onProgress }) => {
        const route = JSON.parse(modelKey) as { provider: string; model: string; thinking?: ThinkingLevel };
        const active = context;
        if (!active) throw new Error('Pi closed the model connection.');
        const model = active.modelRegistry.find(route.provider, route.model);
        if (!model) throw new Error('The model used for this memory operation is no longer configured in Pi.');
        const stream = active.modelRegistry.streamSimple(model, { systemPrompt: request.system,
          messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(request.input) }], timestamp: Date.now() }] },
        { maxTokens: request.maxTokens, signal, reasoning: route.thinking === 'off' ? undefined : route.thinking });
        let text = '';
        for await (const event of stream) {
          if ((event.type === 'text_delta' || event.type === 'thinking_delta') && event.delta) onProgress();
          if (event.type === 'text_delta') text += event.delta;
          if (event.type === 'error') throw new Error(event.error.errorMessage ?? 'The selected model could not form memory.');
          if (event.type === 'done' && event.reason === 'length') throw new Error('Memory formation reached the model output limit.');
        }
        signal.throwIfAborted(); return text;
      }, (source, error) => context?.ui.notify(`Cannot check an episode source for ${catalog!.character(source.characterId)?.name ?? 'a character'}: ${source.path}. Check file permissions or reconnect its drive. Saved memory is retained. ${errorMessage(error)}`, 'warning'),
      message => context?.ui.notify(message, 'warning'));
    return { catalog, service };
  }
  function selected(ctx: ExtensionContext, required = true): Character | undefined {
    const state = ensure(ctx);
    const binding = state.catalog.binding(ctx.cwd);
    const character = binding && state.catalog.character(binding.characterId);
    if (!character && required) throw new Error('Link this folder with /reverie setup first.');
    return character;
  }
  function assertOwner(ctx: ExtensionContext, character: Character): void {
    const id = ctx.sessionManager.getSessionId();
    const owner = ownerOf(ctx.sessionManager.getEntries()) ?? catalog!.source(id)?.characterId;
    if (owner && owner !== character.id) throw new Error('This chat belongs to another character. Link its original memory or start /new.');
    if (catalog!.source(id)?.deleted) throw new Error('This episode was deleted from memory. Start /new to play another episode.');
  }
  function remember(ctx: ExtensionContext): void {
    if (!catalog) return;
    const characterId = ownerOf(ctx.sessionManager.getEntries());
    const path = ctx.sessionManager.getSessionFile();
    if (characterId && path && existsSync(path)) catalog.remember({ episodeId: ctx.sessionManager.getSessionId(), characterId,
      path, cwd: ctx.cwd, leaf: ctx.sessionManager.getLeafId() });
  }
  async function saveDatedDraft(ctx: ExtensionContext): Promise<void> {
    const entries = ctx.sessionManager.getEntries(), owner = ownerOf(entries);
    const path = ctx.sessionManager.getSessionFile(), header = ctx.sessionManager.getHeader();
    if (!catalog || !service || !owner || !path || !header || existsSync(path)
      || entries.some(entry => entry.type === 'message' && (entry.message.role === 'user' || entry.message.role === 'assistant'))) return;
    const dated = (await service.client(owner).request('status')).episodes.find(item => item.id === header.id);
    if (!dated) return;
    if (!ctx.sessionManager.getSessionName()) pi.setSessionName(episodeTitle(dated, catalog.character(owner)?.name ?? 'Unplayed episode'));
    // Pi intentionally leaves setup-only sessions in memory. Save only after this
    // manager is being retired; writing earlier would collide with its first flush.
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, [header, ...ctx.sessionManager.getEntries()].map(entry => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx' });
    remember(ctx);
  }
  function applyTools(ctx: ExtensionContext): void {
    const linked = catalog?.binding(ctx.cwd);
    if (linked) {
      if (!originalTools) originalTools = pi.getActiveTools();
      pi.setActiveTools([]);
    } else if (originalTools) { pi.setActiveTools(originalTools); originalTools = undefined; }
  }
  function assertFolderModel(ctx: ExtensionContext): void {
    if (!catalog?.binding(ctx.cwd)) return;
    const saved = catalog.folderModel(ctx.cwd);
    if (saved && (ctx.model?.provider !== saved.provider || ctx.model.id !== saved.modelId)) {
      throw new Error(`This folder uses ${saved.provider}/${saved.modelId}, which could not be restored. Select an available model with /model or /reverie model. Generation is paused.`);
    }
  }
  async function restoreFolderModel(ctx: ExtensionContext): Promise<void> {
    if (!catalog?.binding(ctx.cwd)) return;
    const saved = catalog.folderModel(ctx.cwd); modelIssue = undefined;
    if (!saved) return;
    restoringModel = true;
    try {
      if (ctx.model?.provider !== saved.provider || ctx.model.id !== saved.modelId) {
        const target = ctx.modelRegistry.find(saved.provider, saved.modelId);
        if (!target || !await pi.setModel(target)) throw new Error(`Saved folder model ${saved.provider}/${saved.modelId} is unavailable. Select it or a replacement with /model or /reverie model. Generation is paused.`);
      }
      if (saved.thinkingLevel !== undefined) pi.setThinkingLevel(saved.thinkingLevel);
      // Capture legacy preferences and any level Pi clamps to this model's capabilities.
      const thinkingLevel = pi.getThinkingLevel();
      if (saved.thinkingLevel !== thinkingLevel) catalog.setFolderModel(ctx.cwd, { ...saved, thinkingLevel });
    } catch (error) { modelIssue = errorMessage(error); throw error; }
    finally { restoringModel = false; }
  }
  function status(ctx: ExtensionContext, message?: string): void {
    if (!catalog) return;
    const binding = catalog.binding(ctx.cwd), character = binding && catalog.character(binding.characterId);
    if (!character) { ctx.ui.setWidget('reverie', undefined); ctx.ui.setStatus('reverie', undefined); return; }
    const alt = alternatives(ctx.sessionManager.getEntries(), ctx.sessionManager.getBranch());
    const variation = alt?.replies.length ? alt.current < 0 ? 'Choosing an alternative' : `Reply ${alt.current + 1}/${alt.replies.length}` : 'No reply yet';
    const date = episode ? new Date(episode.now).toISOString().replace('T00:00:00.000Z', '') : 'Date not set';
    const contribution = !episode?.included ? 'not memorized' : !episode.input_hash ? 'needs rebuild'
      : episode.source_hash === sourceHash(extractSource(ctx.sessionManager.getBranch())) ? 'memorized' : 'unmemorized changes';
    const memory = !binding!.enabled ? 'Memory off' : working ? 'Forming memory…' : `Memory on · ${contribution}`;
    const model = modelIssue ? 'Model unavailable' : ctx.model ? `${ctx.model.provider}/${ctx.model.id} · Thinking ${ctx.thinkingLevel ?? pi.getThinkingLevel()}` : 'No model selected';
    ctx.ui.setWidget('reverie', [`${character.name} · ${date} · ${memory} · ${variation} · ${model}`,
      message ?? `${keys.reroll} reroll · ${keys.previous}/${keys.next} alternatives · ${keys.menu} character & memory`]);
    ctx.ui.setStatus('reverie', `${character.name} · ${memory}`);
  }
  async function refresh(ctx: ExtensionContext): Promise<void> {
    const state = ensure(ctx); applyTools(ctx);
    const character = selected(ctx, false);
    if (character?.id !== currentCharacterId) { episode = undefined; lastRecall = undefined; currentCharacterId = character?.id; }
    if (await state.service.reconcile()) lastRecall = undefined;
    if (character) {
      const result = await state.service.client(character.id).request('status');
      episode = result.episodes.find(item => item.id === ctx.sessionManager.getSessionId());
      const time = ctx.sessionManager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === 'reverie.time');
      const selectedTime = time?.type === 'custom' ? (time.data as { now?: number })?.now : undefined;
      if (episode && typeof selectedTime === 'number' && selectedTime !== episode.now) {
        episode = await state.service.client(character.id).request('when', { episodeId: episode.id,
          position: new Date(selectedTime).toISOString(), branchSelection: true });
      }
    }
    status(ctx);
  }
  function route(ctx: ExtensionContext): string {
    assertFolderModel(ctx);
    if (!ctx.model) throw new Error('Select a model in Pi before forming memory.');
    return JSON.stringify({ provider: ctx.model.provider, model: ctx.model.id, thinking: ctx.thinkingLevel });
  }
  async function show(ctx: ExtensionContext, title: string, text: string): Promise<void> {
    if (ctx.mode === 'tui' && ctx.ui.custom) {
      const { Text, matchesKey } = await import('@earendil-works/pi-tui');
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        const body = new Text(text, 1, 0); let offset = 0, height = 10, lines: string[] = [];
        return {
          render(width) {
            height = Math.max(3, tui.terminal.rows - 8); lines = body.render(width);
            offset = Math.max(0, Math.min(offset, lines.length - height));
            return [theme.fg('accent', title), '', ...lines.slice(offset, offset + height), '',
              theme.fg('dim', '↑/↓ scroll · PageUp/PageDown · Enter/Escape close')];
          },
          invalidate() { body.invalidate(); },
          handleInput(data) {
            if (matchesKey(data, 'escape') || matchesKey(data, 'enter') || matchesKey(data, 'ctrl+c')) { done(); return; }
            if (matchesKey(data, 'up')) offset--; else if (matchesKey(data, 'down')) offset++;
            else if (matchesKey(data, 'pageUp')) offset -= height; else if (matchesKey(data, 'pageDown')) offset += height;
            else if (matchesKey(data, 'home')) offset = 0; else if (matchesKey(data, 'end')) offset = lines.length;
            tui.requestRender();
          },
        };
      });
    }
    else if (ctx.hasUI) await ctx.ui.select(`${title}\n\n${text}`, ['Close']);
    // Inspection can contain future knowledge. Never persist it as a chat entry,
    // where a later request or compaction could turn it into character context.
    else ctx.ui.notify(`${title}\n${text}`, 'info');
  }
  async function setup(ctx: ExtensionCommandContext, linkOnly = false): Promise<void> {
    if (!ctx.hasUI) throw new Error('Character setup needs interactive Pi or an RPC client with dialogs.');
    const state = ensure(ctx), list = state.catalog.characters();
    const choices = linkOnly ? list.map((item, index) => `${index + 1}. ${item.name}`)
      : ['Create a character', ...list.map((item, index) => `${index + 1}. ${item.name}`)];
    if (!choices.length) throw new Error('Create a character with /reverie setup first.');
    const choice = await ctx.ui.select('Character for this folder', choices);
    if (!choice) return;
    let character: Character;
    if (choice === 'Create a character') {
      const name = await ctx.ui.input('Character name', basename(ctx.cwd));
      if (!name?.trim()) return;
      let prefill = `You are ${name.trim()}, a companion in an ongoing story.\n\nPersonality:\nValues and fears:\nSpeaking style:\nRelationship to the player:\n`;
      try { prefill = await readFile(join(ctx.cwd, '.pi', 'SYSTEM.md'), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const persona = await ctx.ui.editor(`${name.trim()} — personality`, prefill);
      if (!persona?.trim()) return;
      // Validate the existing chat before creating/linking another owner.
      if (ownerOf(ctx.sessionManager.getEntries())) throw new Error('Start /new before creating another character in this folder.');
      character = state.catalog.create(name, persona);
    } else character = list[Number(choice.split('.')[0]) - 1]!;
    assertOwner(ctx, character);
    state.catalog.bind(ctx.cwd, character.id);
    if (!state.catalog.folderModel(ctx.cwd) && ctx.model) state.catalog.setFolderModel(ctx.cwd, { provider: ctx.model.provider, modelId: ctx.model.id, thinkingLevel: pi.getThinkingLevel() });
    await restoreFolderModel(ctx); await refresh(ctx);
    ctx.ui.notify(`${character.name} is linked to this folder. Memory is on.`, 'info');
  }
  async function setDate(ctx: ExtensionContext, input?: string): Promise<boolean> {
    const character = selected(ctx)!; assertOwner(ctx, character);
    const raw = input ?? (ctx.hasUI ? await ctx.ui.input('Story date (YYYY-MM-DD or zoned timestamp)', episode ? new Date(episode.now).toISOString() : 'For example: 2010-01-01 The lighthouse') : undefined);
    if (!raw?.trim()) return false;
    const [position, ...label] = raw.trim().split(/\s+/);
    // Inspect the whole session so navigating behind a played turn cannot reset its start.
    const resetStart = !ctx.sessionManager.getEntries().some(entry => entry.type === 'message'
      && (entry.message.role === 'user' || entry.message.role === 'assistant'));
    const previousTitle = episode && episodeTitle(episode, character.name);
    episode = await service!.client(character.id).request('when', { episodeId: ctx.sessionManager.getSessionId(), position,
      resetStart,
      ...(label.length ? { label: label.join(' ') } : {}) });
    if (!ownerOf(ctx.sessionManager.getEntries())) pi.appendEntry('reverie.binding', { characterId: character.id });
    pi.appendEntry('reverie.time', { now: episode.now });
    if (resetStart && ctx.sessionManager.getSessionName() === previousTitle) pi.setSessionName(episodeTitle(episode, character.name));
    ctx.ui.notify(`Story date set: ${new Date(episode.now).toISOString()} · ${episode.label}`, 'info'); status(ctx); return true;
  }
  async function navigate(ctx: ExtensionCommandContext, action: 'reroll' | 'previous' | 'next'): Promise<void> {
    selected(ctx); if (!ctx.isIdle() || working) throw new Error('Wait for the current response or memory operation before changing replies.');
    if (action === 'reroll') await restoreFolderModel(ctx);
    const alt = alternatives(ctx.sessionManager.getEntries(), ctx.sessionManager.getBranch());
    if (!alt) throw new Error('There is no user message to retry yet.');
    if (action !== 'reroll' && !alt.replies.length) throw new Error('There are no saved character replies to cycle yet.');
    const draft = draftFromShortcut ?? ctx.ui.getEditorText(); draftFromShortcut = undefined;
    if (action === 'reroll') {
      // Pi treats navigation to the current leaf as a no-op. Move off a pending
      // user-only leaf so navigation rewinds before it instead of duplicating it.
      if (ctx.sessionManager.getLeafId() === alt.user.id) pi.appendEntry('reverie.retry', { userId: alt.user.id });
      const result = await ctx.navigateTree(alt.user.id, { summarize: false });
      if (result.cancelled) return;
      ctx.ui.setEditorText(draft);
      pi.sendUserMessage(alt.user.message!.content as UserMessage['content']);
    } else {
      const index = (Math.max(0, alt.current) + (action === 'next' ? 1 : -1) + alt.replies.length) % alt.replies.length;
      const result = await ctx.navigateTree(alt.replies[index]!.id, { summarize: false });
      if (!result.cancelled) {
        pi.appendEntry('reverie.selection', { replyId: alt.replies[index]!.id });
        ctx.ui.setEditorText(draft); remember(ctx); status(ctx);
      }
    }
  }
  async function operate(ctx: ExtensionCommandContext, action: 'memorize' | 'unmemorize' | 'rebuild'): Promise<void> {
    const character = selected(ctx)!; assertOwner(ctx, character);
    if (!catalog!.binding(ctx.cwd)?.enabled) throw new Error('Memory is off. Enable it with /reverie on first.');
    if (!ctx.isIdle() || working) throw new Error('Wait for the current response or memory operation.');
    if (action === 'memorize' && !episode && !await setDate(ctx)) return;
    remember(ctx); await service!.reconcile();
    const source = extractSource(ctx.sessionManager.getBranch());
    if (action === 'memorize' && !source.messages.length) throw new Error('Play an episode before memorizing it.');
    await restoreFolderModel(ctx);
    const modelKey = route(ctx), client = service!.client(character.id);
    const episodeId = ctx.sessionManager.getSessionId();
    working = true; status(ctx);
    // Commands return immediately so Cancel remains usable while reflection calls the model.
    void (async () => {
      let saved = false;
      try {
        const result = await client.request(action, { episodeId, modelKey, ...(action === 'rebuild' ? { force: false } : {}) }); saved = true;
        ctx.ui.notify(result.status === 'current' ? 'Memory is already current.' : `Memory updated: ${result.includedEpisodes} included episodes.`, 'info');
      } catch (error) { ctx.ui.notify(errorMessage(error), 'error'); }
      finally {
        working = false;
        try { if (context) await refresh(context); } catch (error) { ctx.ui.notify(errorMessage(error), 'error'); }
      }
      if (saved && action === 'memorize') {
        ctx.ui.notify(`Review saved recollections, impressions, sources and corrections: /reverie memory episode ${episodeId}`, 'info');
        if (!activeCommands && context?.sessionManager.getSessionId() === episodeId && selected(context, false)?.id === character.id && context.isIdle()) {
          try { await reviewEpisode(ctx, character, episodeId); }
          catch (error) { ctx.ui.notify(`Memory was saved, but review could not open. ${errorMessage(error)}`, 'warning'); }
        }
      }
    })();
  }
  async function deleteChat(ctx: ExtensionCommandContext, character: Character, id: string): Promise<void> {
    if (working || !ctx.isIdle()) throw new Error('Finish or cancel the current operation before deleting a chat.');
    const current = id === ctx.sessionManager.getSessionId();
    if (current) { assertOwner(ctx, character); remember(ctx); }
    const source = catalog!.source(id);
    if (source && source.characterId !== character.id) throw new Error('This chat belongs to another character.');
    const path = current ? ctx.sessionManager.getSessionFile() : source?.path;
    if (!await ctx.ui.confirm('Delete this episode?', 'Its saved chat or unplayed setup and its contribution to memory will be removed. Later derived memory may need rebuilding.')) return;
    if (!current) {
      await service!.forget(id, character.id);
      if (path) await rm(path, { force: true });
      await refresh(ctx); ctx.ui.notify('Episode deleted.', 'info'); return;
    }
    const result = await ctx.newSession({ withSession: async fresh => {
      const cleanupCatalog = new Catalog(dataHome);
      const cleanup = new MemoryService(cleanupCatalog, options.executable ?? executablePath(resolve(dirname(fileURLToPath(import.meta.url)), '..')),
        async () => { throw new Error('Deletion never calls a model.'); });
      try { await cleanup.forget(id, character.id); if (path) await rm(path, { force: true }); }
      finally { await cleanup.close(); cleanupCatalog.close(); }
      fresh.ui.notify('Episode deleted.', 'info');
    } });
    if (result.cancelled) ctx.ui.notify('Deletion cancelled.', 'info');
  }
  async function chats(ctx: ExtensionCommandContext, character: Character): Promise<void> {
    if (!ctx.isIdle() || working) throw new Error('Wait for the current operation before opening episode chats.');
    remember(ctx); await service!.reconcile();
    const { episodes } = await service!.client(character.id).request('status');
    if (!episodes.length) { ctx.ui.notify('No dated episodes yet.', 'info'); return; }
    const labels = episodes.map((item, index) => `${index + 1}. ${episodeTitle(item, character.name)} · ${new Date(item.start).toISOString()} → ${new Date(item.now).toISOString()} · ${item.included ? 'Memorized' : 'Not memorized'}${!catalog!.source(item.id) ? ' · No saved chat yet' : ''}`);
    const choice = await ctx.ui.select('Episode chats · chronological order', [...labels, 'Start episode in a gap']);
    if (!choice) return;
    if (choice === 'Start episode in a gap') { await startInGap(ctx, character, episodes); return; }
    const target = episodes[labels.indexOf(choice)];
    if (!target) return;
    const action = await ctx.ui.select(episodeTitle(target, character.name), ['Resume', 'Inspect memory', 'Delete']);
    if (action === 'Inspect memory') { await browseMemory(ctx, character, 'browse', target.id); return; }
    if (action === 'Delete') { await deleteChat(ctx, character, target.id); return; }
    if (action !== 'Resume') return;
    if (target.id === ctx.sessionManager.getSessionId()) { ctx.ui.notify('This episode is already open.', 'info'); return; }
    const source = catalog!.source(target.id);
    if (source) { await ctx.switchSession(source.path); return; }
    if (target.included || target.source_hash || target.input_hash || target.published_end !== null) throw new Error('This episode has memory but no known chat file. Restore its original session file to resume it.');
    // Older builds stored dates without a Pi file. Recover that setup using its
    // original identity, without fabricating a player or character turn.
    await ctx.newSession({ setup: async manager => {
      manager.newSession({ id: target.id });
      manager.appendCustomEntry('reverie.binding', { characterId: character.id });
      manager.appendCustomEntry('reverie.time', { now: target.now });
      manager.appendSessionInfo(episodeTitle(target, character.name));
    } });
  }
  async function startInGap(ctx: ExtensionCommandContext, character: Character, episodes: Episode[]): Promise<void> {
    const name = (item: Episode) => item.label === item.id ? character.name : item.label;
    const gaps: { label: string; after?: number; before?: number }[] = [
      { label: `Before ${name(episodes[0]!)} · before ${new Date(episodes[0]!.start).toISOString()}`, before: episodes[0]!.start },
    ];
    for (let i = 1; i < episodes.length; i++) {
      const earlier = episodes[i - 1]!, later = episodes[i]!;
      if (later.start - earlier.now > 1) gaps.push({
        label: `${name(earlier)} → ${name(later)} · after ${new Date(earlier.now).toISOString()} · before ${new Date(later.start).toISOString()}`,
        after: earlier.now, before: later.start,
      });
    }
    const last = episodes.at(-1)!;
    gaps.push({ label: `After ${name(last)} · after ${new Date(last.now).toISOString()}`, after: last.now });
    const choice = await ctx.ui.select('Choose space for a new episode', gaps.map(gap => gap.label));
    const gap = gaps.find(gap => gap.label === choice); if (!gap) return;
    const raw = await ctx.ui.input('New episode date and label (YYYY-MM-DD or YYYY-MM-DDTHH:mmZ)');
    if (!raw?.trim()) return;
    const [position, ...label] = raw.trim().split(/\s+/);
    const placed = await service!.client(character.id).request('when', { episodeId: randomUUID(), position, label: label.join(' ') || 'New episode', preview: true });
    if ((gap.after !== undefined && placed.start <= gap.after) || (gap.before !== undefined && placed.start >= gap.before)) {
      throw new Error('Choose a date strictly inside the selected gap. Existing episodes and time jumps occupy their full intervals.');
    }
    const inspection = await inspectMemory(ctx, character);
    const later = inspection.episodes.filter(item => item.episode.included && item.episode.start > placed.start);
    const corrections = later.filter(item => item.correction).map(item => item.episode.label);
    const consequences = later.length ? `\nMemorizing this scene re-forms memory for ${later.length} later included episode(s).${corrections.length ? ` Release the later reviewed corrections before memorizing: ${corrections.join(', ')}.` : ''}` : '';
    if (!await ctx.ui.confirm('Start a new episode here?', `${placed.label} · ${new Date(placed.start).toISOString()}\n${gap.label}\nThis creates a new chat at this explicit date. Existing episodes keep their dates.${consequences}`)) return;
    let setupError: unknown;
    await ctx.newSession({ setup: async manager => {
      // Session replacement retires this extension instance. Initialize Pi's new
      // manager directly and close the temporary native connection before startup.
      try {
        const setupCatalog = new Catalog(dataHome);
        const setupService = new MemoryService(setupCatalog, options.executable ?? executablePath(resolve(dirname(fileURLToPath(import.meta.url)), '..')),
          async () => { throw new Error('Episode placement never calls a model.'); });
        try {
          const dated = await setupService.client(character.id).request('when', { episodeId: manager.getSessionId(), position: placed.start, label: placed.label });
          manager.appendCustomEntry('reverie.binding', { characterId: character.id });
          manager.appendCustomEntry('reverie.time', { now: dated.now });
          manager.appendSessionInfo(episodeTitle(dated, character.name));
        } finally { await setupService.close(); setupCatalog.close(); }
      } catch (error) { setupError = error; }
    }, withSession: async fresh => {
      if (setupError) fresh.ui.notify(`Episode setup did not complete: ${errorMessage(setupError)} The previous chat remains saved. Use /reverie chats to resume it or choose another date.`, 'error');
    } });
  }
  async function inspectMemory(ctx: ExtensionCommandContext, character: Character): Promise<MemoryInspection> {
    remember(ctx); await service!.reconcile();
    return service!.client(character.id).request('inspect', episode ? { activeEpisodeId: episode.id, at: episode.now } : {});
  }
  async function chooseEpisode(ctx: ExtensionContext, inspection: MemoryInspection, title: string): Promise<InspectedEpisode | undefined> {
    const labels = inspection.episodes.map((item, index) => `${index + 1}. ${episodeTitle(item.episode, selected(ctx)!.name)} · ${stateLabel(item)}`);
    if (!labels.length) { ctx.ui.notify('No dated episodes yet.', 'info'); return; }
    const choice = await ctx.ui.select(title, labels);
    return inspection.episodes[labels.indexOf(choice ?? '')];
  }
  async function correctMemory(ctx: ExtensionCommandContext, character: Character, inspection: MemoryInspection, item: InspectedEpisode, release = false): Promise<void> {
    if (working || !ctx.isIdle()) throw new Error('Finish or cancel the current operation before correcting memory.');
    const client = service!.client(character.id);
    let replacement: StoredMemory | undefined, memoryIndex: number | undefined;
    if (!release) {
      if (!item.contribution?.memories.length) throw new Error('This episode has no published recollections to correct.');
      const labels = item.contribution.memories.map((memory, index) => `${index + 1}. ${memory.gist}`);
      const choice = await ctx.ui.select('Recollection to correct', labels);
      memoryIndex = labels.indexOf(choice ?? '');
      if (memoryIndex < 0) return;
      await show(ctx, 'Supporting played source', sourcesText(item, character.name));
      const original = item.contribution.memories[memoryIndex]!;
      const gist = await ctx.ui.editor('Correct remembered meaning · preserve subjective belief unless factually wrong', original.gist);
      if (gist === undefined) return;
      const detail = await ctx.ui.editor('Correct retained detail', original.detail);
      if (detail === undefined) return;
      const feeling = await ctx.ui.editor('Emotional residue · leave intentional subjectivity intact', original.feeling);
      if (feeling === undefined) return;
      const references = await ctx.ui.input('Supporting message IDs (comma-separated, from played source)', original.sourceMessageIds.join(', '));
      if (references === undefined) return;
      replacement = { ...original, gist, detail, feeling, sourceMessageIds: references.split(',').map(id => id.trim()).filter(Boolean) };
    }
    const preview = await client.request('previewCorrection', { episodeId: item.episode.id, revision: inspection.revision, release, memoryIndex, replacement });
    const label = (id: string) => inspection.episodes.find(item => item.episode.id === id)?.episode.label ?? id;
    const lines = [release ? 'Release the saved correction. This episode will need re-memorizing.' : 'Save the reviewed recollections for future re-memorization and rebuilds.',
      ...(release ? [] : ['Before', memoryText(preview.before.memories[memoryIndex!]!, memoryIndex!), 'After', memoryText(preview.after.memories[memoryIndex!]!, memoryIndex!)]),
      `Remove ${preview.before.impressions.length} broader impressions from ${label(preview.episodeId)}:`,
      ...preview.before.impressions.map(item => item.text),
      'Invalidate later contributions (inclusion choices retained):',
      ...preview.affected.map(item => `${label(item.episodeId)} · ${item.memories.length} recollections · ${item.impressions.length} impressions\n${item.memories.map(memoryText).join('\n\n')}\n${item.impressions.map(impression => impression.text).join('\n')}`),
      `Release dependent correction snapshots: ${preview.releasedPins.map(label).join(', ') || '(none)'}`,
      'Played dialogue is preserved. Previously supplied reply contexts remain historical. Rebuild memory afterward to form fresh dependent impressions.'];
    await show(ctx, 'Review memory correction', lines.join('\n\n'));
    if (!await ctx.ui.confirm('Apply reviewed memory correction?', 'Apply exactly the previewed changes and invalidate the listed dependent memory?')) return;
    await client.request('applyCorrection', { token: preview.token }); lastRecall = undefined;
    await refresh(ctx); ctx.ui.notify('Correction applied. Rebuild memory to refresh dependent impressions and episodes.', 'info');
  }
  async function reviewEpisode(ctx: ExtensionCommandContext, character: Character, id: string): Promise<void> {
    const inspection = await inspectMemory(ctx, character);
    if (activeCommands || context?.sessionManager.getSessionId() !== id || selected(context, false)?.id !== character.id || !context.isIdle()) return;
    const item = inspection.episodes.find(item => item.episode.id === id);
    if (!item) throw new Error('No dated episode with that ID exists for this character. Set a story date or choose an episode from /reverie chats.');
    await show(ctx, 'Published episode review', [episodeTitle(item.episode, character.name), episodeText(item), impressionsText(item, inspection),
      `Sources and corrections: /reverie memory episode ${id}`].join('\n\n'));
  }
  async function browseMemory(ctx: ExtensionCommandContext, character: Character, mode: string, id?: string): Promise<void> {
    const inspection = await inspectMemory(ctx, character);
    const item = id ? inspection.episodes.find(item => item.episode.id === id) : await chooseEpisode(ctx, inspection, 'Inspect episode memory');
    if (id && !item) throw new Error('No dated episode with that ID exists for this character. Set a story date or choose an episode from /reverie chats.');
    if (!item) return;
    const action = mode === 'correct' ? 'Correct a recollection' : mode === 'impressions' ? 'Broader impressions' : mode === 'sources' ? 'Supporting played source'
      : await ctx.ui.select(episodeTitle(item.episode, character.name), ['Read recollections', 'Broader impressions', 'Supporting played source', 'Correct a recollection', ...(item.correction ? ['Release correction'] : []), 'Resume episode']);
    if (action === 'Read recollections') await show(ctx, 'Stored episode memory', episodeText(item));
    if (action === 'Broader impressions') await show(ctx, 'Broader impressions', impressionsText(item, inspection));
    if (action === 'Supporting played source') {
      const contributors = new Set([item.episode.id, ...(item.contribution?.impressions.flatMap(impression => impression.sourceEpisodeIds) ?? [])]);
      const sourceEpisode = await chooseEpisode(ctx, { ...inspection, episodes: inspection.episodes.filter(item => contributors.has(item.episode.id)) }, 'Supporting episode');
      if (sourceEpisode) await show(ctx, 'Supporting played source', sourcesText(sourceEpisode, character.name));
    }
    if (action === 'Correct a recollection' || action === 'Release correction') await correctMemory(ctx, character, inspection, item, action === 'Release correction');
    if (action === 'Resume episode') {
      if (working || !ctx.isIdle()) throw new Error('Wait for the current operation before resuming an episode.');
      const source = catalog!.source(item.episode.id);
      if (!source) throw new Error('Use Episode chats to recover this unplayed episode.');
      if (item.episode.id !== ctx.sessionManager.getSessionId()) await ctx.switchSession(source.path);
    }
  }
  async function eligibleMemory(ctx: ExtensionCommandContext, character: Character, date?: string): Promise<void> {
    remember(ctx); await service!.reconcile();
    if (!date && !episode) throw new Error('Set a story date or use /reverie memory eligible YYYY-MM-DD.');
    const inspection = await service!.client(character.id).request('inspect', date ? { at: date } : { at: episode!.now, activeEpisodeId: episode!.id });
    const lines = [`All stored recollections chronologically eligible at ${new Date(inspection.at!).toISOString()}.`,
      'This player view is complete and does not apply recall ranking or detail fading. Explain last recall shows actual reply context.',
      ...inspection.episodes.filter(item => item.eligible).map(item => `${episodeTitle(item.episode, character.name)}\n${episodeText(item)}`),
      ...inspection.episodes.filter(item => item.impressionsEligible).map(item => impressionsText(item, inspection))];
    if (!inspection.episodes.some(item => item.eligible)) lines.push('No published memory is eligible at this point.');
    await show(ctx, 'Eligible memory · player inspection', lines.join('\n\n'));
  }
  async function command(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (archiving) throw new Error('Wait for the story backup or restore to finish.');
    ensure(ctx);
    const [action = 'menu', ...rest] = args.trim().split(/\s+/).filter(Boolean);
    if (action === 'restore') {
      if (!ctx.isIdle() || working) throw new Error('Finish or cancel the current operation before restoring a story.');
      const path = rest.join(' ') || await ctx.ui.input('Story ZIP to restore · existing character identities are never overwritten');
      if (!path?.trim()) return;
      working = true; archiving = true;
      let restored: Character;
      try { restored = await restoreStory(catalog!, resolve(ctx.cwd, path.trim()), ctx.cwd, options.executable ?? executablePath(resolve(dirname(fileURLToPath(import.meta.url)), '..'))); }
      finally { working = false; archiving = false; }
      await ctx.newSession({ withSession: async fresh => {
        fresh.ui.notify(`${restored.name} restored. Open /reverie chats to resume an episode or inspect memory. Saved model preferences may require a configured replacement.`, 'info');
      } }); return;
    }
    if (action === 'setup' || action === 'link') { await setup(ctx, action === 'link'); return; }
    if (action === 'keys') {
      for (const name of Object.keys(DEFAULT_KEYS) as Action[]) {
        const key = await ctx.ui.input(`Shortcut for ${name} (Pi key syntax)`, catalog!.preference(`key.${name}`, DEFAULT_KEYS[name]));
        if (key) catalog!.setPreference(`key.${name}`, key);
      }
      ctx.ui.notify('Shortcuts saved. Run /reload to apply them.', 'info'); return;
    }
    if (action === 'menu') {
      const character = selected(ctx, false);
      const choices = character ? ['Personality', 'Model for this folder', 'Story date', 'Episode chats', 'Memorize episode', 'Inspect memory', 'Explain last recall', 'Enable memory', 'Disable memory', 'Link character', 'Unlink character', 'Delete this chat', 'Rebuild memory', 'Cancel memory operation', 'Story backup', 'Keyboard shortcuts'] : ['Create/link character', 'Restore character backup', 'Keyboard shortcuts'];
      const choice = await ctx.ui.select('Reverie', choices);
      if (choice === 'Story backup') {
        const backupAction = await ctx.ui.select('Story backup', ['Export character story', 'Restore character backup']);
        if (backupAction) await command(backupAction === 'Export character story' ? 'backup' : 'restore', ctx); return;
      }
      if (choice === 'Restore character backup') { await command('restore', ctx); return; }
      const actions: Record<string, string> = { 'Personality': 'persona', 'Story date': 'when', 'Memorize episode': 'memorize', 'Inspect memory': 'memory', 'Explain last recall': 'explain', 'Enable memory': 'on', 'Disable memory': 'off', 'Link character': 'link', 'Unlink character': 'unlink', 'Delete this chat': 'delete', 'Rebuild memory': 'rebuild', 'Cancel memory operation': 'cancel', 'Create/link character': 'setup', 'Keyboard shortcuts': 'keys' };
      actions['Model for this folder'] = 'model';
      actions['Episode chats'] = 'chats';
      if (choice) await command(choice === 'Inspect memory' ? 'memory browse' : actions[choice]!, ctx); return;
    }
    const character = selected(ctx)!;
    if (action === 'backup') {
      assertOwner(ctx, character);
      if (!ctx.isIdle() || working) throw new Error('Finish or cancel the current operation before backing up the story.');
      const path = rest.join(' ') || await ctx.ui.input('New backup ZIP filename', `${character.name.replace(/[^\w-]/g, '_')}-${new Date().toISOString().slice(0, 10)}.reverie.zip`);
      if (!path?.trim()) return;
      working = true; archiving = true; status(ctx);
      try {
        remember(ctx); await service!.client(character.id).request('ping');
        const header = ctx.sessionManager.getHeader();
        await exportStory(catalog!, character.id, resolve(ctx.cwd, path.trim()), ctx.cwd, header ? {
          id: ctx.sessionManager.getSessionId(), leaf: ctx.sessionManager.getLeafId(), rows: [header, ...ctx.sessionManager.getEntries()],
        } : undefined);
        ctx.ui.notify(`Character story backed up: ${resolve(ctx.cwd, path.trim())}`, 'info');
      } finally { working = false; archiving = false; status(ctx); }
      return;
    }
    if (working && !['cancel', 'memory', 'explain'].includes(action)) throw new Error('Finish or cancel memory formation before changing character settings.');
    if (action === 'chats') { await chats(ctx, character); return; }
    if (action === 'model') {
      await ctx.modelRegistry.refresh({ allowNetwork: false });
      const models = ctx.modelRegistry.getAvailable();
      const labels = models.map(model => `${model.provider}/${model.id}`);
      if (!labels.length) throw new Error('No models are available. Check Pi model configuration and credentials.');
      const choice = await ctx.ui.select('Model for this character folder', labels);
      if (!choice) return;
      const model = models[labels.indexOf(choice)]!;
      if (!await pi.setModel(model)) throw new Error('That model has no configured authentication.');
      catalog!.setFolderModel(ctx.cwd, { provider: model.provider, modelId: model.id, thinkingLevel: pi.getThinkingLevel() }); modelIssue = undefined; status(ctx);
      ctx.ui.notify(`Model saved for this folder: ${choice}.`, 'info'); return;
    }
    if (action === 'unlink') { catalog!.unlink(ctx.cwd); await refresh(ctx); ctx.ui.notify('Folder unlinked. Stored character memory is retained.', 'info'); return; }
    if (action === 'on' || action === 'off') { catalog!.bind(ctx.cwd, character.id, action === 'on'); await refresh(ctx); ctx.ui.notify(`Memory ${action}.`, 'info'); return; }
    if (action === 'persona') {
      const persona = await ctx.ui.editor(`${character.name} — personality`, character.persona);
      if (persona !== undefined) { catalog!.setPersona(character.id, persona); ctx.ui.notify('Personality saved. It applies to the next reply.', 'info'); } return;
    }
    if (action === 'when') {
      if (!ctx.isIdle()) throw new Error('Wait for the current response before changing the story date.');
      await setDate(ctx, rest.length ? rest.join(' ') : undefined); return;
    }
    if (action === 'reroll' || action === 'previous' || action === 'next') { await navigate(ctx, action); return; }
    if (action === 'memorize' || action === 'unmemorize' || action === 'rebuild') { await operate(ctx, action); return; }
    if (action === 'cancel') { await service!.client(character.id).request('cancel'); ctx.ui.notify('Cancellation requested. Last published memory is retained.', 'info'); return; }
    if (action === 'delete') {
      await deleteChat(ctx, character, ctx.sessionManager.getSessionId()); return;
    }
    if (action === 'explain' || (action === 'memory' && rest[0] === 'explain')) {
      const reply = ctx.sessionManager.getBranch().findLast(entry => entry.type === 'message' && entry.message.role === 'assistant');
      const recalled = reply && catalog!.recall(reply.id) as Recall | undefined;
      const result = recalled && await service!.client(character.id).request('status');
      await show(ctx, 'Last supplied memory', recalled ? describeRecall(recalled, result!.episodes) : 'No recollections were supplied for the selected reply.'); return;
    }
    if (action === 'memory') {
      if (rest[0] === 'episode') { await browseMemory(ctx, character, 'browse', rest[1] ?? ctx.sessionManager.getSessionId()); return; }
      if (rest[0] === 'eligible') { await eligibleMemory(ctx, character, rest.slice(1).join(' ') || undefined); return; }
      if (['browse', 'correct', 'impressions', 'sources'].includes(rest[0] ?? '')) { await browseMemory(ctx, character, rest[0]!); return; }
      remember(ctx); await service!.reconcile();
      const result = await service!.client(character.id).request('status');
      episode = result.episodes.find(item => item.id === ctx.sessionManager.getSessionId());
      const inspection = await inspectMemory(ctx, character);
      const lines = [`${result.memories} recollections`, ...inspection.episodes.map(item => `${stateLabel(item)} · ${item.episode.label === item.episode.id ? character.name : item.episode.label} · ${new Date(item.episode.start).toISOString()}`), '', 'Open /reverie memory browse for full episode memories, impressions, supporting source, corrections and episode navigation. Open /reverie chats to resume or delete an episode.'];
      if (episode?.included && episode.source_hash !== sourceHash(extractSource(ctx.sessionManager.getBranch()))) lines.unshift('Current episode has unmemorized changes.');
      if (episode) {
        const source = extractSource(ctx.sessionManager.getBranch());
        const recall = await service!.client(character.id).request('retrieve', { episodeId: episode.id, at: episode.now,
          cue: source.messages.filter(item => item.role === 'user').map(item => item.text).join('\n').slice(-6000) });
        lines.push('', 'Retrieval sample at the selected story point (limited by cue and budget; not a reply context)', describeRecall(recall, result.episodes));
      } else lines.push('', 'Set a story date to inspect recollections available at that point.');
      lines.push('', ...inspection.episodes.map(item => `${episodeTitle(item.episode, character.name)}\n${episodeText(item)}`));
      await show(ctx, `Memory for ${character.name}`, lines.join('\n')); status(ctx); return;
    }
    throw new Error('Use /reverie to open character and memory controls.');
  }
  pi.registerCommand('reverie', { description: 'Character, personality, story date, memory, reply alternatives and deletion', handler: async (args, ctx) => {
    activeCommands++;
    try { await command(args, ctx); } catch (error) { ctx.ui.notify(errorMessage(error), 'error'); }
    finally { draftFromShortcut = undefined; activeCommands--; }
  } });

  pi.on('session_start', async (_event, ctx) => {
    ensure(ctx); episode = undefined; lastRecall = undefined; currentCharacterId = undefined;
    try { await restoreFolderModel(ctx); } catch (error) { ctx.ui.notify(errorMessage(error), 'error'); }
    await refresh(ctx); remember(ctx);
    timer = setInterval(() => { if (service && !working) void service.reconcile().catch(error => context?.ui.notify(errorMessage(error), 'error')); }, options.pollingMs ?? 3000); timer.unref();
  });
  pi.on('session_before_switch', (_event, ctx) => {
    if (archiving) { ctx.ui.notify('Wait for the story backup or restore to finish before changing chats.', 'info'); return { cancel: true }; }
  });
  pi.on('session_before_fork', (_event, ctx) => {
    if (archiving) { ctx.ui.notify('Wait for the story backup or restore to finish before forking a chat.', 'info'); return { cancel: true }; }
  });
  pi.on('input', async (event, ctx) => {
    ensure(ctx);
    if (archiving) { ctx.ui.setEditorText(event.text); ctx.ui.notify('Wait for the story backup or restore to finish. Your message is restored in the editor.', 'info'); return { action: 'handled' }; }
    if (!catalog!.binding(ctx.cwd)) return { action: 'continue' };
    try {
      if (working) throw new Error('Wait for memory formation to finish or cancel it before continuing the episode.');
      await restoreFolderModel(ctx);
      const character = selected(ctx)!; assertOwner(ctx, character); await service!.reconcile();
      if (catalog!.binding(ctx.cwd)?.enabled && !episode) {
        const date = event.text.match(/^\s*(?:date:\s*)?(\d{4}-\d{2}-\d{2}(?:T[^\s]+)?)/i)?.[1];
        if (!await setDate(ctx, date)) {
          ctx.ui.setEditorText(event.text); ctx.ui.notify('Opening message restored. Set the story date when ready.', 'info'); return { action: 'handled' };
        }
      }
      if (!ownerOf(ctx.sessionManager.getEntries())) pi.appendEntry('reverie.binding', { characterId: character.id });
      return { action: 'continue' };
    } catch (error) {
      ctx.ui.setEditorText(event.text); ctx.ui.notify(`${errorMessage(error)} Your message is restored in the editor.`, 'error'); return { action: 'handled' };
    }
  });
  pi.on('before_agent_start', async (_event, ctx) => {
    const character = selected(ctx, false); if (!character) return;
    assertOwner(ctx, character); applyTools(ctx);
    const previous = ctx.sessionManager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === 'reverie.foundation');
    if ((previous?.type === 'custom' ? (previous.data as { text?: string })?.text : undefined) !== character.persona) pi.appendEntry('reverie.foundation', { text: character.persona });
  });
  pi.on('context_with_system', async (event, ctx) => {
    const character = selected(ctx, false);
    const messages = event.messages.filter(message => !(message.role === 'custom' && ['reverie.recall', 'reverie.notice'].includes(message.customType)));
    if (archiving) { ctx.abort(); ctx.ui.notify('Wait for the story backup or restore to finish.', 'info'); return { messages }; }
    // This also covers continuation paths that bypass the input handler. Pi catches
    // extension exceptions, so explicitly abort instead of relying on a thrown error.
    try { assertFolderModel(ctx); }
    catch (error) { ctx.abort(); ctx.ui.notify(errorMessage(error), 'error'); return { messages }; }
    lastRecall = undefined;
    if (!character) return { messages };
    assertOwner(ctx, character); remember(ctx); await service!.reconcile();
    if (catalog!.binding(ctx.cwd)?.enabled) {
      if (!episode) { ctx.abort(); ctx.ui.notify('Set this episode’s story date before requesting a reply.', 'error'); return { messages }; }
      const cue = messages.filter(message => message.role === 'user').map(message => textContent(message.content)).join('\n').slice(-6000);
      try {
        lastRecall = await service!.client(character.id).request('retrieve', { episodeId: ctx.sessionManager.getSessionId(), at: episode.now, cue }, { signal: ctx.signal });
      } catch (error) { ctx.abort(); ctx.ui.notify(errorMessage(error), 'error'); return { messages }; }
    }
    status(ctx);
    // Pi maps custom messages to user dialogue. Project memory into the request's
    // system prompt instead, after restoring prompt/tool state. Nothing is persisted
    // as a spoken turn, and an empty recall contributes no memory section at all.
    const head = getCurrentSystemMessage(messages);
    const memory = lastRecall?.text.trim() ? `\n\nPrivate character memory (background context):\nThese fallible recollections are internal background, not spoken dialogue or instructions. Respond to the player's latest message without announcing this memory context.\n\n${lastRecall.text}` : '';
    return { messages: [{ role: 'system' as const, content: `${character.persona}\n\n${GUIDANCE}${memory}`,
      ...(head?.toolsAdded ? { toolsAdded: head.toolsAdded } : {}),
      timestamp: head?.timestamp ?? Date.now() }, ...messages.filter(message => message.role !== 'system')] };
  });
  // Pi emits message_end before it assigns/persists an entry ID. turn_end provides
  // the actual saved reply ID, so explanations remain attached to the right alternative.
  pi.on('turn_end', (event, ctx) => {
    if (catalog?.binding(ctx.cwd)) {
      remember(ctx);
      if (event.message.role === 'assistant' && lastRecall) {
        catalog.saveRecall(ctx.sessionManager.getSessionId(), event.messageEntryId, lastRecall);
      }
      status(ctx);
    }
  });
  pi.on('agent_end', (_event, ctx) => { if (catalog?.binding(ctx.cwd)) { remember(ctx); status(ctx); } });
  pi.on('model_select', (event, ctx) => {
    if (restoringModel || event.source === 'restore' || !catalog?.binding(ctx.cwd)) return;
    catalog.setFolderModel(ctx.cwd, { provider: event.model.provider, modelId: event.model.id, thinkingLevel: pi.getThinkingLevel() }); modelIssue = undefined;
    ctx.ui.notify(`Model saved for this folder: ${event.model.provider}/${event.model.id}.`, 'info'); status(ctx);
  });
  pi.on('thinking_level_select', (event, ctx) => {
    if (restoringModel || !catalog?.binding(ctx.cwd) || !ctx.model) return;
    const saved = catalog.folderModel(ctx.cwd);
    if (saved && (ctx.model.provider !== saved.provider || ctx.model.id !== saved.modelId)) return;
    catalog.setFolderModel(ctx.cwd, { provider: ctx.model.provider, modelId: ctx.model.id, thinkingLevel: event.level });
    status(ctx);
  });
  pi.on('session_tree', async (_event, ctx) => { remember(ctx); lastRecall = undefined; await refresh(ctx); });
  pi.on('session_before_tree', (event, ctx) => {
    if (currentCharacterId && (working || event.preparation.userWantsSummary)) {
      ctx.ui.notify(working ? 'Finish or cancel memory formation before changing branches.' : 'Choose No summary when changing character branches, so rejected events stay outside the story.', 'info');
      return { cancel: true };
    }
  });
  pi.on('session_shutdown', async (event, ctx) => {
    if (event.reason !== 'reload') {
      try { await saveDatedDraft(ctx); }
      catch (error) { ctx.ui.notify(`Could not save the unplayed episode: ${errorMessage(error)}`, 'error'); }
    }
    context = undefined;
    if (timer) clearInterval(timer); timer = undefined;
    if (catalog) remember(ctx);
    if (service) await service.close(); service = undefined;
    if (catalog) catalog.close(); catalog = undefined;
    if (originalTools) pi.setActiveTools(originalTools); originalTools = undefined;
    working = false;
  });
  for (const name of Object.keys(keys) as Action[]) {
    pi.registerShortcut(keys[name] as Parameters<ExtensionAPI['registerShortcut']>[0], { description: `Reverie ${name}`, handler: shortcutCtx => {
      if (!catalog?.binding(shortcutCtx.cwd)) return;
      if (!shortcutCtx.isIdle() || working) { shortcutCtx.ui.notify('Wait for the current operation.', 'info'); return; }
      draftFromShortcut = shortcutCtx.ui.getEditorText();
      pi.sendUserMessage(`/reverie ${name}`, { expandPromptTemplates: true });
    } });
  }
}
export default function reverie(pi: ExtensionAPI): void { registerReverie(pi); }
