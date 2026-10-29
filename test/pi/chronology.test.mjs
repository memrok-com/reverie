import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorCandidates, branchTime, relativePlacement, resolveRelative } from '../../.work/pi-test/chronology.mjs';

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
