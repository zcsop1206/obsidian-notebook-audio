/*
 * The recorder, ported from the audio spike that was proven on the iPad (see CONTEXT.md, "What
 * the iPad tests established"). Web APIs only. One recording is a folder: segment-NN.<ext> files,
 * meta.json (the timeline, src/meta.ts) and, when asked, log.md.
 *
 * iOS cuts the mic whenever Obsidian is hidden and the recorder never delivers audio again after
 * a return, so every return starts a new segment on a fresh stream, and a watchdog does the same
 * when no chunk arrives for 3 timeslices while visible. The order of those two on a return is not
 * fixed on the iPad; the comments below say how each case is handled. Keep them as they are.
 *
 * The recorder only logs; notices are the caller's job.
 */
import type { DataAdapter } from 'obsidian';
import type { Meta, MetaSegment, SegmentReason } from './meta';
import { META_FILE, META_FORMAT } from './meta';
import { LOG_PREFIX, Queue, appendText, clock, ensureDir, kb, mmss, pad, r1 } from './util';

const CHUNK_MS = 2000;
/** How long the UI shows "resumed" after a hidden period. */
const RESUMED_MS = 5000;
/** stop() gives up waiting for a recorder's stop event after this long. */
const CLOSE_TIMEOUT_MS = 5000;

export interface RecorderOptions {
  /** Vault path of the recording folder; created if missing. */
  dir: string;
  /** audioBitsPerSecond, e.g. 96000. */
  bitrate: number;
  /** 'auto' = pickFormat(); otherwise this mime type if supported, else pickFormat() (logged). */
  format: 'auto' | string;
  /** Write log.md into dir (else log only to the console). */
  log: boolean;
  /** Stored in meta.note. */
  note?: string;
  /** Stored in meta.version. */
  version: string;
  /** Stored in meta.device.platform; the caller derives it from Obsidian's Platform. */
  platform: 'ios' | 'android' | 'desktop';
}

export type RecorderState = 'idle' | 'starting' | 'recording' | 'paused' | 'resumed' | 'stopping';

export interface RecorderSnapshot {
  /** 'paused' = recording but the document is hidden (audio is being lost); 'resumed' = back for less than 5 s after a hidden period. */
  state: RecorderState;
  /** Since start, 0 when idle. */
  elapsedMs: number;
  bytes: number;
  segments: number;
  /** Total time hidden while recording: the sum of the gaps, including the one running while paused. */
  lostMs: number;
  /** The most recent finished gap, for "resumed, 0:31 lost". */
  lastLostMs: number;
  /** '' when idle. */
  dir: string;
  /** Why the last start() returned false, e.g. 'microphone refused: NotAllowedError'. */
  error?: string;
}

type Phase = 'idle' | 'starting' | 'recording' | 'stopping';

interface Segment {
  n: string;
  file: string;
  parts: string;
  append: boolean;
  idx: number;
  bytes: number;
  meta: MetaSegment;
  /** Resolves once the recorder's stop event has been handled. */
  closed: Promise<void>;
}

const FORMATS: [string, string][] = [['audio/mp4', 'm4a'], ['audio/webm;codecs=opus', 'webm'], ['audio/webm', 'webm'], ['audio/ogg;codecs=opus', 'ogg']];

/** The first supported format, as [mime, ext]; ['', 'bin'] lets the browser choose. */
export function pickFormat(): [string, string] {
  for (const [mime, ext] of FORMATS) if (MediaRecorder.isTypeSupported(mime)) return [mime, ext];
  return ['', 'bin'];
}

function extFor(mime: string) {
  const m = mime.toLowerCase();
  if (m.startsWith('audio/mp4') || m.startsWith('audio/aac') || m.startsWith('audio/x-m4a')) return 'm4a';
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  return 'bin';
}

