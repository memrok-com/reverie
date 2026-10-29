import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { SourceObservation } from './contracts.js';

export interface Entry {
  id: string; parentId: string | null; type: string;
  customType?: string; data?: unknown;
  message?: { role: string; content?: unknown; stopReason?: string };
  targetId?: string; replacement?: { content: unknown } | null;
}
export function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(item => item?.type === 'text').map(item => item.text ?? '').join('\n') : '';
}
export function branchOf(entries: Entry[], leaf: string | null): Entry[] {
  const index = new Map(entries.map(entry => [entry.id, entry]));
  const branch: Entry[] = [], seen = new Set<string>();
  for (let id = leaf; id; ) {
    if (seen.has(id)) throw new Error('The saved conversation has a cyclic branch.');
    seen.add(id);
    const entry = index.get(id);
    if (!entry) throw new Error('The selected conversation branch is incomplete.');
    branch.push(entry); id = entry.parentId;
  }
  return branch.reverse();
}
export function extractSource(branch: Entry[]): SourceObservation {
  let foundation = '';
  const edits = new Map(branch.filter(entry => entry.type === 'context_edit').map(entry => [entry.targetId, entry.replacement]));
  const messages: SourceObservation['messages'] = [];
  for (const entry of branch) {
    if (entry.type === 'custom' && entry.customType === 'reverie.foundation') {
      const data = entry.data as { text?: string } | undefined;
      if (typeof data?.text === 'string') foundation = data.text;
    }
    if (entry.type !== 'message' || !['user', 'assistant'].includes(entry.message?.role ?? '')) continue;
    if (entry.message?.role === 'assistant' && ['error', 'aborted'].includes(entry.message.stopReason ?? '')) continue;
    if (edits.get(entry.id) === null) continue;
    const content = edits.has(entry.id) ? edits.get(entry.id)?.content : entry.message?.content;
    const text = textContent(content);
    if (text.trim()) messages.push({ id: entry.id, role: entry.message!.role as 'user' | 'assistant', text });
  }
  return { foundation, messages };
}
export async function readSourceFile(path: string, leaf: string | null): Promise<SourceObservation> {
  return extractSource(await readBranchFile(path, leaf));
}
export async function readBranchFile(path: string, leaf: string | null): Promise<Entry[]> {
  return branchOf(await readEntriesFile(path), leaf);
}
export async function readEntriesFile(path: string): Promise<Entry[]> {
  const rows = (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  return rows.filter(row => row.type !== 'session');
}
export function sourceHash(source: SourceObservation): string {
  return createHash('sha256').update(JSON.stringify({ messages: source.messages, foundation: source.foundation })).digest('hex');
}
export function ownerOf(entries: Entry[]): string | undefined {
  const owners = new Set(entries.filter(entry => entry.type === 'custom' && entry.customType === 'reverie.binding')
    .map(entry => (entry.data as { characterId?: string } | undefined)?.characterId).filter(Boolean));
  if (owners.size > 1) throw new Error('This conversation contains conflicting character identities.');
  return [...owners][0];
}
export interface Alternatives { user: Entry; replies: Entry[]; current: number }
export function alternatives(entries: Entry[], branch: Entry[]): Alternatives | undefined {
  const edits = new Map(branch.filter(entry => entry.type === 'context_edit').map(entry => [entry.targetId, entry.replacement]));
  const original = branch.findLast(entry => entry.type === 'message' && entry.message?.role === 'user' && edits.get(entry.id) !== null);
  if (!original) return;
  const user = edits.has(original.id) ? { ...original, message: { ...original.message!, content: edits.get(original.id)?.content } } : original;
  const identity = JSON.stringify(user.message?.content);
  const prompts = new Set(entries.filter(entry => entry.type === 'message' && entry.message?.role === 'user'
    && entry.parentId === user.parentId && JSON.stringify(entry.message.content) === identity).map(entry => entry.id));
  const replies = entries.filter(entry => entry.type === 'message' && entry.message?.role === 'assistant'
    && prompts.has(entry.parentId ?? '') && !['error', 'aborted', 'toolUse'].includes(entry.message.stopReason ?? '')
    && textContent(entry.message.content).trim());
  const ids = new Set(branch.map(entry => entry.id));
  return { user, replies, current: replies.findIndex(entry => ids.has(entry.id)) };
}
