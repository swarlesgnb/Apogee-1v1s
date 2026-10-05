# Brand kit

Everything under `assets/brand/` is generated. Nothing in it was drawn by hand, and
nothing in it holds a colour, a mark or an insignia that the client does not already
ship.

```
npm run brand          lockups, palette, emblems, hero, store art, then the share cards
npm run brand:cards    share cards only: the built-in samples, or one result file
npm run brand:cards -- path/to/result.json
```

Both run in under a minute and need no network. `brand` exits non-zero if any
ink/ground pair in either palette falls under its contrast floor, if text leaves a canvas,
if a font fails to load, or if a PNG comes out the wrong size.

A rerun reproduces every SVG byte for byte and every PNG except the four trimmed lockups,
which can move by a few bytes: their viewBox is shrink-wrapped to the drawing, so they
are scaled by a non-integer factor and Chromium's text anti-aliasing is not stable
between runs at that scale. Discard those diffs unless the SVG beside them changed too.

## What is in it

| Path | What |
|---|---|
| `logo/horizontal-{dark,light}` | Mark and wordmark on one line. 1200px wide PNG, transparent. |
| `logo/stacked-{dark,light}` | Mark over wordmark over tagline. 800px wide PNG, transparent. |
| `logo/mark-{dark,light}` | The mark alone in its 24-unit box. 512px PNG, transparent. |
| `palette` | Both palettes with hex and contrast, the type, and the eight tier colours. |
| `emblems/{dark,light}/N-name` | The eight rank insignia, 320x344 PNG, transparent. |
| `emblems/ladder-{dark,light}` | The season 1 ladder: insignia, names, bands, authored and drawn colours. |
| `readme-hero` | 1280x640, also the size GitHub uses for a social preview. |
| `store/header-920x430` | Steam header capsule. |
| `store/small-capsule-462x174` | Steam small capsule. |
| `store/main-capsule-1232x706` | Steam main capsule. |
| `samples/*` | Three share cards, chosen from the 28 renders in `.cache/brand/cards`. |
| `fonts/` | Barlow and Cascadia Mono, latin subsets, with their licences. |

"Dark" means *for a dark ground*: its ink is light. Every image has an SVG beside its PNG,
fonts embedded, so it renders the same in a browser, on GitHub or in an image viewer
with nothing installed.

## Where each part comes from

- **Colours.** The client's stylesheet tokens (`--ground`, `--panel`, `--ink`, `--brand`,
  `--up`, `--down` and so on), read in load order with the last declaration winning,
  exactly as `buildIcon.mjs` and `validate:theme` read them. `tools/brand/kit.ts`.
- **Tiers.** `data/apogee_ranks.json` through `loadRankTheme()`, the file the client ranks
  players with. The build stops if `data/seasons/season-1.json` names or colours the eight
  overall tiers differently.
- **Insignia.** `badge()`, sliced out of `src/app/renderer/renderer.js` the way
  `validate:theme` slices the theme section. Redraw the in-app insignia and every emblem,
  card and capsule follows on the next run.
- **Mark.** The rail's path, `m3 20 9-17 9 17M3 20l9-6 9 6M8 11h8M12 3l0 11`, which
  `buildIcon.mjs` already checks every copy in the app against.

## The share card

`src/core/brand/shareCard.ts` is a pure function from a `ShareCardInput` to SVG, with no
Node or DOM imports, so the client can call it later from the settle screen with the
result it already holds. It takes the palette and the insignia as arguments rather than
reading them, for the same reason. Two layouts: 1200x675 (the 16:9 X, Discord and Reddit
crop a link preview to) and 1080x1920 (a phone story).

What it always shows, because PLAN.md §15 answers "I scored more and lost" with raw
scores, baselines and deltas on every result screen:

- every round's raw score, baseline and delta for both players;
- the round result, with the labels the client's `roundPresentation()` uses, and exact
  equality for a draw, so a card can never call a round differently from the settle screen;
- when two deltas round to the same figure but are not equal, both print with more
  decimals: a lost round shown as +0.4% against +0.4% looks like a bug;
- one line saying what decides a round.

There is a slot for a duel code. Duels have no shareable code yet (PLAN.md §6 addresses
them by player id), so the slot is drawn only when a code is passed; a seeding run with a
code becomes an open challenge headed "Beat this".

Names and scenario labels are measured once the fonts are really loaded:
`FIT_TEXT_SCRIPT` shrinks anything over its width budget to at most 70% of its size and
then truncates it. Small labels carry `data-fit-min` at their own size and are only cut,
because a 32-character name shrunk into a column header came out at 9px.

