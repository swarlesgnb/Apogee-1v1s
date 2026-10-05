# Shadows and Flags: ranked with nobody else in the pool

PLAN.md §15 names one open risk, population. With nobody else in the pool, `find-match`
handed out a seeding match and `settle-match` ended it with "Nothing was rated: there was no
opponent to play against". That was every player's first evening, and on a ladder with zero
population it was every evening.

Two mechanics replace it:

- **Shadow.** When the pool has no run set for you, the match is contested against a
  Shadow: a day at a stated percentile of genuine three-scenario match scores. You get a
  verdict ("You beat a 51st-percentile day: +10.0% vs +0.5% against baselines"), a place on
  a Shadow ladder, and a placement read-out. A Shadow moves no rating.
- **Flag.** The run set you played against the Shadow is planted as an open challenge in
  your band. The first real player to answer it within seven days settles a rated match for
  both of you, and you are told on your next launch ("Your Static Clicking Flag was answered
  by kestrel: you won, +162 rating").

The queue screen says which of these will happen before you commit: "No one in your band
right now. You'll face a Shadow now (a 51st-percentile day), and your run set stays planted
as a Flag."

## Why a Shadow can be honest

A match is decided on each side's delta over its own baseline (PLAN.md §3), so the opponent's
half of any match is one number: how far their three runs landed above or below their own
baselines. "A typical player's day" is therefore definable without a player. It is a quantile
of the distribution of genuine match scores, and a Shadow fielded at the 51st percentile
scores what 51% of genuine days fall below. Nothing about it pretends to be a person: it is
called a Shadow on the queue screen, the match card ("Shadow · a 51st-percentile day ·
synthetic"), the result ("Shadow match · synthetic opponent · unrated"), the top bar, the
rounds table ("Shadow Δ") and the share card ("Shadow match, a 51st-percentile day · unrated").

### Where the distribution comes from

`data/shadow_days.json`, written by `npm run build:shadows` (`tools/buildShadowTable.ts`,
`src/core/match/shadowTable.ts`). There are two ways to build it and the file says which it
holds.

**Corpus** (the honest source, not available here). Replays a real stats folder: for every
play day and every scenario with at least 5 runs on earlier days, the first run of the day is
scored against `baselineFromScores` over those earlier runs, the rule ranked uses less the
verified-PB floor (which lives server-side). Each day's rounds in one skill are drawn into
seeded 1-, 2- and 3-round matches and the quantiles are read off the means. On the owner's
machine a bare `npm run build:shadows` finds the Windows stats folder and does this.

**Model** (what is committed). There is no stats folder in this environment, so the table is
a normal distribution per skill and round count, with every parameter read from a committed
measurement and re-read by the validator:

| input | value | source |
|---|---|---|
| centre | +0.4% | `src/core/history/baseline.ts` header: mean delta of genuine runs under the median rule, 156 scenarios |
| three-round day, p10 / p90 | −5.6% / +5.8% | `docs/overnight/mechanics.md` ghost table, trailing 7-day median row: 199 genuine three-scenario days |
| round noise (median run-to-run change over median score) | all 4.6% (87 scenarios), Clicking 5.15% (42), Tracking 4.5% (27), Switching 3.55% (18) | `data/fun_audit.json`, scenarios with 10+ local runs |

The day spread is the anchor because it is the only committed number measured on
three-scenario days rather than single runs (σ = 4.45%). Round noise sets how the skills
differ and how much a single round spreads compared with a three-round mean (implied
within-day correlation 0.78). The result, as match-score quantiles:

| three-round day | p10 | p20 | p35 | p50 | p65 | p80 | p90 | p95 |
|---|---|---|---|---|---|---|---|---|
| all skills | −5.3% | −3.3% | −1.3% | +0.4% | +2.1% | +4.1% | +6.1% | +7.7% |
| Clicking | −6.0% | −3.8% | −1.5% | +0.4% | +2.3% | +4.6% | +6.8% | +8.6% |
| Tracking | −5.2% | −3.3% | −1.3% | +0.4% | +2.1% | +4.1% | +6.0% | +7.6% |
| Switching | −4.0% | −2.5% | −0.9% | +0.4% | +1.7% | +3.3% | +4.8% | +6.0% |

What the model costs: the ghost row's reference was a 7-day median, not the baseline, which
adds noise of its own, so the model is somewhat wider than the truth. High Shadows are a
little harder and low ones a little easier than a corpus build would make them. Replacing it
is one command on a real folder; the validator then checks the corpus table instead.

The Edge Functions import core modules and never JSON, so the builder also writes the same
numbers to `src/core/match/shadowDays.ts`. `npm run build:shadows -- --check` and
`validate:queue` both fail if the two disagree or if the model no longer matches its inputs.

### Which Shadow you meet

A one-up one-down staircase over seven rungs, `[20, 35, 50, 65, 80, 90, 95]`, starting at the
median. A win moves the next Shadow up a rung, a loss or an abandon down one, a draw or a void
leaves it. The percentile fielded is the rung's centre ±3, drawn by a seeded PRNG keyed on
`shadow:<player id>:<ordinal>`, where the ordinal is how many Shadows the player has met. So
the Shadow is a pure function of server data, and requeueing cannot reroll it: an open match is
handed back with its Shadow, and the ordinal only advances when a Shadow match ends.

A staircase converges on the level a player beats half the time, so every Shadow match stays a
contest. Measured by the validator with a simulated player whose days are genuine days:

| Shadow fielded | that player wins |
|---|---|
| 20th percentile | 80.3% |
| 50th | 49.6% |
| 65th | 34.9% |
| 80th | 18.9% |
| 95th | 4.1% |

The first Shadow lands between the 47th and 53rd percentile for everybody (mean 50.04 over
4,000 players). Over 400 matches the ladder fields that player a mean 53.8th-percentile Shadow.

**Placement** is the maximum-likelihood centre of the player's days among genuine days, from
their last 12 decided Shadow results with a weak prior at 50, shown after three. It reads 50.1
for the typical simulated player and 69.6 for one who shows up 3% sharper. It is a read-out,
not a rank, and the UI calls it "Placement: about the 53rd percentile from 3 Shadows".

### Judging a Shadow match

`settle-match` scores the player's side exactly as every seeding side was scored and stored
(`settleSide`), then judges the Shadow with the same `settleMatch` a contested match uses: the
Shadow becomes an opponent side whose rounds reproduce its deltas exactly, the device
settle-match already uses for a frozen stored side. Voids, the draw margin and rejected or
abandoned rounds therefore behave exactly as they would against a person.

One honest limit, and how it is handled. A round on a scenario with no earlier runs reads 0%
by construction (the run is its own baseline), so it cannot be contested by anybody. On such a
round the Shadow also reads 0% and the match is decided on the rounds that can be compared,
against the Shadow's day for that many rounds (the table carries 1-, 2- and 3-round
quantiles). With no comparable round at all the result is level and says why: "None of these 3
scenarios had earlier runs, so every round read 0% for both sides and there was nothing to
compare." To make that rare, a Shadow match draws its three from scenarios the player has a
full baseline on first, then ones with some history, then the rest, each bucket shuffled by the
match seed. The queue screen also says how many scenarios in the band have baselines before the
player commits.

## Why a Flag is not farmable

The rule every Flag is held to: **each run set rates its owner at most once.**

| run set | rated for its owner |
|---|---|
| a contested side | when played (unchanged) |
| a duel challenger's | when the duel is answered (unchanged) |
| a Flag | when it is first answered, inside seven days |

A Shadow-match run set is rated zero times when played (Shadows move nothing), so a Flag gives
it its one rating. After that, or after expiry, the run set stays in the pool and rates only
whoever answers it, exactly as every seeding side did before Flags existed. `validate:queue`
answers one run set five times (void, forfeit, win, loss, draw) and asserts the planter is rated
once, on the first played answer; the flow test plays a third player against an answered Flag
and asserts the planter's rating does not move.

What does not settle a Flag, and leaves it open for the next player: a void answer (an
abandoned round or a rejected run), a forfeit (otherwise a second account could hand over a
win by leaving), an answer match created after expiry, and the planter's own account (excluded
by `findOpponent`).

