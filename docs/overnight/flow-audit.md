# First-run and core-loop flow audit

Walked on `f853c20` in the real bundled client, with a throwaway profile each time:

```
npm run build:app
npx electron tools/flowScreens.cjs --fresh            --out .cache/flow/before
npx electron tools/flowScreens.cjs --fresh --no-stats --out .cache/flow/before
```

`tools/flowScreens.cjs` loads `dist/app/main.cjs` itself with `--fresh`, visits every tab,
and photographs each one (plus the lower half of any tall one). The signed-in loop cannot
be reached headlessly, because sign-in goes through Steam in a browser, so those states
are painted by handing the renderer the shapes main sends it: a session, an eligibility
answer, a seeding match built from the real draw for the selected category, and a settled
result. Those shots are named `loop-*`. The seeding result carries the explanation string
`settle-match` actually returns.

`npm run smoke` was also run; it walks its own probe path and passed before and after.

## How the ranking works

There is no telemetry and the population is zero, so "how many new players hit it" is
reasoned from which state each issue lives in, not counted:

- **Everyone**: any player who opens the app with a stats folder that is found. The
  season is on Apogee's own scenarios, so nobody arrives with baselines on them either.
- **Everyone who plays**: the first match of every player is a seeding match while the
  pool is empty.
- **Detection misses**: the stats folder is not where `findStatsFolder` looks (second
  Steam library, a non-default install), or KovaaK's is not installed yet.
- **Curious**: players who open a particular tab before they have a reason to.

## Findings, ranked

| # | Reach | What happens | Kind | Status |
|---|---|---|---|---|
| 1 | Everyone | The Getting started checklist sits below the queue stage, under the fold at 1280x820. `index.html` says it goes "above everything on the screen it gates"; `arcade.css` pins the stage and rank card to grid row 2 and leaves the checklist to auto-placement, which puts it in row 3. A new player meets "Sign in to queue" before the three steps that explain it. | Missing explanation | Fixed |
| 2 | Everyone | The rank card reads "Current rank Lunar" over "Next benchmark rank Lunar, 93% there" on the committed snapshot (Odyssey over Odyssey on the live corpus). Two ladders share one set of names: the big name is the population-percentile tier, the bar is the benchmark rank. Unlabelled, it says the player is climbing towards where they already are. | Confusing state | Fixed |
| 3 | Everyone | "Baselines on only 0 of 6 scenarios ... Play a few runs on those first." No button, and the six are named only in a folded panel at the foot of the page whose rows have nothing to press. Season 1 is Apogee's own scenarios, so this is the state every new player is in. | Dead end | Fixed |
| 4 | Everyone who plays | The first result plays the losing sting. A seeding set has `verdict: null`, and the sound choice fell through to `"defeat"`. A void did the same. While the population is zero, every player's first result is a seeding set. | Confusing state | Fixed |
| 5 | Everyone | "Last match" before any match: a verdict panel reading "No matches yet" over a table of column headers with no rows, and no way back to the queue. | Empty screen, dead end | Fixed |
| 6 | Everyone | "0-day streak" is the first thing under the player's name in the rail for anyone who has not played today or yesterday. | Confusing state | Fixed |
| 7 | Curious | Tournaments, signed out: "Sign in to play. Sign in to see and join tournaments." with nothing to press; the only sign-in button is at the foot of the rail. | Dead end | Fixed |
| 8 | Curious | Quests says "Three for today" and "Clear all three"; 97cda0a moved the board to five, and a small pool can issue fewer. | Wrong copy | Fixed |
| 9 | Detection misses | "Couldn't find your KovaaK's stats folder" twice: once in a red error banner (with the error sound, on launch) and once in the card below it, beside a red "Problem" dot. The normal first-run state reads as a crash. | Confusing state | Fixed |
| 10 | Detection misses | Every tab but Mixtape and Expedition is greyed, and pressing one only moves focus to the Choose folder button. Nothing says the two lit tabs work now. From inside Mixtape or Expedition the focus went to a button that was not on screen, so the press did nothing visible at all. | Dead end | Fixed |
| 11 | Detection misses | The rail shows an empty bordered pill where the streak goes. | Empty screen | Fixed |
| 12 | Everyone | Play buttons for Season 1 scenarios deep-link into KovaaK's. The scenarios are Workshop items; a player who has not subscribed to them has nothing to open. What KovaaK's does with a deep link to a missing scenario was not checked: it needs a clean KovaaK's install, which this machine does not have. The Season screen's playlist install is the documented route (share codes are in the playlist JSON). | Possible dead end | Open, needs a clean install to measure |
| 13 | Everyone who signs in with fewer than 50 runs | Ranked stays closed until 50 runs are uploaded (`src/core/match/eligibility.ts`). The gate says so and counts down, and uploads by itself. Correct and explained; a real wall for a brand-new KovaaK's player. | Slow step | Out of scope (server rule) |
| 14 | Everyone | The match rows say "to beat 2,652" while the pool panel says "0 with a baseline". The first is the player's best, the second needs five runs; both are true, and they read as a contradiction. | Confusing state | Open |
| 15 | Curious | Host a tournament is fully interactive while signed out; the refusal only comes from the server on submit. | Extra click | Open |
| 16 | Everyone, signed out | The queue button says "Sign in to queue" with "matched on rating" beside it: `renderPool` repaints the sub-line after `resetCommit` wrote the signed-out one. | Wrong copy | Fixed |
| 17 | Maintainers | `npm run validate` is one `&&` chain, and `validate:standing` fails on `f853c20` ("a scored family earns points: 0.00": no graded variant has a sampled apex board yet). Every suite after it in the chain, twenty-two of them, does not run. Run one by one, the last of those, `validate:season-files`, also fails on `f853c20`, with the same ten out-of-range scenario parameters before and after this branch. | Hidden failure | Open; not a flow issue, recorded because it hides the rest of the gate |

