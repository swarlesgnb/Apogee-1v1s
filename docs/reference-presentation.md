# Reference-driven presentation

The September 23, 2026 presentation pass builds on the current celestial shell. It is
implemented in `src/app/renderer/presentation.css` and `presentation.js`, loaded after
the existing presentation files in both the desktop app and standalone preview.

## References reviewed

The six supplied addresses resolve to five sites. Public pages were retrieved on
September 23; no account, subscription, exported template or purchased asset was used.

| Reference | Available material | Application |
| --- | --- | --- |
| https://deck.gallery/ | Public catalogue and Formula 1 / Strava guideline descriptions and slide captions; full access varies by deck | Compact two-column heading hierarchy, consistent alignment, readable numeric spacing |
| https://animos.app/ | Public page metadata and client landing-page copy: motion templates for showcasing images/video | Framed collection-art hover treatment and short staged page entrances; no claim to have operated its editor |
| https://godly.design/ | Public UI gallery and example listing | Cohesive navigation, prominent primary action, quieter secondary cards |
| https://transitions.dev/ | Public transition catalogue and repository README | Sliding active-navigation marker, panel entrance sequence, modal / toast / menu entrance, shared motion tokens, reduced-motion handling |
| https://backgrounds.supply/gradient-lab | Public descriptions of concentric, mesh and other gradient treatments | Original static concentric CSS field behind the existing solo-practice ship illustration |

Short links: `Nf7zdUN0uZ` → Godly; `qhlLA3X3H8` → Transitions;
`vaMXsei5yR` → Backgrounds Supply; `9bm7tSISFX` → Deck Gallery.

These are design adaptations, not wholesale imports of the catalogues. Existing rank
colours, player themes, data provenance, game rules and expedition artwork retain their
meaning. No remote runtime dependencies, fonts, telemetry or asset requests were added.
The season editor keeps its dense working layout.

## Motion

Routine feedback uses 140 ms, surfaces 180 ms, and entrances 240 ms with at most 24 ms
between six visible blocks. The JavaScript entrance reads the CSS duration and easing
tokens. Rapid navigation cancels prior entrances. Backgrounding or enabling reduced
motion cancels active entrances. Live score values are never staggered or rewritten.
The navigation marker follows resizing and late navigation-item visibility changes.
CSS handles focus and hover; native dialog and tab behavior stays with the renderer.

## Verification

`npm.cmd run validate:reference-ui` rebuilds the preview and runs an isolated Electron
fixture. It derives its screen inventory from the live navigation, requires populated
screens, checks horizontal fit at 1440×1080, 940×640 and 600×900, verifies the visible
queue action and rank-number inset, and captures screenshots in
`.cache/reference-polish`. It also tests marker alignment, a deliberately displaced
marker, rapid navigation, actual entrance creation, dialog focus and reduced motion.
Foreground visibility is simulated for the motion portion of this hidden fixture.

Related regressions: `validate:season-ui`, `validate:expedition-ui`,
`validate:presentation`, `validate:theme`, `typecheck`, and `build:app`.
Screenshots and hidden Electron checks do not establish native-window feel, live
matchmaking, Steam sign-in or a real KovaaK's session. The live website editors were
not operated because browser control was unavailable.
