import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { extractSource, alternatives, branchOf } from '../../.work/pi-test/source.mjs';

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
