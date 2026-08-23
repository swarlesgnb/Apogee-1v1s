# Apogee: Ranked 1v1 for KovaaK's

> A competitive ladder layered on top of KovaaK's and the Voltaic S5 benchmarks. You
> queue, you get matched against someone near your rank, you both play the same three
> scenarios, and the ladder moves.
>
> The name is the high point of an orbit, which is the thing the ladder measures: not
> how long you have played, but how far you reached on the day. It shares its sky with
> the rank tiers, Stargazer through Supernova.

---

## 1. What this is

Apogee is **not an aim trainer**. KovaaK's owns that space and there is no reason to
compete with it. Apogee is a *layer* on top of KovaaK's that supplies the one thing
solo benchmark grinding cannot: an opponent.

The pitch in one line: **ranked matchmaking for aim, played inside KovaaK's.**

The player never leaves their normal routine. They open Apogee, queue for a category,
Apogee tells them which three scenarios to play, they alt-tab to KovaaK's and play them
exactly as they always would. Apogee watches the stats folder, picks up the runs
automatically, settles the match, and moves their rating. No score entry, no
screenshots, no honour system.

### Why this and not the quest system

The original idea was daily quests and XP. That was worth abandoning. Quests reward
*activity*, and activity is the thing a dedicated player already has: 11,000 runs sit
in the stats folder on this machine already. Ranked rewards **performance under
pressure**, which is genuinely absent from solo play and cannot be self-administered.

Quests survive as a secondary system (§11) because they give a reason to open the app
on a day you don't want to compete. They are not the headline.

### Competitive position

| | What it does | What it doesn't |
|---|---|---|
| **KovaaK's** | The trainer itself, global leaderboards | No matched competition; #4,182 of 58,017 means nothing emotionally |
| **evxl.app** | Passive benchmark tracker across platforms | Read-only. Shows you a number, asks nothing of you |
| **Voltaic** | Defines the benchmarks and rank thresholds | A standard, not a game |
| **Apogee** | Matched 1v1, rating, stakes | Doesn't train you; KovaaK's does that |

Nobody owns "matched competitive aim." That is the opening.

---

## 2. The core loop

```
   ┌─────────────────────────────────────────────────────┐
   │                                                     │
   │   pick a category ──▶ get matched ──▶ 3 scenarios   │
   │        ▲                                    │       │
   │        │                                    ▼       │
   │   rating moves ◀── match settles ◀── play in KovaaK's│
   │        │                                            │
   └────────┴────────────────────────────────────────────┘
                   ▲
                   │
        Apogee watches the stats folder and does
        every step after "play" without being asked
```

The entire post-play half of that loop is automatic. That is the product.

---

## 3. Match format

The player chooses a **category** (or "Any"). Apogee selects **three scenarios** from
that category at the player's difficulty tier. Both sides play all three.

For each scenario, Apogee computes a **delta**: how far the player scored above or below
their own established baseline on that scenario.

```
delta_i  =  (score_i − baseline_i) / baseline_i

match_score  =  mean(delta_1, delta_2, delta_3)

higher match_score wins
```

### Why normalized rather than raw score

Raw score is simpler but produces a dead ladder. The higher-ranked player wins
essentially every match, rank converges within a week, and every match after that is a
formality. Worse, raw score punishes scenario familiarity rather than skill: 500 hours
on Frogtagon beats genuine talent that has never seen it.

Normalizing against each player's own baseline means the question is *"who showed up
sharper today"*, which any two players can meaningfully contest. It also makes the
third-best player in the world and a Gold player both able to have a real match.

The cost is legibility: **"I scored more and still lost"** is a real experience and
must be handled in the UI, not hidden. Every match result screen shows both raw scores
and both deltas side by side, always, with the baseline visible. If players can't see
why they lost, they will assume the app is broken.

### The sandbagging exploit, and the fix

This is the serious flaw in a baseline-normalized system, and it must be designed
against from the start rather than patched later.

**The exploit:** deliberately play badly for a while, drag your baseline down, then
play normally and post a huge positive delta. Under a naive mean baseline this is
devastating and trivially easy.

**The fix, after measuring it:**

The first version used a high-water statistic (the mean of the top 30% of recent runs)
on the theory that deliberately bad runs never enter the top band. It worked, but
measuring it against 156 scenarios of real history showed it was solving the wrong half
of the problem and breaking the other half: **only 26% of genuine runs landed above
their own baseline**, so the delta distribution was skewed hard negative and matches
were decided by who avoided a blow-up rather than who played well.

| definition | mean delta | above baseline | sandbag drop |
|---|---|---|---|
| top 30% (first attempt) | −3.8% | 26% | 3.0% |
| **median** | **+0.4%** | **58%** | **3.5%** |
| plain mean | +0.6% | 60% | 9.3% |

The real defence turned out to be the **verified-PB floor**, not the high-water
statistic. Apogee knows the player's true PB from KovaaK's own servers (§5), so:

```
baseline_i = max( median(last 50 runs), 0.90 × verified_PB_i )
```

A player cannot claim a baseline meaningfully below their demonstrated ability, because
KovaaK's itself vouches for what they can do. With that floor in place a median is
centred *and* nearly as ungameable as the high-water statistic (3.5% vs 3.0%), while a
plain mean is three times more gameable (9.3%).

