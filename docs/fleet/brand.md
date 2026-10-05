# Brand: the new mechanics, their share cards, a marketing kit and motion cards

Branch `fleet/brand`. Everything here is generated from code, like the rest of
`assets/brand/` ([docs/overnight/brand.md](../overnight/brand.md)): nothing was drawn or
exported by hand, and a rerun of `npm run brand` redraws all of it.

```
npm run brand              the whole kit: lockups, emblems, palette, store art, mechanics,
                           marketing, motion, then every share card
npm run brand:mechanics    the seven glyphs, their sheet, and the renderer's copy of them
npm run brand:marketing    the marketing kit, from the committed product shots
npm run brand:shots        photograph the real renderer again, then the marketing kit
npm run brand:motion       title cards, lower thirds, tools/video/mechanics.json
npm run brand:cards        every share card sample (result cards and mechanic cards)
npm run brand:contact      contact sheets of all of it, into .cache/brand/contact
npm run validate:brand     the checks below; on Linux run it under xvfb-run -a
```

## What was built

| Path | What |
|---|---|
| `src/core/brand/mechanics.ts` | The seven glyphs (Shadow, Flag, Daily, Challenge link, Crown, Draft, Live race): a 24-unit icon and an 80-unit emblem each, with the name and one line of copy. The only place a glyph is drawn. |
| `assets/brand/mechanics/icons/<id>.svg` | The icon sources, `currentColor`. |
| `assets/brand/mechanics/icons/{dark,light}/<id>-{16,24,32,48}.png` | Rasters at each size. |
| `assets/brand/mechanics/emblems/{dark,light}/<id>.svg/png` | The emblems, 320 px, transparent. |
| `assets/brand/mechanics/sheet-{dark,light}` | Every icon at its real sizes beside its emblem, name and line. |
| `src/app/renderer/mechanic-icons.js` | `window.mechanicIcon(id)` and `window.mechanicEmblem(id)` for the renderer, generated. Loaded in `index.html`'s head and inlined by the preview builder. |
| `src/app/renderer/assets/icons/<id>.svg` | The same icons as files, for an `<img>` or a paste. |
| `src/core/brand/mechanicCards.ts` | Four new share-card kinds: **Daily**, **Crown** (taken or defended), **Flag answered**, **Shadow placement**, at 1200x675 and 1080x1920. |
| `src/core/brand/shareInput.ts` | The record and input types for those cards and the adapters that turn one into the other. |
| `src/app/shareCard.ts` | Main keeps the mechanic records and draws the cards through the existing hidden-window path. |
| `assets/brand/samples/` | Eight new samples: one of each card, both shapes, both themes across them. |
| `assets/brand/marketing/` | Open Graph, X header, Discord icon and banner, two YouTube thumbnails from one template, a square announcement, a "what's new" poster, a README hero with a real product frame. |
| `assets/brand/marketing/shots/` | Three photographs of the real renderer that the marketing images use. |
| `assets/brand/motion/<id>/` | A 16:9 and a 9:16 title card and a transparent lower third per mechanic. |
| `tools/video/mechanics.json` | A ready `shots.json` scene and a caption step per mechanic. `card.html` gained a `glyph` field; `record.cjs` inlines the emblem for it. |
| `tools/brand/checks.ts`, `rasterize.cjs` | The rasteriser now measures every piece of text it draws; the checks hold it to safe areas, collisions and contrast. |

## The glyphs

The icons are drawn exactly like the rail's own: a 24-unit box, stroke 1.65, round caps and
joins, no fill, `currentColor`. The only fills are where a shape will not read without one
at 16 px (the eclipse's shadowed crescent, the race's runners), and they are `currentColor`
too, so every icon stays one colour that CSS sets. `validate:brand` fails on any hard-coded
colour in a glyph.

| Id | Name | Drawn as | Why |
|---|---|---|---|
| `shadow` | Shadow | An eclipse: a body and its equal behind it, the hidden arc dashed | A Shadow is an opponent of your own size, and an eclipse is literally a shadow. The ghost shape already belongs to Ghost Mode. |
| `flag` | Flag | A swallowtail pennant on a planted pole | A planted, standing challenge. |
| `daily` | Daily | The sun on the horizon; the emblem adds the share grid's three marks | One per day; the marks tie the glyph to the card and the share text. |
| `link` | Challenge link | Two chain links | Recognised at a glance; the challenge is in the word beside it. |
| `crown` | Crown | A three-point crown on a band | King of the hill. |
| `draft` | Draft | Two cards, one ticked, one struck out | Pick and ban. |
| `race` | Live race | Two lanes with a runner each and a finish line | Both players at once. |

