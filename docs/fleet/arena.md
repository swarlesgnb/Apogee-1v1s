# Crowns and live races

Two competitive formats, both unrated, both built on matches that already exist.

- **Crowns**: an asynchronous king of the hill. Each category and band of the season has a
  Crown, held by one stored run set on three fixed scenarios. Anybody may challenge it by
  playing the same three. A higher match score than the holder's takes it.
- **Live race**: two players who are both at their PCs play the same three scenarios at the
  same time. Each sees the other's round only once their own run on that scenario has
  landed, and a tug-of-war bar shows the margin over the rounds both have revealed.

Neither moves a rating. Every Crown and race match is created with `matches.rated = false`,
the path tournaments use, so `settle-match` and `forfeitMatch` write no rating and
`find-match` never draws these run sets into the ranked pool. Submission, verification,
baselines, settlement and the match clock are the paths that already exist.

## Why these work at a small population

A match is won on delta over the player's own baseline (PLAN.md §3), so a Gold player and
the best player on the ladder have a real contest. A Crown uses that directly: whoever holds
it, any player can sit down and try to show up sharper today. It needs one other player
ever, not one online now. With one player in a category, that player claims it; with two,
it changes hands; the board is a reason to come back that does not depend on who else is
on.

The race is the opposite trade. It needs two players online together, which a small
population rarely gives by accident, so it is built for friends who arrange it ("race me
now" on Discord) rather than for strangers. It is the secondary format for that reason.

## Crowns: the rules, and the evidence for each

The rules are written once as a pure reducer in `src/core/crowns/crowns.ts` and enforced in
SQL (`crown_resolve` and friends in migration `20261003000025_crowns_and_races.sql`).
`tools/validateCrownsDb.ts` drives 120 random challenges through both and requires the same
outcome, holder, defences, bar and cycle at every step (0 mismatches).

### How a Crown is first seeded: by claiming it

A vacant Crown shows **Claim**. Claiming opens a one-sided unrated match on the Crown's three
scenarios. The first qualifying run set to settle takes the Crown. The three are drawn when
the first claim of a cycle opens (seeded server-side with `selectScenarios`, the queue's own
draw) and stored on the Crown, so every later claimant in that cycle plays the same three
and is judged against whoever took it first.

The brief suggested seeding from the first ranked or seeding run set in that category and
band. I did not, for three reasons:

1. **Two claimants need the same three.** A ranked run set brings its own scenarios. If a
   ranked set seeded the Crown while somebody was mid-claim on a different three, the claim
   could not be compared with it.
2. **A public title should be played for.** A ranked run set put on a named board without
   the player choosing it is a surprise in the wrong direction; a claim is a decision.
3. **Ranked settlement stays untouched.** Auto-seeding means doing Crown work inside every
   ranked settlement. Claims keep the Crown code out of every match that is not a Crown match.

At zero population the board reads "Vacant, Claim" on all 24 Crowns, which is itself the
invitation (screenshot `crowns-10-board-empty.png`).

### Taking, defending and ties

A challenger takes the Crown when their match score is at least **0.0005** (0.05 points)
above the holder's: settleMatch's own `DRAW_EPSILON`, so a Crown changes hands exactly when
settleMatch would call the match a win. A draw is a **defence**: the holder keeps it.
`validateCrowns.ts` asks settleMatch for its verdict on 4,000 score pairs, half of them within
a few draw margins of each other, and `beats()` agrees on every one.

### Simultaneous challenges: judged against whoever holds it when the result comes in

The decision runs in an `AFTER UPDATE` trigger on `matches`, inside the same transaction as
`commit_match_result` (migration 22). It locks the Crown row before it reads anything, the way
migration 22 locks the match and then the ratings, so two challenges that settle at the same
instant are decided one after the other, and a challenge's result never commits without its
Crown decision.

A challenge is judged against whoever holds the Crown when it settles, on the same three
scenarios. If the Crown changed hands while the challenger played, the result screen says
so ("The Crown changed hands while you played, so you were measured against Cedar"). Two
properties follow, and both are tested:

- **Each reign ends at most once.** Two challengers who both beat holder R produce exactly
  one take from R. The second is measured against the new holder.
- **The holder at the end is the best qualifying run set, whatever the settle order.**
  3,000 random batches of 2 to 6 simultaneous challengers in random order: 0 violations.

The alternative, discarding a challenge that finished second ("stale"), would throw away a
better run set because of a few seconds of timing. It is used only when the Crown was
**reset onto new scenarios** while the challenge was played, because then there is nothing
on the same three to compare with.

### What may take a Crown: Verified or Consistent, every round

A run set qualifies when the match settled, every scenario has a run, and every run is
**Verified or Consistent**.

- **Rejected never counts.** A Rejected round already voids a contested match (uneven
  rounds), and a claim with one is refused by the tier check.
- **Suspect does not wear a Crown.** Ranked counts a Suspect run but holds it for review
  (PLAN.md §5). A Crown is a public title, so a run under review does not take one, even when
  settle-match calls the match a win. Tested: the screen says "a run is held for review".
- **Verified-only was considered and not chosen.** Verified needs a linked kovaaks.com
  account, which the primary test account does not have (PLAN.md §5). At this population a
  Verified-only Crown would be unclaimable by most players. The board shows the weakest tier
  among the holder's three runs ("Verified" or "Consistent") so a viewer can weigh it.
  Proposed, not done: Verified-only once most players link an account.
- A challenger must also pass the queue's eligibility bar (50 uploaded non-rejected runs,
  `requireEligible`), so a fresh account cannot challenge.

