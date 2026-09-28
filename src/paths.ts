/*
 * Vault paths of recordings and the relative, URL-encoded link targets written to notes. Pure:
 * no 'obsidian' import, so the unit tests can bundle it. Vault paths use '/' and have no leading
 * or trailing slash; a file at the vault root has the folder ''. See CONTEXT.md, "Files".
 */
import { pad, ymd } from './util';

/** 'YYYY-MM-DD HH-mm' in local time, the recording folder's name. */
export function folderStamp(d: Date): string {
  return `${ymd(d)} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

/** 'YYYY-MM-DD HH-mm-ss', used when the plain stamp's folder already exists. */
export function folderStampSeconds(d: Date): string {
  return `${folderStamp(d)}-${pad(d.getSeconds())}`;
}

/** Splits a path into its non-empty segments ('\' counts as '/'; Obsidian forbids it in names). */
function segments(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter(s => s !== '');
}

/** Joins path parts with '/', normalising repeated, leading and trailing slashes. */
export function joinPath(...parts: string[]): string {
  return parts.map(segments).reduce((a, b) => a.concat(b), [] as string[]).join('/');
}

/** The folder of a vault path: '' for a root file. */
export function dirname(path: string): string {
  return segments(path).slice(0, -1).join('/');
}

/** The last segment of a path, extension included. */
export function basename(path: string): string {
  const s = segments(path);
  return s.length ? s[s.length - 1] : '';
}

/** A file name without its extension ('Lecture 3.md' -> 'Lecture 3'; '.hidden' stays). */
function stripExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/**
 * Folder of a note's recordings: '<note folder>/<note basename>/audio'. For
 * 'Notes/Physics/Lecture 3.md' -> 'Notes/Physics/Lecture 3/audio'; for a root note 'Todo.md' ->
 * 'Todo/audio'.
 */
export function audioFolderForNote(notePath: string): string {
  return joinPath(dirname(notePath), stripExt(basename(notePath)), 'audio');
}

/**
 * The two candidate folders for a new recording, plain stamp first:
 * ['<audio folder>/2026-09-27 14-03', '<audio folder>/2026-09-27 14-03-12']. The caller picks the
 * first that doesn't exist.
 */
export function recordingFolderCandidates(audioFolder: string, d: Date): [string, string] {
  return [joinPath(audioFolder, folderStamp(d)), joinPath(audioFolder, folderStampSeconds(d))];
}

/**
 * Note-less recordings: the folder '<settings folder>/<stamp>' and the note
 * '<settings folder>/Recording <stamp>.md', plain stamp first, then the same with seconds.
 * Leading and trailing slashes on the settings folder are tolerated; '' means the vault root.
 */
export function notelessCandidates(
  settingsFolder: string,
  d: Date,
): [{ folder: string; note: string }, { folder: string; note: string }] {
  const pick = (stamp: string) => ({
    folder: joinPath(settingsFolder, stamp),
    note: joinPath(settingsFolder, `Recording ${stamp}.md`),
  });
  return [pick(folderStamp(d)), pick(folderStampSeconds(d))];
}

/** 'segment-01.m4a' (three digits from 100 up); a leading dot on the extension is tolerated. */
export function segmentFileName(n: number, ext: string): string {
  return `segment-${pad(n)}.${ext.replace(/^\./, '')}`;
}

/** Resolves '.' and '..' segments; a '..' above the vault root is dropped. */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const s of segments(path)) {
    if (s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return out.join('/');
}

/**
 * Relative path from the folder of `fromNotePath` to `toPath`, using ../ where needed. From
 * 'Notes/Physics/Lecture 3.md' to 'Notes/Physics/Lecture 3/audio/x/segment-01.m4a' ->
 * 'Lecture 3/audio/x/segment-01.m4a'; from 'a/b/note.md' to 'c/d.m4a' -> '../../c/d.m4a'.
 */
export function relativePath(fromNotePath: string, toPath: string): string {
  const from = segments(normalizePath(dirname(fromNotePath)));
  const to = segments(normalizePath(toPath));
  // Shared leading folders; the target's own name never counts as one.
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  const ups: string[] = new Array(from.length - common).fill('..');
  return ups.concat(to.slice(common)).join('/');
}

/**
 * URL-encodes a relative path for a markdown link target, segment by segment so '/' stays.
 * Spaces become %20, non-ASCII is UTF-8 percent-encoded, and whatever means something in a link
 * or a URL is encoded as well: '(' and ')' (they end a markdown link), '#' (a heading anchor in
 * Obsidian), '?', '%', '[', ']', '&'. Punctuation that is harmless in a path (' ! * ~ - _ .)
 * stays readable.
 */
export function encodeLinkPath(relPath: string): string {
  return relPath
    .split('/')
    .map(s => encodeURIComponent(s).replace(/[()]/g, c => (c === '(' ? '%28' : '%29')))
    .join('/');
}

/**
 * Decodes a link target back to a path: strips '<…>' brackets and percent-decodes each segment
 * (a segment with a malformed escape is kept as written).
 */
export function decodeLinkPath(target: string): string {
  let t = target.trim();
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
  return t
    .split('/')
    .map(s => {
      try {
        return decodeURIComponent(s);
      } catch (e) {
        return s;
      }
    })
    .join('/');
}
