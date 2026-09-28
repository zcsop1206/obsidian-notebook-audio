import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kb, mmss } from '../../src/util';

test('mmss formats durations as M:SS, and H:MM:SS from an hour up', () => {
  assert.equal(mmss(5000), '0:05');
  assert.equal(mmss(761000), '12:41');
  assert.equal(mmss(3725000), '1:02:05');
  assert.equal(mmss(0), '0:00');
  assert.equal(mmss(999), '0:00');
  assert.equal(mmss(-500), '0:00');
  assert.equal(mmss(3600000), '1:00:00');
});

test('kb shows kB below a million bytes, MB with one decimal above', () => {
  assert.equal(kb(0), '0 kB');
  assert.equal(kb(2048), '2 kB');
  assert.equal(kb(705311), '689 kB');
  assert.equal(kb(7654321), '7.3 MB');
  assert.equal(kb(41 * 1048576), '41 MB');
});
