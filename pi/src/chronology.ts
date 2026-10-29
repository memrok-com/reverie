import type { Episode } from './contracts.js';
import type { Entry } from './source.js';

const counts: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const units: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };
export interface RelativePlacement { anchor: string; direction: 'after' | 'before'; milliseconds: number }

export function relativePlacement(raw: string): RelativePlacement | undefined {
  const match = /^(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(minute|hour|day|week)s?\s+(after|before)\s+(.+)$/i.exec(raw.trim());
  if (!match) return;
  const count = counts[match[1]!.toLowerCase()] ?? Number(match[1]);
  const milliseconds = count * units[match[2]!.toLowerCase()]!;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) throw new Error('Use a positive, whole number of minutes, hours, days or weeks.');
  return { anchor: match[4]!.replace(/^"(.*)"$/, '$1'), direction: match[3]!.toLowerCase() as 'after' | 'before', milliseconds };
}

export function anchorCandidates(episodes: Episode[], anchor: string): Episode[] {
  const exact = episodes.find(episode => episode.id === anchor);
  return exact ? [exact] : episodes.filter(episode => episode.label.toLocaleLowerCase() === anchor.toLocaleLowerCase());
}

export function resolveRelative(placement: RelativePlacement, anchor: Episode): number {
  const at = placement.direction === 'after' ? anchor.now + placement.milliseconds : anchor.start - placement.milliseconds;
  if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime())) throw new Error('The resolved date is outside the supported calendar.');
  return at;
}

/** Translate old and new branch time entries using the offset at their creation. */
export function branchTime(branch: Entry[], episode: Episode): number | undefined {
  const entry = branch.findLast(entry => entry.type === 'custom' && entry.customType === 'reverie.time');
  const time = entry?.data as { now?: number; offset?: number } | undefined;
  return typeof time?.now === 'number' ? time.now - (time.offset ?? 0) + (episode.time_offset ?? 0) : undefined;
}

/** Every time entry can be restored by tree navigation, including unselected branches. */
export function episodeBranchEnd(entries: Entry[], episode: Episode): number {
  let end = episode.now;
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== 'reverie.time') continue;
    const time = entry.data as { now?: number; offset?: number } | undefined;
    const at = branchTime([entry], episode);
    if (!Number.isSafeInteger(time?.now) || (time?.offset !== undefined && !Number.isSafeInteger(time.offset))
      || !Number.isSafeInteger(at) || !Number.isFinite(new Date(at!).getTime())) {
      throw new Error('An episode time entry is invalid. Restore its source before re-dating.');
    }
    end = Math.max(end, at!);
  }
  return end;
}

export function shiftText(delta: number): string {
  if (!delta) return '0 milliseconds';
  let remaining = Math.abs(delta);
  const parts: string[] = [];
  for (const [unit, size] of [['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000], ['second', 1000], ['millisecond', 1]] as const) {
    const count = Math.floor(remaining / size);
    if (count) parts.push(`${count} ${unit}${count === 1 ? '' : 's'}`);
    remaining %= size;
  }
  return `${parts.join(' ')} ${delta < 0 ? 'earlier' : 'later'}`;
}