The samples are built from `data/snapshot.json`: scenario names, the player's raw scores,
rating, percentile and tier are real. The opponent's side and the baseline at the moment
of play are constructed as `snapshot.ts` constructs its demo opponent, and then every
verdict, delta and match score comes from the real `settleMatch()` and every rating change
from the real `updateRating()`. The seven cases are chosen to break the layout: a loss on
more raw points, a win, a near-draw, a seeding run, a promotion, a placement, and a
32-character name against 43-character scenario labels.

The three committed:

1. `defeat-more-points-landscape-dark`: more raw points on every round and still a
   loss. If the card makes that make sense, it does its job.
2. `promotion-portrait-dark`: a promotion is what people post, and a story is where.
3. `victory-landscape-light`: the light palette, on the result a player most wants to share.

## Rasterising

`tools/brand/rasterize.cjs` runs in Electron, already a dependency, which lays type out
with the engine the client uses. Each SVG is laid out inline, fitted, then drawn onto a
canvas of exactly the target size. A canvas rather than `capturePage()`: Windows clamps
even an offscreen window to the screen, and the 1920-tall story card came back cut to the
work area. The canvas path is also the one the client would use to export the same card.

## Design rationale

**Extend, don't invent.** The client's cosmic theme is a dark mineral ground, pale
ceramic inks, one pale chartreuse brand colour, hairlines at 14% and the atlas plates'
devices: square stars, corner registration marks, thin orbits. The kit uses those and
nothing else. There are no glows, no glass and no gradients beyond the single corner wash
the client's own `body::before` paints.

**The orbit.** Apogee is the point of an orbit farthest from what it circles. The hero
and capsules draw the ladder as one: eight insignia rising along the upper half of a
tilted ellipse, growing as they climb, with Supernova beside a point at the far end of the
major axis. Insignia are spaced by distance along the path, not by angle, because equal
angles bunched the top three together at the end of a tilted ellipse, and they shrink
together if the two largest would touch. The small capsule keeps only the orbit and its
point: at 462x174 the insignia are smudges and crowd the logo.

**The lockup.** The mark's feet sit on the wordmark's baseline and its peak a little over
the cap height. The rail's own ratio (a 31px mark beside 29px Bahnschrift) was tried first
and made the mark the loudest thing in every lockup, because Barlow's lowercase is smaller
on the body than Bahnschrift's.

**The light palette.** The client has no light theme, and a card still needs one for a
light Discord or a forum post. Each dark token is carried onto `LIGHT_GROUND` (the light
ground `contrast.ts` already defines for screenshots and the web) with hue and saturation
held and lightness lowered until it clears 4.5:1. The first cut used `legibleOn`, the
rank sheet's lift, which mixes toward the other ground; every chrome token is a pastel,
and mixing a pastel toward near-black lands in grey, so Victory came out #5a716c and read
as disabled. Rank colours still use `legibleOn` against the surface they sit on, as the
client and the rank sheet do, so a tier looks the same in the kit as in the app.
`paletteChecks()` lists every pair a card sets text in, and `npm run brand` fails on any
under its floor. At the last run all 22 cleared on both themes.

**Two tiers look alike on paper.** Stargazer (#00eaea) and Quasar (#00ffff) are nearly the
same cyan as authored, and on the light ground both land near #0a7176. That is in the
season's colours, not the kit; the ladder sheet shows both the authored and the drawn hex,
so it is visible to whoever next edits the season.

## Fonts and licences

| Face | Used for | Licence | Source |
|---|---|---|---|
| Barlow 400, 500, 600 | wordmark, headlines, names, scenario labels | SIL Open Font License 1.1 | `@fontsource/barlow` 5.3.0, latin subset |
| Cascadia Mono 400, 600 | figures, labels, captions | SIL Open Font License 1.1 | `@fontsource/cascadia-mono` 5.3.0, latin subset |

Both licences are in `assets/brand/fonts/`. The OFL allows bundling, embedding and
redistribution with software under any licence, AGPL included, provided the fonts are not
sold on their own and keep their licence. The client sets Bahnschrift, a Windows system
font that may not be redistributed; Barlow is the open grotesk closest to it, both
descending from DIN 1451. Cascadia Mono is the client's own mono face. Names outside the
latin subset fall back to system fonts through the font stack.

## What this does not cover

- Nothing here is wired into the client yet. The share card is ready to be called from
  the settle screen; that is a separate change under `src/app/`.
- Steam's library assets (hero, logo, library capsule) and the Workshop preview are not
  in the kit. The Workshop previews already come from `npm run workshop:previews`.
- The app icon is still `npm run build:icon`, which writes to the ignored `build/`.