Reproducible on any corpus: `npm run compare:baselines`.

### New players and unplayed scenarios

A player with fewer than 5 runs on a scenario has no usable baseline. Fallbacks, in
order:

1. Their baseline on the other scenario in the same **sub-category**, scaled by the
   population-wide ratio between the two scenarios.
2. Their **sub-category** average, scaled the same way.
3. The **rank-cohort median** for that scenario.

Matches settled on fallback baselines are marked *provisional* and carry reduced rating
weight until the player has real history. Apogee's first-run backfill (§10) means an
existing KovaaK's player skips this entirely: 11,000 historical runs produce real
baselines instantly. **This is a genuine competitive moat: the app is most accurate for
exactly the players most likely to try it.**

### Categories

Confirmed against KovaaK's own API: all 54 scenarios resolved, zero missing.
Six scenarios per skill per difficulty, in three sub-categories of two.

| Skill | Sub-category | Scenarios |
|---|---|---|
| **Clicking** | Dynamic | `Pasu`, `Popcorn` |
| | Static | `1wXts`, `ww5t` |
| | Linear | `Frogtagon`, `Floating Heads` |
| **Tracking** | Precise | `PGT`, `Snake Track` |
| | Reactive | `Aether`, `Ground` |
| | Control | `Controlsphere`, `Raw Control` |
| **Switching** | Speed | `DotTS`, `EddieTS` |
| | Evasive | `DriftTS`, `FlyTS` |
| | Stability | `ControlTS`, `Penta Bounce` |

Both levels are now **authoritative**. The three skills come from KovaaK's `aimType`
field; the nine sub-categories are read from
[Voltaic's own published spreadsheet](https://docs.google.com/spreadsheets/d/1RjVJi9AdWLXIOkKR8z6mhmRo_SNokJPxKtLXHWk12Z4),
whose URL is recorded in evxl's registry, and regenerated by
`tools/fetch_voltaic_subcategories.py` rather than hand-typed.

**This table previously carried a hand-derived mapping that was wrong on 6 of 18
scenarios**: it swapped Tracking's Precise and Reactive groups entirely (`PGT` and
`Snake Track` are Precise, not Reactive), and swapped `DriftTS` with `Penta Bounce`
between Evasive and Stability. Inferring the mapping from scenario descriptions looked
reasonable and produced a plausible, confident, incorrect answer; only going to the
source settled it. The nine sub-category *names* guessed from descriptions were right,
which is exactly what made the wrong groupings easy to believe.

Queue options: the 3 skills, the 9 sub-categories, or Any. A sub-category queue draws
its 3 scenarios from a 2-scenario pool, so one repeats. That is acceptable, and it makes
sub-category queues a deliberate specialist choice.

### Scenario selection is seeded, not random

Both sides of a match must get the same three scenarios. The scenario set is derived
from a **seeded PRNG keyed on the match ID**, so it is reproducible, auditable, and
cannot be rerolled by a client. Weighting avoids scenarios either player played in the
last 24h where possible, to reduce warm-up advantage.

---

## 4. Rating system

**Glicko-2**, not Elo. Elo assumes regular play against a known-strength pool. Apogee
has sparse, asynchronous, bursty play with a small early population, exactly the case
Glicko-2's rating deviation (RD) was designed for.

- New players start at **1500 / RD 350** and converge fast during placements.
- RD widens with inactivity, so a returning player's rating moves quickly again.
- **10 placement matches** before a visible rank is assigned.
- Rating periods batch nightly.

### Rank tiers: Apogee's own

Apogee defines **its own rank ladder with its own names and colours**, deliberately not
reusing Voltaic's. Two parallel rank systems sharing the same words would be a permanent
source of confusion, and Voltaic's ranks mean something specific that Apogee has no right
to redefine. Any benchmark rank the player holds appears separately and clearly
labelled, as a *stat*, never as their Apogee rank.

Tier boundaries are set by **population percentile**, not fixed rating, so the
distribution stays meaningful as the player base grows.

Ranks are defined in a single themeable file, `data/apogee_ranks.json`, so the names,
colours, and the entire visual identity can be changed without touching application
code:

```jsonc
{
  "tiers": [
    { "name": "…", "percentile": [0, 20],
      "color": "#…", "glow": "#…", "gradient": ["#…", "#…"] }
  ]
}
```

Each tier carries a base colour, a glow, and a two-stop gradient, which is what makes
rank-up moments feel like something. The colour system drives rank badges, the queue
screen, match result screens, and the weakness map, so a theme change propagates
everywhere at once.

Tier naming is identity work, not engineering, so it lives in that file rather than in
code. Ten tiers run Stargazer to Supernova; anything from 5 to 12 works without code
changes.

---

## 5. Anti-cheat: the existential problem

**This determines the architecture. It is not a later concern.**

A KovaaK's score lives in a plain-text CSV in a folder the player owns:

```
Score:,1020.0
Scenario:,VT Frogtagon Intermediate S5
Hash:,ec8acdea37fa767767d705e389db1463
```

Anyone can open that in Notepad and type `99999`. The moment rank is at stake, people
will. **Most projects in this space die here.** Any design that trusts the local file is
already dead.

