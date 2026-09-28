/*
 * Notebook Audio: records audio next to a note, on the iPad and on desktop. Foreground-only
 * (iOS cuts the mic whenever Obsidian isn't visible), so the plugin shows where audio was lost
 * and plays a recording back as one timeline. See CONTEXT.md for the findings and the layout.
 *
 * This file wires the recorder to Obsidian: the ribbon icon and the command, where a recording
 * goes, the links written into the note on stop, and recovery of an interrupted recording.
 */
import { MarkdownView, Notice, Platform, Plugin, TFile } from 'obsidian';
import { buildTimeline, type Meta, recordingName, summaryText, type Timeline } from './meta';
import { recordingLines } from './links';
import { mediaDurationMs } from './media';
import { audioFolderForNote, dirname, joinPath, notelessCandidates, recordingFolderCandidates } from './paths';
import { Recorder, type RecorderSnapshot, recoverRecording } from './recorder';
import { type ActiveRecording, NotebookAudioSettingTab, parsePluginData, type PluginData, type Settings } from './settings';
import { LOG_PREFIX, ensureDir } from './util';

/** The status UI (issue #4): told about every recorder change, including the 1 s tick. */
export interface RecorderUi {
  update(s: RecorderSnapshot): void;
}

export default class NotebookAudioPlugin extends Plugin {
  recorder!: Recorder;
  /** Exposed for the tests; onload calls it through recoverInterrupted() for a pointer left behind. */
  recoverRecording = recoverRecording;
  settings: Settings = parsePluginData(null).settings;
  /** The recovery pointer, saved with the settings (CONTEXT.md, "Files"). */
  active?: ActiveRecording;
  /** Set by the status UI (issue #4); onRecorderChange forwards every snapshot to it. */
  ui?: RecorderUi;
  /** A start or stop is in progress (from the toggle to the pointer being saved or cleared). */
  private busy = false;
  private unloaded = false;
  /** False for a note this plugin created (a note-less recording): its links are appended. */
  private insertAtCursor = true;