/** Concatenates parts-NN/*.bin into `file` and removes the folder. Returns the byte count. */
async function mergeParts(adapter: DataAdapter, dir: string, file: string) {
  if (!(await adapter.exists(dir))) return 0;
  const files = (await adapter.list(dir)).files.sort();
  const bufs: Uint8Array[] = [];
  for (const f of files) bufs.push(new Uint8Array(await adapter.readBinary(f)));
  const out = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of bufs) { out.set(b, o); o += b.length; }
  await adapter.writeBinary(file, out.buffer);
  await adapter.rmdir(dir, true);
  return out.length;
}

const errText = (e: unknown) => { const err = e as Error; return err && err.name ? `${err.name}: ${err.message}` : String(e); };
const lastComponent = (dir: string) => dir.split('/').filter(Boolean).pop() || dir;

export class Recorder {
  // Test hooks: rec, stream, q and track() are public on purpose.
  q = new Queue();
  rec?: MediaRecorder;
  stream?: MediaStream;
  /** The live meta while recording; undefined when idle. */
  meta: Meta | undefined;

  private adapter: DataAdapter;
  private onChange?: (s: RecorderSnapshot) => void;
  private phase: Phase = 'idle';
  private dir = '';
  private logPath = '';
  private mime = '';
  private ext = '';
  private bitrate = 96000;
  private hasAppend = false;
  private bytes = 0;
  private segment = 0;
  private chunks = 0;
  private lateChunks = 0;
  private worstGap = 0;
  private startedAt = 0;
  private lastChunk = 0;
  private hiddenAt: number | null = null;
  private resumedAt = 0;
  private lostMs = 0;
  private lastLostMs = 0;
  private error?: string;
  private reopening = false;
  private wakeNoted = false;
  private open = new Set<Segment>();
  private wake?: WakeLockSentinel;
  private ticker?: number;
  private dog?: number;
  private onVisibility: () => void;
  private onPageHide: (e: PageTransitionEvent) => void;
  private onPageShow: (e: PageTransitionEvent) => void;
  private onFreeze: () => void;
  private onResume: () => void;

  constructor(adapter: DataAdapter, onChange?: (s: RecorderSnapshot) => void) {
    this.adapter = adapter;
    this.onChange = onChange;
    this.onVisibility = () => { void this.visibilityChanged(); };
    this.onPageHide = e => this.note(`pagehide (persisted ${e.persisted})`);
    this.onPageShow = e => this.note(`pageshow (persisted ${e.persisted})`);
    this.onFreeze = () => this.note('page frozen');
    this.onResume = () => this.note('page resumed');
  }

  get state(): RecorderState {
    if (this.phase !== 'recording') return this.phase;
    if (this.hiddenAt !== null) return 'paused';
    if (this.resumedAt && Date.now() - this.resumedAt < RESUMED_MS) return 'resumed';
    return 'recording';
  }

  private get elapsed() { return this.phase === 'idle' ? 0 : Date.now() - this.startedAt; }

  snapshot(): RecorderSnapshot {
    const idle = this.phase === 'idle';
    const running = this.hiddenAt !== null && !idle ? Date.now() - this.hiddenAt : 0;
    const s: RecorderSnapshot = {
      state: this.state,
      elapsedMs: this.elapsed,
      bytes: idle ? 0 : this.bytes,
      segments: idle ? 0 : this.segment,
      lostMs: idle ? 0 : this.lostMs + running,
      lastLostMs: idle ? 0 : this.lastLostMs,
      dir: idle ? '' : this.dir,
    };
    if (this.error) s.error = this.error;
    return s;
  }

  private emit() {
    if (!this.onChange) return;
    try { this.onChange(this.snapshot()); } catch (e) { console.error(LOG_PREFIX, e); }
  }

  track() { return this.stream && this.stream.getAudioTracks()[0]; }

  async start(opts: RecorderOptions): Promise<boolean> {
    if (this.phase !== 'idle') return false;
    this.error = undefined;
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return this.fail('MediaRecorder is not available here');
    }
    this.phase = 'starting';
    this.emit();
    // The mic first: a refusal leaves no folder or meta.json behind (a meta.json without `ended`
    // would look like an interrupted recording).
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { return this.fail(`microphone refused: ${(e as Error).name || e}`, errText(e)); }

