# Mixtape

Mixtape is a local practice-session builder in the Improve navigation group and lobby.
It uses the real season's practice rows and existing scenario-launch/run-event bridge.
No new IPC capability, network request or runtime dependency is added.

## Session design

- Full spectrum balances the selected band's available categories and prefers distinct families.
- Close the gap sorts by relative distance from personal best to the next scenario threshold.
  Rows without an upcoming threshold come last. A scenario threshold is not a promise of
  a family-rank promotion.
- Side quests starts with the least-played rows, with randomized ties.
- A set requests 3, 6 or 9 distinct scenarios in one difficulty. A small pool produces a
  smaller set and an empty pool cannot start. Remix changes the deterministic random seed.

Starting a set freezes each track's last-run score, falling back to personal best and
otherwise leaving the reference absent. Zero remains a real score. A new matching
`apogee:run` receipt advances only the current track. Scenario names match exactly;
missing, old or far-future timestamps, invalid scores and duplicate receipt IDs are
refused. Launching is not completion. Skips remain separate from played tracks.

Auto-open next track is an opt-in toggle during a set: when a run is recorded, the next
track opens in KovaaK's without returning to Apogee. It is remembered per machine.

A set saved before the season changed can name scenarios the pool no longer has. Those
tracks are skipped with the reason shown, rather than offered and failing to launch.
Ending a set before any track was played discards it instead of filing an empty recap.

Active sets and the latest 12 recaps persist under `apogee.mixtape.v1` in local storage.
Loaded data is validated. If storage fails the interface explicitly says the set is
running in memory. Tracking needs Apogee to stay open; runs played while it is closed
are not backfilled into a set. This is a local companion journal, not a verified
competitive result or XP award. Starting a set is independent of ranked matchmaking.

The tab remains reachable without a snapshot and offers the existing stats-folder
chooser when a desktop user has no folder connected. Preview mode offers planning and
saved recaps but does not simulate run completion or launch the game.

## Visual treatment

Original CSS record artwork, sleeve grids and mood palettes interpret the supplied
Animos, Deck Gallery, Godly and Backgrounds Supply references. Transitions.dev patterns
inform the track reveal, small card tilt and completion burst. Existing source-access
boundaries are recorded in `reference-presentation.md`; no premium asset is imported.

Live motion is confined to the active screen and pauses on blur or document hiding.
Reduced motion stops the record, level bars, track reveals, tilt and completion burst.
The shell additionally gains lobby illumination, collection-art lighting and command
menu feedback while retaining the current celestial palette and gameplay semantics.

## Verification

- `npm.cmd run validate:mixtape`: pure planning, timestamp/identity validation,
  persistence shape, zero handling, skip and recap assertions.
- `npm.cmd run validate:mixtape-ui`: isolated Electron fixture with real preview pool
  and synthetic launch/run receipts. Covers the builder, modes, remix, selected band,
  tracking, reload, partial/full recaps, history, failure states, reduced motion and
  responsive screenshots in `.cache/mixtape-ui`.
- `validate:reference-ui` enumerates the live navigation and covers all 11 player screens.

The fixture proves renderer integration, not a real KovaaK's launch or a native-window
play session. Recap screenshots produced by the fixture contain explicitly synthetic
run results. Existing ranked rules and the season editor are outside the new module.