## What was fixed, and where

1. **Checklist above the queue.** `src/app/renderer/arcade.css`: row 2 for the checklist
   while it is on screen, via `:has()`, so a hidden or finished checklist leaves the grid
   exactly as it was.
2. **One rank card, two named ladders.** `renderClimb` names the rank being climbed from
   ("Benchmark rank Lunar → Odyssey"), and the big name is labelled "Apogee ladder", the
   same two names the Ranks screen uses for the same two panels.
3. **The pool note leads somewhere.** A "Show which" control opens the Scenario pool panel
   and scrolls to it, and every row in that panel has a Play button (the same
   `playButton` the Season and Scenarios screens use).
4. **Seeding does not sound like losing.** Win plays victory, draw and void play the draw
   sound, loss plays defeat, and anything without a loser (seeding, a first tournament
   leg) plays the neutral confirmation.
5. **Last match before a match.** The empty table is hidden, and the result row carries
   "Go to the queue" in the place "Queue again" appears once there is a result.
6. **Streak copy.** Zero reads "Start a streak today"; an unfilled pill is not drawn.
7. **Tournaments sign-in.** The signed-out empty state carries a Sign in with Steam button
   that presses the rail's own, so the two cannot behave differently.
8. **Quest copy.** No count in the lede or the bonus line.
9. **No folder is not an error.** When main reports no stats folder at all, the renderer
   paints the folder card alone with a grey "No folder yet" status. A folder that exists
   and fails to read still goes to the red banner.
10. **Locked tabs explain themselves.** The folder card has a quiet line under its button
    naming what opens once runs are read and linking the two screens that work now.
    Pressing a locked tab rewrites that line with the tab's name, and from Mixtape or
    Expedition brings the card back into view first.
11. **The signed-out queue button says one thing.** `renderPool` leaves the button's
    sub-line alone while signed out, so "Ranked uses your Steam account" stays put.

Nothing server-side, rating, verification or season changed. Every change is in
`src/app/renderer/`; main is untouched, and each decision the renderer makes is about
presentation of a fact main already sent (`statsDir`, `verdict`, the session).

## Screens

Before and after, same tool, same profile shape. `.cache/` is gitignored, so these stay
local:

- `.cache/flow/before/` and `.cache/flow/after/`
- `fresh-00-first-launch.png`: finding 1 (checklist position) and 6 (streak)
- `fresh-01-queue*.png`, `fresh-01-queue-pool.png`, `fresh-loop-01-signed-in-gated.png`:
  findings 2 and 3
- `fresh-03-tournaments.png`: finding 7
- `fresh-04-result.png`: finding 5
- `fresh-08-quests*.png`: finding 8
- `nostats-00-first-launch.png`, `nostats-07-profile.png`: findings 9, 10 and 11
- `fresh-loop-03-seeding-match.png`, `fresh-loop-04-first-result*.png`,
  `fresh-loop-05-rated-result.png`: the core loop end to end
