/*
 * The player: plays a recording's segments as one timeline, with the gaps where audio was lost
 * shown in the bar and skipped in playback, and the wall-clock time of the current position.
 * One <audio> per segment; files are never merged (they are independent MP4s and the gaps must
 * stay visible). Opened by the command "Open a recording of this note" and by a button that a
 * markdown post-processor adds after a recording's embeds in reading view. See CONTEXT.md, "UI".
 */
import { FuzzySuggestModal, ItemView, Notice, type Plugin, setIcon, type App, type FuzzyMatch, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import { buildTimeline, locate, META_FILE, type Meta, recordingName, summaryText, type Timeline, type TimelineItem, wallClockAt } from './meta';
import { isSegmentTarget, recordingFolderOfTarget } from './links';
import { audioFolderForNote, basename, joinPath } from './paths';
import { clock, LOG_PREFIX, mmss } from './util';

export const PLAYER_VIEW = 'notebook-audio-player';

export interface PlayerApi {
  /** Shows the recording in `dir` (vault path of its folder), reusing a player already showing it. */
  open(dir: string): Promise<void>;
}

/** How long to wait for an <audio>'s metadata before falling back to meta.json's audioEndMs. */
const METADATA_TIMEOUT_MS = 5000;
/** How long "0:31 lost here" stays up. */
const GAP_NOTE_MS = 2500;
/** "Previous" restarts the current segment when more than this has played, as media players do. */
const RESTART_MS = 2000;

type SegmentItem = Extract<TimelineItem, { kind: 'segment' }>;
type GapItem = Extract<TimelineItem, { kind: 'gap' }>;

/** '0:31', or 'under a second' for a gap too short for M:SS. */
function lostText(ms: number) {
  return ms < 1000 ? 'under a second' : mmss(ms);
}

/** The gap's tooltip; the next segment's reason says why the audio is missing. */
function gapTitle(gap: GapItem, meta: Meta, next: SegmentItem | undefined) {
  const reason = next ? meta.segments[next.index]?.reason : undefined;
  const why = reason === 'returned' || reason === undefined ? 'while Obsidian was in the background' : 'while the microphone delivered no audio';
  return `${lostText(gap.durationMs)} lost ${why}`;
}

/** Only one player plays at a time, across views too. */
let playingView: PlayerView | null = null;

export class PlayerView extends ItemView {
  /** Vault path of the recording folder; the view's state. */
  dir = '';
  meta: Meta | undefined;
  timeline: Timeline | undefined;
  /** One per segment, in meta.segments order. Never in the DOM. */
  audios: HTMLAudioElement[] = [];
  /** Segments whose file is missing or failed to load; skipped in playback. */
  missing: boolean[] = [];
  /** Why the recording could not be shown, if it couldn't. */
  error = '';

  private pos = 0;
  private current = 0;
  private playing = false;
  private loadId = 0;
  private raf = 0;
  private gapNoteTimer = 0;
  private cleanups: (() => void)[] = [];

  private barEl: HTMLElement | undefined;
  private headEl: HTMLElement | undefined;
  private itemEls: { item: TimelineItem; el: HTMLElement }[] = [];
  private timeEl: HTMLElement | undefined;
  private clockEl: HTMLElement | undefined;
  private segEl: HTMLElement | undefined;
  private playBtn: HTMLButtonElement | undefined;
  private gapNoteEl: HTMLElement | undefined;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType() { return PLAYER_VIEW; }
  getIcon() { return 'audio-lines'; }
  getDisplayText() {
    if (this.meta) return recordingName(this.meta);
    return this.dir ? basename(this.dir) : 'Recording';
  }

  getState(): Record<string, unknown> {
    return { ...super.getState(), dir: this.dir };
  }

  async setState(state: unknown, result: ViewStateResult) {
    const dir = state && typeof (state as { dir?: unknown }).dir === 'string' ? (state as { dir: string }).dir : '';
    if (dir && (dir !== this.dir || !this.meta)) await this.loadDir(dir);
    await super.setState(state, result);
  }

  async onOpen() {
    this.contentEl.addClass('notebook-audio-player');
    this.contentEl.tabIndex = 0;
    // Space toggles play/pause while the view has focus. A focused button handles Space itself.
    this.registerDomEvent(this.contentEl, 'keydown', (e: KeyboardEvent) => {
      if (e.key !== ' ' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest('button, input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      this.toggle();
    });
    if (!this.dir) this.message('No recording');
  }

  async onClose() {
    this.teardown();
  }

  onResize() {
    this.refresh();
  }

  // ---- public for the tests

  get position() { return this.pos; }
  get currentSegment() { return this.current; }
  get isPlaying() { return this.playing; }

  /** Plays from the current position; from the start again when at the end. */
  play() {
    const tl = this.timeline;
    if (!tl || !this.audios.length) return;
    if (this.pos >= tl.totalMs) this.pos = 0;
    const loc = locate(tl, this.pos);
    let i = loc.segment;
    let offsetMs = loc.inGap ? 0 : loc.offsetMs;
    if (this.missing[i]) {
      i = this.nextPlayable(i);
      offsetMs = 0;
    }
    if (i < 0) return this.finish();
    if (playingView && playingView !== this) playingView.pause();
    playingView = this;
    this.pos = this.seg(i).startMs + offsetMs;
    this.current = i;
    this.playing = true;
    this.startSegment(i, offsetMs);
    this.loop();
    this.refresh();
  }

  pause() {
    this.playing = false;
    if (playingView === this) playingView = null;
    for (const a of this.audios) a.pause();
    this.stopLoop();
    // Where the audio actually stopped, not the last frame's estimate.
    this.syncFromAudio();
    this.refresh();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Moves to a timeline position; a position in a gap lands on the next segment's start. */
  seekTo(ms: number) {
    const tl = this.timeline;
    if (!tl || !this.audios.length) return;
    const loc = locate(tl, ms);
    let i = loc.segment;
    let offsetMs = loc.inGap ? 0 : loc.offsetMs;
    const gap = loc.inGap ? this.gapAt(ms) : undefined;
    if (this.missing[i]) {
      const next = this.nextPlayable(i);
      if (next < 0) {
        // Nothing playable from here on: park at the end.
        for (const a of this.audios) a.pause();
        this.pos = tl.totalMs;
        this.current = i;
        if (this.playing) this.finish();
        this.refresh();
        return;
      }
      i = next;
      offsetMs = 0;
    }
    this.pos = this.seg(i).startMs + offsetMs;
    this.current = i;
    if (gap) this.showGapNote(gap);
    if (this.playing) this.startSegment(i, offsetMs);
    else {
      this.pauseOthers(i);
      this.setTime(this.audios[i], offsetMs);
    }
    this.refresh();
  }

  /** Start of the previous segment, or of this one when more than two seconds of it have played. */
  previous() {
    const tl = this.timeline;
    if (!tl) return;
    const seg = this.seg(this.current);
    if (this.pos - seg.startMs > RESTART_MS) return this.seekTo(seg.startMs);
    for (let i = this.current - 1; i >= 0; i--) if (!this.missing[i]) return this.seekTo(this.seg(i).startMs);
    this.seekTo(seg.startMs);
  }

  /** Start of the next segment, or the end after the last one. */
  next() {
    const tl = this.timeline;
    if (!tl) return;
    const i = this.nextPlayable(this.current + 1);
    if (i < 0) {
      if (this.playing) this.pause();
      this.pos = tl.totalMs;
      this.refresh();
      return;
    }
    const gap = this.gapBefore(i);
    this.seekTo(this.seg(i).startMs);
    if (gap) this.showGapNote(gap);
  }

  // ---- loading

  private async loadDir(dir: string) {
    this.teardown();
    const id = ++this.loadId;
    this.dir = dir;
    this.meta = this.timeline = undefined;
    this.error = '';
    this.pos = 0;
    this.current = 0;
    this.message('Loading…');
    const adapter = this.app.vault.adapter;
    let meta: Meta;
    try {
      meta = JSON.parse(await adapter.read(joinPath(dir, META_FILE)));
      if (!meta || !Array.isArray(meta.segments)) throw new Error('no segments');
    } catch (e) {
      if (id !== this.loadId) return;
      this.error = `Could not read ${joinPath(dir, META_FILE)}: ${e}`;
      console.error(LOG_PREFIX, this.error);
      this.message(this.error);
      return;
    }
    if (id !== this.loadId) return;
    this.meta = meta;
    // The durations come from the files; the tab title is right already.
    void this.loadAudio(id, dir, meta);
  }

  private async loadAudio(id: number, dir: string, meta: Meta) {
    const adapter = this.app.vault.adapter;
    const exists = await Promise.all(meta.segments.map(s => adapter.exists(joinPath(dir, s.file)).catch(() => false)));
    if (id !== this.loadId) return;
    this.missing = exists.map(e => !e);
    this.audios = meta.segments.map((s, i) => {
      const a = document.createElement('audio');
      a.preload = 'metadata';
      if (exists[i]) a.src = adapter.getResourcePath(joinPath(dir, s.file));
      return a;
    });
    const durations = await Promise.all(this.audios.map((a, i) => (exists[i] ? this.duration(a, i) : Promise.resolve(undefined))));
    if (id !== this.loadId) return;
    this.timeline = buildTimeline(meta, durations);
    this.audios.forEach((a, i) => this.listen(a, i));
    // At 0, the moment recording started (the first segment may start a few ms later).
    this.pos = 0;
    this.current = Math.max(0, this.nextPlayable(0));
    this.render();
  }

  /** The decoded duration in ms, or undefined (error, timeout, or an infinite live-written file). */
  private duration(a: HTMLAudioElement, i: number): Promise<number | undefined> {
    return new Promise(resolve => {
      let timer = 0;
      const done = (v: number | undefined) => {
        window.clearTimeout(timer);
        a.removeEventListener('loadedmetadata', onMeta);
        a.removeEventListener('error', onError);
        resolve(v);
      };
      const onMeta = () => done(isFinite(a.duration) && a.duration > 0 ? a.duration * 1000 : undefined);
      const onError = () => {
        this.missing[i] = true;
        done(undefined);
      };
      a.addEventListener('loadedmetadata', onMeta);
      a.addEventListener('error', onError);
      timer = window.setTimeout(() => done(undefined), METADATA_TIMEOUT_MS);
      if (a.readyState >= 1) onMeta();
    });
  }

  private listen(a: HTMLAudioElement, i: number) {
    const on = (type: string, fn: () => void) => {
      a.addEventListener(type, fn);
      this.cleanups.push(() => a.removeEventListener(type, fn));
    };
    on('ended', () => this.onEnded(i));
    on('timeupdate', () => {
      if (i !== this.current || !this.playing) return;
      this.syncFromAudio();
      this.refresh();
    });
    on('error', () => {
      if (this.missing[i]) return;
      this.missing[i] = true;
      console.warn(LOG_PREFIX, `player: ${this.meta?.segments[i]?.file} failed to load`, a.error);
      this.markMissing();
      if (i === this.current && this.playing) this.onEnded(i);
    });
  }

  private teardown() {
    this.loadId++;
    this.playing = false;
    if (playingView === this) playingView = null;
    this.stopLoop();
    window.clearTimeout(this.gapNoteTimer);
    for (const f of this.cleanups.splice(0)) f();
    for (const a of this.audios) {
      a.pause();
      a.removeAttribute('src');
      a.load();
    }
    this.audios = [];
    this.missing = [];
    this.itemEls = [];
  }

  // ---- playback

  private seg(i: number): SegmentItem {
    const it = this.timeline!.items.find(x => x.kind === 'segment' && x.index === i);
    return it as SegmentItem;
  }

  /** The first segment from index i on that can play, or -1. */
  private nextPlayable(i: number) {
    for (let j = Math.max(0, i); j < this.audios.length; j++) if (!this.missing[j]) return j;
    return -1;
  }

  private gapAt(ms: number): GapItem | undefined {
    return this.timeline?.items.find((x): x is GapItem => x.kind === 'gap' && ms >= x.startMs && ms < x.endMs);
  }

  /** The gap right before segment i, if there is one. */
  private gapBefore(i: number): GapItem | undefined {
    const items = this.timeline?.items ?? [];
    const k = items.findIndex(x => x.kind === 'segment' && x.index === i);
    const prev = k > 0 ? items[k - 1] : undefined;
    return prev && prev.kind === 'gap' ? prev : undefined;
  }

  private setTime(a: HTMLAudioElement, offsetMs: number) {
    const t = offsetMs / 1000;
    if (Math.abs(a.currentTime - t) > 0.05) {
      try {
        a.currentTime = t;
      } catch (e) {
        // Not seekable yet (no metadata): it starts from 0.
      }
    }
  }

  private pauseOthers(i: number) {
    this.audios.forEach((a, j) => {
      if (j !== i && !a.paused) a.pause();
    });
  }

  /** Plays segment i from offsetMs, pausing every other one first. */
  private startSegment(i: number, offsetMs: number) {
    this.pauseOthers(i);
    const a = this.audios[i];
    this.setTime(a, offsetMs);
    const p = a.play();
    if (p) {
      p.catch((e: DOMException) => {
        if (e && e.name === 'AbortError') return; // a pause or a seek got there first
        console.warn(LOG_PREFIX, 'player: play() refused', e);
        if (this.current === i && this.playing) {
          this.playing = false;
          if (playingView === this) playingView = null;
          this.stopLoop();
          this.refresh();
        }
      });
    }
  }

  /** Segment i finished (or failed): on to the next playable one across the gap, else stop at the end. */
  private onEnded(i: number) {
    if (i !== this.current || !this.playing || !this.timeline) return;
    const next = this.nextPlayable(i + 1);
    if (next < 0) return this.finish();
    const gap = this.gapBefore(next);
    if (gap) this.showGapNote(gap);
    this.current = next;
    this.pos = this.seg(next).startMs;
    this.startSegment(next, 0);
    this.refresh();
  }

  /** Played to the end. */
  private finish() {
    this.playing = false;
    if (playingView === this) playingView = null;
    for (const a of this.audios) a.pause();
    this.stopLoop();
    if (this.timeline) this.pos = this.timeline.totalMs;
    this.refresh();
  }

  /** The position from the current audio element's time. */
  private syncFromAudio() {
    const tl = this.timeline;
    const a = this.audios[this.current];
    if (!tl || !a) return;
    const seg = this.seg(this.current);
    // A segment whose length came from meta.json may run a little past it: hold at its end.
    this.pos = Math.min(seg.endMs, seg.startMs + a.currentTime * 1000);
  }

  private loop() {
    if (this.raf) return;
    const tick = () => {
      this.raf = 0;
      if (!this.playing) return;
      this.syncFromAudio();
      this.refresh();
      this.raf = window.requestAnimationFrame(tick);
    };
    this.raf = window.requestAnimationFrame(tick);
  }

  private stopLoop() {
    if (this.raf) window.cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  // ---- rendering

  private message(text: string) {
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: 'notebook-audio-message', text });
  }

  private render() {
    const meta = this.meta!, tl = this.timeline!;
    const el = this.contentEl;
    el.empty();

    const header = el.createDiv({ cls: 'notebook-audio-header' });
    header.createDiv({ cls: 'notebook-audio-title', text: recordingName(meta) });
    header.createDiv({ cls: 'notebook-audio-summary', text: summaryText(tl) });
    if (meta.note) {
      const note = meta.note;
      const noteName = basename(note).replace(/\.md$/i, '');
      const link = header.createEl('a', { cls: 'notebook-audio-note', text: noteName, href: '#' });
      link.addEventListener('click', e => {
        e.preventDefault();
        void this.app.workspace.openLinkText(note, '', true);
      });
    }

    const bar = el.createDiv({ cls: 'notebook-audio-bar' });
    this.barEl = bar;
    this.itemEls = [];
    tl.items.forEach((item, k) => {
      let span: HTMLElement;
      if (item.kind === 'segment') {
        span = bar.createSpan({ cls: 'notebook-audio-seg' });
        span.title = `segment ${item.index + 1}, ${mmss(item.durationMs)}`;
        span.dataset.index = String(item.index);
      } else {
        span = bar.createSpan({ cls: 'notebook-audio-gap' });
        const next = tl.items[k + 1];
        span.title = gapTitle(item, meta, next && next.kind === 'segment' ? next : undefined);
      }
      span.style.flexGrow = String(item.durationMs);
      this.itemEls.push({ item, el: span });
    });
    this.headEl = bar.createDiv({ cls: 'notebook-audio-head' });
    this.gapNoteEl = bar.createDiv({ cls: 'notebook-audio-gap-note' });
    this.markMissing();
    this.barPointer(bar);

    const readout = el.createDiv({ cls: 'notebook-audio-readout' });
    this.timeEl = readout.createSpan({ cls: 'notebook-audio-time' });
    this.clockEl = readout.createSpan({ cls: 'notebook-audio-clock' });
    this.clockEl.title = 'Wall-clock time of this moment';
    this.segEl = readout.createSpan({ cls: 'notebook-audio-segnum' });

    const controls = el.createDiv({ cls: 'notebook-audio-controls' });
    const button = (cls: string, icon: string, label: string, fn: () => void) => {
      const b = controls.createEl('button', { cls: `notebook-audio-button ${cls}`, attr: { 'aria-label': label, title: label } });
      setIcon(b, icon);
      b.addEventListener('click', e => {
        e.preventDefault();
        fn();
      });
      return b;
    };
    button('notebook-audio-prev', 'skip-back', 'Previous segment', () => this.previous());
    this.playBtn = button('notebook-audio-play mod-cta', 'play', 'Play', () => this.toggle());
    button('notebook-audio-next', 'skip-forward', 'Next segment', () => this.next());

    if (this.missing.some(Boolean)) {
      const n = this.missing.filter(Boolean).length;
      el.createDiv({ cls: 'notebook-audio-warning', text: `${n} segment file${n > 1 ? 's are' : ' is'} missing and will be skipped.` });
    }
    this.refresh();
  }

  private markMissing() {
    for (const { item, el } of this.itemEls) {
      if (item.kind !== 'segment' || !this.missing[item.index]) continue;
      el.addClass('is-missing');
      el.title = `segment ${item.index + 1}: file missing, skipped`;
    }
  }

  /** Click, tap or drag on the bar seeks there. */
  private barPointer(bar: HTMLElement) {
    let down = false;
    const seek = (e: PointerEvent) => {
      const ms = this.msAtX(e.clientX);
      if (ms !== undefined) this.seekTo(ms);
    };
    bar.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      down = true;
      try {
        bar.setPointerCapture(e.pointerId);
      } catch (err) {
        // A synthetic event has no active pointer.
      }
      e.preventDefault();
      seek(e);
    });
    bar.addEventListener('pointermove', e => {
      if (down) seek(e);
    });
    const up = () => {
      down = false;
    };
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  }

  /** The timeline position under a client x on the bar, through the items' laid-out boxes. */
  private msAtX(clientX: number): number | undefined {
    const tl = this.timeline, bar = this.barEl;
    if (!tl || !bar) return undefined;
    const x = clientX - bar.getBoundingClientRect().left - bar.clientLeft;
    const w = bar.clientWidth;
    if (!w) return undefined;
    for (const { item, el } of this.itemEls) {
      const l = el.offsetLeft, r = l + el.offsetWidth;
      if (x < r || el === this.itemEls[this.itemEls.length - 1].el) {
        const f = el.offsetWidth ? Math.min(1, Math.max(0, (x - l) / el.offsetWidth)) : 0;
        return item.startMs + f * item.durationMs;
      }
    }
    return (x / w) * tl.totalMs;
  }

  /** Where a position sits on the bar, as a percentage of its width. Items have minimum widths,
   * so this goes through the item containing the position; without a layout, pos / totalMs. */
  private leftPct(ms: number): number {
    const tl = this.timeline!, bar = this.barEl;
    const w = bar ? bar.clientWidth : 0;
    const plain = tl.totalMs ? (100 * ms) / tl.totalMs : 0;
    if (!w) return plain;
    for (const { item, el } of this.itemEls) {
      if (ms < item.endMs || el === this.itemEls[this.itemEls.length - 1].el) {
        if (ms < item.startMs) return (100 * el.offsetLeft) / w;
        const f = item.durationMs ? Math.min(1, (ms - item.startMs) / item.durationMs) : 1;
        return (100 * (el.offsetLeft + f * el.offsetWidth)) / w;
      }
    }
    return plain;
  }

  private refresh() {
    const tl = this.timeline, meta = this.meta;
    if (!tl || !meta || !this.timeEl) return;
    this.timeEl.setText(`${mmss(this.pos)} / ${mmss(tl.totalMs)}`);
    this.clockEl!.setText(clock(wallClockAt(meta, this.pos)));
    this.segEl!.setText(`segment ${this.current + 1} of ${tl.segments}`);
    if (this.headEl) this.headEl.style.left = `${this.leftPct(this.pos).toFixed(3)}%`;
    for (const { item, el } of this.itemEls) if (item.kind === 'segment') el.toggleClass('is-current', item.index === this.current);
    if (this.playBtn) {
      const want = this.playing ? 'pause' : 'play';
      if (this.playBtn.dataset.state !== want) {
        this.playBtn.dataset.state = want;
        setIcon(this.playBtn, want);
        const label = this.playing ? 'Pause' : 'Play';
        this.playBtn.setAttribute('aria-label', label);
        this.playBtn.title = label;
      }
    }
  }

  /** "0:31 lost here" under the gap for a moment. */
  private showGapNote(gap: GapItem) {
    const el = this.gapNoteEl;
    if (!el) return;
    el.setText(`${lostText(gap.durationMs)} lost here`);
    const box = this.itemEls.find(x => x.item === gap)?.el;
    const w = this.barEl ? this.barEl.clientWidth : 0;
    if (box && w) el.style.left = `${((100 * (box.offsetLeft + box.offsetWidth / 2)) / w).toFixed(3)}%`;
    el.addClass('is-visible');
    window.clearTimeout(this.gapNoteTimer);
    this.gapNoteTimer = window.setTimeout(() => el.removeClass('is-visible'), GAP_NOTE_MS);
  }
}

interface RecordingEntry { dir: string; name: string; summary: string; }

/** 'Recording 2026-09-27 14:03' from a folder named '2026-09-27 14-03' (or '… 14-03-12'). */
function nameFromFolder(dir: string): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2})-(\d{2})(?:-(\d{2}))?$/.exec(basename(dir));
  return m ? `Recording ${m[1]} ${m[2]}:${m[3]}${m[4] ? ':' + m[4] : ''}` : undefined;
}