The emblems use the rank insignia's construction (`badge()` in renderer.js): stroke 1.4 for
outlines, 1.0 at half opacity for inner lines, faces filled in the insignia's steps of one
ink (.1, .17, .28, .48, solid), and the insignia's diamond pip. A rank insignia is a shield
because a rank is something held; a mechanic is a way to play, so its emblem sits in an
instrument dial instead: a ring, four registration ticks (the atlas plates' device), and
one body at apogee on the ring. Emblems are drawn in the brand colour, never a tier colour,
so a mechanic can never be mistaken for a rank.

Checked at 16, 24 and 32 px, pixel for pixel, on both grounds (contact sheet
`1-icon-pixels.png`). All seven read at 16 px; the Draft tick is the smallest detail (about
3 px wide at 16) and still reads as a tick beside the struck card. Like the rail's own
icons, a 1.65 stroke on whole-unit coordinates is soft at 24 px; matching the rail mattered
more than pixel-snapping one set.

### Using them in the renderer

```js
el.innerHTML = mechanicIcon("crown", { className: "nav-icon" });   // sized by the rail's CSS
el.innerHTML = mechanicIcon("flag", { label: "Flag" });            // announced, not decorative
empty.innerHTML = mechanicEmblem("shadow", { size: 96 });          // colour from CSS `color`
APOGEE_MECHANICS.names.race, APOGEE_MECHANICS.lines.race           // "Live race", its one line
```

Ids: `shadow`, `flag`, `daily`, `link`, `crown`, `draft`, `race`. The script is loaded in
`index.html`'s `<head>`, before any feature script, so it is there for every screen. The
CSP (`script-src 'self'`) allows it; nothing is fetched.

## The share cards

Same contract as the result card: a pure function from a typed input to SVG, no Node or DOM,
palette and insignia passed in, 1200x675 and 1080x1920, every name and label carrying a fit
budget. They are built from the result card's own pieces (lockup, sky, wash, registration
marks, orbit), and the two that print rounds use the result card's own round rows,
extracted into `landscapeRounds()` and `portraitRounds()` without changing a byte of the
existing cards (all 28 result-card SVGs were diffed before and after: identical).

Main owns every card. The engineer who owns a mechanic hands main a **record** (the facts
the server answered with); the renderer asks for the card by name, exactly as it asks for
`"match"`; main builds the input with the adapter and draws it. The renderer never sends a
figure. `SHARE_SOURCES` is now `match, ghost, daily, crown, flag, shadow`, so
`window.apogee.shareCard("daily", "portrait", "copy")` works through the existing IPC with
no preload change.

### What to call, per card

| Card | Record type (main builds) | Hand it to | Adapter (main calls it for you) | Input type (drawn) |
|---|---|---|---|---|
| Daily | `DailyRecord` | `shareCards.recordDaily(rec)`, or the `dailyRecord: () => DailyRecord \| null` dep | `dailyCardInput(rec, ctx)` | `DailyCardInput` |
| Crown taken / defended | `CrownRecord` | `shareCards.recordCrown(rec)` | `crownCardInput(rec, ctx)` | `CrownCardInput` |
| Flag answered | `FlagRecord` | `shareCards.recordFlag(rec)` | `flagCardInput(rec, ctx)` | `FlagCardInput` |
| Shadow placement | `ShadowRecord` | `shareCards.recordShadow(rec)` | `shadowCardInput(rec, ctx)` | `ShadowCardInput` |

All types and adapters are in `src/core/brand/shareInput.ts`; the drawing is
`mechanicCardSvg(input, options)` or `anyCardSvg(input, options)` (either kind of card) in
`src/core/brand/mechanicCards.ts`; `ShareCards.renderAny(input, layout)` in
`src/app/shareCard.ts` rasterises any of them. `shareFileName()` names them
(`2026-10-03-daily-3.png`, `2026-10-03-crown-taken.png`, `2026-10-03-shadow-placing.png`).

