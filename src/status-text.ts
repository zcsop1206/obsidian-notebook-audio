/*
 * The text of the status bar item (desktop) and the floating pill (mobile), issue #4. Pure: no
 * 'obsidian' import, so the unit tests can bundle it. See CONTEXT.md, "UI".
 */
import type { RecorderSnapshot } from './recorder';
import { kb, mmss } from './util';

/** Total lost time shows in the running state from this much up. */
export const LOST_SHOWN_FROM_MS = 1000;

const segments = (n: number) => `${n} segment${n === 1 ? '' : 's'}`;

/** What the status surfaces say for a snapshot; '' means hidden (idle without an error). */
export function statusText(s: RecorderSnapshot): string {
  switch (s.state) {
    case 'starting':
      return 'Starting…';
    case 'recording':
      return `● ${mmss(s.elapsedMs)} · ${kb(s.bytes)} · ${segments(s.segments)}` + (s.lostMs >= LOST_SHOWN_FROM_MS ? ` · ${mmss(s.lostMs)} lost` : '');
    case 'paused':
      return `Paused: Obsidian was in the background · ${mmss(s.elapsedMs)}`;
    case 'resumed':
      return `Resumed, ${mmss(s.lastLostMs)} lost while Obsidian was in the background · ${segments(s.segments)}`;
    case 'stopping':
      return 'Saving…';
    default:
      return s.error ? `Could not record: ${s.error}` : '';
  }
}
