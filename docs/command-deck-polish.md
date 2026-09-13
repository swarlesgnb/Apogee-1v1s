# Command deck polish

## Assessment

The vanilla renderer already has shared counters, fill animation, an owned queue WebGL context, queued celebrations, keyboard navigation, reduced-motion guards, native IPC, and explicit synthetic previews. The presentation relies on similar rounded surfaces; six disciplines share three symbols; match progress can tick a local file before submission succeeds; a real opponent inherits the preview opponent's badge; and round summaries do not distinguish ties consistently.

## Passes

1. Queue and home: six authored discipline marks, accent and selection signatures; visible selection/lock/play/debrief stages; a faceted eight-tier insignia system; concise baseline coverage and a data-backed practice route. Keep the primary action visible at the minimum desktop size.
2. Match and outcome: explicit detected/submitting/received/failure states, truthful opponent presentation, per-round debrief cards and an outcome heading; retain raw-score tables and backend verdicts. Extend existing celebration and focus handling rather than adding a motion framework.
3. Progression and events: stronger hierarchy for ladders and practice, tournament fixture/hero/bracket polish, keyboard-scrollable bracket and data tables, quiet empty states and readable provisional labels.

Use opaque ink surfaces, precise boundaries and inset material facets. No new dependencies, remote fonts, bitmap assets, or background animation loops. Restrained motion uses transform and opacity; reduced motion preserves final states.

## Verification

Run JavaScript syntax, TypeScript, app build, sound/counter/orb validators, source design audit, and diff checks after meaningful passes. Add focused regression checks for data-truth fixes. Review queue, debrief, ranks, quests, season and all available tournament preview phases in the browser, at desktop and narrow widths. Exercise native startup and IPC through the existing smoke suite. Record separately what was visually reviewed and what remains synthetic or untested live.

## Existing tournament scope

The current checkout implements groups followed by single-elimination playoffs. Earlier requested double elimination, configurable best-of, and private codes are a separate behavior change and are not represented as working in this presentation pass. Existing tournament behavior and user edits must be retained.

## Implemented, September 13, 2026

- Home and queue: six authored discipline symbols and selection motions; a four-stage queue indicator driven by the existing queue state; a more compact primary action; eight faceted rank insignias; a practice route derived from the player's actual weakest category. Background drift is stopped.
- Match and debrief: received-run count, explicit submitting/failure states, round-by-round improvement cards, shared win/loss/draw/excluded/unavailable classification, and clear result provenance. Local file detection no longer completes a server submission. A real opponent uses a neutral monogram rather than a synthetic tier. Missing deltas and rating changes stay unavailable, while actual zeros remain zero.
- Progression: legible climb and quest progress bars, richer rank plates and ladder surfaces, shared discipline symbols in the aim profile. New local personal-best feedback compares against known local history, including runs arriving between snapshot rebuilds. Benchmark promotions require an upward rank change on the same ladder; they do not claim a ranked-rating promotion.
- Events and accessibility: stronger tournament headers, fixture emphasis, bracket surfaces and winner cues; keyboard landing points for scrolling tables/brackets; a labeled celebration dialog with focus containment, inert background and focus restoration. New longer motion is limited to debrief and promotion events, inside reduced-motion guards.

### Files in this pass

| Area | Files |
| --- | --- |
| Renderer | `src/app/renderer/index.html`, `renderer.js`, `arena.css`, `tournament.css` |
| Local achievement notifications | `src/app/main.ts`, `src/app/preload.cjs` |
| Validation | `tools/validatePresentation.mjs`, `tools/validateCounter.mjs`, `tools/auditLook.mjs`, `package.json` |
| Review artifacts | `tools/apogee-ui-preview.html`, `docs/command-deck-polish.md`, `docs/ui-redesign-progress.md` |

No dependency was added. Existing theme controls, Scenarios screen, season edits and tournament engine changes were retained. The renderer remains a plain Electron script. No release was packaged or deployed.

### Checks and evidence

Passed: renderer JavaScript syntax; `typecheck`; `build:app`; preview generation; `validate:presentation`; `validate:counter`; `validate:sound`; `validate:orb`; `validate:match`; `validate:tournament`; `validate:progression`; `audit:look`; `node tools/validateTheme.mjs`; `git diff --check`.

The new presentation validator executes shipped renderer functions. It checks zero versus unavailable data, ties and exclusions, escaped scenario text, local detection versus receipt, stale-match receipts, failure state, and promotion focus restoration. The counter validator now normalizes Windows line endings before extracting functions. The visual audit explicitly documents the two event-only motion durations.

Final headless Electron smoke passed using isolated `.cache/command-deck-smoke` storage and `--disable-gpu`. It read 12,941 local runs and checked startup, sign-in availability, error presentation, season/band/scenario data, counters, duels/rematch, tournament groups/bracket, preload, editors, and queue WebGL context release. Electron emitted its existing console-message deprecation notice; the suite exited successfully.

Browser visual inspection covered queue, example active match, debrief, ranks, quests, aim profile, season, and tournament registration/groups/playoffs/completion. At 940 x 640 the queue button was entirely visible. At 390 x 844 the queue fit the page width and the debrief table scrolled inside its region using the keyboard. The bracket exposed a keyboard focusable region; a browser inspection timeout prevented measuring its scroll displacement. The viewport override was restored. Browser error/warning capture was empty.

### Remaining QA boundaries

The browser preview uses real local training data with explicitly synthetic opponents, results and tournament players. Live Steam sign-in, real matchmaking, real score submission, live tournament play and live settlement were not run. Promotion focus/state behavior was tested programmatically; a real personal-best or promotion event was not visually exercised. Reduced-motion guards and existing counter behavior were checked in code/tests, not by changing the operating system preference. Low-end GPU performance was not benchmarked. The earlier requested double-elimination/private-code/configurable-series tournament behavior remains outside this presentation pass; this checkout still uses groups followed by single elimination.
