# Notebook Audio: context

Read this first. It holds what the iPad tests established, the decisions that follow from them,
the file layout and `meta.json` schema, and how the repo is worked. Keep it current at each release.

## Where this comes from

`zcsop1206/obsidian-notebook` is the ink plugin (handwriting with the Apple Pencil, SVG pages in
the vault). Its first iPad tests included an audio spike (`src/debug/recorder.ts`, a debug view with
a Record button). On 2026-09-27 the owner decided audio becomes its own plugin: this repo. Issue
`zcsop1206/obsidian-notebook#1` ("Stitch audio segments split by a lock or app switch") moved here
as the player. The ink plugin drops its recorder once this plugin ships.

Owner: Adit (GitHub `zcsop1206`). Develops on Windows, tests on the iPad through BRAT (installs
from GitHub releases). Nothing runs on the iPad from a cloud session: numeric and feel criteria are
checked by the owner after a release.

## Constraints (settled)

- Runs inside Obsidian's iOS web view (WKWebView) and on desktop: **web APIs only**, no Node modules
  at runtime (the esbuild config deliberately does not mark Node built-ins external, so importing
  one fails the build), network only via Obsidian's `requestUrl`. `isDesktopOnly: false`,
  `minAppVersion` 1.7.2. Detect the platform with Obsidian's `Platform`, never the user agent
  (iPadOS reports itself as desktop Safari).
- Dependencies: `obsidian`, `typescript`, `esbuild` only. Ask the owner before adding anything.
- Everything the plugin writes is plain files in the vault, readable without the plugin. Links are
  standard markdown (`[text](<url-encoded relative path>)`, `![alt](<path>)`), never wikilinks.
- The vault is a public GitHub repo by default; audio stays out of it unless published on purpose.
  A `private/` folder exists for sensitive material. The README and the settings tab say so.
- No Mac, no native app, so no background audio: **recording is foreground-only on iOS**. Don't try
  to work around it; make it obvious and robust instead.

## What the iPad tests established (2026-09-26, Obsidian iOS, iPad)

- `MediaRecorder` works with `audio/mp4` (saved as `.m4a`), 96 kbps, a 2 s timeslice honoured:
  8 chunks in 15 s, 0 late. About 689 kB/min, 41 MB/hour. Mic "iPad Microphone" at 48 kHz, echo
  cancellation on.
- `DataAdapter.appendBinary` exists from Obsidian 1.12.3: chunks are appended live to one file, no
  rebuild needed; a force quit 3 s after writing lost nothing and the file plays. Feature-detect
  it; without it, write parts to `parts-NN/00001.bin…` and merge on stop or on recovery.
- **iOS cuts the mic whenever Obsidian isn't visible** (screen lock, app switch): the app goes
  hidden and the mic track is muted at the same moment. The recorder stays "recording" with no
  error and delivers no chunks. **On return it looks fine but isn't**: the mic unmutes, the recorder
  still says "recording", but it never delivers audio again. Fix (confirmed on the iPad): on
  `visibilitychange` back to visible, always reopen the mic and start a new segment; a watchdog
  also reopens when no chunk arrives for 3 timeslices (6 s) while visible; the watchdog can run
  before the `visibilitychange` event on return, so it treats a pending hide as a return, and the
  visibility handler does nothing while a reopen is running.
- Audio recorded while hidden is lost with no silence in its place, so a position in a file doesn't
  map to wall-clock time across a gap. `meta.json` records each segment's `startMs` (and
  `audioEndMs` when known) on one timeline; anything that lines audio up with time must use
  per-segment start times.
- Screen wake lock (`navigator.wakeLock`) is usually granted and held while recording; it was
  refused once (`NotAllowedError`, possibly Low Power Mode). Without it, auto-lock cuts the
  recording after the screen timeout.
- Chromium test harness findings: a simulated hide, killed mic and return produced two decodable
  segments; with `appendBinary` removed, a simulated crash left parts that recovery merged into a
  decodable file.

