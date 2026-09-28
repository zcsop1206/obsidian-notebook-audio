import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RecorderSnapshot } from '../../src/recorder';
import { statusText } from '../../src/status-text';

const snap = (o: Partial<RecorderSnapshot>): RecorderSnapshot => ({
  state: 'recording', elapsedMs: 0, bytes: 0, segments: 0, lostMs: 0, lastLostMs: 0, dir: 'audio/x', ...o,
});

test('starting and stopping', () => {
  assert.equal(statusText(snap({ state: 'starting' })), 'Starting…');
  assert.equal(statusText(snap({ state: 'stopping', elapsedMs: 60000, bytes: 1e6, segments: 2 })), 'Saving…');
});

test('recording: elapsed, size and segments, with the lost time from a second up', () => {
  assert.equal(statusText(snap({ elapsedMs: 252000, bytes: 3040870, segments: 1 })), '● 4:12 · 2.9 MB · 1 segment');
  assert.equal(statusText(snap({ elapsedMs: 1500, bytes: 12000, segments: 1 })), '● 0:01 · 12 kB · 1 segment');
  assert.equal(statusText(snap({ elapsedMs: 0, bytes: 0, segments: 0 })), '● 0:00 · 0 kB · 0 segments');
  assert.equal(statusText(snap({ elapsedMs: 252000, bytes: 3040870, segments: 2, lostMs: 999 })), '● 4:12 · 2.9 MB · 2 segments');
  assert.equal(statusText(snap({ elapsedMs: 252000, bytes: 3040870, segments: 2, lostMs: 31400, lastLostMs: 31400 })), '● 4:12 · 2.9 MB · 2 segments · 0:31 lost');
  assert.equal(statusText(snap({ elapsedMs: 3725000, bytes: 41 * 1048576, segments: 12, lostMs: 1000 })), '● 1:02:05 · 41 MB · 12 segments · 0:01 lost');
});

test('paused: says why, with the elapsed time', () => {
  assert.equal(statusText(snap({ state: 'paused', elapsedMs: 252000, bytes: 3040870, segments: 1, lostMs: 4000 })), 'Paused: Obsidian was in the background · 4:12');
});

test('resumed: the gap just closed, and the segment count', () => {
  assert.equal(
    statusText(snap({ state: 'resumed', elapsedMs: 283000, segments: 2, lostMs: 31400, lastLostMs: 31400 })),
    'Resumed, 0:31 lost while Obsidian was in the background · 2 segments',
  );
  // lastLostMs, not the total
  assert.equal(
    statusText(snap({ state: 'resumed', segments: 3, lostMs: 90000, lastLostMs: 5000 })),
    'Resumed, 0:05 lost while Obsidian was in the background · 3 segments',
  );
});

test('idle: empty, or the error of a start that failed', () => {
  const idle = { state: 'idle' as const, dir: '' };
  assert.equal(statusText(snap(idle)), '');
  assert.equal(statusText(snap({ ...idle, error: 'microphone refused: NotAllowedError' })), 'Could not record: microphone refused: NotAllowedError');
});
