# Apogee arcade redesign

Status: second design pass in progress, September 14, 2026. The user found the first pass too AI-looking and supplied four UI design articles. Current decisions and verification are in `docs/ui-principles-pass.md`; the implementation and verification below record the first pass.

## User direction

- Bright, bold arcade competition. Full visual and navigation redesign, preserving ranked rules, scoring, matchmaking behavior and data.
- Energetic arcade sounds, distinctive interactions, no generic water-drop sounds or generic AI visual language.
- Use Higgsfield as well. The user signed in and approved spending existing Higgsfield credits, with an absolute prohibition on spending money. One illustration was generated using the site's WebMCP interface for 2 existing credits. No money, subscriptions, upgrades, or additional credit purchases were used.
- Continue when usage returns. Existing automation `finish-apogee-visual-redesign` was retargeted to task `01a0a1d6-b341-7391-a6e8-8128533fae4d` and enabled hourly during work. It is now paused because the implementation is complete. No Codex reset credits were purchased or redeemed.

## Starting state

Working directory for implementation: E:/Desk2p/VSCode/aim-arena. Git working tree was clean using per-command `git -c safe.directory=E:/Desk2p/VSCode/aim-arena`. No AGENTS.md found inside the project. Preserve core game logic and all existing features.

Renderer: src/app/renderer/index.html, arena.css, tournament.css, renderer.js. Build copies entire renderer folder. tools/buildUiPreview.ts inlines source CSS and JS with labeled real snapshot/example match. Existing player theme, sound, reduced motion and UI validators must remain functional.

## Implemented

1. A new arcade stylesheet across all nine player screens: petrol grounds, coral, mint and lime accents, bold display typography, a poster-style lobby, discipline cards, bright chapter headers and player cards.
2. Navigation grouped by Compete, Improve and Progress. Searchable native jump dialog with Ctrl/Cmd+K, arrow navigation, Escape and focus restoration. Direct lobby routes to Season and Tournaments.
3. Selection feedback, a pointer-responsive illustration, card interactions and refreshed rank celebrations. Motion is guarded for reduced-motion preferences.
4. Thirteen arcade sound cues using pulse, triangle and restrained chip harmonics. Persistent volume, immediate mute, a sound-preview menu and existing event semantics preserved.
5. Single-file preview builder embeds the new stylesheet and illustration. Contrast validation reads the final stylesheet tokens; rank text lifting accounts for the brighter controls.

## Higgsfield asset provenance

- Local asset: `src/app/renderer/assets/arcade-duel.webp`.
- Job: `27d831df-4d54-42cb-b652-40cea89c0b6b`; request: `b22b4597-33ca-4b2a-91d0-4d966d2735c1`.
- Prompt requested opposing coral and mint mechanical target discs, an acid-lime hit marker, painted resin, screenprint texture and a midnight-petrol background, with no text, watermark, neon glow or glossy liquid shapes.
- The generation UI reported Nano Banana Pro. Configuration requested Nano Banana 2, so model-override behavior was not assumed. Result was a portrait composition despite the square prompt; the app deliberately crops it into its poster card.
- Visually inspected the result and the local WebP before integration. The image is decorative and hidden from assistive technology; all interactive controls remain HTML.

## Verification

Passed: TypeScript typecheck, renderer syntax, app build, preview build, sound/theme/presentation/counter validators and look audit. The final Electron smoke test passed with an isolated profile and real local run data after the layout and pointer-motion changes. The last tournament CSS refinements were rebuilt and visually checked afterwards. `git diff --check` passed.

Browser QA: all nine player screens inspected at 1440x1000; all nine fit 390x844 without horizontal page overflow. At 940x640 the primary queue action remains fully visible. Checked discipline selection, labeled synthetic example matchmaking, tournament detail, command search/Enter, Ctrl+K, arrow wrapping, empty search, Escape focus restoration, volume persistence and mute persistence. The sound menu also fits 390px. No browser warning/error logs observed. Temporary viewport override reset; the preview is left on Play arena.

Audio QA: rendered all 13 cues to WAV using OfflineAudioContext in Electron at the default 65% volume. No clipping; routine controls are quieter than run cues, which are quieter than match celebrations. This is measured verification, not a claim of subjective listening. WAV evidence is local and ignored at `.cache/arcade-sound/`; the temporary audio-rendering profile was removed.

The desktop smoke exercised boot, stats loading (13,156 runs), 256 scenario rows, 64 families, 24 band cards, navigation, duel and tournament bridges, sign-in controls, failure banners, editor wiring and preload. It surfaced an existing Electron console-message API deprecation, with no smoke failure.

Source and built illustration SHA-256 match: `0807A8A3E68C51D6E0AEC67FC41544DA1A0056AAD473F9197DD5F86D023A1DA1`.

## Review

- Open `http://127.0.0.1:4175/apogee-ui-preview.html` while the local preview server is running, or open `tools/apogee-ui-preview.html` directly. The HTML embeds the stylesheet, script and image.
- Run `npm.cmd start` from `E:/Desk2p/VSCode/aim-arena` for the desktop app with live account and matchmaking support.
- Try the discipline selectors, Ctrl+K jump menu, SFX previews and volume control, Season, Last match and the example tournament bracket. Preview opponents and matches remain explicitly labeled examples.
- No implementation blockers remain. Changes are local and uncommitted. The continuation heartbeat is paused now that the requested work is complete.

Evidence limits: live Steam sign-in, real matchmaking and online settlement were not exercised. Reduced-motion code paths and validators were inspected, but OS-level reduced-motion behavior has not been manually exercised. No release, deployment, push or core ranked-game behavior change is part of this work.