### Can a holder's own runs defend? No

A holder cannot challenge their own Crown (refused in SQL and in the function). Only other
players defend it. Defences count **distinct challengers beaten in the reign**: somebody who
loses twice is one defence and two challenges. An alt account can add at most one defence,
and only once a day. A void or forfeit is not a defence.

### Rate limits: one challenge per player per Crown every 20 hours

The three scenarios are fixed for a cycle, so unlimited attempts would hand the Crown to
whoever plays most. In a records process the best of k tries beats one try k times in k+1.
`validateCrowns.ts` replays it: a player who challenges five times a day among five players
holds the Crown **49%** of days without a cooldown and **20%** with one (a fair share is 20%).

Every opened challenge spends the cooldown, whatever it came to. A void or forfeit has to
count too, or quitting a bad run would be a free reroll. 20 hours, not 24, so a player who
plays at about the same time each evening is not refused by a few minutes. On top of that,
each function has a per-player limit in `_shared/rateLimit.ts`: `challenge-crown` 10 per 5
minutes, `list-crowns` 60, `race-action` 20, `race-status` 150 (the live view polls every 4s).

### Expiry: a reign lasts at most 7 days

With players drawn from one distribution, the holder after m qualifying run sets is the best
of m, so the next challenger takes it with probability 1/(m+1). The simulation reproduces
this (49.7%, 24.5%, 16.9%, 8.9% at m = 1, 3, 5, 10, against 50.0%, 25.0%, 16.7%, 9.1%).
Without a cap the board freezes:

| players | changes of hand in week 8, 7-day cap | uncapped | week 1 |
|---|---|---|---|
| 2 | 0.89 | 0.10 | 1.07 |
| 5 | 1.62 | 0.15 | 2.22 |
| 15 | 2.42 | 0.11 | 3.41 |

*Each player challenges a given Crown on about half their days, once a day; 400 trials of
8 weeks; spread of a three-round match score sigma = 4.45%, from the one measurement the repo
has of it (docs/overnight/mechanics.md, trailing-median ghost: p10 -5.6%, p90 +5.8%). Printed
by `npm run validate:crowns`.*

When a reign reaches 7 days it **lapses**. The holder is told how many defences they made,
and the Crown falls vacant onto a new cycle. The next claim draws three new scenarios. A
lapse waits for a challenge that is already being played, so nobody loses a chance
mid-match. A Crown whose scenarios leave the season is reset the same way (the holder is
told).

A re-defence rule (lapse after N days unchallenged) was rejected. At this population most
Crowns would go unchallenged for days, and the board would be empty most of the time.

### The comeback loop

When a Crown changes hands, the database writes a notice for the dethroned holder in the
same transaction. The next time they open the client, `list-crowns` returns it and the
client shows it on whatever screen it opened to, as a sentence:

> You lost the Precise Tracking Crown (Intermediate) to Kestrel after 3 defences. You held it
> for 2 days 21 hours.

On the Crowns screen it has a **Challenge back** button. A dethroned holder can usually take
it straight away: their cooldown is from their own last challenge, and they were the holder.
Holders also get a notice for each defence and for a lapse. Notices are readable only by
their owner: RLS (`crown_notices_read_own`), the function (scoped to the caller), and the
mark-as-read path (an update scoped to the caller). All three are tested with another player
trying.

