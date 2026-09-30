# Mechanics for a ladder with nobody on it

PLAN.md §15 lists one open risk: population. Schema, RLS, Steam auth and every Edge
Function are live, and no contested match has settled, because a contested match needs a
second player and the second player has not arrived. §6 made the ladder async so that one
person online is enough to *play*; it did not make one person online enough to have
*fun*. The seeding match `find-match` hands out on an empty pool ends with
"Nothing was rated: there was no opponent to play against"
(`supabase/functions/settle-match/index.ts`), which is an honest sentence and a bad first
evening.

This document ranks the candidates for a mechanic that works with zero other live
players, feeds a growth loop, and is not already in every aim trainer, then specifies the
winner far enough to build tonight.

## What was measured first

Two numbers decided the ranking more than any argument did. Both come from the stats
folder this project's validators already read (`E:\Steam\steamapps\common\FPSAimTrainer\FPSAimTrainer\stats`,
loaded through `scanStatsFolder` in `src/core/history/history.ts`), and the script that
produced them is in the appendix.

**The folder has grown.** It parses to 14,150 runs on 1,134 scenarios over 227 play days.
11,058 is the size the verification checks were tuned on (§17); `validate:ghost` should
print what it read rather than assume either figure.

**Season 1's pool is nearly unplayed, even by its author.** Of the 164 scenarios in
`data/seasons/season-1.json`, 95 have any run in the folder, 9 have the five runs
`MIN_RUNS_FOR_BASELINE` asks for, and all of them together hold 240 of the 14,150 runs.
The pool moved to Apogee's own scenarios in `fc2c0a9`, which fixed the rank ladders and
emptied the history behind them. These scenarios exist nowhere but Apogee, so an
outside player arrives with no runs on the pool at all. Any mechanic that needs history *on the pool* is therefore unavailable to
everyone at launch, and one that runs on the player's own library is available on day
one.

## The shortlist, scored

Scores are 1 (worst) to 5 (best); for build cost and abuse risk, 5 means cheap and safe.

