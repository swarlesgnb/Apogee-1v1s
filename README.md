# Apogee

Ranked 1v1 for KovaaK's. Queue for a category, get matched against someone near your
rank, play three scenarios in KovaaK's as normal, and the ladder settles itself. Scores
are read straight from the stats folder, never typed in.

See [PLAN.md](PLAN.md) for the full design: match format, rating, anti-cheat, and the
phased build.

## Status

| Phase | | |
|---|---|---|
| 0 | Scenario taxonomy | done, 54/54 Voltaic S5 scenarios resolved |
| 0b | Benchmark data pipeline | done, 121 benchmarks, real thresholds |
| 1 | Stats parser + validation | done, 100% of 11,058 real files, 0 exceptions |
| 2 | History, baselines, ranks, weakness map | done, engine matches KovaaK's exactly |
| 3 | Apogee rank theme + visual editor | done, 10 named tiers |
| 4 | Supabase schema, Steam auth, run upload | done, deployed and verified live |
| 5 | Verification: local integrity + KovaaK's cross-check | done, 0% false positives |
| 6 | Glicko-2, scenario selection, settlement, matchmaking | done, ladder sorts at r=0.998 |
| 7 | Client UI | done, interactive preview on real data |
| 8 | Quests from a pasted evxl link | done, all 121 benchmarks trackable |
| 9 | Electron desktop client | done, boots, watches, renders |
| 10 | Closed beta | gated on population, preflight built |
| 11 | Live sync matchmaking | done, starvation-free, awaiting population |
| 12 | Server-side match engine | done, 5 Edge Functions deployed |
| 13 | Client wired to the backend | done, sign-in + upload + match loop live |
| 14 | First real match | **waiting on a benchmark run** |

### Where things actually stand

The whole loop is built and deployed. What has never happened is a match, because a
match needs an opponent and the pool is empty until someone plays a category once.

Done and verified live:

- Steam sign-in works end to end (`Watchmojo`, steam `…540626`)
- **11,104 runs** uploaded
- **84 baselines** computed, 22 solid, including all 18 Voltaic S5 Intermediate scenarios
- rating row exists at 1500 / rd 350, 0 matches

To finish the loop, from the Queue tab: pick a category, hit Find opponent (expect
"nobody to play yet"), play the three scenarios anyway so they seed the pool, then queue
again. Runs submit themselves as they land; the match settles itself when the third one
does.

## Quick start

```bash
npm install

npm run profile          # your benchmark ranks and weakness map, from local stats
npm run ranks            # the Apogee rank ladder, with self-tests
npm run validate         # every suite against real data
npm run typecheck
```

`npm run profile` takes optional flags:

```bash
npm run profile -- --benchmark voltaic-s5 --difficulty Advanced
npm run profile -- --stats "D:\path\to\FPSAimTrainer\stats"
```

## Rank theme

Apogee's ladder has its own tier names and colours, kept deliberately separate from
Voltaic's. Benchmark rank and ladder standing are different claims and must not share a
vocabulary. Tiers are assigned by **population percentile**, so a tier keeps its meaning
as the player base grows.

Ten tiers run from Stargazer to Supernova, defined in `data/apogee_ranks.json`. Nothing
in the code keys off the names, so they can be renamed freely.

Open `tools/rank-theme-editor.html` in a browser to edit the palette visually: badges,
ladder distribution, a match card built from real scores, and the promotion moment all
update live. Copy the generated JSON back into `data/apogee_ranks.json`, then run
`npm run ranks` to confirm the bands still tile 0 to 100 with no gap or overlap.

## Layout

