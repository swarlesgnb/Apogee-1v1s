# Social: Apogee Daily, challenge links, open challenges, Discord presence

Branch `fleet/social`. Every session should produce something worth posting, and every
post should carry a way in that works at a population of one. Four pieces do that:

| Piece | Works signed out | Works with nobody else online | Moves rating |
|---|---|---|---|
| **Apogee Daily**: one seeded draw per band per day, spoiler-free share text and image, streak, server board | yes (board needs sign-in) | yes | never |
| **Challenge links**: `apogee://` deep links, an https landing page, a confirm-first prompt | the prompt and the Daily link, yes | yes | never |
| **Open challenges**: a duel addressed to a code instead of a name | no (Steam identity) | yes: you play first | never (answers are unrated) |
| **Discord Rich Presence**: opt-in, off by default | yes | yes | n/a |

Rivals (the stretch item) was not built; see the last section.

## Why these, with the numbers

`docs/overnight/mechanics.md` scored "share cards + challenge links" 12 of 20 and held it
back for one reason: a recipient needed install, sign-in, 50 uploaded runs and the Apogee
scenarios before they could play anything. The Daily removes that wall. It needs a stats
folder and nothing else, so a link a friend clicks lands them in today's three whether or
not anybody else is online, signed in or not.

The same document measured that Season 1's pool is nearly unplayed: of 164 scenarios, 9 had
the five runs a baseline wants, and an outside player arrives with none. So the Daily uses
ranked's own baseline rule (PLAN.md §3 as settle-match applies it) rather than inventing
one: the median of up to 50 earlier runs, provisional under five, and with no earlier run
the run stands as its own baseline. That last case is the common one at launch, so it gets
its own glyph (○, "first run: sets your baseline") and stays out of the mean, instead of
reading as a "near" that compares nothing with nothing.

"Near" is ±1%. The baseline is a median measured to centre genuine runs at +0.4% with 58%
above (README, "The baseline, corrected by measurement"), so ordinary runs land a few
percent either side; 1% separates a level day from a good or bad one without swallowing
either.

## Apogee Daily

### Rules

- **One draw per band per day**: one Clicking, one Tracking, one Switching scenario from
  that band of the Season 1 pool, in that order, the same for everyone in the band. The
  share grid therefore always reads Clicking, Tracking, Switching without naming anything.
- **The day is a fixed UTC day, 08:00 to 08:00.** Not each player's local date: with local
  dates a player in UTC+14 starts tomorrow's draw 26 hours before a player in UTC-12
  finishes today's, so the draw is public for a day before part of the board plays it, and
  "today's players" has no single meaning. 08:00 UTC is 1 to 4am across North America and
  9 to 10am in Europe; the cost is a 5 to 6pm change in Asia and Oceania. The app shows a
  countdown, so nobody needs the rule. Daily #1 began 2026-10-01 08:00 UTC
  (`DAILY_EPOCH_MS`); move it before release if the numbering should start at launch.
- **The first run on each of the three inside the day counts**, read from the stats folder
  like everything else. Later runs are practice. No Start button and no clock: it is a
  daily, not a match.
- **The streak counts daily numbers, not calendar days**, in any band, alive until a day is
  missed. A flight, a time zone or a daylight-saving change cannot break or pad it, and one
  local evening can legitimately hold two dailies (validate:daily shows a Honolulu evening
  and a Tokyo afternoon doing exactly that).
- **Never rated.** Nothing in rating, matchmaking or settlement reads `daily_results`.

### The seed, and the preview trade-off

`drawDaily(pool, seasonName, n, band)` is a pure function seeded with
`apogee-daily:v1:<season>:<n>:<band>` through the same `seededRandom` matches use, over the
pool sorted by code unit (so Node and Deno order it identically). The client draws offline;
the server draws the same three to check an entry.

What this does not hide: anything an offline client can draw today it can draw for
tomorrow, and the source is public, so a determined reader can compute future draws. No
secret is kept, because a secret kept from an offline client is not one. What is held:

1. The app never shows a draw before its day begins. Its only entry point is
   `dailyFor(pool, season, now, band)`, which takes the clock; the renderer's `daily()`
   takes no argument. Preview window in the app: zero.
2. The server refuses a board read or an entry for a day that has not started (422).
3. An entry is the first run on each scenario played inside the day, so practising
   tomorrow's three today earns nothing on tomorrow's board directly.
4. The baseline is built from runs before the day began, so practice before the day raises
   the bar the day is measured against. Advance practice partly cancels itself.

