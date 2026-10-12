# Shadows and Flags, on ranked v2

PLAN.md §15 names one open risk, population. With nobody suitable in the pool, `find-match`
hands out a seeding match, and settlement ended it "Nothing was rated: there was no opponent
to play against". That was every player's first evening.

Ranked v2 (PLAN.md §3, §4) changed what a match is: each round goes to the higher **raw
score**, best of three; opponents are drawn from a bank of other players' rounds; only the
caller is rated, against the rating the opponent had when they played; and find-match plants
fresh seeding matches by itself (`shouldPlantFresh`). Shadows and Flags were first built on
v1's delta format and rated-for-both settlement. This is the refit.

- **Shadow.** A seeding match from the queue is contested against a stated percentile score
  on each of its three scenarios, decided like ranked: best of three on raw score. "You beat
  the Shadow 2–1 on rounds: a 52nd-percentile score on each. Shadows move no rating." Unrated,
  and labelled synthetic everywhere it appears.
- **Flag.** News, unrated for you: when somebody plays a match drawn from your banked rounds
  and it settles, you are told on your next launch. "kestrel played your banked rounds and
  took 2 of 3."

Before the player commits, the queue says which will happen: "No one in your band right now.
You'll face a Shadow now (a 52nd-percentile score on each), and your three runs join the bank:
whoever draws them later plays you, and you'll hear how it went." When find-match is planting
fresh scenarios instead, the first sentence says that.

## What a Shadow is now

A ranked round is decided on raw score, so a Shadow is a score on each scenario: the score at
one percentile of that scenario's board, the same percentile on all three. "A 58th-percentile
score on each" means 58% of each board scores below the Shadow. The match against it is decided
by the same `settleMatch` in rounds format that decides ranked (`judgeShadow` in
`src/core/match/shadow.ts`), so ties, rejected runs and rounds left early behave exactly as
they would against a person.

### Where every score comes from

`data/shadow_scores.json`, built by `npm run build:shadows` from what Season 1 already commits
for its ranks (`src/core/match/shadowSource.ts`). Nothing is fitted or assumed:

| point | source |
|---|---|
| rank thresholds | `data/seasons/season-1.json` `rankMaxes`: scores read off each scenario's board at the pool ladder's percentiles (`data/pool.json` `ladder.ranks`), cut per window by `windowRankIndices` exactly as `tools/buildSeason.ts` cut them. "Top 26%" is the 74th percentile from the bottom. |
| board median | `data/season-1/families.json` `median`: the same predicted board at the 50th percentile, scaled by the row's `source.factor`, the factor build:season scaled the whole board by before cutting the thresholds (`scalePoints`) |

Between two committed points a score is interpolated linearly in score against percentile,
which is `scoreAtTopFraction`'s rule for reading a board. Outside them there is no number and
the Shadow does not invent one. The validator reads back all 1,066 committed points exactly
(984 thresholds and 164 medians; every median sits in order among its thresholds, so none was
left out), and fails if the table is stale after a season rebuild.

What the points cover, per window:

| window | scenarios | committed percentiles on every scenario |
|---|---|---|
| Novice | 41 | 14 to 82 |
| **Intermediate (the match window)** | 41 | **50 to 94.5** |
| Advanced | 41 | 50 to 98.5 |
| Expert | 41 | 50 to 99.2 |

These boards are predictions: no Season 1 scenario has a KovaaK's board yet, and the season says
so in every row's `source`. A Shadow is exactly as good as the season's thresholds are, and
improves when they are recut from real boards; `build:shadows` follows them.

### The ladder

Seven rungs, one up for a win and one down for a loss: the staircase that settles on the level
a player beats about half the time, so every Shadow match stays a contest. The percentile is the
rung's centre ±2, drawn by a seeded PRNG keyed on `shadow:<player id>:<ordinal>`, so the Shadow
is a pure function of server data and requeueing cannot reroll it (an open match is handed back
with its Shadow; the ordinal advances only when a Shadow match ends; abandoning or letting it
expire is a Shadow loss).

