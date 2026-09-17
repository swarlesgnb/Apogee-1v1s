# UI principles pass

September 14, 2026. User feedback: the first arcade pass still looked overly AI-generated.

## Sources and application

Read the four articles supplied by the user:

- [Figma: UI design principles](https://www.figma.com/resource-library/ui-design-principles/) emphasizes hierarchy, progressive disclosure, consistency, contrast, proximity and alignment. Applied by putting discipline choice and queue commitment in one group, reducing the header, and making the scenario pool expandable.
- [UX Design Institute: What is UI design?](https://www.uxdesigninstitute.com/blog/what-is-ui-design/) emphasizes predictable controls, consistent visual and functional behavior, feedback, flexibility and efficiency. Applied through one button scale, persistent preferences, descriptive category choices, and the existing keyboard navigation.
- [Maze: UI design principles](https://maze.co/collections/ux-ui-design/ui-design-principles/) discusses user control, informative feedback, recognition over recall and hierarchy. Applied through a visible selected-discipline summary, reversible disclosure, clear keyboard focus and restrained feedback at the control that changes.
- [GeeksforGeeks: UI/UX principles](https://www.geeksforgeeks.org/techtips/principles-of-ui-ux-design/) prioritizes simplicity, visibility, clarity, accessibility and useful delight. Applied by reserving the strongest accent for the queue action, removing competing decoration and keeping match-state feedback and sound controls.

These sources inform the design decisions; they do not prove that a design looks human-made or that users will prefer it.

## Changes

- Replaced the slogan-led poster with a direct Ranked 1v1 heading and secondary routes to benchmarks and tournaments.
- Removed the tilted illustration, stickers, star separators, colorful category backplates, colored page banners and offset shadows. The original Higgsfield image remains on disk with its provenance; this revision does not display it or spend additional credits.
- Rebuilt the presentation stylesheet around a dark neutral palette, warm action accent, stronger typography and consistent 5/8px control/panel corners.
- Grouped readable category descriptions, the selected discipline and the queue button in their actual decision order. Selection has a border and radio indicator as well as color.
- Reduced the rank showcase to a compact standing summary with real rating, uncertainty, provisional standing and run count.
- Made Scenario pool a native keyboard-operable disclosure. Its summary gives the actual available scenario count and baseline coverage. Clicking elsewhere does not dismiss this content disclosure; popover dismissal still works.
- Removed decorative pointer tilt. Preserved restrained selection feedback, match/achievement feedback, all 13 sound cues, volume/mute, search and keyboard controls.

## Verification

September 17, 2026, against the tree as committed:

- `npm run typecheck` clean.
- `npm run validate` - all 30 suites pass, including the appearance validators this pass
  touches: `validate:theme` (contrast against the rebuilt palette tokens),
  `validate:presentation`, `validate:counter`, `validate:orb` and `validate:sound`.
- `npm run audit:look` passes, including the checks against the visual language this pass
  set out to remove: radial orbs, dot grids, sparkles, neon and purple chrome, hover that
  moves things. 154 mono declarations and 12 reduced-motion guards in the client.
- `npm run smoke` boots headlessly and renders every screen off real local data: 13,315
  runs, 256 scenario rows, 64 families, 24 band cards, the duel panel, the tournament
  bracket, both editors and the preload bridge.
- `npm run beta` - 14/14 blockers and 5/5 advisories clear.

Not verified: rendered visual review at desktop and narrow widths, and the interaction
checks for the revised disclosure and selection summary, both of which need a human at
the window. The validators above prove the tokens and the structure, not that it looks
right.

The Higgsfield illustration this pass stopped displaying moved to `.cache/higgsfield/`.
It was still under `src/app/renderer/assets/`, which `build:app` copies wholesale, so an
unreferenced 94KB image was being packaged into every download. Provenance for it stays
recorded in `arcade-redesign-progress.md`.

First-pass renderer files are backed up locally in `.cache/design-pass1/`. Ranked rules, scenario selection logic, scoring, matchmaking, account behavior and data are unchanged.
