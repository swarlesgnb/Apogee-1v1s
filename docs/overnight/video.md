# Video pipeline

The trailer, the vertical teaser and the README GIF are built from a shot list, not
screen-recorded, so they can be re-filmed whenever the UI changes.

```
npm run video                                  everything, into media/
npm run video -- --cut teaser                  one cut (trailer | teaser)
npm run video -- --with mechanic-headline,share-card
                                               include the scenes switched off in shots.json
npm run video -- --skip-record                 re-join the clips already filmed
npm run video -- --no-music                    picture only
```

Outputs, all in `media/` (gitignored, never committed):

| File | Size | Length |
| --- | --- | --- |
| `apogee-trailer-16x9.mp4` | 1920x1080, H.264 High, yuv420p, AAC | ~52.6 s |
| `apogee-teaser-9x16.mp4` | 1080x1920, H.264 High, yuv420p, AAC | 15.0 s |
| `apogee-readme.gif` | 800 px wide, 15 fps, under 8 MB | 11 s, from the trailer's queue scene |

A full run takes about three minutes. It needs ffmpeg and ffprobe on PATH.

## How it works

| File | Job |
| --- | --- |
| `tools/video/shots.json` | The shot list: cuts, scenes, timings, captions, card copy, and the demo match. |
| `tools/video/make.mjs` | Orchestrator: builds the preview, films each cut, joins clips, makes the GIF, probes everything. |
| `tools/video/record.cjs` | Electron main process. Films one cut, scene by scene, into `.cache/video/<cut>/`. |
| `tools/video/stage.js` | Injected into the preview's head: captions, pointer, eased scrolling, and the app's own queue states played in order. |
| `tools/video/card.html` | Title and caption cards, in the cosmic theme's tokens (read from the stylesheets at film time). |
| `tools/video/music.mjs` | A 120 BPM bed, synthesised. The repo ships no audio and nothing licensed goes under a public trailer. |

1. **Preview.** `tools/buildUiPreview.ts` is run with `APOGEE_PREVIEW_OUT` pointing at
   `.cache/video/preview.html`, so the tracked `tools/apogee-ui-preview.html` is left alone.
   It is the real renderer (renderer.js, cosmic.js, presentation.js and the rest) on the
   committed `data/snapshot.json`. The snapshot is not re-exported, so the video shows the
   same data on any machine.
2. **Filming.** Each scene is filmed in real time from an offscreen window's paint stream at
   30 fps. A scene either loads the page fresh and runs its `setup` off camera, or sets
   `continue` to keep the previous scene's page, so a `cut` between them does not show.
   Every http(s) and ws(s) request is cancelled and logged. There are no credentials and
   no Supabase anywhere in the pipeline, and a blocked request fails the build.
3. **Joining.** Clips are joined with the shot list's transitions (`fade` by default, `cut`
   where a scene continues the one before it), with a 0.35 s fade in and a 0.6 s fade out,
   then encoded once: x264 `slow`, CRF 18, maxrate 14M, `+faststart`, metadata stripped
   apart from `title=Apogee`.
4. **Checks.** A build fails if any of these happen:
   - a clip is mostly repeated frames (the machine stalled);
   - a stage direction throws;
   - a caption or card title runs off the frame;
   - the GIF cannot get under 8 MB;
   - an output has no frames.

   A frame every 3 s is written to `.cache/video/review/<output>/` for a look before
   anything is posted.

### Demo data, and what is real

Everything on screen is the renderer's own output on the committed snapshot: rank,
rating, ladder, season pool, expedition. One thing is swapped in. The snapshot's example
match is whatever the last export drew (a two-round defeat at +0.0% when this was
written), so `shots.json` → `demo.match` replaces it with a three-round 2-1 win on this
season's Speed Switching scenarios. The result screen labels it "Demo match · illustrative
opponent", and the opponent card says "demo opponent".

The queue's searching state, the match arriving and the three runs landing are played by
`stage.js` calling the renderer's own functions (`setCommit`, `showOpponent`,
`renderTodo`, `markAllIn`, `showCelebration`). In the preview host, Find opponent jumps
straight to the example match, so the video shows the press without sending it
(`"press": false`) and plays the app's sequence instead.

The preview's own disclaimers are hidden, along with the scrollbars and the tournament
chip:

- the "Design preview" note;
- the footnote;
- the "example set" suffix.

## Shot list v1

