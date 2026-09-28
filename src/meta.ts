/*
 * meta.json: the recording's timeline. One file per recording folder, written by the recorder
 * and read by the player and the note links. Pure: no 'obsidian' import. See CONTEXT.md.
 */

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