Nothing is rated and the board is a percentile within a band, so a preview is worth roughly
what warming up on three scenarios is worth. A server-salted draw was considered and
rejected: it would split online and offline players onto different dailies, which breaks
"the same for everyone in the band".

### Share text and image

```
Apogee Daily #3 · Intermediate
▲ ▼ ▲  −4.5%
Streak 4 · provisional baselines
https://swarlesgnb.github.io/Apogee-1v1s/c/?daily=3&band=intermediate
```

Geometric shapes rather than coloured squares (▲ above, ◆ near, ▼ below, ○ first run), so
the grid survives colour blindness, plain-text channels and monospace fonts. No scenario
name, family, label or score appears; validate:daily builds 256 texts and checks each
against all 164 scenario names, families and labels.

The image goes through the existing card renderer (`src/app/shareCard.ts` with a new
`daily` source) as a plain variant: rounds labelled Clicking / Tracking / Switching, deltas
without raw scores, the season rank emblem, "Apogee Daily #3 · Intermediate" as the kicker.
It still prints the renderer's match furniture ("Recorded", "raw score not sent", an
empty opponent column). The data is right and the drawing is meant to be replaced by the
brand kit's daily card kind at integration: swap `DailyService.shareCardInput` to emit
`kind: "daily"` once that kind exists. `src/core/brand/shareCard.ts` was not edited.

### The board (signed in)

A finished day is posted automatically when signed in (`daily-submit`), and a day finished
signed out is posted once the player signs in. The server does not take the client's word
for anything: it draws the day again from `season_scenarios`, re-verifies the three CSVs
through post-ghost's parse-and-verify path, requires each run to have ended inside the day
and to be the first stored, non-rejected run on its scenario inside the day, and rebuilds
each baseline from runs that ended **and reached the server** before the day began, with
the verified-PB floor. That last condition means history uploaded during the day,
backdated or not, cannot lower the bar (the harness plants ten such runs and shows they are
ignored). The first entry for a day and band stands.

`daily-board` returns a distribution: how many played, how many are placed, the middle
half, the caller's rank and percentile (ties count half), and the server streak. Never a
name, id or another player's entry. Alone on the board: "You are the first in
Intermediate today."

## Challenge links

### Grammar (`src/core/social/deepLinks.ts`)

```
apogee://duel/<code>              open challenge
apogee://ghost/<code>             race a ghost card's code (existing ghost-link feature)
apogee://daily[/<n>[/<band>]]     the Daily, optionally a number and a band
```

A code is eight letters of the ghost-code alphabet (no 0, O, 1, I, L); a number is 1 to
99999 without a leading zero; a band is one of four words. One trailing slash is forgiven.
Everything else is refused before any part is used: unknown verbs, queries, fragments,
percent-encoding, backslashes, whitespace, control and non-ASCII characters, traversal,
anything over 128 characters. validate:links lists 63 refused shapes, including quoted
switch injection, homoglyphs, `file:` and `javascript:`.

### What a link may do

Only propose. `src/app/social.ts` receives links from the first launch's argv, from the
argv a second launch hands over through `second-instance`, and from macOS `open-url`; it
parses, then shows a prompt. The renderer confirms by proposal id and nothing else, so it
cannot substitute a code. A daily link only navigates, and if it names another band the
Daily screen offers the switch rather than making it. A refused link leaves a notice that
names the rule it broke and never echoes the text. Link text never reaches a shell,
`shell.openExternal`, a file path or `eval`; validate:links reads the source to hold that.

From argv, only arguments starting with `apogee:` are considered, among the first 64;
exactly one is honoured, and two or more are all refused as hand-built.

### Registration

`electron-builder.yml` gains `protocols` (macOS Info.plist, Linux desktop file). On Windows
the packaged app calls `app.setAsDefaultProtocolClient("apogee")` at first launch, since the
NSIS installer does not register handlers. Development builds never register, so `npm run
dev` cannot take the scheme from an installed copy; paste a link into **Links & Discord** at
the top of the app, or run `npx electron . apogee://daily`. Argument injection through a
Windows protocol handler (CVE-2018-1000006) is Electron's to prevent and is fixed in the
Electron this ships; the parser adds its own refusal of spaces and quotes.

### https fallback

