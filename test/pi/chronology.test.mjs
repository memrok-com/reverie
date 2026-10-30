import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorCandidates, branchTime, episodeBranchEnd, relativePlacement, resolveRelative, shiftText } from '../../.work/pi-test/chronology.mjs';

test('relative dates use explicit interval boundaries, exact labels/IDs, and safe fixed units', () => {
  const first = { id: 'a', label: 'The lighthouse', start: Date.UTC(2000, 1, 28), now: Date.UTC(2000, 1, 29) };
  const second = { ...first, id: 'b' };
  assert.equal(resolveRelative(relativePlacement('three days after The lighthouse'), first), Date.UTC(2000, 2, 3));
  assert.equal(resolveRelative(relativePlacement('1 day before "The lighthouse"'), first), Date.UTC(2000, 1, 27));
  assert.deepEqual(anchorCandidates([first, second], 'THE LIGHTHOUSE'), [first, second]);
  assert.deepEqual(anchorCandidates([first, second], 'b'), [second]);
  assert.deepEqual(anchorCandidates([first, second], 'lighthouse'), []);
  assert.throws(() => relativePlacement('0 days after The lighthouse'));
  assert.throws(() => relativePlacement('999999999999999 days after The lighthouse'));
  assert.equal(relativePlacement('2000-01-01 New scene'), undefined);
});

test('branch time shifts compose for legacy and newly recorded time entries', () => {
  const entry = data => ({ id: 't', parentId: null, type: 'custom', customType: 'reverie.time', data });
  assert.equal(branchTime([entry({ now: 100 })], { time_offset: 40 }), 140);
  assert.equal(branchTime([entry({ now: 150, offset: 40 })], { time_offset: 70 }), 180);
  assert.equal(branchTime([entry({ now: 150, offset: 40 })], { time_offset: -10 }), 100);
});

test('full episode extent translates every branch with its recorded offset and includes the selected end', () => {
  const time = (id, parentId, now, offset) => ({ id, parentId, type: 'custom', customType: 'reverie.time', data: { now, ...(offset === undefined ? {} : { offset }) } });
  const entries = [time('root', null, 100), time('long', 'root', 250, 50), time('short', 'root', 175, 25)];
  assert.equal(episodeBranchEnd(entries, { now: 180, time_offset: 40 }), 240);
  assert.equal(episodeBranchEnd(entries, { now: 180, time_offset: -40 }), 180);
  assert.throws(() => episodeBranchEnd([time('bad', null, 'bad')], { now: 180 }), /invalid/);
  assert.throws(() => episodeBranchEnd([time('bad', null, 100, Infinity)], { now: 180 }), /invalid/);
});

test('branch extent ignores superseded setup dates while retaining each branch tip and its offset', () => {
  const time = (id, parentId, now, offset = 0) => ({ id, parentId, type: 'custom', customType: 'reverie.time', data: { now, offset } });
  const message = (id, parentId) => ({ id, parentId, type: 'message', message: { role: 'user', content: 'We meet.' } });
  const entries = [time('abandoned', null, Date.UTC(2020, 0, 1)), time('corrected', 'abandoned', Date.UTC(2000, 0, 1)),
    message('played', 'corrected'), time('long', 'played', Date.UTC(2000, 0, 10)), message('long-tip', 'long'),
    time('short', 'played', Date.UTC(2000, 0, 3)), message('short-tip', 'short')];
  const original = structuredClone(entries), episode = { now: Date.UTC(2000, 0, 3) };
  assert.equal(episodeBranchEnd(entries, episode), Date.UTC(2000, 0, 10));
  assert.equal(episodeBranchEnd([...entries].reverse(), { ...episode, time_offset: 86400000 }), Date.UTC(2000, 0, 11));
  // A new time on the long branch supersedes that branch's former end only.
  entries.push(time('long-corrected', 'long-tip', Date.UTC(2000, 0, 5), 86400000), message('new-tip', 'long-corrected'));
  assert.equal(episodeBranchEnd(entries, { ...episode, time_offset: 86400000 }), Date.UTC(2000, 0, 5));
  assert.deepEqual(entries.slice(0, original.length), original);
  assert.throws(() => episodeBranchEnd([message('orphan', 'missing')], episode), /incomplete/);
  assert.throws(() => episodeBranchEnd([message('a', 'b'), message('b', 'a')], episode), /invalid|cyclic/);
});

test('shift previews express sub-day changes as whole time units', () => {
  assert.equal(shiftText(3_600_000), '1 hour later');
  assert.equal(shiftText(-900_000), '15 minutes earlier');
  assert.equal(shiftText(90_000_000), '1 day 1 hour later');
  assert.equal(shiftText(1500), '1 second 500 milliseconds later');
});
