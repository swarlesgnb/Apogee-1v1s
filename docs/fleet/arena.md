# Crowns and live races

Two competitive formats, both unrated, both built on matches that already exist, both
decided the way ranked v2 decides a match (PLAN.md §3): each scenario is a round won by the
higher raw score, and more rounds won wins.

- **Crowns**: an asynchronous king of the hill. Each category and band of the season has a
  Crown, held by one stored run set on three fixed scenarios. Anybody may challenge it by
  playing the same three. Winning more of the three rounds than the holder takes it; a tied
  tally is a defence.
- **Live race**: two players who are both at their PCs play the same three scenarios at the
  same time. Each sees the other's raw score on a round only once their own run on that
  scenario has landed, and a bar shows the rounds decided so far. Equal rounds is a draw.

Neither moves a rating. Every Crown and race match is created with `matches.rated = false`,
the path tournaments use, so settlement and `forfeitMatch` write no rating and `find-match`
never draws these run sets into the ranked pool. Submission, verification, settlement
(`settleForPlayer` in `_shared/rankedV2.ts`) and the match clock are the paths that already
exist.

## Why these work at a small population

A Crown needs one other player ever, not one online now. With one player in a category and
band, that player claims it; with two, it changes hands; the board is a reason to come back
that does not depend on who else is on. Since ranked v2 a round is raw score against raw
score, so a Crown is a straight skill contest inside one band. The band (the season's rating
window) is what keeps it a contest: the people who can challenge a Crown are near each
other. The stronger of them holds it more often, and the 7-day cap below keeps it moving.

