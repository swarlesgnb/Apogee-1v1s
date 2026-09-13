# Apogee 1v1s UI redesign

Status: complete. Final desktop build and verification finished September 9, 2026 (America/Denver).

## Design

Competitive dark with expressive typography: ink-blue surfaces, violet primary actions, clearer navigation, and the existing semantic rank colors. The queue now has a category-selection stage beside a personal rank card. Custom rank insignia and consistent controls, tables, panels, empty states, and feedback extend across the player screens and editors.

Keyboard navigation, focus indicators, reduced-motion behavior, narrow layouts, and legible rank text were improved. Provisional standings and the preview's synthetic opponent/match remain explicitly identified. Match and rating logic were preserved.

References reviewed and adapted to the existing vanilla renderer:
- https://www.ui-skills.com/skills/anthropics/frontend-design
- https://www.ui-skills.com/skills/jakubkrehel/better-ui
- https://www.rareui.com/components/hooksidebar
- https://www.rareui.com/components/animatedcounter
- https://interfaces.dev/cheat-sheet

## Verification

Passed: renderer JavaScript syntax check, npm run typecheck, npm run build:app, standalone preview generation, npm run validate:counter, npm run validate:sound, npm run validate:orb, npm run audit:look, and git diff --check.

Final Electron smoke test passed with an isolated test profile and --disable-gpu outside the sandbox. It loaded 12,795 local runs; rendered season and band data; checked sign-in availability, errors, counters, duel/rematch states, queue orb lifecycle, preload bridge, look editor, and season editor.

Browser review covered all seven player screens and band detail, category selection, keyboard navigation, and responsive layouts. At 390px, all seven screens fit the page width with wide tables scrolling inside their panels. At 940x640, the queue action remained in view. Browser console checks showed no errors or warnings during review. Final regenerated queue preview was inspected again after the desktop smoke test.

Live Steam authentication, real matchmaking, and live match settlement were not exercised. Editor states were covered by the desktop smoke test rather than a complete manual visual review. The preview is a labeled static snapshot of 12,757 runs from earlier on September 9, with example opponent and match data.

## Open the result

Close any running source app, then run npm start from E:/Desk2p/VSCode/aim-arena to open the rebuilt client. The standalone browser preview is tools/apogee-ui-preview.html. The source app was rebuilt; no release installer was packaged or deployed.

Existing user changes were preserved, including FAIR-PLAY.md, PLAN.md, README.md, data/apogee_ranks.json, data/leaderboard_apex.json, data/seasons/season-1.json, docs/apogee-internals.html, src/core/rating/validateGlicko.ts, supabase/migrations/20260905000017_duels.sql, tools/betaReadiness.ts, and LICENSE.

Continuation automation: finish-apogee-visual-redesign. The task is complete and the continuation is being paused at handoff.


## Command deck continuation, September 13, 2026

Completed the next presentation pass: discipline identities, queue stages, faceted rank materials, truthful run receipts and round debriefs, local achievement notifications, tournament polish, and keyboard/focus improvements. Preserved the newer theme controls, Scenarios screen, and existing tournament behavior. Full file list, validation evidence and live-QA boundaries are in [command-deck-polish.md](command-deck-polish.md).

The final app build, Electron smoke with isolated test storage, typecheck, presentation/counter/sound/orb/match/tournament/progression checks, theme checks, design audit, and diff whitespace check passed. Visual inspection used labeled browser previews at desktop and narrow sizes. This was a source-client update; no installer or backend was deployed.