  async onload() {
    const data = parsePluginData(await this.loadData());
    this.settings = data.settings;
    this.active = data.active;
    this.recorder = new Recorder(this.app.vault.adapter, s => this.onRecorderChange(s));
    this.addRibbonIcon('mic', 'Start or stop recording', () => { void this.toggleRecording(); });
    this.addCommand({ id: 'toggle-recording', name: 'Start or stop recording', callback: () => this.toggleRecording() });
    this.addSettingTab(new NotebookAudioSettingTab(this.app, this));
    // A note renamed while recording: the links go to it under its new name.
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      const a = this.active;
      if (!a || !(file instanceof TFile) || a.notePath !== oldPath || this.recorder.state === 'idle') return;
      a.notePath = file.path;
      if (this.recorder.meta) this.recorder.meta.note = file.path;
      void this.save();
    }));
    this.app.workspace.onLayoutReady(() => { void this.recoverInterrupted(); });
    console.log(LOG_PREFIX, 'loaded');
  }

  onunload() {
    this.unloaded = true;
    // Best effort: stop and write the links. A start in progress stops itself once it sees `unloaded`.
    if (!this.busy && this.recorder && this.recorder.state !== 'idle') {
      this.busy = true;
      void this.stopRecording().finally(() => { this.busy = false; });
    }
  }

  async saveSettings() {
    await this.save();
  }

  /** data.json changed on disk (a sync): take its settings; the pointer stays this device's. */
  async onExternalSettingsChange() {
    this.settings = parsePluginData(await this.loadData()).settings;
  }

  private async save() {
    const data: PluginData = { settings: this.settings };
    if (this.active) data.active = this.active;
    await this.saveData(data);
  }

  /** Every recorder change and its 1 s tick while recording. Issue #4's status bar item / pill
   *  sets `this.ui`; nothing else should hook the recorder's callback. */
  onRecorderChange(s: RecorderSnapshot) {
    this.ui?.update(s);
  }

  private async setActive(active: ActiveRecording | undefined) {
    this.active = active;
    await this.save();
  }

  /** Starts a recording when idle, stops it otherwise; ignored while a start or stop is running. */
  async toggleRecording() {
    const state = this.recorder.state;
    if (this.busy || state === 'starting' || state === 'stopping') return;
    this.busy = true;
    try {
      if (state === 'idle') await this.startRecording();
      else await this.stopRecording();
    } catch (e) {
      console.error(LOG_PREFIX, e);
      new Notice(`Notebook Audio: ${(e as Error).message || e}`);
    } finally {
      this.busy = false;
    }
  }

  /** Call through toggleRecording(). */
  async startRecording() {
    const vault = this.app.vault, adapter = vault.adapter;
    const s = { ...this.settings };
    const now = new Date();
    const file = this.app.workspace.getActiveFile();
    let dir: string, notePath: string, noteless = false;
    if (file instanceof TFile && file.extension === 'md') {
      notePath = file.path;
      const [plain, seconds] = recordingFolderCandidates(audioFolderForNote(file.path), now);
      dir = !(await adapter.exists(plain)) ? plain : seconds;
      // Two recordings in the same second (a start right after a stop): add a counter.
      for (let i = 2; dir === seconds && (await adapter.exists(dir)); i++) dir = `${seconds}-${i}`;
    } else {
      noteless = true;
      let pick: { folder: string; note: string } | undefined;
      for (const c of notelessCandidates(s.folder, now)) {
        if (!(await adapter.exists(c.folder)) && !(await adapter.exists(c.note))) { pick = c; break; }
      }
      if (!pick) { new Notice('Could not record: a recording from this second already exists, try again'); return; }
      ({ folder: dir, note: notePath } = pick);
      await this.ensureVaultFolder(dirname(notePath));
    }

    // The pointer goes first: a crash from here on leaves something recovery can find.
    await this.setActive({ dir, notePath, started: now.toISOString() });
    const ok = await this.recorder.start({
      dir, bitrate: s.bitrate, format: s.format, log: s.log, note: notePath, version: this.manifest.version,
      platform: Platform.isIosApp ? 'ios' : Platform.isAndroidApp ? 'android' : 'desktop',
    });
    if (!ok) {
      await this.setActive(undefined);
      new Notice(`Could not record: ${this.recorder.snapshot().error || 'unknown error'}`);
      return;
    }
    this.insertAtCursor = !noteless;
    if (this.unloaded) { await this.stopRecording(); return; }
    // The note-less note is created only once recording works, so a refused mic leaves nothing.
    if (noteless) {
      try {
        const note = await vault.create(notePath, `# ${recordingName({ started: now.toISOString() })}\n`);
        await this.app.workspace.getLeaf().openFile(note);
      } catch (e) {
        console.error(LOG_PREFIX, `could not create ${notePath}`, e); // writeLinks creates it on stop
      }
    }
    new Notice('Recording');
  }

  /** Call through toggleRecording() (or onunload). */
  async stopRecording() {
    const active = this.active;
    const dir = this.recorder.snapshot().dir;
    const meta = await this.recorder.stop();
    if (!meta) return;
    // The pointer is the source of truth for the note (it follows a rename); it belongs to this
    // recording unless something went badly wrong.
    const notePath = active && active.dir === dir ? active.notePath : meta.note || '';
    try {
      if (!notePath) throw new Error('no note recorded for this recording');
      const tl = await this.writeLinks(meta, dir, notePath, this.insertAtCursor);
      new Notice(`Saved ${recordingName(meta)} (${summaryText(tl)})`);
    } catch (e) {
      console.error(LOG_PREFIX, e);
      new Notice(`Saved the recording in ${dir}, but could not write its links: ${(e as Error).message || e}`);
    } finally {
      await this.setActive(undefined);
    }
  }

  /**
   * Writes the recording's lines into the note: at the cursor when `atCursor` and the note is
   * open in the active editor in source mode, else appended at the end. If the note is gone
   * (deleted while recording), it is created again with the lines. Returns the timeline.
   * Ink notes need nothing special: their page embeds come first, the links after them.
   */
  async writeLinks(meta: Meta, dir: string, notePath: string, atCursor = true): Promise<Timeline> {
    const tl = buildTimeline(meta, await this.measureDurations(dir, meta));
    const lines = recordingLines(meta, tl, notePath, dir);
    const vault = this.app.vault;
    const file = vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) {
      await this.ensureVaultFolder(dirname(notePath));
      await vault.create(notePath, lines.replace(/^\n/, ''));
      new Notice(`The note was moved or deleted while recording; created ${notePath} with the links`);
      return tl;
    }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (atCursor && view && view.file && view.file.path === notePath && view.getMode() === 'source') {
      const ed = view.editor;
      const at = ed.getCursor();
      // `lines` starts with a blank line; mid-line, break the line first so the header starts one.
      const text = (at.ch > 0 ? '\n' : '') + lines;
      ed.replaceRange(text, at);
      ed.setCursor(ed.offsetToPos(ed.posToOffset(at) + text.length));
    } else {
      await vault.process(file, t => t + (t === '' || t.endsWith('\n') ? '' : '\n') + lines);
    }
    return tl;
  }

  /**
   * Decoded durations for segments without audioEndMs (the last one of a recovered recording);
   * undefined for the rest, where the timeline uses audioEndMs. If the file's duration can't be
   * read, it is estimated from its size and the bitrate, so the header isn't a flat 0:00.
   */
  async measureDurations(dir: string, meta: Meta): Promise<(number | undefined)[]> {
    const adapter = this.app.vault.adapter;
    const out: (number | undefined)[] = [];
    for (const seg of meta.segments) {
      if (seg.audioEndMs !== undefined) { out.push(undefined); continue; }
      const path = joinPath(dir, seg.file);
      let ms = (await adapter.exists(path)) ? await mediaDurationMs(adapter.getResourcePath(path)) : undefined;
      if (ms === undefined && seg.bytes && meta.bitrate > 0) ms = (seg.bytes * 8 * 1000) / meta.bitrate;
      out.push(ms);
    }
    return out;
  }

  /** On layout ready: a pointer left behind means the last recording was interrupted. */
  async recoverInterrupted() {
    const active = this.active;
    if (!active || this.busy || this.recorder.state !== 'idle') return;
    // Never touch the folder of a recording in progress (this instance's; the check above covers it).
    if (this.recorder.snapshot().dir === active.dir) return;
    this.busy = true;
    try {
      const meta = await recoverRecording(this.app.vault.adapter, active.dir);
      if (!meta) {
        console.log(LOG_PREFIX, `recovery: nothing to recover in ${active.dir} (folder gone or already ended)`);
        return;
      }
      const tl = await this.writeLinks(meta, active.dir, active.notePath, false);
      this.recoveredNotice(`Recovered an interrupted recording: ${recordingName(meta)} (${summaryText(tl)})`, active.notePath);
    } catch (e) {
      console.error(LOG_PREFIX, 'recovery failed', e);
      new Notice(`Could not recover the recording in ${active.dir}: ${(e as Error).message || e}`);
    } finally {
      await this.setActive(undefined);
      this.busy = false;
    }
  }

  private recoveredNotice(message: string, notePath: string) {
    const frag = document.createDocumentFragment();
    frag.appendChild(document.createTextNode(message + ' '));
    const button = document.createElement('button');
    button.className = 'notebook-audio-notice-button';
    button.textContent = 'Open note';
    frag.appendChild(button);
    const notice = new Notice(frag, 15000);
    button.addEventListener('click', e => {
      e.stopPropagation();
      notice.hide();
      const file = this.app.vault.getAbstractFileByPath(notePath);
      if (file instanceof TFile) void this.app.workspace.getLeaf(true).openFile(file);
    });
  }

  /** Creates a vault folder and its parents through the vault API, so the vault knows them
   *  before a note is created inside. */
  private async ensureVaultFolder(path: string) {
    const vault = this.app.vault;
    let acc = '';
    for (const part of path.split('/').filter(Boolean)) {
      acc = acc ? `${acc}/${part}` : part;
      if (vault.getAbstractFileByPath(acc)) continue;
      try { await vault.createFolder(acc); }
      catch (e) { await ensureDir(vault.adapter, acc); } // it exists on disk already
    }
  }
}