### The solution: KovaaK's own servers are the referee

KovaaK's public backend is unauthenticated and returns server-side score records:

```
GET kovaaks.com/webapp-backend/leaderboard/scores/global?leaderboardId=105828&page=0&max=2
```
```json
{ "steamId": "76561199224724634", "score": 1990, "rank": 1,
  "attributes": {
    "hash": "ec8acdea37fa767767d705e389db1463",
    "epoch": 1770677553117,
    "challengeStart": "19:53:04.761",
    "avgFps": 594.3, "cm360": 49, "resolution": "1920x1080",
    "clientBuildVersion": "3.8.5.2026-01-22-16-15-48-0af0bb4eb449" }}
```

`hash`, `challengeStart` and `epoch` are **the same fields present in the local CSV**.
A forged local file cannot produce a matching record on KovaaK's servers.

### Better than planned: recent runs, not just personal bests

This plan originally assumed KovaaK's exposes only the **personal best** per scenario,
which would leave every sub-PB match run unverifiable. **That assumption was wrong, and
finding out improved the model considerably.**

```
GET kovaaks.com/webapp-backend/user/scenario/last-scores/by-name
      ?username=<kovaaks webapp username>&scenarioName=<scenario>
```

returns the player's **~10 most recent runs**, each with `hash`, `epoch`,
`challengeStart`, `avgFps`, `cm360` and `modelOverrides`. Confirmed live: 10 runs
returned, with distinct scores, so these are genuinely recent history rather than a
repeated best.

A match run is therefore verifiable **whether or not it was a personal best**, as long
as it is played within the player's last ten runs on that scenario, which during a
match, it always is. `challengeStart` pins it to the millisecond, so a specific run can
be located rather than merely a matching score.

### The account-link problem, and how it is closed

Those endpoints key on a KovaaK's **webapp username**, which is a separate registration
from Steam. A player could therefore name someone else's account and inherit their run
history. So the link is verified rather than trusted:

```
GET kovaaks.com/webapp-backend/user/search?username=<claimed>
      -> { steamId, username, steamAccountName, ... }
```

The returned `steamId` must equal the SteamID the player actually signed in with. RLS
forbids a client from writing `players.kovaaks_username` at all; only the Edge Function
that performed this check may set it.

### The remaining honest limitation

Not every player has a kovaaks.com webapp account: it is a separate signup, and the
primary test account on this machine does not have one. For those players the
`last-scores` endpoint is unavailable and verification degrades to local checks plus
benchmark progress, landing at **Consistent** rather than **Verified**.

That is a graceful degradation, not a hole: local checks alone already reject every
tampering method tested except ones that cannot inflate a score (§ below). Prompting
players to link a KovaaK's account (and showing the Verified badge when they do) is
the natural incentive, and costs nothing to build.

### Verification tiers

Every submitted run is graded, and the grade is **visible on the match screen**, because social
pressure does real work here.

| Tier | Condition | Rating effect |
|---|---|---|
| **Verified** | Matching record on KovaaK's servers: same `hash`, `challengeStart`, `steamId`, `epoch` in window | Full |
| **Consistent** | No server record (sub-PB run), but CSV internally consistent, timed inside the match window, and `score ≤ verified_PB × 1.02` | Full, flagged |
| **Suspect** | `score > verified_PB × 1.02` with no server record | Counted, held for review, **not** auto-voided |
| **Rejected** | CSV internally inconsistent, replayed `csv_sha256`, or timing outside the match window | Match void, account flagged |

### Measured: local PBs legitimately exceed server PBs

The first draft of this plan auto-voided any score above the verified PB with no server
record. **Checking that against real data showed it would produce false positives.**

Comparing 18 local Voltaic S5 Intermediate bests against the same account's KovaaK's
records: **16 matched exactly, 2 did not**: `Aether` (local 2775 vs server 2708) and
`DotTS` (local 1209 vs server 1199.5). Both local runs are internally valid.

The obvious explanation (the scenario was revised, invalidating old scores) was tested
and **rejected**: all 100 local `Aether` runs from February to August 2026 carry the
identical hash `c4c11bf8…`. The scenario is stable. The remaining explanation is simply
that those runs never reached KovaaK's servers: offline play, a crash before submission,
or a failed network call.

So roughly **1 in 9 genuine personal bests may be missing server-side**. A rule that
voids matches on that basis would punish honest players at a rate no ladder survives.
Hence the **Suspect** tier: such a run still counts, but is flagged, and escalation
depends on repetition and magnitude rather than a single occurrence.

Two useful side findings:

- **Scenario hashes are stable over long periods**, which makes `Hash:` a dependable
  integrity check rather than a moving target.
- Local history is a *superset* of server history, so Apogee's own record of a player is
  richer than KovaaK's, which is good for baselines, and a reason the desktop client matters.

### CSV internal consistency checks

Cheap, local, and they catch naive edits immediately:

