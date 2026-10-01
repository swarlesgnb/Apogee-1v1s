# Video pipeline

The trailer, the two vertical clips and the README GIF are built from a shot list, not
screen-recorded, so they can be re-filmed whenever the UI changes.

```
npm run video                                  everything, into media/
npm run video -- --cut ghost                   one cut (trailer | teaser | ghost)
npm run video -- --with never-typed,expedition include the scenes switched off in shots.json
npm run video -- --skip-record                 re-join the clips already filmed
npm run video -- --no-music                    picture only
npx tsx tools/video/ghostDemo.ts               re-draw the Ghost Mode screens (see below)
```

Outputs, all in `media/` (gitignored, never committed):

| File | Size | Length |
| --- | --- | --- |
| `apogee-trailer-16x9.mp4` | 1920x1080, H.264 High, yuv420p, AAC | 59.1 s, 1773 frames (limit 60) |
| `apogee-teaser-9x16.mp4` | 1080x1920, H.264 High, yuv420p, AAC | 15.0 s, 450 frames |
| `apogee-ghost-9x16.mp4` | 1080x1920, H.264 High, yuv420p, AAC | 15.0 s, 450 frames |
| `apogee-readme.gif` | 800x450, 15 fps, 3.2 MB (limit 8 MB) | 11 s, from the trailer's queue scene |

A full run takes a few minutes. It needs ffmpeg and ffprobe on PATH.

## How it works

| File | Job |
| --- | --- |
| `tools/video/shots.json` | The shot list: cuts, scenes, timings, captions, card copy, and the demo match. |
| `tools/video/make.mjs` | Orchestrator: builds the preview, films each cut, joins clips, makes the GIF, probes and checks everything. |
| `tools/video/record.cjs` | Electron main process. Films one cut, scene by scene, into `.cache/video/<cut>/`. Inlines the brand fonts, lockups, share-card images and the Ghost Mode bridge. |
| `tools/video/stage.js` | Injected into the preview's head: captions, pointer, eased scrolling, and the app's own queue and ghost states played in order. |
| `tools/video/card.html` | Title, showcase and closing cards, in the cosmic theme's colours and the brand kit's type and lockups. |
| `tools/video/ghost.json` | The Ghost Mode screens the video films, frozen. |
| `tools/video/ghostDemo.ts` | Draws `ghost.json` with the real ghost core over a real stats folder. |
| `tools/video/music.mjs` | A 120 BPM bed, synthesised. The repo ships no audio and nothing licensed goes under a public trailer. |

1. **Preview.** `tools/buildUiPreview.ts` is run with `APOGEE_PREVIEW_OUT` pointing at
   `.cache/video/preview.html`, so the tracked `tools/apogee-ui-preview.html` is left alone.
   It is the real renderer (renderer.js, cosmic.js, ghost.js and the rest) on the
   committed `data/snapshot.json`. The snapshot is not re-exported, so the video shows the
   same data on any machine.
2. **Filming.** Each scene is filmed in real time from an offscreen window's paint stream at
   30 fps. A scene either loads the page fresh and runs its `setup` off camera, or sets
   `continue` to keep the previous scene's page, so a `cut` between them does not show.
   A scene can set its own `zoom`. Every http(s) and ws(s) request is cancelled and
   logged. There are no credentials and no Supabase anywhere in the pipeline, and a
   blocked request fails the build.
3. **Joining.** Clips are joined with the shot list's transitions (`fade` by default, `cut`
   where a scene continues the one before it), with a 0.35 s fade in and a 0.6 s fade out,
   then encoded once: x264 `slow`, CRF 18, maxrate 14M, `+faststart`, metadata stripped
   apart from `title=Apogee`.
4. **Checks.** A build fails if any of these happen:
   - a clip is mostly repeated frames (the machine stalled);
   - a stage direction throws;
   - a caption or card title runs off the frame;
   - a cut runs over its `maxSeconds` (60 for the trailer, 15 for both vertical clips);
   - the GIF cannot get under 8 MB;
   - an output has no frames.

   A frame every 2 s, from 1 s in to just before the fade out, is written to
   `.cache/video/review/<output>/`, GIF included, for a look before anything is posted.