    this.dir = opts.dir.replace(/\/+$/, '');
    this.logPath = '';
    this.startedAt = Date.now();
    this.segment = 0; this.bytes = 0; this.chunks = 0; this.lateChunks = 0; this.worstGap = 0;
    this.hiddenAt = null; this.resumedAt = 0; this.lostMs = 0; this.lastLostMs = 0;
    this.reopening = false; this.wakeNoted = false; this.open.clear();
    this.bitrate = opts.bitrate;
    this.hasAppend = typeof this.adapter.appendBinary === 'function';
    let fallback = '';
    if (opts.format && opts.format !== 'auto' && MediaRecorder.isTypeSupported(opts.format)) [this.mime, this.ext] = [opts.format, extFor(opts.format)];
    else {
      [this.mime, this.ext] = pickFormat();
      if (opts.format && opts.format !== 'auto') fallback = `format ${opts.format} is not supported here, using ${this.mime || 'the browser default'}`;
    }
    const track = stream.getAudioTracks()[0];
    const s: MediaTrackSettings = track && track.getSettings ? track.getSettings() : {};
    // segments[].startMs places each file on the recording's timeline; the time between one
    // segment's audio and the next start is lost (Obsidian was hidden). audioEndMs is set when known.
    const meta: Meta = {
      format: META_FORMAT, plugin: 'notebook-audio', version: opts.version, mime: this.mime, ext: this.ext,
      bitrate: this.bitrate, timesliceMs: CHUNK_MS, appendBinary: this.hasAppend, started: new Date(this.startedAt).toISOString(),
      device: { platform: opts.platform, userAgent: navigator.userAgent },
      segments: [],
    };
    if (opts.note !== undefined) meta.note = opts.note;
    if (track) {
      if (track.label) meta.device.mic = track.label;
      if (s.sampleRate) meta.device.sampleRate = s.sampleRate;
      if (s.channelCount) meta.device.channels = s.channelCount;
    }
    try {
      await ensureDir(this.adapter, this.dir);
      if (opts.log) {
        await this.adapter.write(`${this.dir}/log.md`, `# Recording ${lastComponent(this.dir)}\n\n`);
        this.logPath = `${this.dir}/log.md`;
      }
      await this.adapter.write(`${this.dir}/${META_FILE}`, JSON.stringify(meta, null, 1));
    } catch (e) {
      stream.getTracks().forEach(t => t.stop());
      return this.fail(`could not write to ${this.dir}: ${errText(e)}`);
    }
    this.meta = meta;
    this.note(`device: ${navigator.userAgent}`);
    this.note(`format ${this.mime || 'browser default'}, ${Math.round(this.bitrate / 1000)} kbps; appendBinary ${this.hasAppend ? 'yes' : 'no, writing parts'}; chunk every ${CHUNK_MS} ms`);
    if (fallback) this.note(fallback);
    this.useStream(stream);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('pageshow', this.onPageShow);
    document.addEventListener('freeze', this.onFreeze);
    document.addEventListener('resume', this.onResume);
    await this.holdScreen();
    this.phase = 'recording';
    this.startSegment('start');
    this.ticker = window.setInterval(() => this.summary(), 60000);
    this.dog = window.setInterval(() => this.watchdog(), 1000);
    this.emit();
    return true;
  }

  private fail(error: string, detail = error) {
    console.log(LOG_PREFIX, detail);
    this.error = error;
    this.phase = 'idle';
    this.emit();
    return false;
  }

  private async openMic() {
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { this.note(`microphone refused: ${errText(e)}`); return false; }
    this.useStream(stream);
    return true;
  }

  private useStream(stream: MediaStream) {
    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    if (!track) { this.note('microphone stream has no audio track'); return; }
    const s: MediaTrackSettings = track.getSettings ? track.getSettings() : {};
    this.note(`mic "${track.label}": ${s.sampleRate || '?'} Hz, ${s.channelCount || '?'} ch, echoCancellation ${s.echoCancellation}, noiseSuppression ${s.noiseSuppression}, autoGainControl ${s.autoGainControl}`);
    track.onmute = () => {
      this.note('mic muted (input interrupted)');
      // If the system never gives the input back, start over on a fresh stream.
      window.setTimeout(() => {
        if (this.phase === 'recording' && track === this.track() && track.muted && document.visibilityState === 'visible') void this.reopen('mic still muted after 3 s', 'mic ended');
      }, 3000);
    };
    track.onunmute = () => this.note('mic unmuted');
    track.onended = () => this.note('mic track ended');
  }

  private startSegment(reason: SegmentReason) {
    const meta = this.meta!;
    const n = pad(++this.segment);
    const file = `segment-${n}.${this.ext}`;
    let rec: MediaRecorder;
    try { rec = new MediaRecorder(this.stream!, this.mime ? { mimeType: this.mime, audioBitsPerSecond: this.bitrate } : { audioBitsPerSecond: this.bitrate }); }
    catch (e) { this.segment--; this.note(`MediaRecorder failed: ${errText(e)}`); return; }
    const metaSeg: MetaSegment = { file, startMs: Date.now() - this.startedAt, reason };
    let closed!: () => void;
    const seg: Segment = {
      n, file: `${this.dir}/${file}`, parts: `${this.dir}/parts-${n}`, append: this.hasAppend, idx: 0, bytes: 0, meta: metaSeg,
      closed: new Promise<void>(res => { closed = res; }),
    };
    rec.ondataavailable = ev => { if (ev.data && ev.data.size) this.chunk(seg, ev.data); };
    rec.onerror = ev => { const error = (ev as Event & { error?: DOMException }).error; this.note(`recorder error: ${error ? error.name : 'unknown'}`); };
    rec.onstop = () => {
      this.note(`segment ${n} closed: ${kb(seg.bytes)} in ${seg.idx} chunks`);
      metaSeg.bytes = seg.bytes;
      metaSeg.chunks = seg.idx;
      if (!seg.append) this.q.run(() => mergeParts(this.adapter, seg.parts, seg.file));
      this.saveMeta();
      this.open.delete(seg);
      closed();
    };
    rec.start(CHUNK_MS);
    this.rec = rec;
    this.open.add(seg);
    meta.segments.push(metaSeg);
    this.saveMeta();
    if (this.segment === 1) this.lastChunk = Date.now();
    this.note(`segment ${n} started (${reason}) as ${rec.mimeType || this.mime || 'default'}`);
    this.emit();
  }

  private chunk(seg: Segment, blob: Blob) {
    const now = Date.now(), gap = now - this.lastChunk;
    this.lastChunk = now;
    this.worstGap = Math.max(this.worstGap, gap);
    if (gap > CHUNK_MS * 1.75) { this.lateChunks++; this.note(`chunk arrived ${r1(gap / 1000)} s after the previous one`); }
    this.chunks++; this.bytes += blob.size; seg.bytes += blob.size;
    const idx = ++seg.idx;
    this.q.run(async () => {
      const buf = await blob.arrayBuffer();
      if (seg.append) { if (idx === 1) await this.adapter.writeBinary(seg.file, buf); else await this.adapter.appendBinary(seg.file, buf); }
      else { if (idx === 1) await ensureDir(this.adapter, seg.parts); await this.adapter.writeBinary(`${seg.parts}/${pad(idx, 5)}.bin`, buf); }
    });
  }

  private lastSegment() {
    const segs = this.meta ? this.meta.segments : [];
    return segs[segs.length - 1];
  }

  private async visibilityChanged() {
    const track = this.track();
    this.note(`app ${document.visibilityState}; mic ${track ? track.readyState + (track.muted ? ', muted' : '') : 'gone'}; recorder ${this.rec ? this.rec.state : 'none'}`);
    if (document.visibilityState === 'hidden') {
      if (this.hiddenAt === null) this.hiddenAt = Date.now();
      // Audio after this moment is lost; record it now in case the app is killed while hidden.
      const last = this.lastSegment();
      if (this.phase === 'recording' && last && last.audioEndMs === undefined) { last.audioEndMs = this.hiddenAt - this.startedAt; this.saveMeta(); }
      this.emit();
      return;
    }
    if (this.phase !== 'recording') return;
    await this.holdScreen();
    if (this.reopening) return; // the watchdog got there first
    if (this.hiddenAt) return this.resume();
    const now = this.track();
    if (!now || now.readyState === 'ended') await this.reopen('mic track had ended', 'mic ended');
    else if (!this.rec || this.rec.state === 'inactive') { this.note('recorder had stopped, starting a new segment'); this.startSegment('returned'); }
  }

  // On iOS the mic unmutes and the recorder still says "recording" after a lock or app
  // switch, but it never delivers audio again. So always start over on a fresh stream.
  private resume() {
    const hiddenAt = this.hiddenAt!, now = Date.now();
    const away = r1((now - hiddenAt) / 1000), last = this.lastSegment();
    if (last && last.audioEndMs === undefined) { last.audioEndMs = hiddenAt - this.startedAt; this.saveMeta(); }
    this.hiddenAt = null;
    this.lastLostMs = now - hiddenAt;
    this.lostMs += this.lastLostMs;
    this.resumedAt = now;
    this.emit();
    return this.reopen(`back after ${away} s hidden (audio from that time is lost)`, 'returned');
  }

  private saveMeta() {
    if (!this.meta) return;
    const path = `${this.dir}/${META_FILE}`, text = JSON.stringify(this.meta, null, 1);
    this.q.run(() => this.adapter.write(path, text));
  }

  // Restarts the recording if no chunk has arrived for 3 timeslices while visible. On the
  // iPad this can run before the visibilitychange event on return, so it handles that too.
  // It is also the UI's 1 s tick.
  private watchdog() {
    this.emit();
    if (this.phase !== 'recording' || this.reopening || document.visibilityState !== 'visible') return;
    if (this.hiddenAt) { void this.resume(); return; }
    const quiet = Date.now() - this.lastChunk;
    if (quiet > CHUNK_MS * 3) void this.reopen(`no audio for ${r1(quiet / 1000)} s`, 'watchdog');
  }

  private async reopen(reason: string, why: SegmentReason) {
    if (this.reopening) return;
    this.reopening = true;
    try {
      this.note(`${reason}, reopening the mic`);
      // A segment given up on while visible: its audio ends with the last chunk. (After a hide,
      // audioEndMs already holds the hide moment.)
      const last = this.lastSegment();
      if (last && last.audioEndMs === undefined) { last.audioEndMs = Math.max(last.startMs, this.lastChunk - this.startedAt); this.saveMeta(); }
      if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
      if (this.stream) this.stream.getTracks().forEach(t => t.stop());
      if (await this.openMic()) {
        // stop() may have run while the mic was opening: drop the new stream.
        if (this.phase !== 'recording') { if (this.stream) this.stream.getTracks().forEach(t => t.stop()); return; }
        this.startSegment(why);
      }
      this.lastChunk = Date.now();
    } finally { this.reopening = false; }
  }

  private async holdScreen() {
    if (this.wake && !this.wake.released) return;
    if (!navigator.wakeLock) { if (!this.wakeNoted) this.note('screen wake lock: not available'); this.wakeNoted = true; return; }
    try {
      this.wake = await navigator.wakeLock.request('screen');
      this.note('screen wake lock: held');
      this.wake.addEventListener('release', () => this.note('screen wake lock: released'));
    } catch (e) { this.note(`screen wake lock: refused (${(e as Error).name})`); }
  }

  /** Stops, waits for every write to land, and returns the final meta; null if not recording. */
  async stop(): Promise<Meta | null> {
    if (this.phase !== 'recording') return null;
    const stopMs = Date.now() - this.startedAt;
    this.phase = 'stopping';
    this.emit();
    window.clearInterval(this.ticker); window.clearInterval(this.dog);
    const rec = this.rec;
    if (rec && rec.state !== 'inactive') rec.stop();
    // Every recorder still closing (this one, or one a reopen just stopped) flushes its last chunk
    // and updates meta in its stop handler.
    const pending = [...this.open].map(s => s.closed);
    if (pending.length) await Promise.race([Promise.all(pending), new Promise(res => window.setTimeout(res, CLOSE_TIMEOUT_MS))]);
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.wake && !this.wake.released) await this.wake.release().catch(() => {});
    this.wake = undefined;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('pageshow', this.onPageShow);
    document.removeEventListener('freeze', this.onFreeze);
    document.removeEventListener('resume', this.onResume);
    const meta = this.meta!;
    const last = this.lastSegment();
    if (last && last.audioEndMs === undefined) last.audioEndMs = stopMs;
    meta.stoppedMs = stopMs;
    meta.ended = 'clean';
    this.summary();
    this.note('session stopped');
    this.saveMeta();
    await this.q.idle();
    this.phase = 'idle';
    this.meta = undefined;
    this.rec = undefined;
    this.stream = undefined;
    this.open.clear();
    this.emit();
    return meta;
  }

  private summary() {
    const mins = Math.max(this.elapsed, 1000) / 60000;
    this.note(`so far: ${this.chunks} chunks, ${kb(this.bytes)} (${kb(this.bytes / mins)}/min), ${this.lateChunks} late, longest gap ${r1(this.worstGap / 1000)} s, ${this.segment} segment(s), ${mmss(this.lostMs)} lost`);
  }

  private note(msg: string) {
    console.log(LOG_PREFIX, msg);
    if (!this.logPath) return;
    const line = `- ${clock()} +${mmss(Date.now() - this.startedAt)} ${msg}\n`;
    const path = this.logPath;
    this.q.run(() => this.adapter.append(path, line));
  }
}