## Design (M1)

Plugin id `notebook-audio`, name "Notebook Audio". One recorder, foreground-only, honest about gaps.

### Files

A recording is a folder. With an active note `Notes/Physics/Lecture 3.md`:

```
Notes/Physics/Lecture 3/audio/2026-09-27 14-03/
  segment-01.m4a
  segment-02.m4a
  meta.json
  log.md              (only when the "keep a log" setting is on)
  parts-02/00001.bin  (only while recording without appendBinary; merged on stop or recovery)
```

- Folder stamp: local time `YYYY-MM-DD HH-mm`; if that folder exists, `YYYY-MM-DD HH-mm-ss`.
- Ink notes (`ink: 1` frontmatter, the ink plugin's index files, whose pages live in
  `<note basename>/`) are ordinary markdown files: the audio folder sits beside the pages and the
  links are appended after the page embeds.
- No active note: the clip goes to `<settings.folder>/<stamp>/` (default `audio/`), and a note
  `<settings.folder>/Recording <stamp>.md` is created with the links and opened.
- Recovery pointer: `saveData` holds `active: { dir, notePath, started }` while a recording runs,
  cleared on a clean stop. On layout ready, a pointer left behind means the recording was
  interrupted: parts are merged, `meta.json` completed (`ended: "recovered"`), the links appended
  to the note, and a notice offers to open the note.

### `meta.json`

```json
{
  "format": 1,
  "plugin": "notebook-audio",
  "version": "0.1.0",
  "mime": "audio/mp4",
  "ext": "m4a",
  "bitrate": 96000,
  "timesliceMs": 2000,
  "appendBinary": true,
  "started": "2026-09-27T12:03:12.345Z",
  "note": "Notes/Physics/Lecture 3.md",
  "device": { "platform": "ios", "userAgent": "…", "mic": "iPad Microphone", "sampleRate": 48000, "channels": 1 },
  "segments": [
    { "file": "segment-01.m4a", "startMs": 0, "audioEndMs": 61234, "bytes": 705311, "chunks": 31, "reason": "start" },
    { "file": "segment-02.m4a", "startMs": 92510, "audioEndMs": 761000, "bytes": 7654321, "chunks": 334, "reason": "returned" }
  ],
  "stoppedMs": 761000,
  "ended": "clean"
}
```

- `started` is ISO UTC; wall-clock time of a position = `Date.parse(started) + segment.startMs +
  position in that segment`. Display in local time.
- `startMs` is when the segment's `MediaRecorder` started, on the recording's timeline.
  `audioEndMs` is the last moment audio is believed to exist: set when the app went hidden, when
  the watchdog gave up on a segment, or on stop. It is absent for the last segment of a recovered
  recording. The player uses each segment's decoded duration for its length and `startMs` for its
  place; the gap after segment i is `segments[i+1].startMs - (segments[i].startMs + duration_i)`.
- `reason`: `start`, `returned` (back from hidden), `watchdog` (no audio while visible),
  `mic ended` (track ended or stayed muted).
- `ended`: `clean` (stop) or `recovered`; absent while recording or after an unclean exit not yet
  recovered.

### Note links

On stop (or recovery), the plugin writes to the note that was active when recording started: at
the cursor if that note is open in a markdown editor, else appended at the end. Standard markdown,
paths relative to the note's folder and URL-encoded:

```

Recording 2026-09-27 14:03 (12:41 in 2 segments, 0:31 lost while Obsidian was in the background)
![segment 1, 14:03:12, 6:10](Lecture%203/audio/2026-09-27%2014-03/segment-01.m4a)
![segment 2, 14:09:53, 6:31](Lecture%203/audio/2026-09-27%2014-03/segment-02.m4a)
```

Obsidian renders `![](file.m4a)` as a native audio player, so each segment plays without the
plugin. One line per segment; no wikilinks, ever.