class RecordingSuggest extends FuzzySuggestModal<RecordingEntry> {
  constructor(app: App, private entries: RecordingEntry[], private choose: (e: RecordingEntry) => void) {
    super(app);
    this.setPlaceholder('Open a recording of this note');
  }
  getItems() { return this.entries; }
  getItemText(e: RecordingEntry) { return `${e.name} ${e.summary}`; }
  renderSuggestion(match: FuzzyMatch<RecordingEntry>, el: HTMLElement) {
    el.addClass('notebook-audio-suggestion');
    el.createDiv({ cls: 'notebook-audio-suggestion-name', text: match.item.name });
    if (match.item.summary) el.createEl('small', { cls: 'notebook-audio-suggestion-summary', text: match.item.summary });
  }
  onChooseItem(e: RecordingEntry) { this.choose(e); }
}

/** The recordings of a note: folders under its audio folder that hold a meta.json, newest first. */
async function recordingsOf(app: App, notePath: string): Promise<RecordingEntry[]> {
  const adapter = app.vault.adapter;
  const folder = audioFolderForNote(notePath);
  if (!(await adapter.exists(folder))) return [];
  const { folders } = await adapter.list(folder);
  const out: RecordingEntry[] = [];
  for (const dir of folders) {
    const metaPath = joinPath(dir, META_FILE);
    if (!(await adapter.exists(metaPath))) continue;
    let summary = '', metaName: string | undefined;
    try {
      const meta = JSON.parse(await adapter.read(metaPath)) as Meta;
      summary = summaryText(buildTimeline(meta));
      metaName = recordingName(meta);
    } catch (e) {
      summary = 'meta.json unreadable';
    }
    out.push({ dir, name: nameFromFolder(dir) ?? metaName ?? basename(dir), summary });
  }
  return out.sort((a, b) => (basename(a.dir) < basename(b.dir) ? 1 : basename(a.dir) > basename(b.dir) ? -1 : 0));
}