A Flag is a duel addressed to the pool, and inherits exactly the duel's exposure and nothing
more. A planter cannot choose who answers (the matchmaker does, by rating), cannot see who will,
and the answerer cannot see the planted score before playing (`flags` has no client read). Two
accounts colluding can do with Flags what they can already do with a duel, and less, because a
duel names its recipient.

Two answerers can draw the same open Flag before either has played. `commit_flag_answer` claims
the Flag under a row lock in the same transaction as the match result and both ratings; the
second answer is refused `flag-closed` and settle-match settles it again as an ordinary pool
match. The flow test settles the two concurrently and asserts exactly one claim commits.

### A proposed policy change, written up and not made

Abandoning a seeding match costs no rating, which has always been true and is unchanged. So a
duel challenger can play one round, see it go badly, abandon for free and send the duel again,
discarding bad starts before anyone answers. Flags inherit that: a planter can abandon a Shadow
match after a bad first round, and the only cost is a Shadow rung (abandoning is a Shadow loss).
No new kind of farm, but a selection effect on which run sets become rated. The fix belongs to
both duels and Flags together and is a rating-policy change, so it is left to the security pass:
once a seeding match's first counted run has landed, abandoning it could plant (or send) the run
set with the missing rounds scored as forfeited, so it can still lose when answered.