The race is the opposite trade. It needs two players online together, which a small
population rarely gives by accident, so it is built for friends who arrange it ("race me
now" on Discord) rather than for strangers. It is the secondary format for that reason.

## Crowns: the rules, and the evidence for each

The rules are written once as a pure reducer in `src/core/crowns/crowns.ts` and enforced in
SQL (`crown_resolve` and friends in migration `20261011000005_crowns_and_races.sql`).
`tools/validateCrownsDb.ts` drives 118 random challenges through both, with integer raw
scores from a narrow range so tied rounds are common, and requires the same outcome, holder,
defences, bar (the holder's three raw scores), round tally and cycle at every step: 0
mismatches; 14 takes, 72 defences, 22 voids, 10 forfeits, 12 of the 82 judged challenges
level on rounds.

### How a Crown is first seeded: by claiming it

A vacant Crown shows **Claim**. Claiming opens a one-sided unrated match on the Crown's three
scenarios. The first qualifying run set to settle takes the Crown, and its three raw scores
become the ones to beat. The three scenarios are drawn when the first claim of a cycle opens
(seeded server-side with `selectScenarios`, the queue's own draw) and stored on the Crown, so
every later claimant in that cycle plays the same three and is judged against whoever took
it first.

Seeding from the first ranked or seeding run set in the category and band was considered and
not done: two claimants need the same three; a public title should be played for; and it
would put Crown work inside every ranked settlement. At zero population the board reads
"Vacant, Claim" on all 24 Crowns (screenshot `crowns-10-board-empty.png`).

### Taking, defending and ties: rounds on raw score

Round i is scenario i. The challenger wins a round with a higher raw score, loses it with a
lower one, and an exactly equal score is a level round. The challenger takes the Crown when
they win more rounds than they lose: 3–0, 2–1, 2–0 with one level, 1–0 with two level. A
tied tally (1–1 with one level, 0–0 with three level) is a **defence**. The margin does not
matter, only the count: 5,000 against 1,000 on one round and two narrow losses is a defence.

This is settleMatch's rounds format exactly. `validateCrowns.ts` asks `settleMatch(...,
format: "rounds")` for its verdict and tally on 6,000 raw-score pairs, half of them integers
from a four-point range so ties are common, and a take is exactly a settleMatch win, with
the same won/lost/tied count, on every pair. The draw margin the Crown used under mean delta
is gone: there is no epsilon in rounds.

The dethroned holder's notice, the defence notice, the board's history and the result
screen all report the tally ("2–1 on rounds"). The challenger's "against your usual" delta
still shows on the live view and the result screen, as information.

### The holder's scores are sealed, and the sealing is enforced

A challenger sees each of the holder's raw scores only once their own run on that scenario
has landed. Until then the board, the match and the live view say that the holder has a
score there, never what it is. This is enforced in the data, not just the screen:

- **The board** carries no score of the holder's (a key walk over the list-crowns reply
  finds no `score`, `scores`, `delta`, `bar` or `matchScore`). Where the mean-delta "to
  beat" figure was, a card says *Out-round · 3 sealed scores*, and the detail says what
  taking it needs: "Win more of the three rounds than the holder, on raw score. A tie on
  rounds keeps the Crown where it is."
- **The challenge match.** Every participant in a match can read all of its sides through
  RLS (`is_match_participant`, migration 20260921000019). So the holder's side copied into a
  challenge match carries **no scores, no deltas and no match score**. Settlement finds the
  holder's raw scores on the holder's own side, by owner and `submitted_at`, the fallback
  `frozenScores` already uses for copies made without scores. Tested: the copied side holds
  `{}`, `{}`, null, and the challenger can read none of the holder's scores from any match;
  settle-match still settles the match in rounds format against the holder's real scores.
- **The Crown tables** (`crown_reigns.scores` is where the bar lives) are closed to clients;
  `attack:rls` checks that a player cannot read or rewrite them.
- **The live view** (`race-status`) reads the holder's scores from the reign, as the service
  role, and opens each one when the challenger's run on that scenario lands. Not when the
  challenge ends: a challenge abandoned after one round shows that round and keeps the
  other two sealed, or abandoning would be a way to read the bar before the next attempt.
  Tested through the shipped handler.
- **After a take**, `crown_resolve` deletes the copied holder side from the match that just
  took the Crown. The copy made the old holder a participant in the match whose challenger
  side is now the Crown's bar; left in place, a dethroned holder could read the new holder's
  three scores and come back after the cooldown knowing exactly what to beat. Tested: the
  dethroned holder reads zero rows of that match.

Once all three of the challenger's runs have landed nothing is sealed any more, so the
result screen shows each round's two raw scores, and settle-match's own rounds table does
the same.

### Which engine Crown and race matches use: engine 1

Ranked v2 records the engine that created each match (`matches.engine`: 1 for duels,
tournament legs and everything before v2; 2 for queued ranked matches). The engine decides
two things: how a rated result moves a rating, and whether leaving a scenario early spends
the player's one free void a week (`FREE_ABANDONS_PER_WEEK`).

Crown and race matches are created as **engine 1**:

- **They are unrated**, so neither engine's rating rule is ever reached.
- **The free void.** `settleForPlayer` only counts an early exit against the week's free
  void, or turns it into a lost round, for a contested **rated** match (`contested = !seeding
  && rated && policy.freeAbandons !== null`). An engine-2 Crown match would therefore still
  never spend it, but only because of the `rated` term; engine 1 states the intent
  directly: leaving a scenario early voids a Crown challenge or race leg, always, and never
  costs the player their free void for a ranked match. Tested: an abandoned scenario voids
  the challenge and leaves the holder in place.
- **Engine 2 keeps meaning "a queued ranked match"**, which is what the ladder comparisons
  and any per-engine reporting read it as. Duels and tournament legs made the same choice.

Rounds decide either way: settlement picks the rounds format whenever the other side's raw
scores can be found, whatever the engine.

### Simultaneous challenges: judged against whoever holds it when the result comes in

The decision runs in an `AFTER UPDATE` trigger on `matches`, inside the same transaction as
`commit_match_result` (which writes the sides before the match status, so the trigger sees
the challenger's scores). It locks the Crown row before it reads anything, so two challenges
that settle at the same instant are decided one after the other, and a challenge's result
never commits without its Crown decision.

A challenge is judged against whoever holds the Crown when it settles, on the same three
scenarios. If the Crown changed hands while the challenger played, the result screen says
so. Settle-match's own verdict on that screen is against the holder the match was opened
on (the side copied in), so in that case the big verdict and the Crown decision can differ
("Victory" over the old holder, "Wren keeps the Crown"); the Crown note explains it.

**Round majority is not transitive.** A can beat B 2–1, B beat C 2–1 and C beat A 2–1, like
non-transitive dice. So under rounds, "the best run set holds the Crown whatever the settle
order", which held under mean delta, no longer holds: in 3,000 random batches of 2 to 6
simultaneous challengers settled in two different orders, the final holder differed in 270
(9%). What holds whatever the order, and is tested on every batch:

- each challenge is judged against exactly one holder, the one holding when it settled;
- **every take beat the holder it took from**, and every defence did not;
- **each reign ends at most once**, with one take per ended reign;
- there is one live reign.

A challenge that finished second is not discarded ("stale") for that: it would throw away a
result because of a few seconds of timing. Stale is used only when the Crown was **reset
onto new scenarios** while the challenge was played.

### What may take a Crown: Verified or Consistent, every round

A run set qualifies when the match settled, every scenario has a raw score and a run, and
every run is **Verified or Consistent**.

- **Rejected never counts.** A Rejected round already voids a contested match (the rounds
  no longer line up), and a claim with one is refused by the tier check.
- **Suspect does not wear a Crown.** Ranked counts a Suspect run but holds it for review
  (PLAN.md §5). A Crown is a public title, so a run under review does not take one, even when
  settle-match calls the match a win. Tested: the screen says "a run is held for review".
- **Verified-only was considered and not chosen**: it needs a linked kovaaks.com account,
  which most players at this population do not have. The board shows the weakest tier among
  the holder's three runs.
- A challenger must also pass the queue's eligibility bar (`requireEligible`).

### Can a holder's own runs defend? No

A holder cannot challenge their own Crown (refused in SQL and in the function). Defences
count **distinct challengers beaten in the reign**: somebody who loses twice is one defence
and two challenges. A void or forfeit is not a defence.

### Rate limits: one challenge per player per Crown every 20 hours

The three scenarios are fixed for a cycle, so unlimited attempts would hand the Crown to
whoever plays most. `validateCrowns.ts` replays it with the raw-score model below: a player
who challenges five times a day among five equal players holds the Crown **49%** of days
without a cooldown and **21%** with one (a fair share is 20%).

Every opened challenge spends the cooldown, whatever it came to; a void or forfeit has to
count too, or quitting a bad run would be a free reroll. 20 hours, not 24, so a player who
plays at about the same time each evening is not refused by a few minutes. Each function
also has a per-player limit in `_shared/rateLimit.ts`: `challenge-crown` 10 per 5 minutes,
`list-crowns` 60, `race-action` 20, `race-status` 150 (the live view polls every 4s).

### Expiry: a reign lasts at most 7 days

The holder's three are the survivors of every challenge so far, so each new challenger faces
a set that has already beaten everybody before them. With equal players, how often the next
challenger takes a set that has survived m challenges since it took the Crown:

| challenges survived | next challenger takes it |
|---|---|
| 0 | 34.8% |
| 1 | 26.8% |
| 3 | 18.7% |
| 5 | 15.6% |
| 10 | 9.7% |

Without a cap the board freezes. Changes of hand in week 8, with and without the cap:

| in-band skill spread | players | 7-day cap | uncapped | week 1 |
|---|---|---|---|---|
| none | 2 | 1.05 | 0.52 | 1.18 |
| none | 5 | 2.73 | 1.07 | 3.42 |
| none | 15 | 5.57 | 3.19 | 7.09 |
| 4% | 2 | 0.90 | 0.28 | 1.02 |
| 4% | 5 | 2.04 | 0.61 | 2.44 |
| 4% | 15 | 3.66 | 1.19 | 4.94 |

*The model is compareLadders' (`src/core/rating/compareLadders.ts`, the simulation ranked v2
was chosen on): a run's performance is the player's skill plus noise with a robust spread of
5.5% (PLAN.md §4), one run in twenty a bad one centred 10% down; a round goes to the higher
raw score. How far apart players in one band are is not something a stats folder measures,
so it is run with nobody apart (the pure effect of the rule) and with an assumed spread of
4% (compareLadders uses 15% across the whole ladder, which the season splits into four
bands). Each player challenges a given Crown on about half their days, once a day; 400
trials of 8 weeks. Printed by `npm run validate:crowns`.*

The cap matters more once players differ: with a 4% spread an uncapped Crown in week 8
changes hands under a third as often as a capped one, because the strongest player in the
band settles in.

When a reign reaches 7 days it **lapses**. The holder is told how many defences they made,
and the Crown falls vacant onto a new cycle; the next claim draws three new scenarios. A
lapse waits for a challenge that is already being played. A Crown whose scenarios leave the
season is reset the same way.

### The comeback loop

When a Crown changes hands, the database writes a notice for the dethroned holder in the
same transaction. The next time they open the client, `list-crowns` returns it as a
sentence:

> You lost the Precise Tracking Crown (Intermediate) to Kestrel after 3 defences, 2–1 on
> rounds. You held it for 2 days 21 hours.

On the Crowns screen it has a **Challenge back** button. Holders also get a notice for each
defence ("Tern challenged your Static Clicking Crown (Advanced) and did not take it (1–1 on
rounds)") and for a lapse. Notices are readable only by their owner: RLS, the function and
the mark-as-read path, each tested with another player trying.

## Live race (the secondary format), and why not Draft

**Draft** (draw five, ban to three) would have needed the async duel's challenger to play
four or five scenarios, or to wait for the recipient's ban; every option rewrote the duel
flow. **Live race** touches none of those paths: it needs a pairing (its own small invite,
three-minute expiry, one out at a time) and a view, which is a read.

### How a race works

1. A invites B to a category and band. The three are drawn then and shown to B with the
   invitation, which also appears as a toast on any screen.
2. B accepts. `race_start` locks both players in id order, checks neither is in a live match,
   and creates **two one-sided unrated engine-1 matches with the same three and the same
   start** in one transaction.
3. Each plays. Each leg settles on its own through settle-match (the one-sided path), which
   says the other player is still playing rather than the pool sentence.
4. When the second leg ends, the same trigger runs `race_resolve`. It locks the race row, so
   two legs ending together decide it once (tested: a draw, 3 level). It tallies the two
   legs' stored raw scores round by round: **more rounds won wins, equal rounds is a draw**
   (tested: 2–0 with one level; and a big gain on one round with two narrow losses loses the
   race, though its mean delta is far higher). A leg that did not finish all three, with a
   raw score on each, loses to one that did, so quitting cannot deny a result. Neither
   finishing is void. The race row keeps the tally (`inviter_rounds`, `invitee_rounds`,
   `tied_rounds`).

### The sealed reveal

**You see the other side's raw score on a round only once your own run on that scenario has
landed.** Your first run on a scenario is the one that counts, so by the time a round opens
there is nothing left you can do about it, and playing second buys no information. Until
then you see that they landed it, never what they scored. A round is decided, and joins the
bar, once both scores are visible. `validateRace.ts` checks all 144 landing combinations for
any sealed number or round result reaching the viewer (0 leaks); `validateRaceDb.ts` checks
the shipped handler round by round.

For a race this is enforced by RLS as well: the other player's match has no side of yours,
so its match, sides and runs are unreadable (tested), and `race-status` is the only route to
their numbers.

The bar is the round tally: one cell per round, filled won, lost or level as each is
decided, hatched while it is sealed. Each lane shows both raw scores, your delta against
your usual in small type, and the round's result.

## What was built

| Layer | Files |
|---|---|
| Core | `src/core/crowns/crowns.ts` (rules: qualifying, `tally`, `judge`), `src/core/crowns/view.ts` (board, result note with per-round raw scores), `src/core/race/race.ts` (sealed view, tally, verdict), `src/core/race/view.ts` (race list, live status) |
| Schema | `supabase/migrations/20261011000005_crowns_and_races.sql`: `crowns`, `crown_reigns` (with the holder's `scores`), `crown_challenges` (with the round tally), `crown_notices`, `races`; `crown_open_challenge`, `crown_resolve`, `crown_lapse_due`/`_all`, `crown_reset_off_pool`, `crown_vacate`, `race_start`, `race_resolve`; trigger `matches_arena_ended` |
| Edge | `list-crowns`, `challenge-crown`, `race-action`, `race-status`; `_shared/arena.ts`; an `arena` note in `_shared/rankedV2.ts` `settleForPlayer` (already-settled, early-exit void, one-sided and contested paths); rate limits |
| Client | `src/app/arena.ts`, `src/app/arenaApi.ts`; IPC and preload; the **Crowns** tab (`renderer/crowns.js`, `race.js`, `crowns.css`); held label, forfeit confirm, opponent card and an "unrated · crown/race" rating line in `renderer.js`; share cards for Crown and race matches print both raw scores and the round result and no match score (`shareInput.ts`, a `result` field on `shareCard.ts` rounds) |

## How it was tested

| Command | Result |
|---|---|
| `npm run validate:crowns` | core: comparator and tally vs settleMatch's rounds format (6,000 pairs), qualifying, seeding, take, defend, level tallies, repeat challengers, forfeits, stale cycle, the non-transitive cycle, 3,000 simultaneous batches (take/defence/end-once invariants), lapse, cooldown, board (no holder numbers), share card, and the simulations above. DB (PGlite, shipped handlers): claims, one take from two concurrent challengers with the other level on rounds against the new holder, the copied side carrying no numbers, the take removing the old holder's copy, sealing in the live view including after an abandon, Rejected, Suspect, abandoned and forfeited challenges cannot take, notices owner-only, lapse, lapse held by a live challenge, off-pool reset, no rating moved, and the 118-step SQL vs reducer differential. **Pass** |
| `npm run validate:race` | core: sealed raw scores, 144-combination leak search, verdict and tally vs settleMatch's rounds format (4,000 pairs), views. DB: invitations, atomic start, sealed rounds through the handler, RLS refuses the other player's match, the result and tally on the second leg, rounds not mean, forfeit, expiry, decline quiet period, simultaneous finish decided once, Rejected leg loses, no rating moved. **Pass** |
| `npx tsx tools/crownsUiFixture.ts && xvfb-run -a npx electron tools/crownsUi.cjs --no-sandbox` | board, notices, cooldown, history, 860px layout, live challenge bar (a sealed holder score appears nowhere on screen), bar inside the match panel, sealed race round, invitation toast, race panel, take and defend results with per-round raw scores, empty board. **Pass**; screenshots inspected |
| `npm run attack:rls` | the arena attacks, now including lowering a holder's scores and reading them: **no holes found** |
| `npx tsc --noEmit`, `validate:functions`, `validate:schema` (includes `validate:ranked-boundaries`), `validate:security`, `validate:social-functions` | **Pass** |

Screenshots (not committed): `scratchpad/shots/arena-v2/crowns-1-board.png` through
`crowns-10-board-empty.png`. The UI fixtures are built by the real view builders over
Season 1's scenario names, with invented players and raw scores.

The database harness (`tools/arenaHarness.ts`) runs the shipped handlers and shared helpers,
ranked v2's `settleForPlayer`, `forfeitMatch` and `sweepStaleMatches` included, against
PGlite with every migration applied. It replaces only identity, transport, the season pool
and tournament notification. PGlite is one connection: overlapping promises interleave at
every await and exercise the ordering, but **independent connections taking row locks at
once were not exercised**. The SQL is written for that case (every decision takes the Crown
or race row lock before it reads).

## Deployment order

1. `npx supabase db push`: migration `20261011000005_crowns_and_races.sql`, after ranked v2's
   migrations (it needs `match_sides.scores` and `matches.engine`). It must come before the
   functions: the trigger is what decides Crowns and races.
2. `npm run deploy:functions` (the four arena functions are in the chain), including
   `settle-match` and the other functions that bundle `_shared/rankedV2.ts` (it imports
   `_shared/arena.ts` now). The arena note fails open if the tables are missing: the match
   still settles.
3. `npm run verify:deployment`.

Nothing was deployed from here.

## Boundaries: what this does not do

- **Two independent connections were not tested** (see above).
- **Non-transitive outcomes** under simultaneous challenges are accepted, not prevented (see
  above). Preventing them would mean judging a challenge against every holder since it
  opened, which is a different rule from the one ranked uses.
- **A Crown changing hands mid-challenge** shows settle-match's verdict against the old
  holder above the Crown note against the new one. Explained on screen, not unified.
- **Polling, not Realtime.** Invitations every 30s while focused; the live view every 4s.
- **Races need both players online.**
- **Quests.** A Crown challenge or race leg is recorded on the quest board like any settled
  match, as tournament legs already are. Worth a decision.
- **A restart mid-challenge** recovers the match through `fetchActiveMatch`, which does not
  know it is a Crown challenge; the held label reads "Match already open" until the next
  Crown action.
- **Pre-existing, made more likely:** `tournament_open_leg` counts a copied side in somebody
  else's open match as the player's own live match, so a holder whose set is being
  challenged cannot open a tournament leg for those minutes. Not changed here.
- **The ranked share card** still calls rounds on deltas; only Crown and race cards were
  moved to raw scores here. Ranked presentation is outside this branch.
- The crown glyph is a placeholder for the brand kit to replace.
