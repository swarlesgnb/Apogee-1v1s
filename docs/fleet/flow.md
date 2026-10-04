# Flow and performance: fleet/flow

What a player meets between launching the app and queueing again, how long each step takes,
and what the test suite says about itself. Everything here was measured in this container
(Linux, 4 cores, Xvfb, no KovaaK's, no Supabase settings) against a synthetic stats folder,
because there is no real one here. No server code, rating, verification or season data
changed, and there is no migration.

## 1. A synthetic stats folder

`tools/fixtures/syntheticStats.ts` writes a KovaaK's stats folder that the app reads as real.
It was committed on its own (d95382b) so other branches can use it.

```bash
npm run fixture:stats -- --out .cache/fixture/veteran/stats --preset veteran --clean
npm run fixture:stats -- --out .cache/fixture/new/stats --preset new --clean --end 2026-10-03T19:00
npm run fixture:stats -- --out .cache/fixture/veteran/stats --one --count 5   # runs ending now
```

| Preset | Runs | Span | Notes |
|---|---:|---|---|
| `new` | 30 | 2 days | under ranked's 50-run gate; mostly under the first season threshold |
| `regular` | 1,500 | about 60 days | 31 season scenarios with a baseline; 7 bands hold a rank |
| `veteran` | 15,000 | about 16 months | 105 scenarios, 33 season scenarios with a baseline |

`--runs N` sizes any of them; `--seed` and `--end` make the bytes reproducible. The library
code exports `writeStatsFolder`, `generateRuns`, `appendRun` and `PRESETS` for validators.

How the files are made coherent:

- **Season 1 runs** are scored by each scenario's own `.sce` rule (ScorePerKill, ScorePerHit,
  ScorePerDamage, ScoreLossPerMiss), with the player's weapon (damage, fire rate) and the
  bot's health from the same file deciding whether there are kills and how many hits each
  takes. Counters are drawn first and the score computed from them. Score levels sit on each
  scenario's own `rankMaxes`, across bands that overlap by two ranks. `Hash:` is the MD5 of
  the committed `.sce`, which is what `hash_known` holds Apogee scenarios to.
- **Library runs** use only scenarios with a learned score model, a weapon model and a world
  record, so every hard check that can apply does: `score = stat * k`,
  `score = Damage Done * scorePerDamage`, `Damage Possible = Shots * damagePerShot`, the
  firing-rate ceiling, and a score under the record. The Voltaic S5 Intermediate set is
  always in the pool.
- **The player**: play days ending today and yesterday (so there is a streak), sessions of
  back-to-back runs at a minute plus loading, playlists repeated two to six times, a learning
  curve, a warm-up dip, daily form and per-run noise. Season scenarios appear only in the last
  21-28 days, because they did not exist before the season shipped.

`npm run validate:fixture` writes all three sizes and reads them back through the app's own
code. Every file parses with no exceptions; `verifyRun`, given everything submit-run would
give it, grades all 16,530 runs `consistent`; the hard checks that can fire did fire (shot
balance and weapon hits on every run, the known hash on every season run, all four model
checks on every library run, the firing-rate ceiling on the tick-fire ones); every run lasts
its scenario's length and none reads as abandoned; the folder cache marks every file
coherent; a snapshot builds with ranks painted; scores improve on every scenario with 40+
runs; one seed writes the same bytes twice. It also checks the folder cache changes below.

What it is not: a model of how a real player improves, or of KovaaK's format beyond what this
repository reads. It cannot stand in for the corpus measurements in `validate:verify`: a
generator built to pass the checks says nothing about whether the checks pass on real runs.

## 2. Pointing the app at it, and smoke in this container

`--stats <dir>` or `APOGEE_STATS_DIR` names the stats folder for the app, `npm run smoke`,
`tools/flowScreens.cjs` and `tools/measureFlow.cjs`, ahead of the remembered folder and of
detection (`statsFolderOverride` in `src/app/watcher.ts`). A named folder that does not exist
finds nothing rather than falling back to another one. The same variable already pointed the
preview build and the practice tools at a folder.