- Kill rows must reconstruct the summary `Score:` (e.g. Frogtagon: 102 kills × 10 = 1020.0 ✓)
- `Kills:` must equal the kill row count
- `Hit Count:` + `Miss Count:` must equal `Shots` in the weapon block
- Kill timestamps must be monotonic and fall within the scenario duration
- `Hash:` must match the known-good hash for that scenario
- Per-kill TTK distribution must be physically plausible (no sub-20ms human reactions)
- File mtime and `Challenge Start:` must fall inside the match window

### Measured, then corrected

Every check above was run against **11,058 genuine runs** before being allowed to reject
anything. The first draft was badly wrong, and only measurement showed it:

| Check | First attempt | False positives | Fix |
|---|---|---|---|
| `ttk_plausible` | reject TTK < 20ms as "faster than human reaction" | **62.0%** | Misread the field: KovaaK's TTK is first-hit-to-kill within a burst, not reaction time. Now only rejects negative values |
| `score_sane` | reject negative scores | 3 runs | Pressure scenarios legitimately score negative (−160, −54, −500). Now bounds magnitude only |
| `kill_sequence` | require one row per kill, numbered from 1 | 0.85% | `Kill #` is a running **counter**, not a row index; penalty-bot rows repeat it, multi-kills skip it, and numbering starts at 0 or 1. Now requires only that it never runs backwards |

Final state: **every hard check has a 0.00% false-positive rate across all 11,058 runs.**

A check that flags honest players is worse than no check, so anything that could not
reach zero was demoted to advisory rather than kept.

### The strongest check was discovered, not designed

Editing `Score:` and nothing else defeats every structural check: the file stays
perfectly coherent. That looked unfixable locally.

It isn't. Most scenarios score as a **fixed multiple of a countable stat**, and that
multiple is a property of the scenario:

```
VT Frogtagon Intermediate S5   score = kills      * 10
VT Aether Intermediate S5      score = hitCount   * 1
```

Learning that relation from observed runs (`data/score_models.json`, derived across 283
scenarios with enough history) lets the score be **re-derived from the run's own
counters**. Result: **219 scenarios modelled (77.4%)**, 0.00% false positives, and a
**+1% score edit is caught**. Scenarios with no learned model skip the check rather than
failing it, so it can never punish what it cannot model.

### What tampering is caught

Verified by mutating genuine runs:

| Attack | Outcome |
|---|---|
| Absurd score (999999) | rejected |
| Score edited +8% | rejected |
| Score edited +1% | rejected |
| Hit count inflated | rejected |
| Weapon shot count edited | rejected |
| Kill timestamps reordered | rejected |
| Negative TTK | rejected |
| Kill rows deleted **and** kill count adjusted to match | rejected |
| Kill row deleted or duplicated alone | **advisory only** |
| Score edit on an unmodelled scenario | **not caught locally** |
| Genuine run, incl. legitimately negative scores | correctly accepted |

The two gaps are stated rather than hidden. Neither row-level edit can inflate a score,
and the unmodelled-scenario gap shrinks as history accumulates and more models are
learned. Both are covered by server-side verification where a KovaaK's account is
linked.

**Measured against the real folder: kill rows are not always present.**

| Aim type | Runs | Have kill rows |
|---|---|---|
| Clicking | 243 | **100.0%** |
| Target Switching | 139 | **100.0%** |
| Tracking | 277 | **76.2%** |

The gap is structural, not a parser bug: tracking scenarios built around an
*invincible* target (`Controlsphere`, `Raw Control`, `Snake Track`) score at a rate and
never register a kill, so there are no rows to reconstruct from. Tracking scenarios with
killable targets (`Aether`, `Ground`, `PGT`) do produce rows.

So the row-reconstruction check covers clicking and switching completely, and tracking
partially. **Invincible-target tracking runs need a separate local check**, based on the
weapon-block `Shots`/`Hits`/`Damage Done` totals and the scenario's known scoring rate,
rather than on kill rows. Those runs lean correspondingly harder on server-side
verification, worth knowing before the verification service is written, not after.

### Steam identity

Steam OpenID login binds an Apogee account to a `steamId`, which is what KovaaK's
leaderboards key on. Without this the verification model does not work at all, so it is
**required at signup**, not optional.

### What this does not stop

Stated plainly so it isn't discovered later: hardware cheats (aimbots) that produce
genuine KovaaK's scores are **invisible to this design**, because KovaaK's itself
accepts them. Mitigation is statistical anomaly detection on top-end accounts plus
human review of the top ranks, the same answer every competitive game arrives at.
This is acceptable for launch and should be stated publicly rather than oversold.

---

## 6. Cold start

A synchronous 1v1 queue with five users is an empty queue, and an empty queue kills the
app in week one. Apogee therefore ships **asynchronous**.

**Async matches:** you are matched against a *stored run set* from a player near your
rating. Their delta was computed and frozen when they played. You play the same three
scenarios; the result settles the moment your third run lands.

This works with **one** player online, and every match played deepens the pool for
everyone else. The 11,000 historical runs on this machine can seed the pool on day one.

**Live mode ships at ~100 concurrent players.** The matchmaking, rating,
verification and settlement layers are identical for both modes; live adds a queue
server, a countdown, and realtime score reveal, and nothing else. Building async first
costs nothing later.

---

## 7. Architecture