```
data/
  scenario_taxonomy.json     54 Voltaic S5 scenarios, aim types, leaderboard ids
  evxl_registry.json         121 benchmarks with KovaaK's ids + rank colours
  subcategories.json         the nine Voltaic sub-categories, from Voltaic's sheet
  apogee_ranks.json          Apogee's own rank tiers, names and colours
  score_models.json          learned score = stat * k relations, for verification
  benchmarks/*.json          full definitions: thresholds, ranks, colours
src/core/
  stats/                     KovaaK's CSV parsing
  benchmarks/                energy and rank computation
  history/                   run history and match baselines
  rating/                    Glicko-2
  match/                     scenario selection, settlement, matchmaking, live queue
  verify/                    local integrity checks and KovaaK's cross-check
  quests/                    evxl link resolution and quest generation
  ranks/                     Apogee rank ladder
  consistency/               day-to-day consistency floor and reporting
  sync/                      Steam sign-in and run upload
  report/                    local profile, weakness map, UI snapshot
src/app/                     Electron main, preload bridge, renderer
supabase/                    migrations, seed, edge functions
tools/                       build-time data extraction and preflight
```

## Where the data comes from

Nothing here is guessed or hand-transcribed.

- **Scenario metadata and score thresholds** come from KovaaK's own public API
  (`webapp-backend/benchmarks/player-progress-rank-benchmark`), which serves the
  official per-scenario `rank_maxes` for every benchmark.
- **The benchmark registry** (which benchmark maps to which KovaaK's id, plus per-rank
  hex colours) comes from evxl.app's own JSON route, `/data/benchmarks`.
- **The nine sub-categories** are read from Voltaic's own published spreadsheet, whose
  URL is recorded in evxl's registry.

All three are build-time steps. The results are committed to `data/`, so the app never
depends on any of those services being reachable at runtime.

To refresh:

```bash
npm run fetch:evxl                              # cached 24h; --force to re-ask
python tools/fetch_benchmark_defs.py            # or --all for every benchmark
python tools/fetch_scenario_taxonomy.py
python tools/fetch_voltaic_subcategories.py
python tools/generate_seed.py
```

## Backend

Deployed and verified. See [SETUP.md](SETUP.md) for the full walkthrough.

```bash
npm run validate:schema       # applies migrations + seed to Postgres-in-WASM, no Docker
npm run verify:deployment     # proves RLS, auth and the match engine against the live project
npm run deploy:functions      # redeploy all five Edge Functions
npm run sync:reference        # push updated reference data (the seed will not)
```

Five Edge Functions carry the server side. `steam-auth` is deliberately public because
Steam's servers call it directly; the other four require a session, and verification
asserts they refuse both anonymous callers and the anon key.

The functions import the shared core straight from `src/core`, so settlement, Glicko-2
and the integrity checks are the *same* code the local validation suites exercise. There
is no second implementation to drift.

### What is not wired yet

Nothing, on the client side: it signs in over Steam, backfills its run history, and
calls `find-match`, `submit-run` and `settle-match` for real. What has never happened is
a settled match, because settling one needs an opponent and the pool stays empty until
somebody plays a category through once.

`validate:schema` is the useful one during development: it runs the whole migration and
seed against a real Postgres compiled to WASM, so schema errors surface without Docker,
a cloud project, or network access.

### The security rule everything rests on

**The client never computes anything that matters.** It parses CSVs, hashes them, and
uploads facts. Baselines, deltas, verification tiers and ratings are all computed
server-side. RLS enforces it: clients hold no write grant whatsoever on `ratings`,
`matches`, `match_sides`, `baselines` or `verified_pbs`. Runs are insert-and-read only,
never update or delete, so history is append-only and a bad run cannot be quietly
removed after the fact.

`runs.csv_sha256` is unique per player, which gives idempotent backfill and replay
protection from the same constraint: re-running a sync is a no-op, and a good run
cannot be submitted twice to win two matches.

### Steam sign-in

Supabase has no native Steam provider and cannot have one, because Steam speaks OpenID
2.0 rather than OAuth2/OIDC. `supabase/functions/steam-auth` bridges the gap: it runs
the OpenID dance, verifies the assertion with Steam directly, and mints a Supabase
session for the resulting SteamID64.