### Demo data, and what is real

Everything on screen is the renderer's own output on the committed snapshot: rank,
rating, ladder, season pool. Three things are swapped in, and each is labelled or drawn
by the real code:

- **The ranked match.** `shots.json` → `demo.match` replaces the snapshot's example match
  with a three-round 2-1 win on this season's Speed Switching scenarios. The result screen
  labels it "Demo match · illustrative opponent", and the opponent card says "demo
  opponent".
- **The ghost race.** `tools/video/ghost.json`, drawn by `ghostDemo.ts`: `drawGhostMatch`,
  `startMatch`, `applyRun`, `viewOf` and `judge` from `src/core/ghost/ghost.ts` on a real
  library as of 2026-09-30 19:00 local, `month_ago` kind. The three scenarios, each
  ghost's score and session day, the baselines, bests, verdict and margins are the core's.
  Only the three live scores are chosen, as gaps of +2.6%, −3.8% and +3.0% of baseline, so
  the running margin reads +2.6% → −0.7% → +0.5%: ahead, behind going into the last lane,
  and the last lane turns it. Frozen and committed, because a draw is a function of the
  day, and the video has to film the same thing on any machine. The streak (3, then 4)
  and record (5–2, then 6–2) are set in the generator.
- **Share cards.** The brand kit's committed samples in `assets/brand/samples/`. They are
  generated by `npm run brand:cards` from the snapshot through the real `settleMatch()`,
  but the card is **not wired into the client yet** (brand.md, "What this does not
  cover"). If the trailer goes public before it is, the scene overstates what ships, so
  either wire it or turn the scene off with `"enabled": false`.

The queue's searching state, the match arriving and the three runs landing are played by
`stage.js` calling the renderer's own functions (`setCommit`, `showOpponent`,
`renderTodo`, `markAllIn`, `showCelebration`). In the preview host, Find opponent jumps
straight to the example match, so the video shows the press without sending it
(`"press": false`) and plays the app's sequence instead.

Ghost Mode has no main process to talk to in the preview, so `record.cjs` puts a bridge
in front of ghost.js, as `tools/ghostUi.cjs` does for its fixture: `apogee.ghost()` returns
the current screen, Race and Start answer with the screen GhostService would send back,
and `stage.js`'s `ghost` demo step pushes the next screen when a run "lands". ghost.js
plays the 3-2-1 reveal, holds the margin, and holds the last lane before the verdict on
its own; nothing about that is staged.

The preview's own disclaimers are hidden, along with the scrollbars and the tournament
chip: the "Design preview" note, the footnote and the "example set" suffix.

### Brand

Cards set Barlow and Cascadia Mono from `assets/brand/fonts/` as data URIs, under the
family names the kit's SVGs use (`Apogee Display`, `Apogee Mono`), and inline
`assets/brand/logo/horizontal-dark.svg` (title cards) and `stacked-dark.svg` (closing
cards) rather than drawing the mark themselves. Colours still come from the client's
stylesheet tokens at film time. Captions over the app use the same two faces. The app's
UI keeps Bahnschrift: it is the product being filmed, not the video's voice.

## Shot list v2

### Trailer, 16:9, zoom 1.25, 59.1 s