```
┌──────────────────────────────────────────────────────────┐
│  APOGEE DESKTOP CLIENT          Electron + React + TS    │
│                                                          │
│  main process          renderer                          │
│  ├─ chokidar watcher   ├─ queue / match / result UI      │
│  │  on stats/*.csv     ├─ weakness map                   │
│  ├─ CSV parser         ├─ profile, quests                │
│  ├─ local SQLite       └─ framer-motion juice            │
│  │  (cache + offline)                                    │
│  └─ Supabase client                                      │
└───────────────┬──────────────────────────────────────────┘
                │ HTTPS
┌───────────────▼──────────────────────────────────────────┐
│  SUPABASE                                                │
│  ├─ Auth        Steam OpenID → steamId                   │
│  ├─ Postgres    runs, matches, ratings, quests, baselines│
│  ├─ RLS         clients never write ratings directly     │
│  ├─ Edge fns    verification, settlement, matchmaking    │
│  └─ Realtime    (live mode, later)                       │
└───────────────┬──────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────┐
│  KOVAAK'S PUBLIC API        server-side score verification│
└──────────────────────────────────────────────────────────┘
```

**Electron over Tauri** for v1: the Supabase JS SDK, chokidar, and the animation-heavy
UI all work first-try, and iteration speed matters far more right now than a 150MB
install. Tauri is a clean swap later if bundle size becomes a real complaint, since the
renderer is portable as-is.

### The security rule that everything depends on

**The client never computes anything that matters.** It parses CSVs and uploads raw run
data. All deltas, baselines, verification and rating changes are computed in Edge
Functions, and Postgres RLS forbids clients from writing to `ratings`, `matches`, or
`baselines`. A client that can write its own rating is a client that will.

---

## 8. Data model

```sql
players        id, steam_id, display_name, created_at, flags
runs           id, player_id, scenario_id, score, accuracy, avg_ttk,
               played_at, challenge_start, hash, csv_sha256,
               verification_tier, match_id (nullable), raw_stats jsonb
scenarios      id, name, leaderboard_id, aim_type, sub_category,
               difficulty, top_score
baselines      player_id, scenario_id, value, run_count, computed_at
verified_pbs   player_id, scenario_id, score, epoch, synced_at
matches        id, mode, category, seed, scenario_ids[], status,
               created_at, settled_at
match_sides    match_id, player_id, run_ids[], deltas[], match_score,
               result, rating_before, rating_after, rd_before, rd_after
ratings        player_id, rating, rd, volatility, tier, updated_at
quests         id, player_id, kind, params jsonb, progress, target,
               expires_at, claimed_at
```

`csv_sha256` gives replay-attack protection: the same file can never be submitted
twice.

---

## 9. Stats ingestion

The parser is the foundation everything else stands on, so it gets built and tested
first, against the 11,058 real files already on disk.

Filename: `<Scenario> - Challenge - YYYY.MM.DD-HH.MM.SS Stats.csv`

Three blocks per file:
1. Per-kill rows: `Kill #, Timestamp, Bot, Weapon, TTK, Shots, Hits, Accuracy, …`
2. Weapon summary
3. Key-value tail: `Score:`, `Scenario:`, `Hash:`, `Challenge Start:`, `Avg FPS:`, sens, resolution

Requirements:

- **Backfill on first run.** Parse the entire stats folder, build baselines and history
  from day one. This is the single best onboarding moment the app has: a new user sees
  their real ranks and weakness map within 60 seconds of installing, having done nothing.
- **Watch, debounced.** KovaaK's writes the file progressively; parse on a settle
  timeout, not on first write event, or you get truncated reads.
- **Ignore non-benchmark variants.** The stats folder contains `VT Pasu Advanced S5
  Hard`, `VT Aether Novice S5 Bot 2`, `… 90%`. These are practice variants and must
  never count. Exact-name matching against the 54-scenario table only.
- **Tolerate malformed files.** Crashes and alt-F4 mid-run leave partial CSVs. Skip and
  log; never crash the watcher.

---

## 10. Quests: personalized by benchmark

Quests are **not hardcoded to Voltaic**. The player pastes the evxl link for whichever
benchmark they are actually grinding, and Apogee generates quests against *that*
benchmark's real scenarios and thresholds.

```
┌──────────────────────────────────────────────────────┐
│  Track a benchmark                                   │
│  ┌────────────────────────────────────────────────┐  │
│  │ https://evxl.app/benchmarks/Voltaic%20S5       │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ✓ Voltaic S5 — Intermediate                         │
│    18 scenarios · Platinum → Master                  │
│    You currently sit: Diamond (4 scenarios to Jade)  │
└──────────────────────────────────────────────────────┘
```

**This is fully solved and proven** (§11). Any of the **133 benchmarks** evxl tracks
works: Voltaic S5/S5.5/S4, Revosect, Aimerz+, Viscose, TSK, and the long tail of
community benchmarks. The player can track several at once and pick which drives their
daily quests.

Resolution flow:

```
evxl URL ──▶ benchmarkName ──▶ evxl registry ──▶ kovaaksBenchmarkId
                                                        │
                                                        ▼
                              KovaaK's benchmarks API: rank_maxes,
                              rank names, leaderboard ids, colours
                                                        │
                                                        ▼
                              cached definition ──▶ quest generation
```