The desktop side uses the RFC 8252 native-app loopback pattern. The app listens on an
ephemeral `127.0.0.1` port, the browser handles login, and a **single-use token** (never
a session) crosses back over loopback to be redeemed.

This is load-bearing: the SteamID is the join key to KovaaK's leaderboards, so without a
trustworthy Steam binding, score verification is meaningless and the ladder is
unprotected.

### Why two scenario tables

A scenario belongs to many benchmarks with *different* thresholds. Voltaic S5.5 reuses
S5's Advanced scenario names but re-tunes the ranks. Identity lives in `scenarios`;
thresholds live in `benchmark_scenarios`, keyed by (benchmark, difficulty, scenario).
Collapsing these silently gives a scenario whichever benchmark's numbers loaded last.

## Verification

Two independent layers (`src/core/verify/`).

**Local integrity.** The file must be internally coherent. Every check was measured
against all 11,058 real runs before being allowed to reject anything, and **every hard
check has a 0.00% false-positive rate**. Three checks in the first draft did not, and
were corrected rather than kept:

- rejecting sub-20ms TTK flagged **62%** of genuine runs, because KovaaK's TTK is
  first-hit-to-kill within a burst, not reaction time
- rejecting negative scores flagged real pressure-scenario runs, which legitimately
  score below zero
- requiring one kill row per kill flagged 0.85%, because `Kill #` is a running counter:
  penalty rows repeat it and multi-kills skip it

**Score models** are the strongest check, and were discovered rather than designed.
Most scenarios score as a fixed multiple of a countable stat (`Frogtagon = kills * 10`,
`Aether = hitCount * 1`), so the score can be re-derived from the run's own counters.
219 scenarios modelled (77.4%), and a **+1% score edit is caught**. Scenarios with no
model skip the check rather than failing it.

```bash
npm run build:score-models    # rebuild data/score_models.json from your corpus
npm run validate:verify       # false positives, tamper detection
```

**KovaaK's cross-check.** `user/scenario/last-scores/by-name` returns a player's ~10
most recent runs with `hash`, `epoch` and `challengeStart`, so a match run is verifiable
whether or not it was a personal best. The KovaaK's username is confirmed against
`user/search` to belong to the signed-in SteamID before it is stored, and RLS forbids
clients from writing it.

Tiers: `verified` → `consistent` → `suspect` → `rejected`. Only an incoherent file is
rejected outright. **Suspect still counts.** Measured, ~1 in 9 genuine personal bests
never reach KovaaK's servers, so "above your PB with no server record" means *look
closer*, not *forged*.

## Rating and matches

**Glicko-2**, implemented from the specification and checked against Glickman's own
worked example: 1464.0506 / 151.5165 / 0.059996, matched exactly. Chosen over Elo
because Apogee's play is sparse, bursty and asynchronous, which is the case Elo handles
worst.

A simulated 60-player, 25-period season recovers the hidden true-skill order at a
**Spearman correlation of 0.998**, so the ladder does sort people by skill rather than
by luck.

**Match format.** Three scenarios from a category, each scored as a delta against the
player's own baseline, averaged; higher average wins. Scenario choice is a pure function
of the match seed, so both sides get the same three and no client can reroll them.

Because it is normalised, **you can score higher and still lose**. That is intended, and
`explainVerdict()` names the case explicitly rather than leaving the player to conclude
the app is broken.

**Matchmaking is asynchronous**: you are matched against a stored run set from someone
near your rating. It works with one player online, which is what makes launch survivable
(PLAN.md §6). Live mode reuses all of it and adds only a queue and a countdown.

### The baseline, corrected by measurement

The baseline is the centre every match is measured from. The first implementation used
the mean of the top 30% of recent runs, for sandbag resistance. Measured across 156
scenarios of real history, it was badly off-centre: only **26%** of genuine runs landed
above their own baseline, so matches were decided by who avoided a disaster rather than
who played well.

