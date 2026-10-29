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
  const time = (now, offset) => ({ type: 'custom', customType: 'reverie.time', data: { now, ...(offset === undefined ? {} : { offset }) } });
  const entries = [time(100), time(250, 50), time(175, 25)];
  assert.equal(episodeBranchEnd(entries, { now: 180, time_offset: 40 }), 240);
  assert.equal(episodeBranchEnd(entries, { now: 180, time_offset: -40 }), 180);
  assert.throws(() => episodeBranchEnd([time('bad')], { now: 180 }), /invalid/);
  assert.throws(() => episodeBranchEnd([time(100, Infinity)], { now: 180 }), /invalid/);
});

test('shift previews express sub-day changes as whole time units', () => {
  assert.equal(shiftText(3_600_000), '1 hour later');
  assert.equal(shiftText(-900_000), '15 minutes earlier');
  assert.equal(shiftText(90_000_000), '1 day 1 hour later');
  assert.equal(shiftText(1500), '1 second 500 milliseconds later');
});