### Trailer, 16:9, zoom 1.25

| # | Scene | Kind | Seconds | What is on screen |
| --- | --- | --- | --- | --- |
| 1 | `hook` | card | 4.6 | "Ranked 1v1 for KovaaK's." · "Queue a category. Play three scenarios. The ladder settles itself." |
| 2 | `queue` | app | 8.6 | 01 Queue a category: scroll to the queue, pick Speed Switching, Find opponent, searching orb, match found |
| 3 | `scenarios` | app, continues | 7.6 | 02 Play three scenarios: the three runs land as received · verified, then "Read from the stats folder" |
| 4 | `never-typed` | card | 3.8 | "Scores come straight from the game." · settled on the server |
| 5 | `result` | app | 8.4 | 03 Beat your own baseline: Victory +18, round cards with deltas, the scores-vs-baselines table |
| 6 | `ladder` | app | 7.0 | 04 The ladder settles itself: Apogee ladder (Lunar, top 56.3%), then benchmark standing per band |
| 7 | `rank-reveal` | app, continues | 4.6 | The promotion celebration, Carbine → Rifle |
| 8 | `expedition` | app | 5.6 | 05 Practice between matches: the First Light star chart, three.js planets turning |
| – | `mechanic-headline` | card | 4.0 | **Disabled placeholder** |
| – | `share-card` | card | 3.6 | **Disabled placeholder** |
| 9 | `close` | card | 5.4 | apogee wordmark · the tagline · "Free for Windows" · repo URL |

### Teaser, 9:16, zoom 1.5, 15.0 s

`hook` (3.0) → `queue` (3.4) → `scenarios` (3.2, continues) → `result` (3.2) → `close` (3.4),
with 0.4 s fades.

### GIF

The trailer from the start of `queue`, 11 s. That covers the pick, the search, the match
and the first runs landing. Width and frame rate step down (800/15, 720/15, 640/12,
560/10) until the file is under `maxBytes`.

## Re-filming after the flow, brand and mechanic branches merge

Run `npm run video`, read the failures, then look at `.cache/video/review/`. These are the
parts most likely to break or date:

- **Flow branch.** Every app scene addresses the UI through selectors and renderer
  globals, and a renamed one fails the build rather than filming the wrong thing:
  - selectors: `.queue-stage`, `#cats .cat`, `#queueBtn`, `#opponent`, `#todoList`,
    `#debriefRounds`, `#roundsBody`, `#screen-ranks h2`, `.exp-map`;
  - renderer globals in `stage.js`: `setCommit`, `showOpponent`, `renderTodo`, `markAllIn`,
    `renderResult`, `showCelebration`, `startMatchClock`, `current`, `pendingScenarios`.

  If the queue gains or loses a step, re-time `queue` and `scenarios`, which are the
  scenes most tied to the current flow. If the preview stops jumping straight to the
  example match on Find opponent, drop `"press": false` and the `search`/`found` demo steps.
- **Brand branch.** Cards read `--ground`, `--brand`, `--ink`, `--font`, `--mono` and
  `--display` from the stylesheets at film time, and the mark path is in `card.html`
  (`MARK`, the same path as `buildIcon.mjs`). A new wordmark or mark needs `card.html`
  updating. New taglines go in `shots.json` only. `stage.js` hides preview-only elements
  by id (`#previewNote`, `#tnPreviewNote`, `#footnote`, `#tnLive`), so any new preview
  disclaimer needs adding there.
- **Mechanic branch.** Turn `mechanic-headline` into an `app` scene that shows the mechanic
  working, give it a caption index, set `enabled` to true, and place it after `ladder` or
  `rank-reveal`. It is kept as a card only so the pipeline can be run end to end with
  `--with mechanic-headline` today.
- **Share card.** Once a shareable result exists, film it from the Last match screen as
  `share-card`, after `result`. Consider it for the teaser too; it is the natural closing
  beat in 9:16.
- **Length.** The trailer is 52.6 s with both placeholders off. Turning both on adds about
  6.6 s, so trim `expedition` or `ladder` to stay under 60 s. The teaser has to stay at
  exactly 15 s: scene lengths minus 0.4 s per fade.
- **Snapshot.** If `data/snapshot.json` is re-exported, rank names and numbers on screen
  change with it. The promotion in `rank-reveal` is hard-coded (Carbine → Rifle, a Static
  Clicking step), so check it is still a real step on the season's ladder.