**Daily.** The fields are the Daily screen's (`DailyScreen` in the social branch's
`dailyService.ts`), so the record is one line there:

```ts
// dailyService.ts, replacing shareCardInput()'s drawing (its own comment asks for this)
shareRecord(): DailyRecord | null {
  const v = this.view();
  if (!v.complete) return null;
  return { number: v.number, band: v.band.name, marks: v.rounds.map((r) => r.glyph),
           meanDelta: v.meanDelta, streak: v.streak, provisional: v.provisional, date: localDay(this.now()) };
}
// main.ts, in new ShareCards({...}):  dailyRecord: () => daily.shareRecord(),
```

`DailyMark` is the social branch's `Glyph` exactly (`above`, `near`, `below`, `first`,
`pending`), drawn with the same shapes its share text uses: a triangle up, a diamond, a
triangle down, an open ring for a first run, a dashed ring for one not played. Shape first,
colour second, so the grid survives a colour-blind reader and a greyscale repost.
`DailyRecord` has no field a scenario name could go in; the card is spoiler-free by
construction, and `validate:brand` also searches every rendered daily card's markup for all
164 season scenarios and every snapshot label. The card carries no link: the landing URL is
about seventy characters, which no card can print legibly and no image can make clickable.
The text paste carries the link; the card carries the number and the band.

**Crown.** `CrownRecord.rounds` are `SettledRound`s from this player's side (on a defence,
you are the holder and your stored set is "you"). `band` is the Crowns screen's band name
("Intermediate"). The card says "unrated" in its kicker and its footer states the Crown's own
rule from the arena branch (`core/crowns`): the higher match score takes it and a tie stays
with the holder. Rounds still print won/lost, as every round row does.

**Flag.** From the planter's side: "Flag held" (win), "Flag lost" (loss), "Draw". Flags
settle for real, so a rating change prints when `rated` is not false. A void answer is
refused.

**Shadow.** `series` in play order; void matches are dropped, as they did not count. The
tier prints only once `series` reaches `of`: a tier before that would be a placement the
server has not made, so the adapter discards one sent early. Each Shadow's calibrated
rating is printed on its own tile. A one-match "series" (`of: 1`) is a single Shadow match.

Each adapter cleans what it is given (control characters stripped, names capped, counts
clamped) and refuses a record that cannot make an honest card, with a reason the renderer
can show: no number, nothing played, a mark it does not know, a defence with no
challenger, a void flag, more than ten placement matches, and so on.

## The palette fix this found

