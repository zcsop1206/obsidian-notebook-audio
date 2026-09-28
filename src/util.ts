/*
 * Small helpers shared by the recorder, the UI and the pure modules. Nothing here imports
 * 'obsidian' at runtime (only its types), so the unit tests can bundle it.
 */
import type { DataAdapter } from 'obsidian';

export const LOG_PREFIX = '[notebook-audio]';

export const pad = (n: number | string, w = 2) => String(n).padStart(w, '0');
export const r1 = (v: number) => Math.round(v * 10) / 10;

/** Local time as HH:MM:SS, for logs and the player's clock readout. */
export function clock(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Local time as HH:MM. */
export function hhmm(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local date as YYYY-MM-DD. */
export function ymd(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A duration as M:SS, or H:MM:SS from an hour up. */
export function mmss(ms: number) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function kb(bytes: number) {
  return bytes < 1e6 ? `${Math.round(bytes / 1024)} kB` : `${r1(bytes / 1048576)} MB`;
}

/** Runs async jobs one at a time so file appends land in order. */
export class Queue {
  private p: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.p.then(fn);
    this.p = next.catch(e => console.error(LOG_PREFIX, e));
    return next;
  }
  /** Resolves once everything queued so far has run. */
  idle() { return this.run(() => {}); }
}

export async function ensureDir(adapter: DataAdapter, path: string) {
  let acc = '';
  for (const part of path.split('/')) {
    if (!part) continue;
    acc = acc ? `${acc}/${part}` : part;
    if (!(await adapter.exists(acc))) await adapter.mkdir(acc);
  }
}

export async function appendText(adapter: DataAdapter, path: string, text: string, header = '') {
  if (await adapter.exists(path)) await adapter.append(path, text);
  else await adapter.write(path, header + text);
}