| definition | mean delta | above baseline | sandbag drop |
|---|---|---|---|
| top 30% | −3.8% | 26% | 3.0% |
| **median** | **+0.4%** | **58%** | **3.5%** |
| plain mean | +0.6% | 60% | 9.3% |

The **verified-PB floor** turned out to be what defeats sandbagging, not the high-water
statistic. With the floor in place a median is centred *and* nearly as hard to game,
while a plain mean is three times more gameable. So:

```
baseline = max( median(last 50 runs), 0.9 × verified PB )
```

```bash
npm run compare:baselines    # reproduce the table above on your own history
```

## Quests

Quests are generated against whichever benchmark the player tracks. Paste any evxl
link. **All 121** benchmarks in the registry are trackable, resolved entirely
offline from committed data.

Resolution refuses to guess: an ambiguous name (`"Voltaic"` matches S3, S4, S5, S5.5)
resolves to nothing rather than silently tracking the wrong season.

## Desktop client

```bash
npm start      # build and launch
npm run dev    # the same, but rebuilt and relaunched on every save
npm run smoke  # boot, verify, exit; no window, usable in CI
npm run doctor # why is it not working: bundle, folder, keys, data
```

`npm run dev` exists because Electron holds a single-instance lock: `npm start` with a
window already open focuses the old process, which is still running the old bundle, so
a change that is definitely on disk is definitely not in the app. The dev loop rebuilds
and relaunches on save, and the window reopens where it was.

The stats folder is found from Steam's own `libraryfolders.vdf`, so an install on any
drive or library is picked up without being told; a folder chosen by hand is remembered,
along with the window's size and position.

Electron main process finds the KovaaK's stats folder, watches it, and rebuilds the
player snapshot whenever a run lands. **All parsing and computation happens in main**;
the renderer is a pure view that receives settled data over a narrow, named IPC bridge.
That mirrors the server-side rule: the layer that can be tampered with is never the
layer that decides anything.

The renderer runs with a CSP, context isolation on, and no Node access. Its preload
exposes eight named capabilities and no generic "invoke any channel" escape hatch.

The file watcher waits for a file's size to stop changing before parsing. KovaaK's
writes stat files progressively, so parsing on the first filesystem event yields a
truncated CSV with no `Score:` line.

`npm run ui` regenerates `tools/apogee-ui-preview.html`, a shareable single-file build of
**the same renderer** with a snapshot inlined, so the preview and the app cannot drift.

## Live matchmaking

Async carries the ladder from day one; `liveQueue.ts` switches on once there is a
concurrent population. Everything downstream is unchanged: same seeded scenarios, same
settlement, same rating update.

The problem live mode has that async does not is **starvation**. A player at the top or
bottom of the ladder may have nobody close. Tolerance therefore widens with waiting
time, and a player who still cannot be paired is released to an async match rather than
force-paired into a pointless one. Simulated across four populations (100 players, 8
players widely spread, a lone outlier among 20 clustered, and an odd population),
**nobody is ever stranded**.

## Before inviting anyone

```bash
npm run beta
```

Checks what must be true before a closed beta: thresholds populated, RLS on every
table, no client write policy on `ratings`/`matches`/`baselines`, Steam assertions
actually verified, renderer locked down, environment configured. Separates blockers
from advisories, and prints the manual items it cannot check rather than pretending
they're done.

## The energy model

Reverse-engineered from KovaaK's API and validated against real accounts. Computed
category and overall progress match the server to within 0.005 energy, and every rank
matches, across 20 checks (`npm run validate:engine`).

- Each scenario threshold `i` is worth `2500 * (i + 1)` energy; between thresholds
  energy interpolates linearly, below the first it scales from zero, above the last it
  caps.
- Category energy is the sum of its scenarios'.
- Category and overall rank are the highest thresholds met.

Per-scenario energy is on a universal scale, but category thresholds differ: Switching
requires more energy for the same rank than Clicking. Getting that backwards is the easy
mistake.