## Live race (the secondary format), and why not Draft

**Draft** (draw five, ban to three) was the other option. In the async duel the challenger
plays first and never waits (PLAN.md §6). The three therefore have to be fixed before the
challenger plays. A blind ban by both sides then needs the challenger to play four or five
scenarios: `matches_three_scenarios` forbids that, and settle-match, send-duel and answer-duel
all assume three. Otherwise the challenger has to wait for the recipient's ban. Every option
rewrites the duel flow, which `fleet/social` is changing tonight for challenge links. High
collision risk for a ban screen.

**Live race** touches none of those paths. It needs a pairing, which I built as its own small
invite (three-minute expiry, one out at a time), and a view, which is a read. The spectacle
is the one an aim trainer does not have: two people's bars moving as their runs land.

### How a race works

1. A invites B (from the duel roster) to a category and band. The three are drawn then and
   shown to B with the invitation, which also appears as a toast on any screen.
2. B accepts. `race_start` locks both players in id order, checks neither is in a live match,
   and creates **two one-sided unrated matches with the same three and the same start** in
   one transaction. A's client learns of it on its next poll and takes up its match.
3. Each plays. Runs go through `submit-run` as always. Each leg settles on its own through
   `settle-match` (the one-sided path), which says "Bo is still playing" rather than the pool
   sentence.
4. When the second leg ends, the same trigger runs `race_resolve`. It locks the race row, so
   two legs ending together decide it once (tested: a draw). Higher match score wins. A leg
   that did not finish all three loses to one that did, whatever the score, so quitting
   cannot deny a result. Neither finishing is void.

### The sealed reveal

**You see the other side's round only once your own run on that scenario has landed.** Your
first run on a scenario is the one that counts, so by the time a round opens there is nothing
left you can do about it, and playing second buys no information. Until then you see that
they landed it, never how well. Their match score appears only once your own match has
ended. `validateRace.ts` checks all 144 landing combinations for any sealed number reaching
the viewer (0 leaks). `validateRaceDb.ts` checks the real handler round by round.

For a race this is enforced, not presented. The other player's match has no side of yours,
so RLS refuses it outright (tested: zero rows of their match, sides and runs, and the `races`
table refuses you). `race-status` is the only route to their numbers, and it applies the rule.

