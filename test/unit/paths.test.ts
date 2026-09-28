// src/paths.ts: recording folders, relative link targets and their encoding.
// Dates are built from local components, so the tests pass in any time zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  audioFolderForNote, basename, decodeLinkPath, dirname, encodeLinkPath, folderStamp, folderStampSeconds,
  joinPath, normalizePath, notelessCandidates, recordingFolderCandidates, relativePath, segmentFileName,
} from '../../src/paths';

const D = new Date(2026, 8, 27, 14, 3, 12, 345);

test('folder stamps are local time, minutes then seconds', () => {
  assert.equal(folderStamp(D), '2026-09-27 14-03');
  assert.equal(folderStampSeconds(D), '2026-09-27 14-03-12');
  assert.equal(folderStamp(new Date(2027, 0, 5, 9, 7, 3)), '2027-01-05 09-07');
  assert.equal(folderStampSeconds(new Date(2027, 0, 5, 0, 0, 0)), '2027-01-05 00-00-00');
});

test('audio folder sits beside the note, named after it', () => {
  assert.equal(audioFolderForNote('Notes/Physics/Lecture 3.md'), 'Notes/Physics/Lecture 3/audio');
  assert.equal(audioFolderForNote('Todo.md'), 'Todo/audio');
  assert.equal(audioFolderForNote('Cours/Café (draft).md'), 'Cours/Café (draft)/audio');
  assert.equal(audioFolderForNote("Mathe/Übung 3 – Adit's.md"), "Mathe/Übung 3 – Adit's/audio");
  assert.equal(audioFolderForNote('a/v1.2 notes.md'), 'a/v1.2 notes/audio');
});

test('recording folder candidates: plain stamp first, then with seconds', () => {
  assert.deepEqual(recordingFolderCandidates('Notes/Physics/Lecture 3/audio', D), [
    'Notes/Physics/Lecture 3/audio/2026-09-27 14-03',
    'Notes/Physics/Lecture 3/audio/2026-09-27 14-03-12',
  ]);
  assert.deepEqual(recordingFolderCandidates('Todo/audio/', D), ['Todo/audio/2026-09-27 14-03', 'Todo/audio/2026-09-27 14-03-12']);
});

test('note-less candidates: folder and note, trailing slashes tolerated', () => {
  const expected = [
    { folder: 'audio/2026-09-27 14-03', note: 'audio/Recording 2026-09-27 14-03.md' },
    { folder: 'audio/2026-09-27 14-03-12', note: 'audio/Recording 2026-09-27 14-03-12.md' },
  ];
  assert.deepEqual(notelessCandidates('audio', D), expected);
  assert.deepEqual(notelessCandidates('audio/', D), expected);
  assert.deepEqual(notelessCandidates('audio//', D), expected);
  assert.deepEqual(notelessCandidates('private/audio/', D)[0], {
    folder: 'private/audio/2026-09-27 14-03', note: 'private/audio/Recording 2026-09-27 14-03.md',
  });
  assert.deepEqual(notelessCandidates('', D)[0], { folder: '2026-09-27 14-03', note: 'Recording 2026-09-27 14-03.md' });
});

test('segment file names', () => {
  assert.equal(segmentFileName(1, 'm4a'), 'segment-01.m4a');
  assert.equal(segmentFileName(12, '.webm'), 'segment-12.webm');
  assert.equal(segmentFileName(100, 'ogg'), 'segment-100.ogg');
});

test('dirname, basename, joinPath, normalizePath', () => {
  assert.equal(dirname('Todo.md'), '');
  assert.equal(dirname('Notes/Physics/Lecture 3.md'), 'Notes/Physics');
  assert.equal(basename('Notes/Physics/Lecture 3.md'), 'Lecture 3.md');
  assert.equal(basename('Todo.md'), 'Todo.md');
  assert.equal(basename(''), '');
  assert.equal(joinPath('', 'a/', '/b//c/', 'd.m4a'), 'a/b/c/d.m4a');
  assert.equal(joinPath('/a/', ''), 'a');
  assert.equal(joinPath(), '');
  assert.equal(normalizePath('a/./b/../c'), 'a/c');
  assert.equal(normalizePath('../../a'), 'a');
});

test('relative paths from a note to a file', () => {
  assert.equal(
    relativePath('Notes/Physics/Lecture 3.md', 'Notes/Physics/Lecture 3/audio/2026-09-27 14-03/segment-01.m4a'),
    'Lecture 3/audio/2026-09-27 14-03/segment-01.m4a',
  );
  assert.equal(relativePath('Todo.md', 'audio/x/segment-01.m4a'), 'audio/x/segment-01.m4a');
  assert.equal(relativePath('a/b/note.md', 'c/d.m4a'), '../../c/d.m4a');
  assert.equal(relativePath('a/b/note.md', 'a/c/d.m4a'), '../c/d.m4a');
  assert.equal(relativePath('a/b/note.md', 'a/b/d.m4a'), 'd.m4a');
  assert.equal(relativePath('a/note.md', 'd.m4a'), '../d.m4a');
  // A file named like the note's folder is still a file, not a shared folder.
  assert.equal(relativePath('a/b/note.md', 'a/b'), '../b');
  assert.equal(
    relativePath('Cours/Café (draft).md', 'Cours/Café (draft)/audio/2026-09-27 14-03/segment-01.m4a'),
    'Café (draft)/audio/2026-09-27 14-03/segment-01.m4a',
  );
});

test('link paths: spaces, parentheses, apostrophes, non-ASCII', () => {
  assert.equal(
    encodeLinkPath('Lecture 3/audio/2026-09-27 14-03/segment-01.m4a'),
    'Lecture%203/audio/2026-09-27%2014-03/segment-01.m4a',
  );
  assert.equal(encodeLinkPath('Café (draft)/audio/x/segment-01.m4a'), 'Caf%C3%A9%20%28draft%29/audio/x/segment-01.m4a');
  assert.equal(encodeLinkPath("Übung 3/Adit's/segment-01.m4a"), "%C3%9Cbung%203/Adit's/segment-01.m4a");
  assert.equal(encodeLinkPath('../../c/d.m4a'), '../../c/d.m4a');
  assert.equal(encodeLinkPath('#1 [x] 50%?/a.m4a'), '%231%20%5Bx%5D%2050%25%3F/a.m4a');
  for (const p of ['Café (draft)/audio/2026-09-27 14-03/segment-01.m4a', "Übung 3/Adit's/../x #1 50%.m4a", '日本語/ノート.m4a']) {
    const enc = encodeLinkPath(p);
    assert.doesNotMatch(enc, /[ ()#?\[\]]/, enc);
    assert.doesNotMatch(enc, /%(?![0-9A-F]{2})/, enc);
    assert.match(enc, /^[\x21-\x7e]+$/, 'ASCII only');
    assert.equal(decodeLinkPath(enc), p);
  }
});

test('decodeLinkPath tolerates angle brackets and malformed escapes', () => {
  assert.equal(decodeLinkPath('<Lecture 3/audio/segment-01.m4a>'), 'Lecture 3/audio/segment-01.m4a');
  assert.equal(decodeLinkPath('a%20b/100%/c%2'), 'a b/100%/c%2');
  assert.equal(decodeLinkPath('Lecture 3/segment-01.m4a'), 'Lecture 3/segment-01.m4a');
});