Quest kinds, generated against whatever benchmark is tracked:

- *Rank up one scenario in **{tracked benchmark}***, the original idea, now generalised
- *Beat your baseline in any {weakest category} scenario*
- *Play 3 {category} scenarios today*
- *Win a match in your weakest sub-category*
- *Play 3 days in a row*
- *Close the gap: you are 40 points from **{rank}** in {scenario}*, computed from real
  thresholds, so it can name an exact, achievable target

That last kind is only possible because the thresholds are real, and it is the most
motivating quest in the list: a specific number, on a specific scenario, that moves a
rank the player already cares about.

Auto-completed from parsed runs. Quest XP feeds an account level and cosmetic titles,
somewhere for the points to go that doesn't touch competitive integrity. **Quest XP must
never influence Apogee rating**, or the ladder becomes a grind.

---

## 11. Benchmark data pipeline: solved

The original plan flagged the ~250 Voltaic score thresholds as an open blocker needing a
spreadsheet export. **That blocker is gone.** The data is available officially and for
free, and the path was found by reading evxl's own client bundle to see where *it* gets
the numbers. The answer: evxl doesn't own them either. It reads KovaaK's API.

**Two build-time steps, both committed to `data/` so the app never depends on either
service being reachable at runtime:**

1. `tools/scrape_evxl_bundle.py` + `tools/extract_evxl_registry.py`
   → `data/evxl_registry.json`: **133 benchmarks**, each with `kovaaksBenchmarkId`,
   `rankColors`, category structure.

2. `tools/fetch_benchmark_defs.py`
   → `data/benchmarks/*.json`, per difficulty: rank names, **per-scenario
   `rankMaxes`**, category energy maxes, `leaderboardId`.

Verified live. Voltaic S5 Intermediate, straight from KovaaK's:

```
rankNames  ['Platinum', 'Diamond', 'Jade', 'Master']
rankColors {Platinum #2FCFC2, Diamond #B9F2FF, Jade #85FA85, Master #EC44CA}

Clicking   category maxes [15000, 30000, 45000, 60000]
  VT Pasu Intermediate S5     [770, 850, 930, 980]     lb 98330
  VT Popcorn Intermediate S5  [600, 690, 780, 860]     lb 98333
Switching  category maxes [17500, 35000, 52500, 70000]
  VT DotTS Intermediate S5    [1110, 1180, 1230, 1280] lb 104865
```

All four Voltaic S5 difficulties resolved, 18 scenarios each, including
*Elite (Unofficial)* with its Stellaris / Lunara / Solara tiers.

Passing the player's real SteamID to the same endpoint also returns their **actual
score, scenario rank, and overall benchmark progress**, so Apogee can show verified
benchmark standing without computing anything itself.

---

## 12. Weakness map

A radar/heat visual over the sub-categories of the tracked benchmark, showing the
player's rank in each, computed from real history against real thresholds. Its job is to
answer *"what should I practise today"* and then hand that straight to the queue button.

This is the most **retention-relevant** feature in the plan and the lowest
competitive-risk: it makes Apogee useful on days the player doesn't want to compete, and
it feeds back into matches by suggesting a category.

Colours come from the tracked benchmark's own `rankColors`, so a Voltaic user sees
Voltaic's palette here while Apogee's own palette (§4) governs the competitive ladder.
The two systems stay visually distinct on purpose.

**No longer blocked.** Thresholds are solved (§11).

---

## 13. Build phases

Each phase ends somewhere real, and the early ones need no backend at all.

| Phase | Deliverable | Backend |
|---|---|---|
| **0** | Scenario taxonomy (**done**, 54/54 resolved) | none |
| **0b** | Benchmark data pipeline (**done**, 133 benchmarks, real thresholds) | none |
| **1** | CSV parser + folder watcher, validated against 11,058 real files | none |
| **2** | Local history, baselines, benchmark ranks, weakness map | none |
| **3** | Apogee rank theme + custom colour system | none |
| **4** | Supabase schema, Steam auth, run upload | yes |
| **5** | KovaaK's verification service + tiers | yes |
| **6** | Async matchmaking, settlement, Glicko-2 (**done**) | yes |
| **7** | Match UI, ranks, profile, juice (**done**, preview) | yes |
| **8** | Quests driven by a pasted evxl link (**done**) | yes |
| **9** | Electron shell around the UI (**done**) | yes |
| **10** | Closed beta (**gated on population**; preflight built, `npm run beta`) | yes |
| **11** | Live sync mode at ~100 concurrent (**done**, awaiting population) | yes |

Every phase is built, validated and deployed. What is left is not code: the ladder
needs people on it before a match can settle or a beta can mean anything.

Phases 1–3 were the right place to start, and the reason is worth keeping: they produce
a genuinely useful standalone app (history, real benchmark ranks, weakness map, a rank
theme) and they de-risk the parser everything else stands on, with no hosting
decisions, no auth, and no cost. A contributor picking this up should still read them
first.

---

## 14. Seasons, and three ladders

Two changes that belong together, because each answers the other's hardest question.
Scheduled next; nothing here is built.

### Three ranks, not one