Smoke's `--allow-offline` accepts only the missing Supabase settings and the disabled
"Sign-in unavailable" button they cause, and says so on the result line. Without it the check
still fails:

```
$ xvfb-run -a npx electron . --no-sandbox --smoke --stats .cache/fixture/veteran/stats --allow-offline
stats folder : .cache/fixture/veteran/stats
runs         : 15000
supabase     : MISSING (allowed by --allow-offline)
ghost mode   : month_ago+ last_week+ last_week_best+
season pool  : 164 scenarios, 41 families, 28 playlists, 4 bands, 41 rows in 6 sub-skills, 23 to play next, ...
scenario ranks: 164 rows, 28 ranked (core: 164, 28)
band ranks   : 24 cards over 6 categories, 6 held
OK: desktop client boots, finds stats, and renders (offline: no Supabase settings, sign-in untested; allowed by --allow-offline)

$ xvfb-run -a npx electron . --no-sandbox --smoke --stats .cache/fixture/veteran/stats
FAIL:
  built without Supabase settings; fill in .env and rebuild
  the sign-in button is disabled (Sign-in unavailable)
```

Before this branch, smoke here found no folder and failed ten checks, most of them screens
with nothing to paint. One was a real fault in the probe rather than the environment: the
season editor's search test typed the first six letters of a season scenario, which since the
season became Apogee's own is "Apogee" for all 164, so the one it wanted was never among the
forty results shown. It now searches a scenario the editor can offer by the letters that tell
it apart.

## 3. `npm run validate` runs every suite