The new measurements caught a real bug in the existing light theme. Its inks were deepened
to exactly 4.5:1 against the bare light ground, but every card and sheet paints a corner
wash that darkens that ground, and the labels that sit in it (the top-right "Season 1" of
every light card, the ladder sheet's title) measured **3.9:1** under it. `lightPalette()`
now deepens against the washed corner instead:

| Light ink | Before | After | On the wash, before | After |
|---|---|---|---|---|
| inkDim | #596f8a | #51657e | 3.91:1 | 4.52:1 |
| brand | #68741a | #5d6818 | 3.87:1 | 4.59:1 |
| up | #297c56 | #25704e | 3.86:1 | 4.53:1 |
| down | #d91600 | #c51400 | 3.91:1 | 4.57:1 |
| warn | #886818 | #7b5e16 | 3.93:1 | 4.60:1 |

`paletteChecks()` now lists every ink on the washed ground too (34 pairs, up from 22), and
`npm run brand` fails if one drops under. The dark palette is unchanged (its wash lightens
a ground under light inks). Nothing in the client changes, since the client has no light
theme. These committed assets changed because of it, and only these:

| Asset | What changed |
|---|---|
| `logo/horizontal-light`, `logo/stacked-light`, `logo/mark-light` (SVG and PNG) | The mark's brand ink, #68741a to #5d6818; the stacked tagline's inkDim. |
| `emblems/ladder-light` | The title and band labels (inkDim), the lockup's mark (brand). Tier colours are unchanged: they are lifted against the bare ground, as the client and rank sheet lift them. |
| `palette` | The light row's swatches and ratios, which are this table. |
| `samples/victory-landscape-light.png` | Kicker and duel code (brand), Victory and the deltas (up/down), the small labels (inkDim). |

A side-by-side of the sample and the ladder, before (main) and after, is
`shots/brand/9-light-palette-before-after.png` in the fleet's shots directory: the change is
a slightly deeper ink, the layout is identical. Every other existing kit PNG is untouched
(see the last point under "What this does not do").

## Marketing kit

Every tagline is a statement the product makes true: "Ranked 1v1 for KovaaK's", "Scores
read from your stats folder, never typed in", "A round goes to whoever beats their own
baseline by more", "Free for Windows". No superlatives (`validate:brand` checks the copy).

| File | Size | Held clear of |
|---|---|---|
| `og-1200x630` | 1200x630 | 40 px margin. Usable as GitHub's social preview. |
| `x-header-1500x500` | 1500x500 | The avatar (bottom left) and the phone crop (80 px top and bottom). |
| `discord-icon-512` | 512x512 | The round crop; the mark alone reads at 48 px. |
| `discord-banner-960x540` | 960x540 | The server name Discord lays over the top 120 px. |
| `youtube-thumbnail-template-ranked` / `-mechanic` | 1280x720 | YouTube's duration badge, bottom right. `thumbnail({ kicker, title, shot \| glyph })` in buildMarketing.ts is the template. |
| `announcement-1200x1200` | 1200x1200 | 48 px margin. |
| `whats-new-1080x1350` | 1080x1350 | 48 px margin. Lists `FEATURED` only. |
| `readme-hero-1280x640` | 1280x640 | 40 px margin. |

**Product shots are photographs, not mock-ups.** `npm run brand:shots` builds the UI
preview (`tools/buildUiPreview.ts`: the real renderer on the committed
`data/snapshot.json`), opens it in Electron and captures the Play arena, Ranks and Last
match screens at 1440x900. Two differences from a Windows desktop: the preview's own
"Design preview" banners and scrollbars are hidden (the video pipeline hides the same
ones), and Bahnschrift, a Windows font that cannot be redistributed, is set in Barlow, the
open face the kit already uses in its place. The result screen keeps the app's own
"Example match · synthetic opponent" label. The mechanics built tonight appear only as
their glyphs and their one line, never as screens.

**Draft is not on any poster.** The arena branch built Crowns and Live race; Draft has its
glyph, emblem and motion cards (the brief asked for all seven) but `FEATURED` in
`buildMarketing.ts` leaves it out. Shadow and Flag are on the posters because the queue
branch owns them; if either does not merge, take it out of `FEATURED` and rerun
`npm run brand:marketing`.

**README hero.** `readme-hero-1280x640` puts a real product frame beside the lockup, with
the ladder in a row under the words. I think it improves on `assets/brand/readme-hero.png`
for a README, where people want to see the app, but the README belongs to the growth
phase, so the old hero is untouched and the README still points at it. Swapping is one
path in README.md.

## Motion

For the video producer ([docs/overnight/video.md](../overnight/video.md)):

- **Animated.** Add a scene from `tools/video/mechanics.json` to a cut in `shots.json`. It
  is a normal `card.html` card with one new field, `"glyph": "<id>"`, which `record.cjs`
  fills with the emblem from `assets/brand/mechanics/emblems/dark/`. The emblem leads the
  top row in place of the lockup and fades in with it. Each entry also has a `caption`
  step for `stage.js`, for the same words over app footage. Only add a mechanic that merged.
- **Stills.** `assets/brand/motion/<id>/title-16x9.png`, `title-9x16.png` and
  `lower-third.png` are `card.html`'s resting frame drawn as SVG (the same ground glow,
  orbits, vmin type sizes and brand rule), and a lower third on an opaque plate with the
  rest of the frame transparent, for an editor or an ffmpeg overlay.

`validate:brand` renders every `mechanics.json` scene through the real `card.html` at 16:9
and 9:16 and fails if the page throws, the glyph is missing, or the title had to shrink.

## How it was tested