`Tracking`, `Clicking` and `Switching` each get their own rating and their own tier.
You queue a category, you rank in that category, and "what is my Tracking rank" stops
being unanswerable. An overall tier is derived from the three so there is still one
number that means *you*, but it is a readout rather than the thing that moves.

This is a schema change: `ratings` is keyed on `player_id` alone today, and becomes
`(player_id, category)`. Matchmaking, settlement and `rating_history` follow it, and
`match_sides` already records the ratings it used, so past matches stay readable.

### Where thresholds come from

The obvious plan is to write our own numbers, and the obvious plan is a trap: it swaps
*Voltaic changing them* for *us maintaining them*, and ours would be guesses where
theirs are grounded in a real population. That is a worse position, and it fails the
first time somebody asks why a rank is where it is.

Thresholds are therefore **derived from Apogee's own population**, the same principle
§4 already uses for the ladder, applied one level down: a rank on a scenario is a
percentile of what Apogee players actually score on it. Nothing to maintain, nothing to
go stale, and the answer to "why is Diamond 930" is a fact rather than an opinion.

### One ladder, three scenario windows

A ladder has to hold both a first-week player and a good one, and one set of scenarios
cannot measure that range. A perfect run on something easy stops proving anything at some
point; past that point the ladder needs harder scenarios or it stops measuring.

Season 1's first cut got this wrong in the most instructive way. It took Voltaic
Intermediate's four thresholds and extended them by repeating the last step four times,
and the result was broken at both ends: rank 1 was Voltaic Platinum, so most players were
unranked and saw no progress at all, and the top four ranks were a straight line where the
real curve steepens, so a strong player cleared all four at once. Both halves of "too
hard for a newcomer *and* too easy at the top" came from the same mistake.

The fix is not three benchmarks a player chooses between - that re-imports the §4
confusion one level down, and it makes matchmaking ask a question it should never have to.
It is **one ladder cut into windows**:

```
ranks  1- 4   Novice variants        VT Pasu Novice S5        555  660  745  800
ranks  5- 8   Intermediate variants  VT Pasu Intermediate S5  770  850  930  980
ranks  9-12   Advanced variants      VT Pasu Advanced S5      910 1020 1110 1240
```

The six scenario **families** per category are the unit that gets graded, not the eighteen
variants. A family's energy is the *best* of its variants, offset by the ranks below its
window, so:

- a player only ever plays the six scenarios their band uses, and the ladder is twelve
  ranks deep without being three times the grind
- a maxed Novice scenario reads as "this proves rank 4, and cannot prove more", which is
  the honest thing to say about a perfect run on something easy
- above window 0 a variant is *silent* below its own first threshold rather than
  interpolating from zero, so a bad score on a hard scenario cannot be credited as though
  it were a good one on an easy scenario
- the app can name the scenario the next rank is scored on, which is the one thing a
  windowed ladder must never leave implicit

Where one window hands over to the next is Voltaic's judgement in season 1 and a
measurement in season 2: with players who have run both variants of a family, the
handover point can be regressed rather than assumed.

The **match pool** is a separate question and stays one window. Settlement compares a
player against their own baseline (§3), so a beginner and a Celestial already get a real
contest on the same scenario, and splitting the pool by window would divide a small
population three ways for nothing. `find-match` already partitions by
`(category, difficulty)`, so banding it later is a change of one field.

### Why seasons make that work rather than complicate it

Derived thresholds have one flaw: they move. A player grinding toward a rank does not
want the target sliding while they chase it, and a ladder whose meaning shifts weekly
cannot be talked about.

A season fixes exactly that, and nothing else has to. A season is a **frozen
definition** - a scenario pool and a set of thresholds - held still for its duration:

```
season N thresholds  =  percentiles of season N-1's population, computed once, frozen
season 1 thresholds  =  seeded from the existing corpus and the published Voltaic
                        numbers, which become a starting point we own rather than a
                        dependency we track
```

So the numbers are grounded *and* stable, which neither property gets on its own. The
pool can change between seasons, ratings can soft-reset, and the thing that brings
people back is the same thing that keeps the data honest.

### What this does not change

The ladder still never reads a threshold. Match settlement compares a player against
their own baseline (§3) and nothing else, which is why seasons can re-cut ranks without
touching how a match is decided. Thresholds feed quests, the weakness map and the
consistency report - the surfaces §4 already calls *stats* rather than standing.

### The order to build it in

1. Own the pool. A season file naming the scenarios per category, read where
   `data/benchmarks/*.json` is read now. No invented scenarios: the fifty-four across
   Voltaic's three difficulties are proven and already hosted, and authoring new ones is
   a different project. **Done.**
2. Seed season 1's thresholds from the corpus, and check them against the published
   Voltaic numbers - not to copy them, but because a large unexplained divergence
   would mean the derivation is wrong. **Done**, and the check earned its place twice: it
   caught the stretched single-window ladder, and it caught Voltaic's Switching energy
   thresholds asking 17,500 per rank where six families can only ever produce 15,000 -
   a top rank unreachable at any score, in their published numbers as well as ours.
   `validateSeason` refuses that shape now.
3. Split `ratings` per category, with the derived overall on top.
4. Only then the rollover: compute season 2 from season 1's population.

