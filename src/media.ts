/*
 * Reading media files in the web view. Used for the length of a recovered recording's last
 * segment (meta.json has no audioEndMs for it) and, later, by the player.
 */

/**
 * The duration of the audio at `src` (a resource URL, from adapter.getResourcePath) in ms, read
 * from a detached <audio> with preload 'metadata'. Undefined if it can't be read within
 * `timeoutMs`, on an error, or if it stays non-finite.
 *
 * A file written by MediaRecorder often has no duration in its header (Chromium's WebM, possibly
 * fragmented MP4), so the element reports Infinity. Seeking far past the end makes the browser
 * find the real end and fire durationchange; that value is used when it arrives in time.
 */
export function mediaDurationMs(src: string, timeoutMs = 5000): Promise<number | undefined> {
  return new Promise(resolve => {
    const audio = new Audio();
    let done = false, probing = false;
    const finish = (ms: number | undefined) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      audio.removeAttribute('src');
      try { audio.load(); } catch (e) { /* releases the file; nothing to do if it throws */ }
      resolve(ms);
    };
    const timer = window.setTimeout(() => finish(undefined), timeoutMs);
    const read = () => {
      const d = audio.duration;
      if (isFinite(d) && d >= 0) finish(d * 1000);
      else if (d === Infinity && !probing) {
        probing = true;
        try { audio.currentTime = 1e101; } catch (e) { finish(undefined); }
      }
    };
    audio.preload = 'metadata';
    audio.addEventListener('loadedmetadata', read);
    audio.addEventListener('durationchange', () => { if (probing) read(); });
    audio.addEventListener('error', () => finish(undefined));
    audio.src = src;
  });
}