## What was built

| layer | files |
|---|---|
| core | `src/core/match/shadow.ts` (table reads, ladder, draw, scenario preference, judging, words, placement), `flags.ts` (TTL, planting, settling, the planter's rating step, words), `shadowTable.ts` (model and corpus builds), `shadowDays.ts` (generated) |
| data | `data/shadow_days.json`, `tools/buildShadowTable.ts` (`npm run build:shadows`) |
| schema | `supabase/migrations/20261003000023_shadows_and_flags.sql`: `match_shadows`, `flags`, the void-to-forfeit trigger, `commit_shadow_match`, `commit_flag_answer`; RLS on, no policies, client grants revoked |
| server | `supabase/functions/_shared/queue.ts`; hooks in `find-match`, `settle-match`, `abandon-match`; new `queue-board` function (rate limited 60 per 5 minutes) |
| client | `src/app/queueBoard.ts` (IPC `apogee:queueBoard`, polled on launch, sign-in, focus and after each settle), `api.ts` (`fetchQueueBoard`, types), `preload.cjs` (`queueBoard`, `onQueueBoard`), `src/app/renderer/queue-board.js` and `.css` |
| tests | `src/core/match/validateQueue.ts`, `tools/validateQueueFlow.ts`, `tools/postgrestShim.mjs`, `tools/queueUi.cjs` |

Shared files touched, and how little: `renderer.js` gains two one-line hooks
(`window.apogeeQueueHooks?.paintMatch` / `paintSettled`); `index.html` a stylesheet and a script
tag; `ghost.js` one condition (its "Nobody in the pool yet" offer is untrue on a Shadow result);
`main.ts` an import, an install line and three refresh calls; `src/core/brand/shareInput.ts`
three lines so a Shadow result's card names the Shadow and draws no opponent column;
`tools/validateSettlementOrder.mjs` mocks the new shared module; `tools/buildUiPreview.ts` inlines
the new renderer files.

No match side is created anywhere new. A Shadow match's side is still inserted by find-match's
existing seeding branch, and a Flag answer's two sides by its existing contested branch. The new
server writes are `match_shadows` (`recordShadow`, before the side) and the two commit functions.

## How it was tested

```bash
npm run validate:queue        # pure core (68 checks), then the PGlite flow (13 checks)
npm run build:shadows -- --check
npx tsc --noEmit
# screenshots, from the flow test's real handler payloads:
npx tsx tools/validateQueueFlow.ts
APOGEE_PREVIEW_OUT=.cache/queue-ui/preview.html npx tsx tools/buildUiPreview.ts
xvfb-run -a npx electron tools/queueUi.cjs --no-sandbox
```

`validate:queue` first checks the pure rules: the table is what its committed inputs produce and
the server copy matches it; every column rises; the win rates above; deterministic draws; the
ladder's steps and bounds; judging with and without history, rejected rounds and draws; that
nothing in the Shadow path can reach a rating; the Flag rules; and a corpus build from a
6,000-run synthetic stats folder (`tools/fixtures/syntheticStats.ts`, cherry-picked from
fleet/flow), which proves the pipeline and says nothing about the numbers.

Then `tools/validateQueueFlow.ts` drives the shipped `find-match`, `settle-match`,
`queue-board` and `abandon-match` handlers against every migration in PGlite. Only auth, the
rate limiter, tournament notification and HTTP are replaced; `tools/postgrestShim.mjs` turns
supabase-js calls (embedded joins, filters on joined columns, counts, bulk inserts, RPCs) into
SQL. It plays: an empty pool (the board predicts the Shadow, find-match fields exactly the
percentile the core predicts, requeueing hands back the same match and Shadow, settling plants a
Flag and never says "Nothing was rated", no rating moves); a second player answering the Flag
(rated both sides, 1500→1662 and 1500→1338 for two new players at full weight); the planter's
next board (the answered line, then quiet once acknowledged); a third player on the same run set
(rated alone); two answerers settling one Flag concurrently (one claim commits, one is refused
`flag-closed`); an expired Flag (closes on the planter's read, rates only its late answerer); a
Shadow match left to expire and one abandoned with the button (both forfeits, one rung down, no
Flag); and a round left early (void, the ladder holds). Finally it asserts no Shadow match ever
wrote a rating receipt.

The UI was photographed under Xvfb from the preview with a synthetic bridge serving the flow
test's real payloads; `tools/queueUi.cjs` asserts the copy on each screen and that nothing reads
NaN, undefined or null, and that nothing scrolls sideways at 1440 and 820 wide.

## Deployment order

1. `! npx supabase db push --yes` for `20261003000023_shadows_and_flags.sql`. It must land before
   the functions: the new find-match writes `match_shadows` on every empty-pool match.
2. `! npm run deploy:functions`, which now includes `queue-board`, and redeploys `find-match`,
   `settle-match` and `abandon-match`.
3. `! npm run verify:deployment`, which now also checks that `queue-board` refuses anonymous
   callers and that clients cannot read `match_shadows` or `flags`.
4. Ship the client. An older client still works against the new functions (it ignores the new
   fields, keeps its "Run set recorded" headline and shows the server's Shadow explanation
   under it); a new client against old functions shows no plan
   and no Flags panel, because the board read fails quietly.

Seeding matches opened before the deploy have no Shadow row and settle the old way.

## What this does not do

- **The committed table is a model**, not a corpus. It rests on three committed measurements of
  one player's history and is somewhat wider than a corpus build would be. `npm run
  build:shadows` on the owner's machine replaces it; nobody has run that yet.
- **A first-ever attempt cannot be made meaningful.** On three scenarios with no earlier runs
  the result is level, with the reason stated. The scenario preference makes that rare for
  anyone with history in the band; it cannot help a player with none.
- **The table does not recalibrate itself** from the ladder's own settled match scores. Once
  there are a few hundred non-provisional sides per skill that is the better source; by then the
  pool will rarely be empty.
- **No Flag preference in matchmaking.** A Flag is answered when it is the best rating fit, like
  any run set. Preferring Flags would change matchmaking for rated matches, which this branch
  leaves alone.
- **Quests.** A Shadow match counts toward `ranked_play` exactly as a seeding match always did,
  and never toward `weekly_wins`. There is no Shadow-specific quest.
- **A season rebuilt mid-match** retires an open Shadow match through forfeitMatch, which the
  trigger records as a forfeit (one rung). Rare, unrated, and stated here rather than special-cased.
- **The preview pool check duplicates find-match's candidate query** in `_shared/queue.ts`
  (`previewPool`) so that find-match's change stays a set of hooks. The flow test asserts the two
  agree on every queue it plays; folding them into one helper is a follow-up for whoever next
  edits find-match.
- **Glyphs are placeholders** (an outlined figure for a Shadow, a pennant for a Flag) until the
  brand kit's marks land.
- Nothing was deployed, and no screen was shown against a live backend.
