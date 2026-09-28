// src/links.ts: the lines written to a note and recognising them again.
// `started` comes from a local Date and expected clocks are computed the same way, so the
// tests pass in any time zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSegmentTarget, parseRecordingLinks, recordingFolderOfTarget, recordingLines, segmentLinks } from '../../src/links';
import { buildTimeline, type Meta, type MetaSegment } from '../../src/meta';
import { audioFolderForNote, recordingFolderCandidates } from '../../src/paths';
import { clock } from '../../src/util';

const START = new Date(2026, 8, 27, 14, 3, 12, 345);

function meta(segments: MetaSegment[], note = 'Notes/Physics/Lecture 3.md'): Meta {
  return {
    format: 1, plugin: 'notebook-audio', version: '0.1.0', mime: 'audio/mp4', ext: 'm4a', bitrate: 96000,
    timesliceMs: 2000, appendBinary: true, started: START.toISOString(), note,
    device: { platform: 'ios', userAgent: 'test', mic: 'iPad Microphone', sampleRate: 48000, channels: 1 },
    segments, stoppedMs: 792000, ended: 'clean',
  };
}

// The CONTEXT.md example: 6:10 of audio, 0:31 lost, then 6:31.
const EXAMPLE = meta([
  { file: 'segment-01.m4a', startMs: 0, audioEndMs: 370000, reason: 'start' },
  { file: 'segment-02.m4a', startMs: 401000, audioEndMs: 792000, reason: 'returned' },
]);
const NOTE = 'Notes/Physics/Lecture 3.md';
const DIR = recordingFolderCandidates(audioFolderForNote(NOTE), START)[0];

test('recordingLines matches the CONTEXT.md example byte for byte', () => {
  // Computed from local time the way the plugin does; equal to the literal CONTEXT.md text.
  const c1 = clock(START), c2 = clock(new Date(START.getTime() + 401000));
  assert.equal(c1, '14:03:12');
  assert.equal(c2, '14:09:53');
  const expected =
    '\n' +
    'Recording 2026-09-27 14:03 (12:41 in 2 segments, 0:31 lost while Obsidian was in the background)\n' +
    `![segment 1, ${c1}, 6:10](Lecture%203/audio/2026-09-27%2014-03/segment-01.m4a)\n` +
    `![segment 2, ${c2}, 6:31](Lecture%203/audio/2026-09-27%2014-03/segment-02.m4a)\n`;
  const out = recordingLines(EXAMPLE, buildTimeline(EXAMPLE), NOTE, DIR);
  assert.equal(out, expected);
  assert.ok(!out.includes('[['));
});

test('recordingLines: one segment, root note, deep note, odd names', () => {
  const one = meta([{ file: 'segment-01.m4a', startMs: 0, audioEndMs: 65000, reason: 'start' }], 'Todo.md');
  const out = recordingLines(one, buildTimeline(one), 'Todo.md', 'Todo/audio/2026-09-27 14-03');
  assert.equal(out, `\nRecording 2026-09-27 14:03 (1:05)\n![segment 1, ${clock(START)}, 1:05](Todo/audio/2026-09-27%2014-03/segment-01.m4a)\n`);

  const cafe = recordingLines(one, buildTimeline(one), 'Cours/Café (draft).md', 'Cours/Café (draft)/audio/2026-09-27 14-03-12');
  assert.match(cafe, /\]\(Caf%C3%A9%20%28draft%29\/audio\/2026-09-27%2014-03-12\/segment-01\.m4a\)\n$/);

  const deep = recordingLines(one, buildTimeline(one), "Mathe/Übung/Adit's Übung 3.md", 'audio/2026-09-27 14-03');
  assert.match(deep, /\]\(\.\.\/\.\.\/audio\/2026-09-27%2014-03\/segment-01\.m4a\)\n$/);
  for (const s of [out, cafe, deep]) assert.ok(!s.includes('[['));
});

test('recordingLines uses decoded durations from the timeline', () => {
  const out = recordingLines(EXAMPLE, buildTimeline(EXAMPLE, [369500, 391999]), NOTE, DIR);
  assert.match(out, /\(12:41 in 2 segments, 0:31 lost while Obsidian was in the background\)/);
  assert.match(out, /!\[segment 1, \d\d:\d\d:\d\d, 6:09\]/);
  assert.match(out, /!\[segment 2, \d\d:\d\d:\d\d, 6:31\]/);
});

test('segmentLinks lists the segments in order', () => {
  assert.deepEqual(segmentLinks(buildTimeline(EXAMPLE)), [
    { file: 'segment-01.m4a', startMs: 0, durationMs: 370000 },
    { file: 'segment-02.m4a', startMs: 401000, durationMs: 391000 },
  ]);
});