Steps 1 and 2 are worth having on their own even if seasons never ship, which is the
right shape for a plan this size.

---

## 15. Open questions and risks

**Open**

1. **Population.** Everything is built and deployed, and no match has settled, because
   settling one needs an opponent and the pool stays empty until somebody plays a
   category through. This is no longer an engineering problem; it is the cold-start
   problem of §6, and async is the answer to it.

**Resolved:**

- ~~Name~~ → **Apogee**. Settled. The Supabase project already carries it; the client,
  the README and the module names still say Apogee and are yet to follow.
- ~~Deployment~~ → **done**. Schema, RLS, Steam auth and five Edge Functions are live
  and verified against the running project by `npm run verify:deployment`.
- ~~Apogee rank tier names and colours~~ → **done**. Ten tiers, Stargazer through
  Supernova, with the top three widened from 1% to 5/4/2% so they are not permanently
  empty at a small population.
- ~~Sub-category mapping is provisional~~ → **resolved** (§3). Read from Voltaic's own
  spreadsheet, and the hand-derived version it replaced was wrong on 6 of 18 scenarios.

**Resolved during planning:**

- ~~Voltaic S5 score thresholds need a spreadsheet export~~ → **solved** (§11). Official,
  free, and generalises to all 133 benchmarks.
- ~~evxl has no machine-readable data~~ → **solved**. Its registry was recoverable from
  the client bundle, and it points at KovaaK's own API.

**Risks:**

| Risk | Severity | Response |
|---|---|---|
| Hardware cheats produce genuine scores | High | Unsolvable at this layer. Statistical review at top ranks; be honest publicly |
| KovaaK's API changes or blocks us | High | Cache aggressively, degrade to Consistent tier, never hard-depend on liveness |
| Cold start: nobody queues | High | Async-first (§6) makes this survivable rather than fatal |
| "I scored more and lost" confusion | Medium | Show raw scores, baselines and deltas on every result screen |
| Baseline sandbagging | Medium | High-water baseline + verified-PB floor (§3) |
| KovaaK's objects to the whole thing | Medium | Talk to them early. Apogee drives engagement *to* KovaaK's, so the pitch is friendly |
| Voltaic objects to benchmark use | Low | Benchmarks are public and widely used; credit prominently, don't reuse their rank names |

---

## 16. Parked ideas

Not scheduled. Recorded so they are not lost.

### Solo mode: matches against your own past runs

Queue against *yourself*: your recent run set becomes the opponent, and the match is
won by beating the version of you that played it.

Worth noting how little this would cost. Async matchmaking already plays a live player
against a **stored run set** (§6), and the only rule stopping a player facing their own
is one explicit guard in `findOpponent`. Baselines, deltas, settlement and verification
all work unchanged, because none of them care who the opponent is.

Two things would need thought rather than code:

- **What it does to rating.** Almost certainly nothing: beating yourself is not
  evidence about the population, and letting it move the ladder would be farmable.
  Better as quest and streak progress only, on the same principle that keeps quest XP
  out of rating (§10).
- **Which past self.** Your run set from last week is a very different opponent from
  your best-ever, and they mean different things: one is "am I improving", the other is
  "can I still hit my peak". Both are interesting; they are not the same feature.

It also fixes the cold-start problem completely for a player who has nobody to face,
which makes it more valuable at launch than it looks.

---

## 17. Verified facts

Everything below was confirmed against live data during planning, not assumed.

**Local environment**
- KovaaK's install: `E:\Steam\steamapps\common\FPSAimTrainer`
- Stats folder `…\FPSAimTrainer\FPSAimTrainer\stats` holds **11,058 CSVs**, active VT S5 runs
- CSV exposes `Score:`, `Scenario:`, `Hash:`, `Challenge Start:`, per-kill rows, sens, FPS
- Tooling present: Python 3.13.9, Node 24.13.0, npm 11.6.2

**KovaaK's public API**, unauthenticated, and the backbone of this design
- `scenario/popular` → `leaderboardId`, `aimType`, `topScore`. **54/54 VT S5 resolved**
- `leaderboard/scores/global?leaderboardId=` → `steamId`, `score`, `hash`, `epoch`,
  `challengeStart`, `avgFps`, `cm360`: basis of the entire verification model (§5)
- `benchmarks/player-progress-rank-benchmark?benchmarkId=&steamId=` → **per-scenario
  `rank_maxes`**, category maxes, rank names + icons, `leaderboard_id`, and the player's
  own score and rank. Basis of the benchmark pipeline (§11)

**evxl.app**
- A SvelteKit SPA. `__data.json` routes return empty; nothing useful in the HTML shell
- Runtime API at `api.evxl.app`: `/rank-counts` works and lists **58 ranked benchmarks**
- Its full benchmark registry ships inside the client bundle: **133 benchmarks** with
  `kovaaksBenchmarkId`, `rankColors`, and category structure. This is how an evxl URL
  gets resolved to real threshold data (§10)

**Voltaic**
- `app.voltaic.gg` is a Nuxt app backed by Supabase; no public benchmark endpoint found,
  and none needed, since KovaaK's serves the same data officially
- **Voltaic S5.5 exists** (Advanced, 21 scenarios) and is newer than the S5 set
  currently being played on this machine
