# Season 1 circuit rebuild

> Follow-up: the [September 13 theory-led revision](benchmark-theory-rebuild.md) replaces seven families and updates the current circuits. The tables below describe the September 12 pass.


Done locally on September 12, 2026. The season is still a draft; nothing was deployed to the backend and no installer was built.

## Scope

The five non-static categories each have six scenario families across Novice, Intermediate, Advanced, and Expert. The full season has 39 families and 156 scenarios, 39 per band.

The first pass leaned on Voltaic: 19 of the 30 non-static families used Voltaic's own cuts, so grinding the season was mostly grinding a benchmark people already play. Thirteen of them were swapped for other authors' versions of the same scenario (Pasu, Popcorn, Smoothbot, DotTS) or for a lineage that fits the category better (cloverRawControl, Controlsphere, Ground Plaza, Air CELESTIAL). Six still use Voltaic cuts, because no other author publishes four usable rungs for them: Air Reading, EddieTS, psalmTS, Smooth Transfer, bounceTS and FlyTS.

Static Clicking is unchanged: the same nine families, 36 variants, score targets, rank names, colors, metadata, and season category definition. A deep comparison of its scenario records against the previous build matches once the fields every rebuild refreshes are left out: `sanity.sampledAt`, and the `corpus` readout of the local stats folder.

## Circuits

Play each category in this order, then go back to whichever rank target is closest. The category playlists use the same order.

| Category | Circuit order |
| --- | --- |
| Dynamic Clicking | Pasu → PipeClick → Bounce → Angelic → HopClick → Popcorn |
| Precise Tracking | Smoothbot → cloverRawControl → PreciseTrack → Whisphere → Smoothsphere → Controlsphere |
| Reactive Tracking | Ground Plaza → Air Reading → Air Angelic → Strafe Gallery → Leapstrafes → Air CELESTIAL |
| Speed Switching | DotTS → Vox Range → EddieTS → PivoTS → Pokeball → psalmTS |
| Evasive Switching | Pasu Switch → Smooth Transfer → bounceTS → Hop Transfer → tamTargetSwitch Smooth → FlyTS |

The Season screen shows a short guide for each category and numbered focus cues. The editor keeps the authored circuit order even when scenario rows are reordered while editing, and the browser preview reads the same guides as the desktop app.

## Sources and calibration

Selections come from [EVXL](https://evxl.app/), its [benchmark registry](https://evxl.app/data/benchmarks), and the KovaaK's benchmark definitions and leaderboard samples behind them. The EVXL registry was refreshed to 128 benchmarks, and eight of the selected benchmark definitions were refreshed; the pool keeps exact scenario names and leaderboard IDs.

Of the 120 non-static variants, 117 use frozen percentile-derived targets. The other three are Elite variants, calibrated by hand because their sparse boards and published upper targets did not support a reliable percentile ladder. Each keeps its published first target and follows a geometric progression ending at the floor of the sampled fifth-place score:

| Elite scenario | First target | Final target |
| --- | ---: | ---: |
| VT EddieTS Elite S5 | 860 | 951 |
| VT bounceTS Elite | 720 | 854 |
| VT FlyTS Elite S5 | 450 | 520 |

`data/season_rebuild_calibration.json` records the exact names, original source citations, intermediate targets, and dated anchor evidence. Cached sample dates vary, so these are fixed draft targets rather than live percentiles. Every rebuilt target is at or below its sampled leaderboard record. Rank names and colors are unchanged; category energy thresholds scale to six equally weighted families.

`data/pool_curation.json` explains each selection and its four-band progression. `data/scenario_rationale.json` tracks family rationale and source coverage. Three choices in particular need testing in game: the mixed-author progressions, the two PivoTS Hard releases, and the Smoothbot regeneration variant. The circuits were built from the data, not by playing them, so whether they are fun and whether the difficulty steps feel even is still to be judged in KovaaK's.

## Verification

Passed: pool structure, threshold provenance, rationale, season edits, curation, standings, aim types, playlists, quests, quest progression, rank distribution diagnostics, TypeScript, design source guards, app build, and desktop smoke. The engine passed 24 live comparisons against KovaaK's. The Season preview was checked by eye at desktop width and at 390 pixels; at the narrow width it renders five guides, 30 focus cues, and 39 rows per selected band without overflowing the page.

`npm run validate:curation` checks all 20 rebuilt category playlists, scenario identity and order, guide coverage, targets against sampled records, that the Elite calibration reproduces, and that circuit order survives an editor save.

Still reported: the existing taxonomy gaps and unused source declarations, and, for Static Clicking, the upper-target warnings and empty Photon Lance result it already had. That last comes from the simplified same-percentile distribution model, which describes the shape of a ladder and does not predict the real player population. Live matchmaking was not tested.

## Where to look

`npm start` builds and launches the rebuilt desktop app. `tools/apogee-ui-preview.html` is the generated single-file preview; live play and Steam sign-in only work in the desktop app. The rank sheet is `docs/season-1-ranks.html`.