test('parseRecordingLinks round-trips recordingLines', () => {
  const lines = recordingLines(EXAMPLE, buildTimeline(EXAMPLE), NOTE, DIR);
  const text = '# Lecture 3\n\nSome notes.' + lines + '\nMore notes after.\n';
  const groups = parseRecordingLinks(text);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].line, 3);
  assert.equal(text.split('\n')[groups[0].line].slice(0, 26), 'Recording 2026-09-27 14:03');
  assert.equal(groups[0].name, 'Recording 2026-09-27 14:03');
  assert.deepEqual(groups[0].segments, [
    { alt: `segment 1, ${clock(START)}, 6:10`, target: 'Lecture%203/audio/2026-09-27%2014-03/segment-01.m4a' },
    { alt: `segment 2, ${clock(new Date(START.getTime() + 401000))}, 6:31`, target: 'Lecture%203/audio/2026-09-27%2014-03/segment-02.m4a' },
  ]);
  for (const s of groups[0].segments) assert.equal(recordingFolderOfTarget(NOTE, s.target), DIR);
});

test('parseRecordingLinks: two recordings, a group without a header, CRLF', () => {
  const a = recordingLines(EXAMPLE, buildTimeline(EXAMPLE), NOTE, DIR);
  const bare = '![clip](Lecture%203/audio/x/segment-01.webm)\n![clip 2](<Lecture 3/audio/x/segment-02.webm>)\n';
  const text = ('intro\n' + a + '\n![photo](img/cat.png)\n' + bare + 'end').replace(/\n/g, '\r\n');
  const groups = parseRecordingLinks(text);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].name, 'Recording 2026-09-27 14:03');
  assert.equal(groups[0].line, 2);
  assert.equal(groups[0].segments.length, 2);
  assert.ok(!groups[0].segments[1].target.includes('\r'));
  assert.equal(groups[1].name, undefined);
  assert.equal(groups[1].line, 7);
  assert.deepEqual(groups[1].segments, [
    { alt: 'clip', target: 'Lecture%203/audio/x/segment-01.webm' },
    { alt: 'clip 2', target: '<Lecture 3/audio/x/segment-02.webm>' },
  ]);
  assert.equal(recordingFolderOfTarget(NOTE, groups[1].segments[1].target), 'Notes/Physics/Lecture 3/audio/x');
});

test('parseRecordingLinks ignores headers without embeds and non-segment embeds', () => {
  assert.deepEqual(parseRecordingLinks('Recording 2026-09-27 14:03 (1:00)\n\n![a](notes.md)\n![[segment-01.m4a]]\n'), []);
  assert.deepEqual(parseRecordingLinks(''), []);
});

test('isSegmentTarget', () => {
  assert.equal(isSegmentTarget('notes.md'), false);
  assert.equal(isSegmentTarget('Lecture%203/notes.md'), false);
  assert.equal(isSegmentTarget('segment-1.m4a'), false);
  assert.equal(isSegmentTarget('segment-01.m4a.md'), false);
  assert.equal(isSegmentTarget('my segment-01.m4a'), false);
  assert.equal(isSegmentTarget('SEGMENT-03.M4A'), true);
  assert.equal(isSegmentTarget('a/b/segment-12.webm'), true);
  assert.equal(isSegmentTarget('Caf%C3%A9%20%28draft%29/audio/2026-09-27%2014-03/segment-01.m4a'), true);
  assert.equal(isSegmentTarget('<x y/segment-02.ogg>'), true);
  assert.equal(isSegmentTarget('segment-100.m4a'), true);
});

test('recordingFolderOfTarget resolves against the note folder', () => {
  assert.equal(
    recordingFolderOfTarget(NOTE, 'Lecture%203/audio/2026-09-27%2014-03/segment-01.m4a'),
    'Notes/Physics/Lecture 3/audio/2026-09-27 14-03',
  );
  assert.equal(recordingFolderOfTarget(NOTE, './Lecture%203/audio/x/segment-01.m4a'), 'Notes/Physics/Lecture 3/audio/x');
  assert.equal(recordingFolderOfTarget('a/b/note.md', '../../audio/2026-09-27%2014-03/segment-01.m4a'), 'audio/2026-09-27 14-03');
  assert.equal(recordingFolderOfTarget('a/b/note.md', '../c/segment-01.m4a'), 'a/c');
  assert.equal(recordingFolderOfTarget('Todo.md', 'Todo/audio/2026-09-27%2014-03/segment-01.m4a'), 'Todo/audio/2026-09-27 14-03');
  assert.equal(
    recordingFolderOfTarget('Cours/Café (draft).md', 'Caf%C3%A9%20%28draft%29/audio/2026-09-27%2014-03/segment-02.m4a'),
    'Cours/Café (draft)/audio/2026-09-27 14-03',
  );
});
