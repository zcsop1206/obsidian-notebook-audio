/*
 * The lines a recording writes into its note, and recognising them again (for the player's
 * button and the "open a recording of this note" list). Standard markdown only, never
 * wikilinks. Pure: no 'obsidian' import. See CONTEXT.md, "Note links".
 */
import { type Meta, recordingName, summaryText, type Timeline, wallClockAt } from './meta';
import { basename, decodeLinkPath, dirname, encodeLinkPath, joinPath, normalizePath, relativePath } from './paths';
import { clock, mmss } from './util';

export interface SegmentLink { file: string; startMs: number; durationMs: number; }

/** The segments of a timeline, in order, as the links show them. */
export function segmentLinks(tl: Timeline): SegmentLink[] {
  const out: SegmentLink[] = [];
  for (const it of tl.items) if (it.kind === 'segment') out.push({ file: it.file, startMs: it.startMs, durationMs: it.durationMs });
  return out;
}

/**
 * The lines written to the note, each ending in '\n', after a blank line:
 *
 *   Recording 2026-09-27 14:03 (12:41 in 2 segments, 0:31 lost while Obsidian was in the background)
 *   ![segment 1, 14:03:12, 6:10](Lecture%203/audio/2026-09-27%2014-03/segment-01.m4a)
 *   ![segment 2, 14:09:53, 6:31](Lecture%203/audio/2026-09-27%2014-03/segment-02.m4a)
 *
 * The alt is 'segment N, <local wall clock of the segment's start>, <its duration>'. `notePath`
 * is the note the lines go into and `dir` the recording folder (vault path); targets are relative
 * to the note's folder and URL-encoded. `tl` is buildTimeline(meta, decoded durations if any).
 */
export function recordingLines(meta: Meta, tl: Timeline, notePath: string, dir: string): string {
  let out = `\n${recordingName(meta)} (${summaryText(tl)})\n`;
  segmentLinks(tl).forEach((s, i) => {
    const alt = `segment ${i + 1}, ${clock(wallClockAt(meta, s.startMs))}, ${mmss(s.durationMs)}`;
    out += `![${alt}](${encodeLinkPath(relativePath(notePath, joinPath(dir, s.file)))})\n`;
  });
  return out;
}

const HEADER = /^(Recording \d{4}-\d{2}-\d{2} \d{2}:\d{2})(?: \(.*\))?\s*$/;
/** '![alt](target)' alone on a line; the target may be '<…>'-bracketed and followed by a title. */
const EMBED = /^\s*!\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+"[^"]*")?\s*\)\s*$/;

/**
 * Recognises the lines above in note text: every group of consecutive segment embeds, with the
 * header line's index and the recording name when a header precedes them (else the first embed's
 * line and no name), and each embed's alt and raw target. Line indexes are 0-based. Windows line
 * endings are tolerated.
 */
export function parseRecordingLinks(text: string): { line: number; name?: string; segments: { alt: string; target: string }[] }[] {
  const lines = text.split(/\r?\n/);
  const groups: { line: number; name?: string; segments: { alt: string; target: string }[] }[] = [];
  const embedAt = (i: number) => {
    const m = i < lines.length ? EMBED.exec(lines[i]) : null;
    return m && isSegmentTarget(m[2]) ? { alt: m[1], target: m[2] } : null;
  };
  for (let i = 0; i < lines.length; i++) {
    const h = HEADER.exec(lines[i]);
    const start = h ? i + 1 : i;
    const segs: { alt: string; target: string }[] = [];
    let j = start;
    for (let e = embedAt(j); e; e = embedAt(++j)) segs.push(e);
    if (!segs.length) continue;
    groups.push(h ? { line: i, name: h[1], segments: segs } : { line: i, segments: segs });
    i = j - 1;
  }
  return groups;
}

/**
 * True when a link target (raw, as in the note) points at a segment file: its decoded basename
 * is 'segment-NN.<ext>', any case (NN has two digits, three from segment 100 up).
 */
export function isSegmentTarget(target: string): boolean {
  return /^segment-\d{2,}\.[a-z0-9]+$/i.test(basename(decodeLinkPath(target)));
}

/**
 * The recording folder (vault path) of a segment target, resolved against the note's folder:
 * for note 'Notes/Physics/Lecture 3.md' and target
 * 'Lecture%203/audio/2026-09-27%2014-03/segment-01.m4a' ->
 * 'Notes/Physics/Lecture 3/audio/2026-09-27 14-03'. Handles '../' and a leading './'; a target
 * starting with '/' is taken from the vault root.
 */
export function recordingFolderOfTarget(notePath: string, target: string): string {
  const path = decodeLinkPath(target);
  const base = path.startsWith('/') ? '' : dirname(notePath);
  return normalizePath(joinPath(base, dirname(path)));
}
