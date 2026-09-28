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
  decodable file. Headless Chromium 141 supports `audio/mp4`, reports finite durations for the
  live-appended MP4 blobs, and its fake mic keeps recording while "hidden" until the track is
  killed, so decoded segment lengths in tests run past `audioEndMs` (on the iPad audio stops at
  the hide). The wake lock is refused in headless Chromium.

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
- Two recordings in the same second (a start right after a stop) get `-2`, `-3` after the
  seconds form.
- No active note: the clip goes to `<settings.folder>/<stamp>/` (default `audio/`; an empty
  setting means `audio/`, never the vault root), and a note `<settings.folder>/Recording
  <stamp>.md` starting with `# Recording YYYY-MM-DD HH:mm` is created and opened once the mic
  works (a refused mic leaves no note). Its links are appended on stop.
- Recovery pointer: the plugin data is `{ settings, active? }`; `active: { dir, notePath,
  started, device }` is saved before the recorder starts and cleared on a clean stop. `device` is
  a per-install id kept in `localStorage`, so a pointer that reached another device through a
  synced `data.json` is left alone there (#12). On layout ready, a pointer left behind with this
  device's id means the recording was interrupted: parts are merged, `meta.json` completed
  (`ended: "recovered"`), the links appended to the note, and a notice offers to open the note.
  A note renamed while recording is followed (the pointer and `meta.note` are updated); a note
  deleted while recording is created again with the links on stop.

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

On stop, the plugin writes to the note that was active when recording started: at the cursor if
that note is open in the active markdown editor in source mode (a line break first when the
cursor is mid-line), else appended at the end. Recovery and note-less notes always append (the
cursor is meaningless there). Standard markdown, paths relative to the note's folder and
URL-encoded:

```

Recording 2026-09-27 14:03 (12:41 in 2 segments, 0:31 lost while Obsidian was in the background)
![segment 1, 14:03:12, 6:10](Lecture%203/audio/2026-09-27%2014-03/segment-01.m4a)
![segment 2, 14:09:53, 6:31](Lecture%203/audio/2026-09-27%2014-03/segment-02.m4a)
```

Obsidian renders `![](file.m4a)` as a native audio player, so each segment plays without the
plugin. One line per segment; no wikilinks, ever.

### Recorder behaviour (ported from the spike, keep the tests)

`src/recorder.ts`, class `Recorder(adapter, onChange)`: `start(options)`, `stop()` (resolves once
every write landed, returns the final meta), `snapshot()` for the UI, and `recoverRecording(adapter,
dir)`.
2 s timeslice; `pickFormat()` prefers `audio/mp4`, then webm/opus, webm, ogg (the "preferred
format" setting can force one). Chunks go through a serial write queue: `writeBinary` for the
first chunk, then `appendBinary`; without it, parts under `parts-NN/` merged on stop. Visibility
handling, watchdog and reopen as in the findings above; `pagehide`, `pageshow`, `freeze`, `resume`
and mic `mute`/`unmute`/`ended` are logged; the wake lock is requested at start and again on
return. The state exposed to the UI: `idle`, `starting`, `recording`, `paused` (hidden: audio is
being lost), `resumed` (back, with how long was lost), `stopping`.

### UI

- Ribbon icon and command "Start or stop recording". No pause: a pause is a stop.
- Desktop: a status bar item. Mobile: a small floating pill fixed above the mobile toolbar (it
  stays while the user switches notes), chosen once from `Platform.isMobile` (`src/status.ts`,
  text in `src/status-text.ts`). Both show state, elapsed time, size and segment count, and the
  pause state, "Paused: Obsidian was in the background"; on return, "Resumed, 0:31 lost while
  Obsidian was in the background" for 5 s, then the running state with the total lost time; a
  failed start shows its error for 5 s. A click or tap stops (only while recording; never starts).
- Player (this is `obsidian-notebook#1`, `src/player.ts`): an `ItemView` (state `{ dir }`) with
  one `<audio>` per segment, played in order as one timeline, a bar that draws segments to scale
  and the gaps between them (hatched; the tooltip says why from the next segment's `reason`),
  "0:31 lost here" when playback or a seek crosses a gap, the wall-clock time of the current
  position from `meta.json`, click/tap/drag-to-seek including across gaps, previous/next segment,
  Space to toggle. Segment lengths come from the loaded media durations, `audioEndMs` as the
  fallback. Opened by the command "Open a recording of this note" (a suggest modal of the folders
  under the note's `audio/` that hold a `meta.json`, newest first, named from the folder stamp;
  from inside a player, "this note" is the recording's note) and by a "Play as one timeline"
  button that a markdown post-processor adds after each run of consecutive segment embeds from
  one folder, in reading view only. Files are never merged: they are independent MP4s and the
  gap must stay visible.
- Settings: bitrate (96 kbps default), folder for note-less recordings (`audio/`), keep a log
  (off), preferred format (auto). The tab repeats the privacy note.

### Known gaps

- One recovery pointer slot: if device A crashes, its `data.json` syncs to B, and B then starts a
  recording, B's pointer overwrites A's and A never recovers that recording. One pointer per
  device would fix it; not done.
- If iOS ever cleared Obsidian's `localStorage`, the device would get a new id and its own old
  pointer would look foreign (not recovered, not cleared). Unknown whether that happens.
- A note whose parent folder is renamed while recording (or whose `<basename>/` folder the ink
  plugin moves) is not followed; the recorder keeps writing to the old path.
- The "mic muted for 3 s while visible" reopen path is ported from the spike but has no
  Playwright check.

### Out of scope

Background recording, transcription, syncing audio to ink strokes (owner: not wanted), noise
processing, merging segment files.

### Source map

- `src/main.ts`: plugin wiring: ribbon, commands, folders, note links, recovery, the `ui` hook.
- `src/recorder.ts`: the recorder and `recoverRecording`.
- `src/status.ts`, `src/status-text.ts`: status bar item / mobile pill and its text.
- `src/player.ts`: the timeline player, its command and the reading-view button.
- `src/settings.ts`: settings, plugin data, the settings tab.
- `src/paths.ts`, `src/meta.ts`, `src/links.ts`, `src/media.ts`, `src/util.ts`: pure helpers
  (folders and link targets, the timeline, the note lines, media durations, formatting).
- `test/`: `mock-obsidian.js` + `harness.html` (the mock Obsidian), `run_recorder_test.py`
  (Playwright), `unit/*.test.ts` (node --test, bundled by `build.mjs`).

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
  `NB_TEST_PORT_BASE` picks the port (default 8765) so parallel checkouts can run the suite at
  once; when Playwright's own Chromium is missing, the runner uses `NB_CHROMIUM` or
  `/opt/pw-browsers/chromium` (the browser pre-installed in cloud sessions). The suite runs
  about four minutes: it records in real time.
- Release: `.github/workflows/release.yml` on a tag push, or `workflow_dispatch` on `main` (it
  creates the tag itself; the cloud session's git proxy refuses tag pushes). BRAT installs from the
  release's `main.js`, `manifest.json`, `styles.css`. Bump `manifest.json` and `versions.json`
  together (`package.json` carries no version).
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; PR bodies end with
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Ask the owner before: new dependencies, anything touching the ink repo, anything that writes
  outside the recording's folder and the active note (the `.gitignore` offer included), publishing
  audio.
- After each release tell the owner exactly what to test and what they should see.
