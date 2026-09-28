/*
 * Notebook Audio: records audio next to a note, on the iPad and on desktop. Foreground-only
 * (iOS cuts the mic whenever Obsidian isn't visible), so the plugin shows where audio was lost
 * and plays a recording back as one timeline. See CONTEXT.md for the findings and the layout.
 */
import { Notice, Platform, Plugin } from 'obsidian';
import { Recorder, recoverRecording } from './recorder';
import { hhmm, ymd } from './util';

export const LOG_PREFIX = '[notebook-audio]';

export default class NotebookAudioPlugin extends Plugin {
  recorder!: Recorder;
  /** Exposed for the tests; issue #3 calls it on layout ready for an interrupted recording. */
  recoverRecording = recoverRecording;

  async onload() {
    this.recorder = new Recorder(this.app.vault.adapter);
    // Placeholder until issue #3: fixed folder `audio/<stamp>`, no note, no settings, no
    // recovery pointer. #3 replaces this with the folder rules from CONTEXT.md.
    this.addCommand({
      id: 'toggle-recording',
      name: 'Start or stop recording',
      callback: async () => {
        if (this.recorder.state === 'idle') {
          const dir = `audio/${ymd()} ${hhmm().replace(':', '-')}`;
          const platform = Platform.isIosApp ? 'ios' : Platform.isAndroidApp ? 'android' : 'desktop';
          const ok = await this.recorder.start({ dir, bitrate: 96000, format: 'auto', log: true, version: this.manifest.version, platform });
          new Notice(ok ? 'Recording' : `Could not record: ${this.recorder.snapshot().error}`);
        } else {
          const dir = this.recorder.snapshot().dir;
          if (await this.recorder.stop()) new Notice(`Saved ${dir}`);
        }
      },
    });
    console.log(LOG_PREFIX, 'loaded');
  }

  onunload() {
    void this.recorder.stop();
  }
}
