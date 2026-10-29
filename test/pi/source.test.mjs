import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { extractSource, alternatives, branchOf, sourceHash } from '../../.work/pi-test/source.mjs';
import { recallHistory } from '../../.work/pi-test/recall-history.mjs';

test('Pi source preserves the selected full story across alternatives and compaction', () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry('reverie.binding', { characterId: 'mara' });
  manager.appendCustomEntry('reverie.foundation', { text: 'Proud Mara' });
  const first = manager.appendMessage({ role: 'user', content: 'I offer a coat.', timestamp: 1 });
  const reply = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'I accept.' }], stopReason: 'stop' });
  manager.branch(manager.getEntry(first).parentId);
  manager.appendMessage({ role: 'user', content: 'I offer a coat.', timestamp: 2 });
  const second = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'I refuse.' }], stopReason: 'stop' });
  assert.deepEqual(extractSource(manager.getBranch()).messages.map(message => message.text), ['I offer a coat.', 'I refuse.']);
  const alt = alternatives(manager.getEntries(), manager.getBranch());
  assert.deepEqual(alt.replies.map(entry => entry.id), [reply, second]);
  manager.branch(reply);
  manager.appendCustomEntry('reverie.selection', { replyId: reply });
  manager.appendCompaction('SUMMARY THAT MUST NOT BECOME PLAYED SOURCE', reply, 1000);
  manager.appendCustomMessageEntry('reverie.recall', 'INJECTED MEMORY IS NOT PLAYED SOURCE', false);
  const source = extractSource(manager.getBranch());
  assert.equal(source.foundation, 'Proud Mara');
  assert.deepEqual(source.messages.map(message => message.text), ['I offer a coat.', 'I accept.']);
  assert.deepEqual(extractSource(branchOf(manager.getEntries(), manager.getLeafId())), source);
});

test('Pi append-only message edits and omissions apply to memory and reroll prompts', () => {
  const manager = SessionManager.inMemory();
  const user = manager.appendMessage({ role: 'user', content: 'I offer a coat.', timestamp: 1 });
  const reply = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'I accept.' }], stopReason: 'stop' });
  manager.appendContextEdit(user, { content: 'I offer a blue lantern.' });
  manager.appendContextEdit(reply, { content: [{ type: 'text', text: 'I take the lantern.' }] });
  assert.deepEqual(extractSource(manager.getBranch()).messages.map(item => item.text), ['I offer a blue lantern.', 'I take the lantern.']);
  assert.equal(alternatives(manager.getEntries(), manager.getBranch()).user.message.content, 'I offer a blue lantern.');
  manager.appendContextEdit(reply, null);
  assert.deepEqual(extractSource(manager.getBranch()).messages.map(item => item.text), ['I offer a blue lantern.']);
});

test('activation history follows selected successful replies, rejects changed prefixes and owners, and never expands historical sections', () => {
  const manager = SessionManager.inMemory(), episodeId = manager.getSessionId(), saved = new Map();
  const catalog = { recall: (replyId, id) => id === episodeId ? saved.get(replyId) : undefined };
  const save = (id, extra = {}) => saved.set(id, { characterId: 'mara', episodeId, at: 100,
    memories: [{ episodeId: 'old', contributionHash: 'published-state', memoryIndex: 0, detail: 'blue lantern' }],
    historicalContext: [{ episodeId: 'NEVER_RECURSE', contributionHash: 'foreign', memoryIndex: 1 }],
    playedPrefixHash: sourceHash(extractSource(manager.getBranch())), ...extra });
  const user = manager.appendMessage({ role: 'user', content: 'I will return.', timestamp: 1 });
  const first = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'I am afraid.' }], stopReason: 'stop' }); save(first);
  manager.branch(user);
  const alternate = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'I feel calm.' }], stopReason: 'stop' }); save(alternate);
  let history = recallHistory(catalog, manager.getBranch(), episodeId, 'mara');
  assert.deepEqual(history.map(item => item.replyId), [alternate]);
  assert.equal(history[0].memories.length, 1); assert.equal(history[0].memories[0].episodeId, 'old');
  manager.branch(first);
  manager.appendCompaction('summary is not evidence', first, 1000);
  assert.deepEqual(recallHistory(catalog, manager.getBranch(), episodeId, 'mara').map(item => item.replyId), [first]);
  for (const stopReason of ['error', 'aborted']) {
    manager.appendMessage({ role: 'user', content: 'A failed attempt.', timestamp: 2 });
    const failed = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'partial' }], stopReason }); save(failed);
  }
  assert.deepEqual(recallHistory(catalog, manager.getBranch(), episodeId, 'mara').map(item => item.replyId), [first]);
  assert.deepEqual(recallHistory(catalog, manager.getBranch(), episodeId, 'anya'), []);
  assert.deepEqual(recallHistory(catalog, manager.getBranch(), 'foreign-episode', 'mara'), []);
  manager.appendContextEdit(user, { content: 'I never left.' });
  assert.deepEqual(recallHistory(catalog, manager.getBranch(), episodeId, 'mara'), []);
  manager.branch(first); save(first, { playedPrefixHash: undefined });
  assert.deepEqual(recallHistory(catalog, manager.getBranch(), episodeId, 'mara'), []);
});
