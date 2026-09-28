/*
 * meta.json: the recording's timeline. One file per recording folder, written by the recorder
 * and read by the player and the note links. Pure: no 'obsidian' import. See CONTEXT.md.
 */
import { hhmm, mmss, ymd } from './util';

export const META_FORMAT = 1;
export const META_FILE = 'meta.json';

export type SegmentReason = 'start' | 'returned' | 'watchdog' | 'mic ended';

export interface MetaSegment {
  /** File name inside the recording folder, e.g. segment-01.m4a. */
  file: string;
  /** When this segment's MediaRecorder started, ms on the recording's timeline. */
  startMs: number;
  /** Last moment audio is believed to exist, ms on the timeline. Absent for the last segment of a recovered recording. */
  audioEndMs?: number;
  bytes?: number;
  chunks?: number;
  reason: SegmentReason;
}

export interface MetaDevice {
  platform: 'ios' | 'android' | 'desktop';
  userAgent: string;
  mic?: string;
  sampleRate?: number;
  channels?: number;
}

export interface Meta {
  format: number;
  plugin: 'notebook-audio';
  version: string;
  mime: string;
  ext: string;
  bitrate: number;
  timesliceMs: number;
  appendBinary: boolean;
  /** ISO UTC; wall-clock time of a position = Date.parse(started) + startMs + position. */
  started: string;
  /** Vault path of the note the recording belongs to, if any. */
  note?: string;
  device: MetaDevice;
  segments: MetaSegment[];
  /** Set on a clean stop, ms on the timeline. */
  stoppedMs?: number;
  /** 'clean' after stop, 'recovered' after recovery; absent while recording or after an unclean exit. */
  ended?: 'clean' | 'recovered';
}

/** 'Recording 2026-09-27 14:03' from meta.started, in local time. */
export function recordingName(meta: Pick<Meta, 'started'>): string {
  const d = new Date(Date.parse(meta.started));
  return `Recording ${ymd(d)} ${hhmm(d)}`;
}

/** Local Date of a position on the recording's timeline. */
export function wallClockAt(meta: Pick<Meta, 'started'>, timelineMs: number): Date {
  return new Date(Date.parse(meta.started) + timelineMs);
}

export type TimelineItem =
  | { kind: 'segment'; index: number; file: string; startMs: number; endMs: number; durationMs: number }
  | { kind: 'gap'; startMs: number; endMs: number; durationMs: number };

export interface Timeline {
  /** Segments in order, with a gap item between two segments wherever audio was lost. */
  items: TimelineItem[];
  /** The last segment's endMs: the length of the timeline, gaps included. */
  totalMs: number;
  /** Sum of the segments' durations: the audio that exists. */
  recordedMs: number;
  /** Sum of the gaps: the audio lost while Obsidian was in the background (or the mic stalled). */
  lostMs: number;
  segments: number;
}

/** A usable duration: finite and not negative. */
const known = (v: number | undefined): v is number => typeof v === 'number' && isFinite(v) && v >= 0;

/**
 * Builds the timeline. A segment's length is `durationsMs[i]` (its decoded duration) when known,
 * else `audioEndMs - startMs`, else 0 (the last segment of a recovered recording before it has
 * been decoded). It sits at `startMs` and ends at `startMs + duration`. The gap after segment i
 * is `segments[i+1].startMs - endMs_i`, left out when it is zero or negative (never negative).
 */
export function buildTimeline(meta: Pick<Meta, 'segments'>, durationsMs?: (number | undefined)[]): Timeline {
  const items: TimelineItem[] = [];
  let recordedMs = 0, lostMs = 0, totalMs = 0;
  let prevEnd: number | undefined;
  meta.segments.forEach((s, index) => {
    const given = durationsMs ? durationsMs[index] : undefined;
    const durationMs = known(given) ? given : s.audioEndMs !== undefined ? Math.max(0, s.audioEndMs - s.startMs) : 0;
    if (prevEnd !== undefined && s.startMs - prevEnd > 0) {
      items.push({ kind: 'gap', startMs: prevEnd, endMs: s.startMs, durationMs: s.startMs - prevEnd });
      lostMs += s.startMs - prevEnd;
    }
    const endMs = s.startMs + durationMs;
    items.push({ kind: 'segment', index, file: s.file, startMs: s.startMs, endMs, durationMs });
    recordedMs += durationMs;
    totalMs = prevEnd = endMs;
  });
  return { items, totalMs, recordedMs, lostMs, segments: meta.segments.length };
}

/**
 * Where a timeline position falls: inside segment i at offsetMs; in a gap (or before the first
 * segment) -> the next segment at offset 0 with inGap true, so seeking into a gap jumps to the
 * next segment; at or past the end -> the last segment at its duration. A negative position
 * counts as 0. Segment indexes are 0-based; an empty timeline gives segment -1.
 */
export function locate(tl: Timeline, positionMs: number): { segment: number; offsetMs: number; inGap: boolean } {
  const timelineMs = Math.max(0, positionMs);
  let last: Extract<TimelineItem, { kind: 'segment' }> | undefined;
  for (const it of tl.items) if (it.kind === 'segment') last = it;
  if (!last) return { segment: -1, offsetMs: 0, inGap: false };
  if (timelineMs >= tl.totalMs) return { segment: last.index, offsetMs: last.durationMs, inGap: false };
  for (let i = 0; i < tl.items.length; i++) {
    const it = tl.items[i];
    if (it.kind === 'segment') {
      // Before this segment and not inside anything earlier: the lead-in before the first one.
      if (timelineMs < it.startMs) return { segment: it.index, offsetMs: 0, inGap: true };
      if (timelineMs < it.endMs) return { segment: it.index, offsetMs: timelineMs - it.startMs, inGap: false };
    } else if (timelineMs >= it.startMs && timelineMs < it.endMs) {
      const next = tl.items[i + 1];
      if (next && next.kind === 'segment') return { segment: next.index, offsetMs: 0, inGap: true };
    }
  }
  return { segment: last.index, offsetMs: last.durationMs, inGap: false };
}

/**
 * Summary text as the note's header line shows it: '12:41 in 2 segments, 0:31 lost while
 * Obsidian was in the background'; '12:41 in 2 segments' when less than a second was lost (a
 * watchdog restart); just '12:41' for a single segment. The duration is the recorded audio.
 */
export function summaryText(tl: Timeline): string {
  if (tl.segments <= 1) return mmss(tl.recordedMs);
  const lost = tl.lostMs >= 1000 ? `, ${mmss(tl.lostMs)} lost while Obsidian was in the background` : '';
  return `${mmss(tl.recordedMs)} in ${tl.segments} segments${lost}`;
}
