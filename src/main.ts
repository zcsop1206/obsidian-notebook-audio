/*
 * Notebook Audio: records audio next to a note, on the iPad and on desktop. Foreground-only
 * (iOS cuts the mic whenever Obsidian isn't visible), so the plugin shows where audio was lost
 * and plays a recording back as one timeline. See CONTEXT.md for the findings and the layout.
 */
import { Plugin } from 'obsidian';

export const LOG_PREFIX = '[notebook-audio]';

export default class NotebookAudioPlugin extends Plugin {
  async onload() {
    console.log(LOG_PREFIX, 'loaded');
  }

  onunload() {}
}