| Mechanic | Cold-start impact | Build cost | Farm / abuse risk | 15 s video "wow" | Total |
|---|---|---|---|---|---|
| **Ghost Mode**, library-first | **5**: works signed out, offline, with no server row; a ghost match could be drawn on 206 of 227 play days | **4**: one pure core module, one store, IPC, one renderer screen; server layer optional and deferrable | **5**: moves no rating; only a cosmetic quest and a streak | **4**: "me vs me a week ago", per-round reveal as each run lands | **18** |
| Share cards + challenge links | 3: brings people in, but a recipient needs install, Steam sign-in, 50 uploaded runs (`MIN_RUNS_TO_QUEUE`) and the Apogee scenarios installed before a first play | 2: `duels.challenged_id` must become nullable or code-addressed, `send-duel`/`answer-duel` change, a deep-link protocol (none registered: no `setAsDefaultProtocolClient` in `src/app`, no `protocols` in `electron-builder.yml`), card rendering (no `capturePage` anywhere yet) | 2 if rated: an open link is an invitation to answer with an alt and gift the win. Must ride `matches.rated = false` | 5 | 12 |
| Bounties / Legends | 1: needs top players' stored run sets, and there are none; seeding from the KovaaK's leaderboard gives raw scores, which §3 already rejected as the thing to compare | 2: a bounty table, a refresh job, a claim path through settlement | 3: a stored set answered by many is fine (`findOpponent` already treats sets as unconsumed), but "badge for beating X" invites alt-account staging of X | 4 | 10 |
| Rival (weekly nearest rating) | 1: needs at least two rated players in a category; zero until population exists | 3: a weekly pick over `ratings`, a head-to-head read over `match_sides` | 4 | 2 | 10 |
| *Added:* Ghost links (race somebody else's ghost) | 3: needs only the sender to be a player; the recipient's result is unrated | 3: the Ghost Mode server layer plus a code lookup | 4: unrated both ways | 4 | 14 |

Two ideas were considered and dropped before scoring. A "legend" built from the KovaaK's
global leaderboard is a raw score, which is exactly the comparison §3 threw out; normalised
against the player's baseline it collapses into the rank thresholds the season already
has. And "best-ever you" as an opponent, which PLAN §16 names, loses on measurement below.

## Decision

**Headline: Ghost Mode, on the player's own library.** A three-scenario match in the ranked
format against the player's own past performance on those scenarios, drawn from their
existing KovaaK's history. It moves quests and a ghost streak, never rating. It is built
local-first, so tonight's build is testable without a deploy, and has a server layer
(below) that makes the result shareable and verifiable once it is deployed.

**Follow-up 1: Ghost links.** Every ghost result gets a card and a code; anyone with the
code races the sender's three live runs as a ghost of their own. This is the growth loop,
and it reuses the headline's server layer almost entirely.

**Follow-up 2: Share cards on ranked results**, riding the same card renderer, and
challenge links for duels once the card exists, with link-born duels unrated
(`matches.rated = false`, the path tournaments already use).

Rival and Bounties wait for population; both are cheap once there are thirty players and
worthless before.

### Why Ghost Mode, and why not on the pool

Ghost Mode is the only candidate that is fun with zero players, and it is fun for exactly
the player Apogee is best at already: somebody with years of KovaaK's history (§3, "the app
is most accurate for exactly the players most likely to try it"). It also rehearses the
ranked format. §15 lists "I scored more and lost" as a medium risk; against a ghost both
sides share one baseline, so the per-round comparison reduces to
`(live − ghost) / baseline`, a plain percentage over the player's own past, which teaches
the delta readout on the easiest possible case before it has to explain a stranger's.

It is not built on the season pool, because on the pool there is no ghost. Restricted to
Season 1's scenarios (the appendix script with `--pool`), the measurement finds 0 play days of 227 where a "last week"
ghost match could be drawn, and 2 for any definition at all. On the library it is 206.

### Which past self: measured, not chosen

PLAN §16 left this open: "last week" and "best-ever" "mean different things". Each
definition was replayed over the folder: for every play day, three scenarios the player
touched that day were drawn from those with at least five earlier runs and a ghost
available; the first run of the day on each was the live side; both sides were scored
against the same baseline from runs before that day (`baselineFromScores`, no PB floor,
since verified PBs live server-side); the live side wins when its mean delta is higher.

| ghost, per scenario | matches possible | live side wins | margin p10 / p50 / p90 |
|---|---|---|---|
| median of the last session at least 30 days earlier | 173 | 74.6% | −2.9% / +3.5% / +12.9% |
| **median of the last session at least 7 days earlier** | **206** | **58.3%** | −6.1% / +1.2% / +8.5% |
| best of the last session at least 7 days earlier | 206 | 49.0% | −8.3% / −0.0% / +8.0% |
| trailing 7-day median | 199 | 51.3% | −5.6% / +0.1% / +5.8% |
| best of the last session before today | 211 | 33.2% | −8.4% / −1.7% / +5.5% |
| best ever (PB) | 211 | 2.4% | −15.2% / −8.6% / −3.1% |

*Re-derived by `npm run validate:ghost`, which replays each day through the app's own
seeded draw and `settleMatch` (a draw is not a win). The first draft of this table came
from the appendix script, whose shuffle and tie handling differ: 55.3%, 47.6%, 53.8%,
40.3% and 3.3% in the rows above. No decision below changes.*

What that decides:

- **Best-ever is not an opponent.** 3.3% is a wall, not a match. The PB stays on the result
  card as a distance ("2.4% off your best"), never as the thing to beat.
- **The trailing 7-day median is rejected** despite a good win rate: it is nearly the
  baseline itself (the baseline is a median of the last 50 runs), so the match is a
  seeding match with a different label, and "beat your baseline" is not a past self.
- **Three ghosts ship**, one per question:

  | ghost | question it answers | measured win rate | when it is offered |
  |---|---|---|---|
  | `month_ago` | "have I improved?" | 74.6% | default for the first ghost match an install plays, and whenever last week is unavailable |
  | `last_week` | "am I still improving?" | 58.3% | default after the first |
  | `last_week_best` | "can I beat my good day?" | 49.0% | chosen explicitly |

  The first match is deliberately the one most people win: it is the hook, and the video.

The live side here is the *first run of the day*, colder than a run played with intent
after pressing Start, so real win rates will sit somewhat above these. `validate:ghost`
has to re-derive this table, and the numbers in this document are to be replaced by its
output if they differ.

## Headline spec: Ghost Mode

### Rules

- **A ghost match is three scenarios**, drawn by main from the player's library: scenarios
  with at least `MIN_RUNS_FOR_BASELINE` (5) runs before the match starts and a ghost session
  for the chosen kind. Draw with `seededRandom` from `src/core/match/scenarioSelection.ts`,
  seeded `${dayKey}:${kind}:${ordinal}` (`dayKey` from `src/core/quests/progression.ts`), so
  the draw is reproducible and cannot be rerolled by restarting. Prefer scenarios played in
  the last 90 days, so the three are ones the player still plays; fall back to any
  eligible scenario when fewer than three qualify.
- **The ghost** for each scenario is frozen at draw time: the median (or best, for
  `last_week_best`) of the runs on the most recent local calendar day at least 7 (or 30) days
  before the start. A *session* is one local calendar day. All timestamps involved are the
  bare local wall clock parsed from filenames, compared only with each other, so the
  timezone rule in CLAUDE.md is not engaged on the local path. The server layer is
  different (see below).
- **The baseline** for each scenario is frozen at draw time too, from
  `computeBaseline(history)` over runs before the start. Freezing both means a run played
  during the match cannot move the bar it is measured against.
- **The first run on each scenario after Start counts**, in any order. Later runs on the
  same scenario are practice, the way a ranked match counts one attempt (§3). A run on an
  unrelated scenario is ignored.
- **The clock mirrors ranked**: 8 minutes to land the first run, then 3 minutes of idle
  allowance after each (`INITIAL_TTL_MS` and `IDLE_ALLOWANCE_MS` in
  `supabase/functions/_shared/apogee.ts`). The constants are redefined in the core module
  with a comment naming their source, because the Edge Functions' module is not importable
  by the client. The point of the mode is to rehearse the ranked format, and a lenient
  clock rehearses the wrong thing.
- **Scoring reuses `settleMatch`** from `src/core/match/settle.ts`: the live rounds and the
  ghost rounds are both `RoundSubmission`s with `verificationTier: "unverified"`, same
  baseline, and the ghost side's `score` is the frozen ghost score. Void rules, the draw
  epsilon and abandoned-run handling (`isAbandonedRun`) come for free. `ratingWeight` is
  ignored.
- **Abandoning counts as a loss** for the streak. Each round's result is revealed as it
  lands, which is the drama of the mode, so without this rule a player behind after two
  rounds would abandon and keep the streak.
- **Rewards**: a win pays quest progress and advances the ghost streak (consecutive local
  days with a ghost win). Nothing else. No rating, no season standing, no pool entry.

### User flow, screen by screen

1. **Entry points.** A *Ghost* tab in the Improve nav group beside Mixtape
   (`src/app/renderer/index.html`, the `nav.group.practice` block), a *Race your ghost*
   link in the lobby's `arcade-hero-links` row, and, the one that matters for cold start,
   on the **seeding match result** (when `settle-match` answers `seeding: true`):
   "Nobody in the pool yet. Race last week's you on these three while it fills." Available
   signed out, unlike the ranked queue.
2. **Ghost chooser.** Three cards, `month_ago`, `last_week`, `last_week_best`, each with the
   date of the session it would draw from and the measured win rate as "about N in 10
   won this in testing" (tenths, since in quarters `last_week` and `last_week_best` both
   read "2 in 4"). Unavailable kinds show why ("no session 30+ days ago on enough
   scenarios"). One primary button: **Race**.
3. **Pre-match.** The three scenarios, the ghost's score and the date behind each, the
   frozen baseline, and the PB as context. **Start** starts the clock and opens scenario 1
   in KovaaK's in one step, the way Expedition's `launch` action does.
4. **Live.** A three-lane tracker: ghost bar per lane, live side empty. While a launched
   scenario is outstanding: "Listening for your run". When a run lands, its lane fills and
   flips to the round verdict ("+3.8% over last week's you") with the running match margin.
   A 3-2-1 reveal of the ghost's bar is the one animation that earns its place.
5. **Result.** Verdict, the three rounds side by side (live, ghost, baseline, delta each,
   shown the way §3 requires for ranked), the streak, quest progress, and **Rematch**
   (same three scenarios, same ghost, new clock) and **Share** (disabled with a reason
   until the server layer is deployed).

### Core module: `src/core/ghost/`

Pure, no `node:fs`, so the server layer can import it the way
`src/core/history/baseline.ts` is imported by `refresh-baselines`.

- `ghost.ts`
  - `type GhostKind = "month_ago" | "last_week" | "last_week_best"`
  - `ghostScore(runs: {score, playedAt}[], start: Date, kind): { score, sessionDay } | null`
  - `availableKinds(history: Map<string, ScenarioHistory>, now): Record<GhostKind, { scenarios: number; sessionDay: string | null }>`
  - `drawGhostMatch(history, now, kind, ordinal): GhostMatch | null`: three scenarios, each
    with frozen `ghost`, `baseline`, `pb`, `sessionDay`
  - `applyRun(match, run): GhostMatch`: first-run-counts, window, abandon, unrelated-scenario
    rules; returns the new state and never mutates
  - `judge(match): GhostVerdict`, a thin adapter over `settleMatch`
  - `ghostStreak(records, now)`
  - `GHOST_START_ALLOWANCE_MS`, `GHOST_IDLE_ALLOWANCE_MS`
- `validateGhost.ts`, run as `npm run validate:ghost` (add to `package.json` and to the
  `validate` chain). Loads the corpus exactly as `validateMatch.ts` and `validateQuests.ts`
  do: `const dir = process.argv[2] ?? DEFAULT_STATS_DIR`, then `scanStatsFolder(dir)`.
  It checks:
  - **the corpus is really there**: prints run and scenario counts, and fails below 100
    drawable match-days, so an empty or moved folder fails instead of passing with
    nothing measured;
  - **the table above**: replays every play day per kind, prints availability, win rate and
    margin percentiles, and fails if a shipped kind leaves 35%..80% (both ends: a ghost
    that always wins is busywork, one that never does is a lie, the same standard
    `validateQuests.ts` applies to quest completion rates), and fails if best-ever lands
    *inside* that band, since that would mean the reason for excluding it is gone;
  - **the pool fact**: prints how many play days could draw a pool-only ghost, so the
    claim that the pool cannot host this is re-derived on every run;
  - **determinism**: the same `(dayKey, kind, ordinal)` draws the same three;
  - **rules that must refuse**, each built from a real match: a run before Start, a second
    run on a counted scenario, an unrelated scenario, a run after the idle deadline, an
    abandoned run (the match voids), and abandon-as-loss for the streak. Every one asserts
    the refusal *happened*, not that nothing went wrong.

### Quests: `src/core/quests/board.ts`

- A new variety kind `beat_ghost` ("Beat a ghost"), target 1, XP in line with
  `ranked_play`. Unlike `ranked_play` it does not need `ctx.ranked`, so a signed-out
  board finally has a match-shaped quest.
- `QuestState` gains `ghosts: GhostRecord[]` (`{ id, at, kind, verdict }`), pruned on the
  same eight-day window as `matches`, with a `recordGhost` beside `recordMatch`. The
  version stays 2, and a stored state without `ghosts` loads as an empty list.
- `ghost` records never enter `matches`. `weekly_wins` counts `matches` with
  `!m.seeding`; a ghost win there would be a ranked win nobody else took part in.
  `validateQuests.ts` gains the assertion that recording a ghost win leaves `ranked_play`
  and `weekly_wins` unchanged, and that `beat_ghost` completes on a ghost win and on
  nothing else.

### Client: main decides, renderer is a view

- `src/app/ghostStore.ts`: `ghost.json` in `userData`, atomic temp-then-rename with a
  `.bak`, the pattern of `src/app/questStore.ts`. Holds the active match, the last 30
  results and the streak. Same stance as the quest store: not a secret, decides nothing
  anybody else sees.
- `src/app/main.ts`:
  - in `startWatching`'s `onRun`, after the `apogee:run` broadcast, pass the run to the
    active ghost match (`applyRun`); on change, persist, broadcast `apogee:ghost`, and when
    the third round lands, record the result into the quest state and run the existing
    quest sync so `apogee:questComplete` fires as it does for matches;
  - `ipcMain.handle("apogee:ghost")` returns the view (chooser availability, the active
    match, the last result, the streak);
  - `ipcMain.handle("apogee:ghostAction")` takes `{ type: "draw", kind } | { type: "start" } |
    { type: "rematch" } | { type: "abandon" }` and `{ type: "launch" }`, which launches the
    next unplayed scenario with the same `launchKovaaks` path Expedition's `launch` uses;
  - **`apogee:launchScenario` has to learn about ghost matches.** It refuses any scenario
    not in the active ranked match or the season (`inMatch`/`inSeason`), and nearly every
    ghost scenario is neither. Add `inGhost`, read from the main-side active ghost match,
    never from the renderer's argument;
  - the idle deadline is checked on a timer in main and on every run, so the renderer never
    decides that time ran out.
- `src/app/preload.cjs`: `ghost()`, `ghostAction(action)`, `onGhost(handler)`, mirroring
  `expedition`/`expeditionAction`/`onExpedition`.
- Renderer: `src/app/renderer/ghost.js` and `ghost.css`, loaded from `index.html` the way
  `mixtape.js` is. It draws what `apogee:ghost` sends and sends actions; it computes no
  verdict, no margin and no deadline. (Mixtape keeps its engine in the renderer,
  `mixtape-engine.js`; Ghost does not follow it, because a ghost result feeds the quest
  board, which lives in main.)
- A running window keeps its old bundle (CLAUDE.md): test with `npm run dev`, and check
  `npm run doctor` before believing a "button does nothing".

### Server layer (for sharing; needs a deploy)

The local match is enough to play. It is not enough to *show somebody*: a card computed by
the client is a claim, and this codebase does not let the client make claims other people
read. The server layer re-derives the result from runs it verified.

**Migration** `supabase/migrations/20260930000020_ghost_results.sql` (a new table only; no
season or existing table is altered):

```sql
create type ghost_kind as enum ('month_ago', 'last_week', 'last_week_best');

create table ghost_results (
  id             uuid primary key default gen_random_uuid(),
  player_id      uuid not null references players (id) on delete cascade,
  -- Short, unguessable enough to share aloud, and the only handle anyone else gets.
  code           text not null unique,
  kind           ghost_kind not null,
  scenario_names text[] not null,
  live_run_ids   uuid[] not null,
  live_scores    numeric[] not null,
  ghost_scores   numeric[] not null,
  baselines      numeric[] not null,
  -- Local calendar day of the ghost session, per scenario.
  ghost_days     date[] not null,
  margin         numeric not null,
  -- 'win' | 'loss' | 'draw'. The enum has no 'void' and does not need one: a voided
  -- ghost match has nothing to share, so post-ghost refuses it rather than storing it.
  verdict        match_result not null,
  -- Lowest tier among the three live runs, so the card can say what it rests on.
  live_tier      verification_tier not null,
  created_at     timestamptz not null default now(),

  constraint ghost_three check (array_length(live_run_ids, 1) = 3),
  -- One card per set of runs, so replaying the same three cannot mint a streak of cards.
  constraint ghost_runs_once unique (player_id, live_run_ids)
);

alter table ghost_results enable row level security;
-- No policies, grants revoked as rate_limits and the tournament tables do: written by
-- post-ghost and read by ghost-card under the service role, nothing else.
```

**Edge Functions** (add both to `deploy:functions` in `package.json`, and let
`tools/validateFunctionNames.ts` and `validateFunctionImports.ts` cover them):

- `post-ghost`: `requireCaller`, `enforceRateLimit` (new `LIMITS` entry in
  `supabase/functions/_shared/rateLimit.ts`, e.g. 10 per 5 minutes like `send-duel`).
  Body: the three raw CSVs with filenames and `tzOffsetMinutes`, plus `kind`. Each CSV goes
  through the same parse and `verifyRun` path `submit-run` uses, inserted into `runs` or,
  when the same `csv_sha256` is already there from backfill, re-verified in place. The
  ghost and baseline are rebuilt from the caller's stored `runs` by the same
  `src/core/ghost/ghost.ts`, reading by the existing `runs_player_scenario_idx`. **Session
  days on the server must be local days**: `played_at` is a real instant, so the function
  shifts it by the caller's `tzOffsetMinutes` before bucketing, or a player west of UTC
  gets a ghost from the wrong evening. Returns the code and the card payload.
- `ghost-card`: `code` in, card payload out. Requires a signed-in caller for now (no
  `verify_jwt = false` in `supabase/config.toml`), which is enough for in-app viewing and
  keeps a public scrape surface closed until a web card page exists.

**Deploy order** stays the one in CLAUDE.md, and Rylee runs it:
`! npx supabase db push --yes`, then `! npm run deploy:functions`, then
`! npm run verify:deployment`. Until then Share stays disabled with a line saying so.

### Server-side vs client-side

| decided by | what |
|---|---|
| main process (local) | draw, ghost and baseline freeze, run acceptance, clock, verdict, streak, quest progress |
| renderer | nothing; it draws `apogee:ghost` |
| server (once deployed) | everything on a shared card: runs re-verified, ghost and baseline rebuilt from stored `runs`, verdict re-judged, code minted |
| nobody | rating, season standing, pool membership: a ghost result touches none of `ratings`, `matches`, `match_sides`, `baselines` or `verified_pbs` |

### Anti-abuse

- **Rating is untouchable by construction.** The local path has no server write; the
  server path writes one table that nothing in rating, matchmaking or settlement reads.
  §10's rule that quest XP never touches rating covers the rest.
- **Sandbagging a ghost** (playing badly this week to beat it next week) costs a week of
  bad play for a cosmetic quest. The ghost is a session *median*, so one tanked run does not
  move it; it takes a whole deliberately bad evening. The PB on the card makes a padded
  win visible: "+12% over last week, 9% off your best" says what happened.
- **Cherry-picking scenarios** is closed by the seeded draw: the player picks the ghost
  kind, never the three scenarios, and restarting the app redraws the same three.
- **Retrying until it goes well** is closed by first-run-counts and the ranked clock.
- **Abandoning a losing match** is a loss for the streak.
- **Editing `ghost.json`** fakes a local streak, which cheats only the editor, the same
  stance `questStore.ts` takes. It cannot fake a card, because the card is server-derived.
- **Backfilled history is client-inserted** (the `submit-run` header says so), so a
  server ghost rests on data the player wrote. The card says "ghost from uploaded
  history" and shows the live runs' verification tier; it does not claim more.

### What this does not cover

It is measured against one player's folder, which proves the rules are fair to one real
history and says nothing about a player with three weeks of it; `availableKinds` has to say
plainly when there is no ghost. Whether racing oneself stays fun past the first week is a
playtest question the corpus cannot answer.

### Where the build departs from this spec

Each of these is argued at the code it lives in; this is the list.

- **Frozen at local midnight, not at the click.** Eligibility, ghost and baseline are all
  read as of the start of the draw's local day (`drawGhostMatch`), so a draw is a pure
  function of (history before today, day, kind, ordinal). Warming up before pressing Race
  cannot change the three or move the bar, and it is the frame the win rates were replayed
  in. The ordinal counts matches *started* today, so discarding an unstarted draw brings
  back the same three.
- **A run counts from when it began.** `applyRun` refuses a run whose derived start
  (filename end minus duration) is more than 2 s before Start, not only one that ended
  before it. The clock expires a match at the deadline plus ranked's 90 s end grace.
- **Tenths, not quarters**, on the chooser; see the note under the table above.
- **The streak is days with a win**, as specified, so a loss, an abandon and a void all
  add nothing. "Abandoning is a loss" is enforced as the *record*: an abandon after Start
  is stored as a loss (never a void, never nothing), pays no quest, and `validate:ghost`
  asserts that. A void from an abandoned *run* is kept locally as "No result"; only the
  server refuses to store one.
- **Bars are drawn on a baseline-centred scale** (±25%), computed in `viewOf`; scaled to
  raw scores a 4% win looked like a tie.
- **`ghost_results` has two more columns**: `pbs` (the card's distance to best) and
  `tz_offset_minutes` (so the card's streak counts the poster's local days), plus check
  constraints on the arrays' lengths and on the code's alphabet.
- **The server does not replay the draw.** Its copy of the library is whatever was
  uploaded, so a replay would refuse honest players whose upload lags; it checks each
  scenario has a ghost of the claimed kind in uploaded history, and requires the three
  runs to have been played as one sitting on the ranked idle clock.
- **Cut:** Ghost links (follow-up 1) and a card renderer. Share mints a code and shows it
  on the result screen once post-ghost is deployed; there is no image yet.

## Video beats

1. **Cold open, the empty ladder** (2 s): the seeding-match result, "Nothing was rated:
   there was no opponent", then the new line under it: "Race last week's you."
2. **The ghost appears** (3 s): the chooser, the `last_week` card showing the date of the
   session it came from; press Race and KovaaK's opens on scenario 1 with no clicks between.
3. **The run lands** (4 s): split frame, KovaaK's end screen on one side, Apogee's lane
   filling on its own on the other, the 3-2-1 ghost reveal, "+3.8% over last week's you".
   No typing, no alt-tab: the watcher is the demo.
4. **Round three, close** (3 s): the running margin within a percent, the last lane flips,
   WIN.
5. **The card** (3 s): the share card with streak and code, the quest toast
   `apogee:questComplete` firing over it.

Film on a real library with a real week-old session. The `npm run fresh` profile has no
history and therefore no ghost, which is the correct behaviour and the wrong footage.

## Share card

Must show, in this order of visual weight:

1. **Verdict and margin**: "Beat last week's me by +2.1%" (or "Lost to", or "Drew with").
   The margin is the mean of the three `(live − ghost) / baseline`.
2. **Ghost kind and its date**: "vs. me on 23 Sep" (the session day), because "last week"
   means nothing on a card seen a week later.
3. **Three rounds**, each: scenario name as KovaaK's shows it, live score, ghost score,
   per-round delta with sign and colour. Raw scores are shown, not only percentages, for
   the reason §3 gives for ranked results.
4. **Ghost streak** (consecutive days with a ghost win) and the player's Steam display name.
5. **Distance to PB** on the best round, small: context, not a boast.
6. **Trust line**, small: "Runs verified by KovaaK's" or "Runs unverified", from
   `live_tier`, and "ghost from uploaded history".
7. **Code and call to action**: the `ghost_results.code` and "Race this in Apogee". Only on
   server-derived cards; a local-only card prints no code, since it has nothing behind it.

Must not show: rating, rank tier or season standing, because the result moved none of
them and a card implying otherwise is the "I scored more and lost" confusion pointed at
strangers.

## Appendix: the measurement

Save as `.cache/ghost-measure.ts` and run `npx tsx .cache/ghost-measure.ts`. `validate:ghost`
supersedes it; this is what the tables above came from.

```ts
import { readFileSync } from "node:fs";
import { scanStatsFolder } from "../src/core/history/history.ts";
import { baselineFromScores } from "../src/core/history/baseline.ts";

const dir = process.argv.slice(2).find((a) => !a.startsWith("--"))
  ?? "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";
const hist = scanStatsFolder(dir);
let runs = 0; for (const h of hist.values()) runs += h.runs.length;
console.log(`${runs} runs on ${hist.size} scenarios`);
if (runs === 0) throw new Error(`no runs read from ${dir}`);
const season = JSON.parse(readFileSync("data/seasons/season-1.json", "utf8"));
const poolNames = new Set<string>(season.scenarios.map((s: any) => s.scenario));
const poolOnly = process.argv.includes("--pool");
const onPool = [...poolNames].map((n) => hist.get(n)?.runs.length ?? 0);
console.log(`season pool: ${poolNames.size} scenarios, ${onPool.filter((c) => c > 0).length} played, ` +
  `${onPool.filter((c) => c >= 5).length} with 5+ runs, ${onPool.reduce((a, c) => a + c, 0)} runs`);

const DAY = 86_400_000;
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const max = (a: number[]) => Math.max(...a);
type R = { score: number; t: number };
const lastSession = (runs: R[], cutoff: number, agg: (a: number[]) => number) => {
  const before = runs.filter((r) => r.t < cutoff);
  if (!before.length) return null;
  const k = dayKey(new Date(before[before.length - 1].t));
  return agg(before.filter((r) => dayKey(new Date(r.t)) === k).map((r) => r.score));
};
const defs: Record<string, (r: R[], d: number) => number | null> = {
  "trailing 7d median": (r, d) => { const w = r.filter((x) => x.t >= d - 7 * DAY && x.t < d); return w.length >= 3 ? med(w.map((x) => x.score)) : null; },
  "last session >=7d ago, median": (r, d) => lastSession(r, d - 7 * DAY, med),
  "last session >=7d ago, best": (r, d) => lastSession(r, d - 7 * DAY, max),
  "last session >=30d ago, median": (r, d) => lastSession(r, d - 30 * DAY, med),
  "last session before today, best": (r, d) => lastSession(r, d, max),
  "best ever (PB)": (r, d) => { const b = r.filter((x) => x.t < d); return b.length ? max(b.map((x) => x.score)) : null; },
};

const series = new Map<string, R[]>();
for (const [n, h] of hist) series.set(n, h.runs.filter((r) => r.playedAt).map((r) => ({ score: r.score, t: r.playedAt!.getTime() })));
const days = new Map<string, { start: number; scen: Map<string, number> }>();
for (const [n, rs] of series) for (const r of rs) {
  const d = new Date(r.t), k = dayKey(d);
  let e = days.get(k);
  if (!e) days.set(k, (e = { start: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), scen: new Map() }));
  if (!e.scen.has(n)) e.scen.set(n, r.score); // first run of the day
}
console.log(`${days.size} play days`);

const lcg = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
for (const [name, def] of Object.entries(defs)) {
  const rand = lcg(7);
  let n = 0, wins = 0; const margins: number[] = [];
  for (const e of days.values()) {
    const ok: { live: number; ghost: number; base: number }[] = [];
    for (const [s, live] of e.scen) {
      if (poolOnly && !poolNames.has(s)) continue;
      const rs = series.get(s)!, before = rs.filter((r) => r.t < e.start);
      if (before.length < 5) continue;
      const base = baselineFromScores(s, before.map((r) => r.score)).value;
      const ghost = def(rs, e.start);
      if (base > 0 && ghost != null) ok.push({ live, ghost, base });
    }
    if (ok.length < 3) continue;
    const pick = [...ok].sort(() => rand() - 0.5).slice(0, 3);
    const m = pick.reduce((a, p) => a + (p.live - p.ghost) / p.base, 0) / 3;
    n++; if (m > 0) wins++; margins.push(m);
  }
  margins.sort((a, b) => a - b);
  const q = (x: number) => (100 * margins[Math.floor(margins.length * x)]).toFixed(1);
  console.log(`${name.padEnd(34)} ${n} matches, ${(100 * wins / n).toFixed(1)}% won, margin ${q(0.1)} / ${q(0.5)} / ${q(0.9)}`);
}
```