Social sites do not make `apogee://` clickable, so posts carry
`https://swarlesgnb.github.io/Apogee-1v1s/c/?duel=CODE` (or `?ghost=`, `?daily=3&band=…`).
`npm run build:site` now also writes `site/c/index.html`: a static page that reads the query
with the same grammar (bundled), explains the link, and offers **Open in Apogee** (its href
is the canonical link built from the parsed values) and **Download**. CSP `default-src
'none'`; text only, never markup. The base URL is `LANDING_BASE` in deepLinks.ts; change it
there if the site moves.

## Open challenges

A named duel is rated because both people agreed to it by name. An open link invites
answering from an alt account and losing on purpose, so every answer is **unrated**.

- **Post** (`open-duel` `create`, the **Open challenge** panel on the Play screen): the same
  seeding match send-duel makes, plus a `duels` row with a code and no named opponent. You
  play first. The poster meets the queue's eligibility bar, since their three join the pool
  like any seeding run set.
- **Look up** (`view`): who sent it, category, band, whether it can be answered yet, how
  many have answered. Never the poster's score, for PLAN.md §6's reason.
- **Answer** (`accept`): an unrated (`matches.rated = false`) two-sided match against the
  poster's frozen side, once per answering player, up to 200 answers. Settlement runs as
  ever and skips every rating write; the result says "Unrated: this was an open challenge."
  Answering does not require 50 uploaded runs: nothing it does is rated or enters the pool.
- **Refusals**, in order: your own code, taken back, expired, poster left their own match,
  poster still playing, already answered, full.
- **Database guard**: a trigger on `open_duel_answers` refuses an answer whose match is
  rated or whose answerer is the poster, whatever a function does; `duels_named_or_open`
  makes a duel either named or coded, never both.
- **After your three settle**, the result screen offers **Copy challenge link**, and the
  share card's existing open-duel slot carries the code ("Beat this").
- The poster's list shows answers and how they went (`mine`).

## Discord Rich Presence

Off by default; turned on in **Links & Discord**. Implemented over Discord's local IPC
socket with Node's `net` (no dependency): `discord-ipc-0..9` as a named pipe on Windows or
a unix socket (runtime dir, Flatpak and Snap paths) elsewhere, 8-byte little-endian
header plus JSON, handshake `{ v: 1, client_id }`, then `SET_ACTIVITY`.

Inert unless both the build has `APOGEE_DISCORD_CLIENT_ID` (baked in by build:app; see
SETUP.md and .env.example) and the player opted in. Without the id the toggle is disabled
and no socket is ever opened.

What friends see: "In a ranked match" / "In a duel" / "In an open challenge" / "In a
tournament match" / "Racing a ghost" / "Playing Apogee Daily #14", the category or band,
and an elapsed timer. Never a score, rating, rank, opponent or code; a category with
characters no season name has is dropped rather than sent. PRIVACY.md says the same.

## How it was tested

| Command | Result |
|---|---|
| `npm run validate:daily` | 71 of 71: day boundaries; a filename lands on the same daily on the client parse and the server's `wallClockToInstant` in 9 zones (63 of 63); identical draws across 9 process time zones, from the season file and from `season_scenarios` rows in three database orders, 400 days × 4 bands; band separation; no preview; result rules; streak across Honolulu, Tokyo, London-at-DST, New York and Sydney; 256 share texts with no names; board maths |
| `npm run validate:links` | 160 of 160: 10 valid forms with round trips through both spellings, 63 refusals, 14 argv cases (first launch, second-instance with Chromium switches, two links, injected switch, 70 arguments), 16 pasted/https cases, open-challenge view and refusal order, source checks on sinks and confirm-by-id |
| `npm run validate:presence` | 27 of 27, against a fake Discord on a unix socket: inert without an id and when off, handshake, send-after-READY, no resend when unchanged, PING/PONG, clear on opt-out, oversized frame dropped |
| `npm run validate:social-functions` | 35 checks. The shipped `daily-submit`, `daily-board`, `open-duel`, `settle-match` and `list-duels` handlers bundled from source against PGlite with every migration, the seed and the Season 1 pool; only identity, transport and the network client stubbed; the real rate limiter. Server glyphs and mean equal the client's evaluation of the same history; 11 refusals leave no row behind; a Chicago player's wall clocks land on the right instant; band separation; open answers are unrated and settle without moving any rating or writing rating history; own-answer refused; two racing answers from one player leave one match; list-duels unaffected; the 21st call in five minutes is a 429 |
| `npm run attack:rls` | no holes; 7 new attacks (write, raise or delete a board entry; post an open challenge directly; convert one into a named duel; record an answer directly; flip an answer match to rated) and 3 new reads |
| `npm run validate:schema` | passes with migration 024 |
| `xvfb-run -a npx electron tools/socialUi.cjs --no-sandbox` (`npm run validate:social-ui`) | the real bundled client on a synthetic stats folder: first launch from a challenge link shows the signed-out prompt; the Daily at one of three; two runs copied in while the watcher runs complete it; share text has no names; the card renders; **a second launch with a daily link reaches the first instance through Electron's lock** and offers the band switch without making it; a refused link from a second launch leaves a notice without echoing it; no renderer errors |
| `npx tsc --noEmit`, `git diff --check` | clean |
| `validate:share` (Xvfb) | passes: the existing match and ghost cards are unchanged |