`npm run validate` was one `&&` chain, so the first failure hid every later suite (audit #17).
It is now `tools/validateAll.mjs`, which runs each `npm run` step of `validate:suites` (the old
chain, moved verbatim, plus `validate:fixture`), echoes each suite's output, writes a log per
suite to `.cache/validate/`, and ends with a table. It exits 1 if any suite failed. `--bail`
keeps the old behaviour; `npm run validate -- validate:ranks validate:glicko` runs only those.

Final run on this branch:

```
suite                  result     time  why
validate:expedition    pass       1.4s
validate:parser        FAIL       0.5s  exit 1: Error: ENOENT: no such file or directory, scandir 'E:\Steam\steamapps\common\FPSA…
validate:duration      FAIL       0.5s  exit 1: Error: ENOENT: no such file or directory, scandir 'E:\Steam\steamapps\common\FPSA…
validate:season        pass       0.6s
validate:pool          pass       0.6s
validate:thresholds    pass       0.5s
validate:aimtypes      pass       0.5s
validate:standing      pass       0.6s
validate:engine        FAIL       0.8s  exit 1: FAIL: engine disagrees with KovaaK's
validate:ranks         pass       0.5s
validate:sync          FAIL       0.5s  exit 1: No payloads produced, cannot validate.
validate:verify        FAIL       1.1s  exit 1: Error: ENOENT: no such file or directory, scandir 'E:\Steam\steamapps\common\FPSA…
validate:kovaaks       pass       0.6s
validate:glicko        pass       0.5s
validate:match         FAIL       0.5s  exit 1: FAIL: 2 check(s) failed
validate:duels         pass       0.5s
validate:tournament    pass       2.8s
validate:playlist      pass       0.5s
validate:quests        FAIL       0.5s  exit 1: FAIL: 1 check(s) failed
validate:ghost         FAIL       0.5s  exit 1: FAIL: no real draw to test the rules on
validate:ghost-links   FAIL       0.5s  exit 1: FAIL: 12 check(s) failed
validate:live          pass       0.5s
validate:schema        pass      18.3s
validate:functions     pass       5.1s
validate:sound         pass       0.2s
validate:orb           pass       1.1s
validate:theme         pass       7.3s
validate:counter       pass       0.2s
validate:progression   pass       0.5s
validate:presentation  pass       0.2s
validate:sce           FAIL       0.5s  exit 1: FAIL no KovaaK's install found; nothing was measured
validate:season-files  FAIL       0.5s  exit 1: FAIL no KovaaK's install; thresholds and value ranges cannot be checked
validate:fixture       pass       8.2s

22 passed, 11 failed in 58s. Logs: .cache/validate/
```

Every failure is one the baseline already had, for the reason the brief gives: the suite reads
`E:\...\stats` or a KovaaK's install, or calls KovaaK's API (HTTP 403 here). `validate:standing`
failed at baseline for a shallow clone and passes now that history is complete. These suites
were deliberately not pointed at the fixture: their claims are about the real corpus.

**Merge note for the PM**: other branches add their validator by appending
`&& npm run validate:<name>` to the `validate` script. On this branch that string lives in
`validate:suites`; move any such addition there, unchanged.

## 4. Performance

### Harness

`tools/measureFlow.cjs` loads the bundled main process into an Electron process, as
`flowScreens.cjs` does, and times it on the same clock: first contentful paint, the window's
ready-to-show, **queue ready** (the first frame on which the queue screen shows the run count,
which is painted from the snapshot), the longest main-process event-loop stall
(`monitorEventLoopDelay`), renderer long tasks, memory, and every IPC handler over 50 ms. With
`--ingest <dir>` it renames staged run files into the stats folder one at a time and times the
run toast and the run count going up. With `--profile <dir>` it keeps the app profile between
launches.

Machine load from other agents moved absolute numbers by up to 2x during the night, so before
and after were measured interleaved: the pre-performance commit (32ed208) was built in a
separate tree, and before and after launches alternated on the same regenerated 15,000-run
fixture, three of each per mode. Medians:

**First launch, throwaway profile, with five arrivals afterwards**

| measure | before | after |
|---|---:|---:|
| first paint (ms) | 2651 | 1080 |
| window ready-to-show (ms) | 2563 | 950 |
| queue ready (ms) | 3188 | 2780 |
| longest main-process stall (ms) | 1999 | 238 |
| renderer long tasks (count / total ms / longest ms) | 4 / 339 / 105 | 4 / 505 / 282 |
| main heap / main RSS (MB) | 26.5 / 260.6 | 40.4 / 270.7 |
| renderer heap (MB) | 10.7 | 12.1 |
| all processes working set (MB) | 641.6 | 714.9 |
| a new run: toast on screen (ms) | 813 | 409 |
| a new run: queue count painted (ms) | 2213 | 910 |
| longest stall during the five arrivals (ms) | 107 | 117 |

**Relaunch on the same folder, kept profile**

| measure | before | after |
|---|---:|---:|
| first paint (ms) | 2448 | 1043 |
| queue ready (ms) | 2929 | 1586 |
| longest main-process stall (ms) | 1825 | 322 |
| renderer long tasks (count / total ms / longest ms) | 4 / 284 / 87 | 4 / 326 / 101 |
| all processes working set (MB) | 649.7 | 632.7 |

The app's own log on the kept profile: `initial read 1699ms` on the first launch and
`initial read 46ms` on the relaunch, then `rebuild (initial scan)` at 219 ms and 173 ms.

For scale, the 1,500-run fixture before the change painted at 1121 ms with a 421 ms stall;
the cost grows with the folder.

### What changed

1. **The first read of the folder no longer freezes the app.** `startWatching` used to run the
   initial scan synchronously on the main process before anything else; the window could not
   paint, take a click or answer the renderer until every file was parsed. Now
   `primeStatsFolder` (`src/core/stats/folderCache.ts`) parses in 12 ms slices, yielding the
   event loop between them, and the initial rebuild runs when it is done. The handlers that
   read the whole history (practice, apex, expedition, ghost, available scenarios and the two
   action handlers) wait for it with `statsRead()` instead of parsing the rest in one go; the
   first version without that froze for 1.2 s in the practice handler. The work after the
   rebuild (saving the cache, ghost catch-up, installing scenario files, refreshing playlists)
   runs a turn at a time. The validator measures the slicing: priming 15,000 files took about
   2 s with a longest event-loop stall of 22 ms.
2. **The parse is kept between launches.** Parsed runs are written to
   `userData/stats-cache.json` (2.0 MB for 15,000 runs) under the build stamp, so a relaunch
   reads only files it has not seen. This leans on the same fact the in-session cache already
   did: KovaaK's writes a stats file once and never again. A new build, a different folder or
   a different key reads as no cache. Failures are never stored. The owner's log records a
   54 s cold rebuild on Windows; that is the case this is for, and it was not measurable here.
3. **A new run shows sooner.** The watcher started every file at an unknown size, so its first
   check always saw growth and waited a second 400 ms; it now records the size at every event.
   It also retries a file that is steady by size but incomplete, or locked, until 15 s,
   instead of dropping it: a dropped file is a run the match is never told about. The rebuild
   debounce went from 1200 ms to 300 ms; runs land a minute apart and files that land together
   settle within milliseconds of each other, so a burst is still one rebuild.
4. **The empty card says the folder is being read.** With the window painting during the read,
   the card's default "Looking for your KovaaK's stats…" claimed the folder had not been
   found. It now reads "Reading your KovaaK's stats…" with the path (screenshot
   `after/veteran/fresh-00a-reading.png`).

### What got worse, honestly

- **Renderer long tasks on a first launch** rose from 339 ms total (longest 105) to 505 ms
  (longest 282). The renderer now exists while data arrives, and the expedition and practice
  screens are drawn twice: once from their own IPC reply and once from the rebuild's
  broadcast. Before, those broadcasts went to a window that had not loaded and were dropped.
  It happens once, under the reading card. On a relaunch the totals are back to before.
- **Main heap after a first launch** is about 14 MB higher three seconds after the queue is
  ready, and the working set about 70 MB higher; on a relaunch both are at or below before.
  Not investigated further.
- **Queue ready on a first launch** improved only 0.4 s: the parse itself is the same work.

## 5. The flows, re-walked

`tools/flowScreens.cjs` now takes `--stats` like the app, photographs the window while the
folder is read (`--early`), photographs the tournament host panel, and writes `fit.json`: the
queue button's bottom against the viewport at five sizes, with the checklist hidden and the
one-off notice dismissed (the lobby of anybody past their first session). Shots are under
`scratchpad/shots/flow/{before,after}/{new,regular,veteran,nostats}/`.

Ranked by reach, the way the overnight audit ranked them:

| # | Reach | What happens | Status |
|---|---|---|---|
| 1 | Everyone, every launch | The window cannot paint or respond until the whole folder is parsed (2.0 s stall at 15,000 runs here; 54 s cold in the owner's log). | Fixed (§4) |
| 2 | Everyone past their first session | At the default 1280x880 window, Find opponent is below the fold: bottom at 1009 px. At 1440x1015 (a 1080 window under the Windows title bar) it clears by 11 px here and missed by 33 px in the preview suite on Windows fonts. | Fixed: 799 px and 796 px |
| 3 | Everyone who plays a match | Match rows said "to beat 2,516" while the pool below said a scenario had no baseline (audit #14). The best never decided a round; the baseline does. | Fixed: "best 2,516", or "best 1,357 · 3 runs to a baseline" |
| 4 | Everyone, every run | 0.8 s to the run toast and 2.2 s to the count; a file still incomplete at its settle check was dropped, so a match could miss a run. | Fixed (§4) |
| 5 | Everyone with a long history, first launch | The new reading state said the folder was not found. | Fixed |
| 6 | Curious, signed out | Host a tournament was fully interactive and only the server refused (audit #15). | Fixed: the form stays explorable and ends in "Sign in to host", which presses the rail's button |
| 7 | Maintainers | One failing suite hid every later one (audit #17). | Fixed (§3) |
| 8 | Maintainers | Smoke could not run here at all, and its season-editor search probe could not pass on Season 1. | Fixed (§2) |
| 9 | New players | Matches draw from Intermediate (`matchPool.window: 1`) while the Season screen and the Expedition start at Novice: the 30-run player has 0 of 8 baselines in the pool. The note and "Show which" explain it. | Open: season policy, not changed |
| 10 | Developer builds only | With no Supabase settings, the checklist's Sign in and the new "Sign in to host" stay enabled while the rail says "Sign-in unavailable"; they read the rail's state when drawn. | Open, low reach |
| 11 | Everyone | Season deep links to Workshop scenarios a player has not subscribed to (audit #12). | Open: needs a clean KovaaK's install |

Fit, from `fit.json` (button bottom against viewport height, checklist hidden):

| window content | before | after |
|---|---|---|
| 1280x880 (default window) | 1009 of 880, below | 799 of 880 |
| 1440x1015 | 1004 of 1015 | 796 of 1015 |
| 1920x1032 (maximised 1080p) | 1004 of 1032 | 796 of 1032 |
| 1440x1080 | 1004 of 1080 | 1004 of 1080 (full hero, unchanged) |
| 1280x720 | 574 of 720 | 574 of 720 |

The fix extends the lobby's existing compact hero (one-line title, short expedition card,
tighter queue padding) from windows up to 800 px tall to windows up to 1060 px tall. The
tighter category cards stay at 800 px. Taller windows keep the full hero.

Re-walked without findings worth a change: first launch with no folder, Getting started (it
still sits above the stage on purpose, audit #1), Season, Quests, Ghost (all three ghosts
correctly unavailable to a 30-run player, with reasons), Expedition, the seeding match and
both results.

## 6. Tests run

| Command | Result |
|---|---|
| `npx tsc --noEmit` | passes |
| `npm run validate:fixture` | passes (all checks; §1) |
| `npm run validate` | 22 passed, 11 failed: the same eleven as the baseline, every one environmental (table in §3) |
| `npm run validate:background-refresh` | passes ("shipped snapshot receiver coalesces 100 background updates and resumes on focus") |
| `npm run attack:rls` | passes ("no holes found") |
| `npm run validate:reference-ui`, `validate:expedition-ui` (after the CSS change; the generated preview was reverted, not committed) | pass, queue fit included |
| smoke with the fixture, `--allow-offline` | OK; without the flag, fails on exactly the two Supabase lines |
| `git diff --check` | clean |

## 7. Files others are likely to touch (merge hotspots)

- `package.json`: `validate` is now `node tools/validateAll.mjs`; the chain is `validate:suites`.
  New scripts `fixture:stats`, `validate:fixture`.
- `src/app/main.ts`: `startWatching` (sliced first read), `scheduleRebuild`,
  `REBUILD_DEBOUNCE_MS`, `statsRead()` added before `apogee:getState`, `await statsRead()` at
  the top of seven history handlers, the smoke routine (`--allow-offline`, the editor search
  probe), the startup folder choice (`statsFolderOverride`), `useDiskCache` and
  `saveDiskCache` on quit.
- `src/app/renderer/renderer.js`: `renderTodo` (match rows), `tnHostPanel` (signed-out
  branch), `paintFolderReading` beside `paintFolderMissing`, two calls in `onScanning` and the
  `getState` handler.
- `src/app/renderer/cosmic.css`: the first `(max-height:800px)` block is now
  `(max-height:1060px)`.
- `src/app/watcher.ts`, `src/core/stats/folderCache.ts`: rewritten internals, same exports
  plus `primeStatsFolder`, `isPrimed`, `useDiskCache`, `saveDiskCache`, `statsFolderOverride`.

## 8. Deployment

Client only. No migration, no Edge Function, no backend step. The disk cache file appears in
the user's profile on first launch of a build with this change.

## 9. Not done

- The doubled expedition and practice draws at first launch (§4) are not removed.
- The startup rebuild still holds the main process for about 220-330 ms once, after the window
  is painted and while the card says the folder is being read.
- No Windows measurement: every number here is Linux under Xvfb on a synthetic folder in the
  page cache. The disk cache's effect on a cold NTFS folder is argued, not measured.
- The environmental suites still read `E:\` and were not given a fixture path.