| # | Scene | Kind | Seconds | What is on screen |
| --- | --- | --- | --- | --- |
| 1 | `hook` | card | 4.0 | horizontal lockup · Season 1 · "Ranked 1v1 for KovaaK's." |
| 2 | `queue` | app | 7.6 | 01 Queue a category: pick Speed Switching, Find opponent, searching, match found |
| 3 | `scenarios` | app, continues | 6.4 | 02 Play three scenarios: three runs land verified, then "Read from the stats folder" |
| 4 | `result` | app | 6.8 | 03 Beat your own baseline: Victory +18, one pan to the round cards and the table |
| 5 | `share-card` | card | 4.4 | "Every result, one image.": the defeat and victory sample cards |
| 6 | `ladder` | app | 5.2 | 04 The ladder settles itself: Apogee ladder, then benchmark standing |
| 7 | `rank-reveal` | app, continues | 3.8 | The promotion celebration, Carbine → Rifle |
| 8 | `ghost-title` | card | 3.6 | New · Ghost Mode · "Nobody online? Race your ghost." |
| 9 | `mechanic-headline` | app, zoom 1.15 | 16.0 | 05 Pick your ghost (last month's you) → Race → Start → three lanes, 3-2-1 each → "The last lane decides it" → Beat last month's you, +0.5% |
| 10 | `close` | card | 4.8 | stacked lockup · tagline · Free for Windows · repo URL |

Cut to make room: `never-typed` (its point is already the "Read from the stats folder"
caption) and `expedition` (practice, the weakest beat for a first watch). Both stay in
the shot list with `enabled: false`. The result scene lost its second pan: the first
already rests on the round cards and the whole table, and the second only pushed them
half under the top bar.

### Teaser, 9:16, zoom 1.5, 15.0 s

`hook` (3.0) → `queue` (3.4) → `scenarios` (3.2, continues) → `result` (3.2) → `close` (3.4),
with 0.4 s fades. Cards on the brand lockups; otherwise unchanged.

### Ghost clip, 9:16, zoom 1.5, 15.0 s

`ghost-title` (2.4, "Nobody online? Race your ghost.") → `race` (10.4: pick, Race, three
lanes with the reveals overlapping by half a second, result) → `close` (3.0, stacked
lockup), with 0.4 s fades. Start is not clicked on camera here; the started board is
pushed straight after Race, because the clip cannot afford the second click.

### GIF

The trailer from the start of `queue`, 11 s. Width and frame rate step down (800/15,
720/15, 640/12, 560/10) until the file is under `maxBytes`; this run needed only the first.

## Defects found in review, and fixed

- **Sidebar through the caption band** (the result shot, "03"): the band was a gradient
  5 to 10% see-through where the text sits, so the sidebar's rank, rating and streak
  read through. The band is now opaque up to 64% of its height and fades over the top
  third only.
- **Ghost streak pill sliced by the top bar** in the 16:9 race: the board is now scrolled
  flush, so the pill goes fully under the bar instead of leaving a sliver.
- **Closing card of the ghost clip never settled** before the fade out at 2.2 s: it now
  runs 3.0 s and starts animating at 0.05 s.

Frames that are mid-pan or mid-crossfade show content crossing an edge or two scenes at
once. That is the motion, not a layout fault; the resting frames either side are clean.

## Re-filming later

- **Flow changes.** Every app scene addresses the UI through selectors and renderer
  globals, and a renamed one fails the build rather than filming the wrong thing:
  - selectors: `.queue-stage`, `#cats .cat`, `#queueBtn`, `#opponent`, `#todoList`,
    `#explain`, `#debriefRounds`, `#screen-ranks h2`, `.gh-card[data-kind]`,
    `[data-gh="draw"]`, `[data-gh="start"]`, `.gh-board`, `.gh-result`, `.gh-cards`;
  - renderer globals in `stage.js`: `setCommit`, `showOpponent`, `renderTodo`, `markAllIn`,
    `renderResult`, `showCelebration`, `startMatchClock`, `current`, `pendingScenarios`;
  - the ghost bridge is inserted before the preview's `<script>/* Ghost Mode:` marker;
    `record.cjs` fails if the marker is missing.
- **Ghost Mode changes.** If GhostService's screen shape changes, re-run `ghostDemo.ts`
  (it needs a stats folder with a `month_ago` ghost) and re-film. The reveal timings in
  `shots.json` assume ghost.js's 2.6 s `REVEAL_MS` and 1.9 s count.
- **Snapshot.** If `data/snapshot.json` is re-exported, rank names and numbers on screen
  change with it. The promotion in `rank-reveal` is hard-coded (Carbine → Rifle), so check
  it is still a real step on the season's ladder.
- **Length.** The trailer has 0.9 s left under 60. Anything added comes out of `result`
  or `ladder`. The vertical cuts have to be exactly scene lengths minus 0.4 s per fade.