| Command | Result |
|---|---|
| `npx tsc --noEmit` | passes |
| `xvfb-run -a npm run validate:brand` | passes: 68 mechanic card renders (17 inputs, both shapes, both themes) print the figures their input holds and stay in their margins with no collisions; 100 images measured for safe areas, overlap and contrast, lowest 4.22:1 on 24 px text (floor 3:1 for large text), every body-size line at 4.5:1 or more; 7 video scenes drawn by `card.html` in both shapes; 5 source and adapter check groups. |
| `npm run build:app && node tools/buildShareTest.mjs && xvfb-run -a npx electron --no-sandbox .cache/share-test.cjs` (validate:share) | passes: the original 4 renders and checks, plus all four mechanic cards in both shapes through `ShareCards`, refusals without a record, copy, and a void flag refused. |
| `xvfb-run -a npm run brand` | passes, 29 + 102 + 56 images, all checks clean |
| `git diff --check` | clean |
| Every suite the brief lists as passing (expedition, season, pool, thresholds, aimtypes, ranks, kovaaks, glicko, duels, tournament, playlist, live, schema, functions, sound, orb, theme, counter, progression, presentation, ranked-boundaries, background-refresh, attack:rls) | still pass |

The edge cases are in `tools/brand/mechanicSamples.ts`: 32-character names on both sides,
43-character scenario labels, a six-scenario daily with every mark kind, an all-first-run
daily, a ten-match placement, a vacant crown, 999 defences, a same-day draw on a flag, an
excluded round.

**What the checks are.** The rasteriser (`tools/brand/rasterize.cjs`) now measures every
`<text>` after fitting: its box in output pixels, its ink, and the least legible pixel of
what is drawn behind it, taken from the same SVG drawn again with its text removed, so a
wash, a panel or a photograph under a word is measured as it is. `tools/brand/checks.ts`
holds that to a safe inset per asset, platform zones (avatar, round crop, name overlay,
duration badge), no two text boxes colliding, and WCAG contrast through
`src/core/report/contrast.ts` (4.5:1 under 24 px, 3:1 above). `npm run brand` applies the
same checks to the mechanic sheet, the marketing kit and the motion cards on every run.

Contact sheets of everything, for review, are in the fleet's shots directory
(`shots/brand/1-icon-pixels.png` to `8-product-shots.png`); `npm run brand:contact`
rebuilds them.

## Deployment order

Nothing to deploy. No migration, no Edge Function, no server change.

## Files others are likely to touch (merge hotspots)