/** Registers the view, the command and the post-processor; returns the api. */
export function registerPlayer(plugin: Plugin): PlayerApi {
  const app = plugin.app;
  plugin.registerView(PLAYER_VIEW, leaf => new PlayerView(leaf));

  const api: PlayerApi = {
    async open(dir: string) {
      const ws = app.workspace;
      const existing = ws.getLeavesOfType(PLAYER_VIEW).find(l => (l.getViewState().state as { dir?: string } | undefined)?.dir === dir);
      const leaf = existing ?? ws.getLeaf('tab');
      if (!existing) await leaf.setViewState({ type: PLAYER_VIEW, state: { dir }, active: true });
      await ws.revealLeaf(leaf);
      ws.setActiveLeaf(leaf, { focus: true });
      if (leaf.view instanceof PlayerView) leaf.view.contentEl.focus();
    },
  };

  plugin.addCommand({
    id: 'open-recording',
    name: 'Open a recording of this note',
    callback: async () => {
      // From a player, "this note" is the note its recording belongs to.
      const active = app.workspace.getActiveViewOfType(PlayerView);
      const notePath = app.workspace.getActiveFile()?.path ?? active?.meta?.note;
      if (!notePath) {
        new Notice('Open a note first: its recordings are listed.');
        return;
      }
      const entries = await recordingsOf(app, notePath);
      if (!entries.length) {
        new Notice(`No recordings for ${basename(notePath).replace(/\.md$/i, '')}.`);
        return;
      }
      new RecordingSuggest(app, entries, e => void api.open(e.dir)).open();
    },
  });

  // Reading view: a "Play as one timeline" button after each recording's run of segment embeds.
  plugin.registerMarkdownPostProcessor(async (el, ctx) => {
    const embeds = Array.from(el.querySelectorAll<HTMLElement>('.internal-embed[src]')).filter(e => isSegmentTarget(e.getAttribute('src') ?? ''));
    const groups: { folder: string; embeds: HTMLElement[] }[] = [];
    for (const e of embeds) {
      const folder = recordingFolderOfTarget(ctx.sourcePath, e.getAttribute('src') ?? '');
      const last = groups[groups.length - 1];
      if (last && last.folder === folder) last.embeds.push(e);
      else groups.push({ folder, embeds: [e] });
    }
    for (const g of groups) {
      // Claimed synchronously, so a second run over the same element adds nothing.
      if (g.embeds.some(e => e.dataset.notebookAudioPlayer)) continue;
      for (const e of g.embeds) e.dataset.notebookAudioPlayer = g.folder;
      if (!(await app.vault.adapter.exists(joinPath(g.folder, META_FILE)))) continue;
      const btn = el.ownerDocument.createElement('button');
      btn.className = 'notebook-audio-open';
      btn.setAttribute('aria-label', 'Play the segments as one timeline, with the gaps shown');
      setIcon(btn.createSpan({ cls: 'notebook-audio-open-icon' }), 'play');
      btn.createSpan({ text: 'Play as one timeline' });
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        void api.open(g.folder);
      });
      g.embeds[g.embeds.length - 1].insertAdjacentElement('afterend', btn);
    }
  });

  return api;
}