**The rungs moved, and this is the one place the PM's design could not be kept as written.**
v1's rungs were the 20th to 95th percentile. Under v2 a rung has to be a committed score, and for
the match window nothing is committed below the board median or above the 94.5th percentile. So
the seven rungs are now **52, 58, 65, 72, 79, 86, 92**, starting at the bottom one, a median
score: with jitter they span 50 to 94, all inside what every Intermediate scenario commits. The
cost is real: a player whose scores sit below the median of these boards loses the bottom-rung
Shadow and stays there. Lower rungs come back the day the season commits points below the median
for the match window (a recut from real boards does that).

If the match window ever moves to Novice, rungs 86 and 92 fall outside its committed range; those
rounds are then not contested and the result says so ("One scenario has no committed score at
that percentile, so it was not contested and the other two decided it"). With no committed score
on any of the three, there is no result, with the reason stated.

The read-out is a bracket from the player's own results, with no model behind it: "beaten up to
the 58th · lost at the 65th · rounds 6 of 9 · streak 2".

### What it decides

Nothing about rating: ranked v2 rates a player against a person's rating at play, and a Shadow
has none (a rating moved against a table would also be farmable). The side is stored exactly as
every v2 seeding side is (rounds format, raw scores kept), so its rounds join the bank the same
way; the flow test plays a second player against them.

## What a Flag is now

Ranked v2 deliberately rates only the player who played, and this refit does not change that.
A Flag is the owner hearing about it: when a settled, rated, queued (engine 2) match holds a copy
of your side, you are told who played your rounds and how many they took, by ranked's own rule
(the higher raw score takes the round). When the stored scores could disagree with the stored
verdict (a round left early a second time in a week counts as lost whatever its partial score),
the news says only who won.

It is read from rows v2 already writes, so settlement writes nothing extra. The only new state is
`flag_reads`, how far each player has read; the client acknowledges with the board's
`newsThrough`, so news is said once, on whichever machine opens first. A first launch is told
about the last seven days at most.

Planting is find-match's, unchanged: the queue's pre-commit line only explains it.

## What was retired, and why

| retired | why |
|---|---|
| `data/shadow_days.json`, `shadowTable.ts`, `shadowDays.ts` (the delta-day model) | a Shadow was a three-scenario mean delta. Deltas decide nothing in ranked now, and nothing else used the model, so it is gone rather than kept beside a format it no longer describes |
| the `flags` table, `commit_flag_answer`, rated-for-both settlement | v2 rates only the caller, on purpose (PLAN.md §4). Never deployed |
| measured-baseline scenario preference for Shadow matches | it existed so rounds could be compared on deltas; raw rounds need no baseline, and v2's own selection (away from recently played scenarios) is what planting depends on |
| the placement estimate | it modelled a player's days as shifted copies of everyone's deltas. Raw-score percentiles mean something else, and a bracket from real results needs no model |

## How it is wired

| layer | files |
|---|---|
| core | `src/core/match/shadow.ts` (table read, ladder, draw, judging, words, read-out), `shadowSource.ts` (table build), `shadowScores.ts` (generated), `flags.ts` (bank news) |
| data | `data/shadow_scores.json`, `tools/buildShadowTable.ts` (`npm run build:shadows`, `--check`) |
| schema | `supabase/migrations/20261011000004_shadows_and_flags.sql`: `match_shadows`, `flag_reads`, the void-to-forfeit trigger, `commit_shadow_match`; RLS on, no policies, client grants revoked |
| server | `supabase/functions/_shared/queue.ts`; `queue-board` (60 per 5 minutes); hooks in `find-match`, `_shared/rankedV2.ts` and `abandon-match` |
| client | `src/app/queueBoard.ts`, `api.ts`, `preload.cjs`, `src/app/renderer/queue-board.js` and `.css`; two one-line hooks in `renderer.js` |
| tests | `src/core/match/validateQueue.ts`, `tools/validateQueueFlow.ts`, `tools/postgrestShim.mjs`, `tools/queueUi.cjs` |

The hooks, all small:

- `find-match`: after `open_ranked_match` opens a seeding match, `fieldShadow` freezes its Shadow
  (a failure leaves an ordinary seeding match, logged); the response and `resume` carry `shadow`.
- `_shared/rankedV2.ts` `settleForPlayer`: the seeding branch hands a Shadow match to
  `settleShadowMatch` (null for a duel's or fixture's first leg); the free-void branch calls
  `markShadowVoid` for a seeding match; a repeated settle returns `shadow`.
- `abandon-match`: a Shadow match's abandon message.
- `tools/validateSettlementOrder.mjs` mocks the new module, as it mocks the others.

No match side is created anywhere new: Shadow matches are opened by `open_ranked_match` in v2's
own seeding branch.

## How it was tested

```bash
npm run validate:queue            # pure core (37 checks), then the PGlite flow (11 checks)
npm run build:shadows -- --check
npx tsc --noEmit
npx tsx tools/validateQueueFlow.ts
APOGEE_PREVIEW_OUT=.cache/queue-ui/preview.html npx tsx tools/buildUiPreview.ts
xvfb-run -a npx electron tools/queueUi.cjs --no-sandbox
```

The pure checks: the table is exactly what the season's files produce and the server's copy
matches; every committed point reads back; nothing outside them is scored; every rung with its
jitter is covered on all 41 match-window scenarios and is harder up the ladder on every one;
draws are deterministic and cannot be rerolled; raw score decides rounds and a higher delta does
not save a lower score; uncovered rounds are not contested; rejected runs void; nothing in the
Shadow path can reach a rating; the rated-for-both settlement is gone; bank news follows ranked's
rule and stays quiet when it would contradict the stored verdict.

The flow drives ranked v2's unmodified `find-match`, `settle-match` and `abandon-match`, and
`queue-board`, against every migration in PGlite (only auth, the rate limiter, tournament
notification and HTTP replaced): an empty pool (the board predicts the Shadow, find-match fields
exactly the one the core predicts and freezes its scores, a requeue returns the same match,
settling decides it 2–1 on raw rounds, moves no rating and banks the side); a second player drawn
against those rounds (rated alone); the owner's next board ("kestrel played your banked rounds and
took 2 of 3.", then quiet once acknowledged, still listed for the week); find-match's own planting
(predicted by the board, carrying a Shadow) and pressing Abandon on it; the ladder up after a win
and down after a 0–3; an expired Shadow match (forfeit); a round left early (no result); and no
rating receipt for any Shadow match. The screenshots are drawn from those payloads.

## Deployment order

1. `npx supabase db push` for `20261011000004_shadows_and_flags.sql` (after ranked v2's and the
   social migration). Before the functions: find-match writes `match_shadows`.
2. `npm run deploy:functions`: the new `queue-board`, and `find-match`, `settle-match` and
   `abandon-match` (they import `_shared/queue.ts`).
3. `npm run verify:deployment`: `queue-board` refuses anonymous callers.
4. The client. Old clients keep working (they ignore `shadow` and show the server's explanation).

## What this does not do

- **Below the board median, nothing.** See the ladder: the bottom rung is a median score until the
  season commits lower points for the match window.
- **The scores are predictions** until the season's thresholds are recut from real boards.
- **No share cards.** Brand's Flag and Shadow cards (`src/core/brand/shareInput.ts`) were drawn for
  the v1 design (a rated Flag, a rating-calibrated placement series) and are not wired; under v2
  they would need a Flag card of "who played your rounds, rounds each way" and a Shadow card of a
  percentile score on each.
- **The preview duplicates find-match's pool read** (`previewPool`) so find-match's change stays a
  hook. The flow test asserts they agree on every queue it plays; a player with no ratings row is
  previewed at the default rating, where find-match would seed it from PBs.
- **A season rebuilt mid-match** retires an open Shadow match through forfeitMatch, which the
  trigger records as a forfeit.
- Glyphs are placeholders until the brand marks are wired here. Nothing was deployed.
