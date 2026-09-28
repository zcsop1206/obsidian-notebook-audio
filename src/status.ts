/*
 * The recorder's status, issue #4: a status bar item on desktop, a floating pill on mobile (fixed
 * over the workspace, so it stays while the user switches notes). Both show statusText(); a click
 * or tap on either stops the recording. The surface is chosen once, from Platform.isMobile (never
 * the user agent: iPadOS reports itself as desktop Safari). See CONTEXT.md, "UI".
 */
import { Platform } from 'obsidian';
import type NotebookAudioPlugin from './main';
import type { RecorderUi } from './main';
import type { RecorderSnapshot, RecorderState } from './recorder';
import { statusText } from './status-text';

/** How long "Could not record: …" stays before the surface hides. */
const ERROR_MS = 5000;
const HIDDEN = 'notebook-audio-hidden';
/** A click or tap stops only in these; while idle (an error showing) it dismisses. */
const STOPPABLE: RecorderState[] = ['recording', 'paused', 'resumed'];

export class StatusUi implements RecorderUi {
  /** The element that carries the text. On desktop it is the status bar item itself. */
  readonly el: HTMLElement;
  /** The status bar item or the pill: carries `data-state` and the hidden class. */
  readonly root: HTMLElement;
  private readonly mobile: boolean;
  private readonly plugin: NotebookAudioPlugin;
  private state: RecorderState = 'idle';
  private errorTimer?: number;
  private destroyed = false;

  constructor(plugin: NotebookAudioPlugin) {
    this.plugin = plugin;
    this.mobile = Platform.isMobile;
    if (this.mobile) {
      const pill = document.body.createDiv({
        cls: ['notebook-audio-pill', HIDDEN],
        attr: { role: 'button', tabindex: '0', 'aria-label': 'Stop recording', 'data-state': 'idle' },
      });
      pill.createSpan({ cls: 'notebook-audio-pill-dot' });
      this.el = pill.createSpan({ cls: 'notebook-audio-pill-text' });
      pill.createSpan({ cls: 'notebook-audio-pill-stop', text: 'Stop' });
      this.root = pill;
      plugin.registerDomEvent(pill, 'keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.tap(); }
      });
    } else {
      this.root = this.el = plugin.addStatusBarItem();
      this.root.addClass('notebook-audio-status', 'mod-clickable', HIDDEN);
      this.root.setAttr('aria-label', 'Notebook Audio: click to stop recording');
      this.root.setAttr('data-tooltip-position', 'top');
      this.root.setAttr('data-state', 'idle');
    }
    plugin.registerDomEvent(this.root, 'click', () => this.tap());
  }

  update(s: RecorderSnapshot): void {
    if (this.destroyed) return;
    const prev = this.state;
    this.state = s.state;
    if (s.state !== 'idle') {
      this.clearErrorTimer();
      this.show(s.state, statusText(s));
    } else if (s.error && prev !== 'idle') {
      // A start that failed: say why for a few seconds (the error stays in later idle snapshots).
      this.clearErrorTimer();
      this.show('idle', statusText(s), true);
      this.errorTimer = window.setTimeout(() => { this.errorTimer = undefined; this.hide(); }, ERROR_MS);
    } else if (this.errorTimer === undefined) {
      this.hide();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.clearErrorTimer();
    this.root.remove();
  }

  private tap() {
    if (STOPPABLE.includes(this.state)) void this.plugin.toggleRecording();
    else if (this.state === 'idle') { this.clearErrorTimer(); this.hide(); }
  }

  private show(state: RecorderState, text: string, error = false) {
    this.root.setAttr('data-state', error ? 'error' : state);
    // The pill draws its own (pulsing) dot.
    this.el.setText(this.mobile ? text.replace(/^● /, '') : text);
    this.root.removeClass(HIDDEN);
  }

  private hide() {
    this.root.setAttr('data-state', 'idle');
    this.el.setText('');
    this.root.addClass(HIDDEN);
  }

  private clearErrorTimer() {
    if (this.errorTimer !== undefined) window.clearTimeout(this.errorTimer);
    this.errorTimer = undefined;
  }
}
