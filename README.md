# Notebook Audio

An Obsidian plugin that records audio next to a note, on the iPad and on desktop. It is the audio
half of the [Notebook](https://github.com/zcsop1206/obsidian-notebook) ink plugin, split into its
own plugin.

Recording on iOS is **foreground-only**: Obsidian's web view loses the microphone the moment the
app is not visible (screen lock, app switch). The plugin doesn't pretend otherwise. It shows a
clear "paused: Obsidian was in the background" state, starts a new segment when you come back,
tells you how much was lost, and plays a recording back as one timeline with the gaps visible.

## What you get

- A ribbon button and a command, "Start or stop recording". A status bar item (desktop) or a small
  floating pill (mobile) shows the elapsed time, size, segment count and any pause.
- Clips saved next to the note that was active when recording started:
  `<note folder>/<note basename>/audio/<YYYY-MM-DD HH-mm>/segment-01.m4a`, `segment-02.m4a`, …
  and a `meta.json` with each segment's start time, so audio can be lined up with wall-clock time
  across the gaps. Links are appended to the note as standard markdown (never wikilinks), so the
  note works without the plugin and after a sync.
- Audio is written as it arrives (appended live on Obsidian 1.12.3 and later), so a force quit
  loses at most a couple of seconds; an interrupted recording is recovered on the next launch.
- A player that plays a recording's segments in order, shows where audio was lost, and shows the
  wall-clock time of the current position.

Out of scope: background recording (impossible in the web view), transcription, syncing audio to
ink strokes, noise processing.

## Privacy

Audio is not meant for a public vault repo. By default the plugin writes clips into the note's own
folder, so put `audio/` folders in the vault's `.gitignore` (or keep such notes under `private/`).
A clip is only published if you publish it on purpose.

## Install

Through [BRAT](https://github.com/TfTHacker/obsidian42-brat): add `zcsop1206/obsidian-notebook-audio`
as a beta plugin. Releases carry `main.js`, `manifest.json` and `styles.css`.

## Develop

```
npm install
npm run build          # tsc + esbuild -> main.js
npm run test:unit      # node --test over the pure modules
npm test               # build, unit tests, then the Playwright recorder suite
```

The Playwright suite needs `pip install playwright && python -m playwright install chromium`. It
drives the built plugin in headless Chromium with a fake microphone and a mock of the Obsidian API
(`test/mock-obsidian.js`); see `CONTEXT.md` for the findings the design rests on.