Every suite the brief lists as passing still passes. `validate:quests` gets further than the
baseline did (the git-history error is gone) and fails on "real history was readable",
which needs the owner's stats folder.

Screenshots: `scratchpad/shots/social/` (13 app screens, both card layouts, three landing
page states). Pictures named `painted-*` are signed-in states painted by sending the window
the shapes main sends, because Steam sign-in and a deployed backend are not available here.

## Deployment order

1. `npx supabase db push --yes` (migration `20261003000024_social.sql`: `daily_results`,
   `duels.code`, `open_duel_answers` and its trigger).
2. `npm run deploy:functions` (adds `daily-submit`, `daily-board`, `open-duel`; also
   redeploys `list-duels`, which now lists named duels only, and `settle-match`, whose
   unrated explanation now names open challenges).
3. `npm run verify:deployment` (the three new functions are in its anonymous-refusal list).
4. Optional: set `APOGEE_DISCORD_CLIENT_ID` in `.env` and upload an `apogee` art asset.
5. `npm run build:app` / `npm run dist`, then `npm run build:site` and publish `site/`
   including `site/c/`.

The client degrades plainly before step 2: the board says it is not live yet and keeps the
result on the PC; open challenges say they are not live.

## Files others are likely to touch

`src/app/main.ts` (one import, the `installSocial` block after `shareCards`, one line in
`onRun`, `recordSettled` gains a fourth argument, `second-instance` takes `argv`, a new
`open-url`, two lines after `createWindow`, one in `window-all-closed`);
`src/app/preload.cjs` (eight methods at the end); `src/app/renderer/index.html` (a Daily
tab after Play arena, which renumbers the keyboard shortcuts after it, one screen section,
two stylesheets, two scripts); `src/app/api.ts` (`callFunction` exported, `FoundMatch.duel`
gains `code/open/unrated`); `package.json` (four validators in the chain, the deploy chain,
`validate:social-ui`); `supabase/functions/_shared/rateLimit.ts` (three limits);
`tools/verifyDeployment.ts`; `src/app/shareCard.ts` and `src/core/brand/shareInput.ts`
(a `daily` source; `duelCode`/`openChallenge` on `MatchRecord`), which the brand designer
is also extending; `supabase/functions/settle-match/index.ts` (one line);
`supabase/functions/list-duels/index.ts` (one filter); `tools/buildSite.ts`;
`tools/buildApp.mjs`; `electron-builder.yml`; `tools/attackRls.mjs`;
`src/app/ghostService.ts` (a `presence()` accessor). The synthetic fixture commit from
`fleet/flow` (d95382b) is cherry-picked here and will merge cleanly with that branch.

## What this does not do

- **Rivals** was not built. It is the stretch item, and mechanics.md already measured why
  it can wait: a rival needs head-to-head history in `match_sides`, of which there is none
  while no contested match has settled (it scored 1 of 5 for cold start). Built now it
  would be an empty panel on every profile. The read is one query over `match_sides` once
  there are contested matches, and the challenge button can reuse `send-duel`.
- **The share image is the plain variant** described above.
- **Future draws are computable from the source.** See the seed section.
- **The server cannot see an attempt that was never uploaded.** A modified client that
  holds back its first try and posts its second is not caught (the same limit post-ghost
  documents). The app uploads history as runs land, which is what makes it visible.
- **Locally, a run that ended early still counts as the day's first run.** History carries
  no durations; the server refuses a day with an abandoned first run, so such a day stays
  off the board.
- **The poster is not notified** when somebody answers; the Open challenge panel lists
  answers and results when it is next drawn.
- **Protocol registration and Discord were tested on Linux only**: registration logic on
  Windows and macOS follows Electron's documented calls but was not run on those systems,
  and presence was tested against a fake Discord, not the Discord client.
- **The board is read whole** (up to 10,000 rows a band a day). Fine at Apogee's size; an
  aggregate is the next step if a band ever gets busy.