### Recorder behaviour (ported from the spike, keep the tests)

`src/recorder.ts`, class `Recorder`: `start(dir, options)`, `stop()`, `snapshot()` for the UI.
2 s timeslice; `pickFormat()` prefers `audio/mp4`, then webm/opus, webm, ogg (the "preferred
format" setting can force one). Chunks go through a serial write queue: `writeBinary` for the
first chunk, then `appendBinary`; without it, parts under `parts-NN/` merged on stop. Visibility
handling, watchdog and reopen as in the findings above; `pagehide`, `pageshow`, `freeze`, `resume`
and mic `mute`/`unmute`/`ended` are logged; the wake lock is requested at start and again on
return. The state exposed to the UI: `idle`, `starting`, `recording`, `paused` (hidden: audio is
being lost), `resumed` (back, with how long was lost), `stopping`.

### UI

- Ribbon icon and command "Start or stop recording". No pause: a pause is a stop.
- Desktop: a status bar item. Mobile: a small floating pill fixed over the workspace (it must stay
  visible while the user switches notes). Both show state, elapsed time, size and segment count,
  and the pause state, "paused: Obsidian was in the background"; on return, "resumed, 0:31 lost"
  for a few seconds, then the running state with the total lost time. A tap on the pill stops.
- Player (this is `obsidian-notebook#1`): an `ItemView` with one `<audio>` per segment, played in
  order as one timeline, a bar that shows segments and the gaps between them, the wall-clock time
  of the current position from `meta.json`, and click-to-seek including across gaps. Opened by the
  command "Open a recording of this note" (lists the note's recordings) and by a button that a
  markdown post-processor adds after a recording's embeds in reading view. Files are never merged:
  they are independent MP4s and the gap must stay visible.
- Settings: bitrate (96 kbps default), folder for note-less recordings (`audio/`), keep a log
  (off), preferred format (auto). The tab repeats the privacy note.

### Out of scope

Background recording, transcription, syncing audio to ink strokes (owner: not wanted), noise
processing, merging segment files.

## Acceptance (owner, iPad)

1. Record 2 min and play back (each embed plays natively; the player plays the whole thing).
2. Lock the screen 30 s mid-recording, then switch apps 30 s: the pill shows the pause, a new
   segment starts on return, the player plays all segments with the gaps shown.
3. Force-quit Obsidian during a recording, reopen: the recording is recovered and plays.
4. The note has working links after a sync to the laptop.

## How the repo is worked

- Issues per piece (Goal / Scope / Out of scope / Acceptance criteria / Depends on). One branch per
  unit of review; PRs say "For #N", not "Closes": an issue closes only when the owner confirms the
  iPad criteria. Rebase merges. Full test run (`npm test`) before every merge and release.
- Tests: `node --test` unit tests for the pure parts (`test/unit/*.test.ts`, bundled by
  `test/build.mjs`; they must not import `obsidian`) and the Playwright suite
  (`test/run_recorder_test.py`) for the recorder with the fake mic, against the mock in
  `test/mock-obsidian.js`. Playwright simulates a hide by stubbing `document.visibilityState` and
  dispatching `visibilitychange`, a killed mic by stopping the track, a stall by dropping
  `ondataavailable`, and a crash by dropping the plugin instance mid-recording and reloading.
  Audio checks decode the written bytes with `OfflineAudioContext.decodeAudioData`.
- Release: `.github/workflows/release.yml` on a tag push, or `workflow_dispatch` on `main` (it
  creates the tag itself; the cloud session's git proxy refuses tag pushes). BRAT installs from the
  release's `main.js`, `manifest.json`, `styles.css`. Bump `manifest.json`, `versions.json` and
  `package.json` together.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; PR bodies end with
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Ask the owner before: new dependencies, anything touching the ink repo, anything that writes
  outside the recording's folder and the active note (the `.gitignore` offer included), publishing
  audio.
- After each release tell the owner exactly what to test and what they should see.
