// src/meta.ts: recording name, wall clock, timeline, locate and the summary text.
// `started` comes from a local Date, so the tests pass in any time zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, locate, type MetaSegment, recordingName, summaryText, wallClockAt } from '../../src/meta';

const START = new Date(2026, 8, 27, 14, 3, 12, 345);
const started = START.toISOString();
const seg = (file: string, startMs: number, audioEndMs?: number): MetaSegment =>
  audioEndMs === undefined ? { file, startMs, reason: 'start' } : { file, startMs, audioEndMs, reason: 'start' };

test('recording name and wall clock are local time', () => {
  assert.equal(recordingName({ started }), 'Recording 2026-09-27 14:03');
  assert.equal(wallClockAt({ started }, 0).getTime(), START.getTime());
  const d = wallClockAt({ started }, 401000);
  assert.deepEqual([d.getHours(), d.getMinutes(), d.getSeconds()], [14, 9, 53]);
  // Past midnight the date rolls over.
  assert.equal(recordingName({ started: new Date(2026, 11, 31, 23, 59, 59).toISOString() }), 'Recording 2026-12-31 23:59');
});

test('timeline from audioEndMs, with the gap between segments', () => {
  const tl = buildTimeline({ segments: [seg('segment-01.m4a', 0, 370000), seg('segment-02.m4a', 401000, 792000)] });
  assert.deepEqual(tl.items, [
    { kind: 'segment', index: 0, file: 'segment-01.m4a', startMs: 0, endMs: 370000, durationMs: 370000 },
    { kind: 'gap', startMs: 370000, endMs: 401000, durationMs: 31000 },
    { kind: 'segment', index: 1, file: 'segment-02.m4a', startMs: 401000, endMs: 792000, durationMs: 391000 },
  ]);
  assert.equal(tl.totalMs, 792000);
  assert.equal(tl.recordedMs, 761000);
  assert.equal(tl.lostMs, 31000);
  assert.equal(tl.segments, 2);
});

test('decoded durations override audioEndMs', () => {
  const tl = buildTimeline(
    { segments: [seg('segment-01.m4a', 0, 61234), seg('segment-02.m4a', 92510, 761000)] },
    [60900, undefined],
  );
  assert.deepEqual(tl.items[0], { kind: 'segment', index: 0, file: 'segment-01.m4a', startMs: 0, endMs: 60900, durationMs: 60900 });
  assert.deepEqual(tl.items[1], { kind: 'gap', startMs: 60900, endMs: 92510, durationMs: 31610 });
  assert.equal(tl.items[2].durationMs, 761000 - 92510);
  assert.equal(tl.recordedMs, 60900 + 761000 - 92510);
  // An unusable duration (NaN, negative) falls back to audioEndMs.
  const t2 = buildTimeline({ segments: [seg('segment-01.m4a', 0, 5000)] }, [NaN]);
  assert.equal(t2.items[0].durationMs, 5000);
  const t3 = buildTimeline({ segments: [seg('segment-01.m4a', 0, 5000)] }, [-1]);
  assert.equal(t3.items[0].durationMs, 5000);
});

test('recovered recording: last segment without audioEndMs or duration counts as 0', () => {
  const meta = { segments: [seg('segment-01.m4a', 0, 10000), seg('segment-02.m4a', 15000)] };
  const tl = buildTimeline(meta);
  assert.deepEqual(tl.items[2], { kind: 'segment', index: 1, file: 'segment-02.m4a', startMs: 15000, endMs: 15000, durationMs: 0 });
  assert.equal(tl.totalMs, 15000);
  assert.equal(tl.recordedMs, 10000);
  assert.equal(tl.lostMs, 5000);
  // Once decoded, its duration is used.
  const decoded = buildTimeline(meta, [undefined, 42000]);
  assert.equal(decoded.totalMs, 57000);
  assert.equal(decoded.recordedMs, 52000);
});