- `src/core/brand/shareInput.ts`: the social branch also edits it (`MatchRecord`'s
  `duelCode`/`openChallenge`, `matchCardInput`'s mode and code, and `SHARE_SOURCES`). My
  changes are all below `ghostCardInput()` except `shareFileName()`; `matchCardInput()` is
  untouched. Resolve `SHARE_SOURCES` to
  `["match", "ghost", "daily", "crown", "flag", "shadow"]`.
- `src/app/shareCard.ts`: social adds a `daily?: (ctx) => ShareCardInput` dep and a
  `"daily"` branch in `input()`. Take this branch's `input()` and wire the Daily with
  `dailyRecord: () => daily.shareRecord()` (snippet above). Social's `recordSettled()`
  signature change does not overlap mine.
- `src/app/renderer/index.html`: one `<script src="mechanic-icons.js">` in the `<head>`,
  away from the body script list other branches append to.
- `tools/buildUiPreview.ts`: one line in the preview's `<head>`.
- `package.json`: six `brand:*`/`validate:brand` scripts next to `brand:cards`, and
  `validate:brand` appended to the `validate` chain.
- `tools/video/card.html`, `tools/video/record.cjs`: the `glyph` field.

## What this does not do

- The mechanic cards are not yet called from the mechanics' screens: the records come from
  server responses on the other branches. The calls are the one-liners in the table above;
  the renderer side is the existing `shareCard(source, layout, action)` bridge.
- No share card for Live race or Draft (the brief asked for four kinds).
- The README is not switched to the new hero, and nothing is posted anywhere.
- The product shots are of the preview on Linux; a Windows capture would show Bahnschrift
  and Segoe UI rather than Barlow and the Linux fallback for body text.
- PNGs of existing kit assets whose SVG did not change were not recommitted: Linux and
  Windows Chromium anti-alias text differently, so a Linux rerun rewrites them with
  pixel-level noise only. Only assets whose SVG changed (the light palette) were committed.
  Measured on the final tree: a second `npm run brand` reproduced every file this branch
  adds byte for byte, and rewrote only 26 pre-existing PNGs (the dark and light rank
  emblems, ladder-dark, the dark lockups, the original README hero, the store capsules and
  the two dark result samples), none of whose SVGs changed; `git checkout --` restores them.

## Integration polish

Branch `fleet/polish`, after the queue, social, arena and brand branches merged. What the
seams between them needed:

- **The Shadow card says what the queue says.** It was drawn before the queue settled its
  design and printed "Shadow 1604" per match and a placed tier. A Shadow is a day at a stated
  percentile of genuine match scores, climbed on a seven-rung ladder, and moves no rating;
  the app shows a placement read-out after three results and no tier. The card now leads with
  the match just played ("Shadow beaten", "Shadow wins", "Level"), names the Shadow as the app
  does ("rylee vs a 63rd-percentile day"), gives each recent Shadow (up to the board's eight)
  a tile with its percentile and how it went, and prints the queue board's read-out in the
  app's words ("About the 71st percentile", "Placement from 6 Shadows"), or "1 of 3 Shadow
  results" with dashed "To play" tiles before it shows. The kicker says "synthetic, unrated";
  there is no tier or rating anywhere on it. `ShadowRecord` is now `{ series: { verdict,
  percentile, yourMatchScore?, shadowScore? }[], placement?, streak?, category, at }`.
- **Crown and Flag cards without rounds.** The queue board sends an answered Flag's two match
  scores, not its rounds, and a Crown defence reaches the holder as a notice. Both cards now
  draw two match-score panels (planted set and answer; holder and challenger) when no rounds
  were sent, and refuse only when neither rounds nor both scores exist. `list-crowns` now
  returns the two scores `crown_notices` already stores (the owner can read them under RLS
  anyway). The committed Flag and defended-Crown samples are drawn that way.
- **The cards are wired.** `src/app/shareRecords.ts` builds each record in main: a Shadow from
  settle-match's `shadow` body, completed by the queue board's ladder once the board counts that
  match; the newest answered Flag from the queue board; a Crown taken from settle-match's arena
  note (two scores instead of rounds when the Crown changed hands mid-match), a defence from the
  newest `defended` notice when it is newer than the Crown record held. Each record has a key;
  main pushes the keys as `apogee:shareRecords` (preload `shareRecords`, `onShareRecords`).
- **Share controls**, all through the one panel in `share.js` (`window.apogeeShare.panel()`):
  the result screen offers a card switch, Shadow or Crown first and Rounds second, when main
  holds that result's record; the Flags panel and the answered-Flag toast have Share for the
  newest answered Flag; a defence notice on the Crowns screen has Share.
- **Glyphs**: the Crowns tab, cards, notices and header emblem; the Shadow and Flag marks in
  `queue-board.js`; the Daily tab and kicker; the challenge-link icon; a race mark on "Race
  now". The rail's two tabs name their icon (`data-mechanic-icon`) and the generated
  `mechanic-icons.js` draws it, so `index.html` holds no copy of a glyph; it loads in the head
  of the app and of the preview.
- **Crowns notice said twice.** The "You lost the … Crown" banner is for a player on another
  screen; arriving on the Crowns screen, or dismissing the row, now takes it down, and the row
  with Challenge back stays.
- **validate:brand fails when its Electron children fail.** `app.quit()` exits 0 whatever
  `process.exitCode` says, so cardSmoke's and the rasteriser's FAIL lines left validate:brand
  green. Both now exit through `app.exit(status)`, and cardSmoke writes a result file the parent
  reads. Shown by forcing a cardSmoke failure (validate:brand exited 1, then reverted). The title
  fit check allows 1% (`window.__fit` 0.998 under load is a metric wobble) and prints the fit.

Tested: `npx tsc --noEmit`, `validate:brand`, `validate:share` (now also drives
`MechanicShares` with settle-match, queue-board and list-crowns shaped payloads),
`validate:queue`, `validate:crowns`, `validate:presentation`, `validate:theme`: all pass.
Screens photographed from the preview with a stub bridge (fleet shots `polish/`).

Not done: Discord presence states for Crown challenges, live races and Shadow matches; the
mechanic `line` for Shadow in `mechanics.ts` still says "A calibrated opponent at your rating",
which the queue's design contradicts (changing it reruns the sheet, motion and marketing kit);
the tracked `tools/apogee-ui-preview.html` is left for the PM to regenerate.