The duel rule (a recipient cannot see the challenger's score before answering) is untouched:
duels are not changed, and in a race nobody has played anything before both have agreed.

The same live view serves a **Crown challenge**: each of the holder's rounds opens as your run
on it lands. There the sealing is presentation only. The holder's run set is copied into your
match, and a participant can read a copied side through RLS, as in every ranked async match
today. The board already shows the holder's mean publicly as the bar to beat. Showing it is
deliberate. A duel recipient who saw the score first could pick only winnable duels at the
sender's expense; a low Crown bar is supposed to fall.

## What was built

| Layer | Files |
|---|---|
| Core | `src/core/crowns/crowns.ts` (rules), `src/core/crowns/view.ts` (board, result note), `src/core/race/race.ts` (sealed view, verdict), `src/core/race/view.ts` (race list, live view) |
| Schema | `supabase/migrations/20261003000025_crowns_and_races.sql`: `crowns`, `crown_reigns`, `crown_challenges`, `crown_notices`, `races`; `crown_open_challenge`, `crown_resolve`, `crown_lapse_due`/`_all`, `crown_reset_off_pool`, `crown_vacate`, `race_start`, `race_resolve`; trigger `matches_arena_ended` |
| Edge | `list-crowns`, `challenge-crown`, `race-action`, `race-status`; `_shared/arena.ts`; a small hook in `settle-match` (an `arena` note and the sentence for unrated Crown and race matches); rate limits |
| Client | `src/app/arena.ts` (main-side calls, polling, adoption), `src/app/arenaApi.ts`; IPC and preload methods; a **Crowns** tab (`renderer/crowns.js`, `race.js`, `crowns.css`); held label, forfeit confirm and opponent card branches in `renderer.js`; share cards labelled unrated |

## How it was tested

| Command | Result |
|---|---|
| `npm run validate:crowns` | core: comparator vs settleMatch (4,000 pairs), qualifying, seeding, take, defend, tie, repeat challengers, forfeits, stale cycle, simultaneous batches (3,000), lapse, cooldown, board, share card label, and the simulations above. DB (PGlite, shipped handlers): claims, one take from two concurrent challengers, best score wins in either order, Rejected, Suspect, abandoned and forfeited challenges cannot take, the live view sealing, notices owner-only (RLS, function, mark-read), lapse, lapse held by a live challenge, off-pool reset, no rating moved, and 120-step SQL vs reducer differential with 0 mismatches. **Pass** |
| `npm run validate:race` | core: sealed rounds, 144-combination leak search, verdicts vs settleMatch, views. DB: invitation rules, atomic start with the same three, a player in a match cannot start, sealed rounds through the handler, RLS refuses the other player's match, the result on the second leg, forfeit, expiry, a ten-minute quiet period after a decline, simultaneous finish decided once, Rejected leg loses, no rating moved. **Pass** |
| `xvfb-run -a npx electron tools/crownsUi.cjs --no-sandbox` (after `npx tsx tools/crownsUiFixture.ts`; `npm run validate:crowns-ui`) | board, notices and badge, cooldown, history, 860px layout, live challenge bar, bar inside the match panel, sealed race round, invitation toast, race panel, take and defend results, empty board, and what each button sends. **Pass**; screenshots inspected |
| `npm run attack:rls` | 18 new attacks on the five tables and the decision functions, 6 new read checks: **no holes found** |
| `npx tsc --noEmit`, `npm run validate:functions`, `npm run validate:schema` (includes ranked-boundaries) | **Pass** |
| every suite the brief lists as passing | see the report; all still pass |
| `npm run smoke` under Xvfb | the same 10 environmental failures as the base commit (no stats folder, no Supabase settings), none new |

Screenshots (not committed): `scratchpad/shots/arena/crowns-1-board.png` through
`crowns-10-board-empty.png`. The UI fixtures are built by the real view builders over
Season 1's scenario names, with invented players.

The database harness (`tools/arenaHarness.ts`) runs the shipped handlers and shared helpers
against PGlite with every migration applied. It replaces only identity, transport, the season
pool, the sweep's embedded join, and tournament notification. PGlite is one connection.
Overlapping promises interleave at every await and exercise the ordering, but **independent
connections taking row locks at once were not exercised**. The SQL is written for that case
(every decision takes the Crown or race row lock before it reads); this environment cannot
run it.

## Deployment order

1. `npx supabase db push`: migration `20261003000025_crowns_and_races.sql`. It must come
   before the functions: the trigger is what decides Crowns and races.
2. `npm run deploy:functions` (the four new functions are in the chain), including
   `settle-match`, which imports `_shared/arena.ts`. settle-match fails open if the tables are
   missing: the arena note is skipped and the match still settles.
3. `npm run verify:deployment` (the four functions refuse anonymous callers; the four closed
   tables refuse the anon key).

Nothing was deployed from here.

## Boundaries: what this does not do

- **Two independent connections were not tested** (see above).
- **Polling, not Realtime.** Invitations every 30s while focused (2 min behind the game);
  the live view every 4s during a race or Crown challenge. A race invitation can therefore
  take up to 30s to appear.
- **Races need both players online**, and a friend with no history on the three reads 0% per
  round (the baseline rule's no-history case). The live view marks provisional baselines;
  the race panel does not warn in advance.
- **Quests.** A Crown challenge or race leg is recorded on the quest board like any settled
  match, so it counts toward "Play a ranked match" and, when won against a holder,
  "weekly wins", as tournament legs already do. I followed that precedent rather than change
  quest policy. Worth a decision.
- **A restart mid-challenge** recovers the match through `fetchActiveMatch`, which does not
  know it is a Crown challenge. The live view is re-detected (one race-status call), but the
  held label reads "Match already open" until the next Crown action.
- **Pre-existing, made more likely:** `tournament_open_leg` counts a copied side in somebody
  else's open match as the player's own live match. A Crown holder whose set is being
  challenged cannot open a tournament leg for those minutes. Not changed here (tournament
  code); the arena SQL uses its own check that excludes copies.
- The crown glyph is a placeholder drawn in `crowns.css`/`crowns.js` for the brand kit to
  replace. The tracked `tools/apogee-ui-preview.html` was not regenerated; the builder now
  includes the new files.
- Holders get a notice for every defence. At a larger population that may be noisy; it is
  one query to change to "defences since you last looked".
