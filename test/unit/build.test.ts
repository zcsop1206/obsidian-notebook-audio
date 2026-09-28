// A smoke test so `npm run test:unit` has something to run before the pure modules land.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('unit test bundle runs', () => {
  assert.equal(1 + 1, 2);
});