/** After a crash or force quit: merges leftover parts-NN folders into segment files, fills missing
 *  segment bytes from file sizes (adapter.stat), sets ended = 'recovered', appends a line to log.md
 *  if it exists, writes meta.json. Returns the meta, or null if the folder has no meta.json or is
 *  already ended. Must not touch a recording in progress (the caller decides which dir to pass). */
export async function recoverRecording(adapter: DataAdapter, dir: string): Promise<Meta | null> {
  dir = dir.replace(/\/+$/, '');
  const metaPath = `${dir}/${META_FILE}`;
  if (!(await adapter.exists(metaPath))) return null;
  let meta: Meta;
  try { meta = JSON.parse(await adapter.read(metaPath)); } catch (e) { console.log(LOG_PREFIX, `recovery: unreadable ${metaPath}: ${errText(e)}`); return null; }
  if (!meta || typeof meta !== 'object' || !Array.isArray(meta.segments) || meta.ended) return null;
  const ext = meta.ext || 'bin';
  const rebuilt: string[] = [];
  const folders = (await adapter.list(dir)).folders.filter(f => /\/parts-\d+$/.test(f)).sort();
  for (const parts of folders) {
    const n = parts.slice(parts.lastIndexOf('parts-') + 6);
    const size = await mergeParts(adapter, parts, `${dir}/segment-${n}.${ext}`);
    rebuilt.push(`segment ${n} rebuilt from parts (${kb(size)})`);
  }
  for (const seg of meta.segments) {
    if (typeof seg.bytes === 'number') continue;
    const st = await adapter.stat(`${dir}/${seg.file}`);
    if (st && st.type === 'file') seg.bytes = st.size;
  }
  meta.ended = 'recovered';
  const log = `${dir}/log.md`;
  const line = `- ${clock()} recovered after unclean exit: ${rebuilt.length ? rebuilt.join('; ') : 'audio was appended live, nothing to rebuild'}\n`;
  console.log(LOG_PREFIX, `${dir}: ${line.slice(2).trim()}`);
  if (await adapter.exists(log)) await appendText(adapter, log, line);
  await adapter.write(metaPath, JSON.stringify(meta, null, 1));
  return meta;
}