test('zero and negative gaps are clamped away', () => {
  const zero = buildTimeline({ segments: [seg('segment-01.m4a', 0, 1000), seg('segment-02.m4a', 1000, 3000)] });
  assert.deepEqual(zero.items.map(i => i.kind), ['segment', 'segment']);
  assert.equal(zero.lostMs, 0);
  // Decoded audio a little longer than the time until the next segment started: overlap, no gap.
  const neg = buildTimeline({ segments: [seg('segment-01.m4a', 0, 1000), seg('segment-02.m4a', 1000, 3000)] }, [1200, undefined]);
  assert.deepEqual(neg.items.map(i => i.kind), ['segment', 'segment']);
  assert.equal(neg.lostMs, 0);
  assert.equal(neg.recordedMs, 3200);
  // audioEndMs before startMs never gives a negative duration.
  const bad = buildTimeline({ segments: [seg('segment-01.m4a', 500, 100)] });
  assert.equal(bad.items[0].durationMs, 0);
  for (const t of [zero, neg, bad]) for (const it of t.items) assert.ok(it.durationMs >= 0);
});

test('empty timeline', () => {
  const tl = buildTimeline({ segments: [] });
  assert.deepEqual(tl, { items: [], totalMs: 0, recordedMs: 0, lostMs: 0, segments: 0 });
  assert.deepEqual(locate(tl, 0), { segment: -1, offsetMs: 0, inGap: false });
});

test('locate: inside a segment, inside a gap, past the end', () => {
  const tl = buildTimeline({ segments: [seg('segment-01.m4a', 0, 370000), seg('segment-02.m4a', 401000, 792000)] });
  assert.deepEqual(locate(tl, 0), { segment: 0, offsetMs: 0, inGap: false });
  assert.deepEqual(locate(tl, 12345), { segment: 0, offsetMs: 12345, inGap: false });
  assert.deepEqual(locate(tl, 369999), { segment: 0, offsetMs: 369999, inGap: false });
  assert.deepEqual(locate(tl, 370000), { segment: 1, offsetMs: 0, inGap: true });
  assert.deepEqual(locate(tl, 390000), { segment: 1, offsetMs: 0, inGap: true });
  assert.deepEqual(locate(tl, 401000), { segment: 1, offsetMs: 0, inGap: false });
  assert.deepEqual(locate(tl, 500000), { segment: 1, offsetMs: 99000, inGap: false });
  assert.deepEqual(locate(tl, 792000), { segment: 1, offsetMs: 391000, inGap: false });
  assert.deepEqual(locate(tl, 1e9), { segment: 1, offsetMs: 391000, inGap: false });
  assert.deepEqual(locate(tl, -5), { segment: 0, offsetMs: 0, inGap: false });
});

test('locate: three segments, lead-in, and a zero-length last segment', () => {
  const tl = buildTimeline({ segments: [seg('segment-01.m4a', 200, 1000), seg('segment-02.m4a', 2000, 3000), seg('segment-03.m4a', 5000)] });
  assert.deepEqual(locate(tl, 100), { segment: 0, offsetMs: 0, inGap: true });
  assert.deepEqual(locate(tl, 1500), { segment: 1, offsetMs: 0, inGap: true });
  assert.deepEqual(locate(tl, 2500), { segment: 1, offsetMs: 500, inGap: false });
  assert.deepEqual(locate(tl, 4000), { segment: 2, offsetMs: 0, inGap: true });
  assert.deepEqual(locate(tl, 5000), { segment: 2, offsetMs: 0, inGap: false });
});

test('summaryText in its three shapes', () => {
  const two = buildTimeline({ segments: [seg('segment-01.m4a', 0, 370000), seg('segment-02.m4a', 401000, 792000)] });
  assert.equal(summaryText(two), '12:41 in 2 segments, 0:31 lost while Obsidian was in the background');
  const one = buildTimeline({ segments: [seg('segment-01.m4a', 0, 761000)] });
  assert.equal(summaryText(one), '12:41');
  const noLoss = buildTimeline({ segments: [seg('segment-01.m4a', 0, 370000), seg('segment-02.m4a', 370000, 761000)] });
  assert.equal(summaryText(noLoss), '12:41 in 2 segments');
  // A watchdog restart loses a few hundred ms: not worth a '0:00 lost'.
  const tiny = buildTimeline({ segments: [seg('segment-01.m4a', 0, 370000), seg('segment-02.m4a', 370400, 761400)] });
  assert.equal(summaryText(tiny), '12:41 in 2 segments');
  const long = buildTimeline({ segments: [seg('segment-01.m4a', 0, 3700000), seg('segment-02.m4a', 3800000, 3900000), seg('segment-03.m4a', 4000000, 4000500)] });
  assert.equal(summaryText(long), '1:03:20 in 3 segments, 3:20 lost while Obsidian was in the background');
});
