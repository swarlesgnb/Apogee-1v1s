# Security: anticheat fixes from the October audit

Branch `fleet/security`. This implements the fixes from the adversarial audit of ranked
integrity (SEC-01 to SEC-09). The owner's constraint holds throughout: no grading or rating
policy changed. Consistent still counts. A run refused or rejected here is one the
documented rules already say cannot count: played outside its match, submitted twice, or
stamped later than it could have been played.

| ID | Severity | Finding | Status |
|---|---|---|---|
| SEC-01 | Critical | The client's UTC offset moves a run into any match window, and lets best runs from different hours share one match | **Fixed**, with a documented residual |
| SEC-02 | High | One run counts in several matches, because the replay claim is keyed on the offset-derived instant | **Fixed** |
| SEC-03 | High | A client can rewrite its own `steam_id`, `display_name` and moderation `flags` | **Fixed** |
| SEC-04 | Medium | `verified_pbs` is never written, so the documented baseline floor never engages | **Fixed** (doc corrected too) |
| SEC-05 | Medium | A captured Steam OpenID callback replays into a fresh session | **Fixed** |
| SEC-06 | Medium | `ratings` hands every session an ordered list of every `player_id` | **Fixed** |
| SEC-07 | Low | `attack:rls` never tried an UPDATE on `players` | **Fixed** |
| SEC-08 | Low | A duel answerer can read the challenger's frozen deltas after accepting | **Proposal** (policy, below) |
| SEC-09 | Info | `display_name` reaches other players and is safe only because every sink escapes | **Fixed at the source** (SEC-03) plus a CI guard |
| (note) | | `sandbox: false` on the main window | **Fixed**: sandbox on, preload verified |

## 1. Time integrity (SEC-01, SEC-02)

### The problem, and why the audit's bound does not fix it

KovaaK's writes a bare local wall clock into the stats filename. The UTC offset that turns
it into an instant comes from the client, and submit-run accepted any integer within
±840 minutes, per run. The audit proposed refusing a ranked run whose corrected time is far
from "now". That adds nothing: the attacker chooses the corrected time, and puts it at
now, where the match window already is. Omitting the offset is the same lever (offset 0).

What the client controls is the *conversion*, so the fix is to stop the conversion being a
free choice: per run, per match, per evening, and per performance. Each rule below closes a
separate path, and each has a test.

### The rules

| Rule | What it stops | Where |
|---|---|---|
| **One clock per match** | Slotting best runs from different times of day into one match | match creators record the offset on the player's side; submit-run holds every run to it |
| **Continuity** | Declaring a shifted clock for one match while uploading normally | `matchClock` at match creation, and on first use for older clients |
| **Nothing from the future** | Stamping a run later than it was played (and pre-pinning a future time) | submit-run and post-ghost refuse; the database skips history rows |
| **On time** | Playing after the deadline of an unswept match and stamping the run back into it | submit-run |
| **First seen wins** | Resubmitting a run uploaded live, re-exported or re-offset, into a later match | submit-run reads it before grading; the database trigger enforces it for every writer |
| **One claim per performance** | Counting one run in two matches | `ranked_run_fingerprints`, keyed on scenario, challenge start and score |
| **Positive contradiction** | A linked player's time-shifted run | verifyRun: a KovaaK's record of the same run outside the window is a window failure |

**One clock per match.** find-match, send-duel, answer-duel and play-fixture send
`tzOffsetMinutes` and store it on the caller's side (`match_sides.tz_offset_minutes`). Every
ranked run must carry exactly that offset. The one exception is a daylight-saving change
during the match, accepted only when a real IANA zone was on the side's offset when the
clock was declared and on the run's offset when the run ended (`zoneExplaining`, which
asks the zone database rather than the client). A missing offset on a ranked submission is
refused with "update Apogee". A match created by an older client, which sends no offset to
find-match, is pinned by its first ranked run (the shipped client already sends one with
every submission), under the same continuity check.

**Continuity: 6 hours.** The offset declared for a new match must agree with every offset on
the player's own runs played in the last six hours and on their match clocks declared in
that time, unless a real zone explains the change. The query reads only readings that
disagree, so an honest player's check returns nothing. Runs are read by when they were
played, not when they arrived, so a late backfill of last week's runs says nothing about
today. Why six: the honest client uploads every run as it lands, so switching offsets
mid-evening needs six hours of silence from it, while a traveller waits at most six hours
after their last run in the old zone, less the flight. A daylight-saving change never waits.
The refusal names the time it will be accepted.

**Nothing from the future: 15 minutes.** A corrected end later than server receipt plus
fifteen minutes is refused (submit-run, post-ghost: 422 with a message; history inserts: the
row is skipped by the trigger, so one bad row does not fail a 500-row batch, and it uploads
normally once its time has passed). Why fifteen: a PC synchronised by Windows is within
seconds; one that has not synchronised for months drifts by minutes (quartz runs around
20 ppm, about ten minutes a year). The gain to a cheat is a run stamped up to fifteen minutes
late, and only if it was not uploaded first. The database backstop is sixteen minutes, so a
request the function accepted is never dropped by the trigger.

**On time: 15 minutes past the deadline.** A match nobody sweeps stays `awaiting_runs` past
its deadline. With one consistent negative offset, a player could queue, wait hours, warm
up, play the three, and stamp them back inside the window: every other rule passes. This
path was not in the audit or the brief; it turned up while testing the brief's design. The
honest client submits each run the moment its file lands, and the run already had to end
inside the window, so a receipt more than fifteen minutes after the deadline (plus the
window's own 90 seconds) is refused. The fifteen minutes cover a PC clock running behind the
server's: the deadline after the first run is reckoned from the PC's own clock. This
enforces the existing deadline; it does not change what running out of time costs.

**First seen wins.** A performance keeps the play time it was first stored with. "The same
performance" is the same scenario and challenge start plus the same filename wall clock
(any upload), or the same score (a ranked submission, which also catches a renamed file).
`runs.ended_local` holds the filename's wall clock, derived by the trigger as
`played_at − tz_offset_minutes`, never taken from the client. Because the app uploads every
run as history when it lands, a run uploaded live is pinned to the instant it was played; a
later ranked submission with any offset is graded at that instant and fails the later
match's window, the existing rule. History takes the pinned time silently; a ranked insert
that disagrees with it is refused (`TI409`), since submit-run graded it against the time it
looked up and a race would leave the grade describing another instant.

**One claim per performance.** `ranked_run_claims` (migration 21) reserved
`(player, scenario, played_at)`, and `played_at` is what the offset produced. It and its rows
are kept as evidence and still consulted. Beside it, `ranked_run_fingerprints` reserves
`(player, scenario, challenge_start, score)`, which no offset, re-export or rename moves.
Two genuine ranked runs would have to start in the same millisecond of the day and score
exactly the same to collide. A file with no `Challenge Start:` line (KovaaK's always writes
one) is keyed on the empty string, so stripping the line does not escape. The migration
backfills it from every run a match has counted; where the old hole let one performance into
two matches, the earliest receipt keeps the claim and nothing historical is rewritten.

**Positive contradiction.** When a linked player's KovaaK's record matches the run on score,
hash and challenge start, but its timestamp lies outside the match window (widened by the
same three minutes Verified allows), the run is rejected as a match-window failure
(`server_time_in_window` in the stored notes). Missing evidence still degrades to Consistent
exactly as before.

This deviates from the brief's wording on purpose. The brief compares KovaaK's timestamp with
the *corrected* time. The corrected time is the player's PC clock plus their offset, while
KovaaK's timestamp and the match window are both server clocks. Compared with the corrected
time, an honest linked player whose PC runs five minutes fast would be rejected (the match
window already admits a clock up to about eight minutes fast). Compared with the window, the
same shifted runs are caught (hours out) and the fast clock is not (it stays Consistent, as
it is today). The harness has both cases.

### Honest players

All in `tools/validateTimeIntegrity.mjs`, against the shipped submit-run, the shared helpers
and every migration. Runs come from the synthetic stats generator, written in each player's
own zone (`process.env.TZ`); history goes up through the client's own `toPayload` as the
`authenticated` role; submissions carry the offset the client computes (`runClockOffset`).

- **30 zones, 26 distinct offsets, UTC−10 to UTC+14**, including the half-hour zones
  (St John's, Tehran, Kabul, Kolkata, Yangon, Adelaide, Marquesas) and the 45-minute ones
  (Kathmandu, Eucla, Chatham). Each player uploads an evening of history, queues, and plays
  three ranked runs; every run counts, stored at the instant it was played.
- **Daylight-saving changes**: Sydney (uploads on UTC+10, a match on UTC+11 an hour after the
  change), Lord Howe (a 30-minute change), Chicago (spring forward), and a match that
  straddles Sydney's change, whose later runs take the new offset. A clock no zone explains
  is still refused.
- **Older client**: history without an offset is stored as before, with no wall clock and no
  continuity evidence; its match is pinned by its first ranked run and held to it.
- **Late backfill**: week-old runs upload as history at their own instants; they cannot be
  counted in today's match, honestly (outside the window) or renamed to today (first seen).
- **Fast PC clock**: ten minutes fast still uploads and submits; a linked player whose clock
  is five minutes fast stays Consistent rather than Rejected.

The client change that makes this hold: history rows now carry the offset each file was read
with (`getTimezoneOffset()` at that file's own wall clock), and submit-run sends the same
per-file offset instead of today's, so a run played before a daylight-saving change agrees
with its own history row.

### What remains (honest)

- **Only KovaaK's authenticates time.** An unlinked player who never lets the client upload
  as they play, holds one false zone consistently for weeks (positive shifts make live
  uploads future-dated, so they can never upload live), and pre-plays runs that many hours
  before queueing still counts them as Consistent. The harness shows this case passing. It is
  inside the documented "coherent forgeries count as Consistent" limitation. It is also
  narrower than it sounds: the three scenarios are drawn at queue time, and one offset per
  match means all three pre-played runs must have been played back to back, in a session that
  happened to cover the drawn three.
- **The filename is client-controlled.** A renamed file is caught for ranked submissions when
  the performance was uploaded before (first seen, by score), and for linked players by the
  contradiction rule. A file whose `Challenge Start:` and kill timestamps are rewritten
  consistently is a coherent forgery, the documented limit. Proposal: the duration a renamed
  filename implies is not upper-bounded (`runDurationSeconds` returns null past two hours and
  nothing checks it); measuring genuine durations on the corpus would show whether a ceiling
  can be added without rejecting honest runs. That would be a grading change, so it is the
  owner's call.
- **Daylight-saving windows.** Wherever a real zone changes offset between two readings, a
  change of exactly that size is accepted. For one match clock this means a match created
  minutes before some zone's transition; for continuity, a declaration within six hours after
  one. The step is 60 minutes (30 at Lord Howe, 120 at Troll), and the run must still not
  have been uploaded live.
- **First seen relies on the live upload.** A run that never reached the server before its
  ranked submission has no earlier time to be pinned to; the other rules apply to it.
- **Old clients' history** carries no offset, so it pins only by fingerprint (ranked
  submissions) and is not continuity evidence. This ends as clients update.

## 2. SEC-03 and SEC-07: player profiles are server-owned

Every client path was checked: `src/app/api.ts`, `src/app/session.ts` and `src/core/sync/*`
read `players` (the own row, in `session.ts`) and never write it. steam-auth writes the
profile on every sign-in, the KovaaK's link is written by the function that verified it, and
moderation writes `flags`, all under the service role. So the legitimately self-editable set
is empty, and migration 26 revokes INSERT, UPDATE and DELETE on `players` from `anon` and
`authenticated`. `players_update_self` stays as the row guard for any column granted by name
later. `attack:rls` now tries each write (steam_id, display_name, flags, kovaaks_username,
avatar/country, insert, delete), and as positive cases reads the profile exactly as
`session.ts` does, checks the row is unchanged afterwards, and checks moderation can still
write flags.

## 3. SEC-04: the verified-PB floor

A trigger on `runs` records the best score of every run graded Verified into `verified_pbs`,
and the migration backfills it from runs already graded so. A Verified run matched a KovaaK's
record on score, hash, challenge start and time, so its score is one KovaaK's vouches for. A
client cannot reach it: `verification_tier` is not client-insertable (migration 13).
`kovaaksClient` fetches no leaderboard PB at runtime (`recentScores` returns recent runs), so
there is nothing else to populate from without new network calls.

The check the brief asked for, "a real reason this would change behaviour for honest players
beyond the documented formula", found one: `baselineFor` read `verified_pbs` unfrozen. A
personal best set inside a match would be recorded at once, and settle-match would then floor
that same match's baseline at 0.9 × the new best, capping a PB round near +11%. That breaks
the rule settle-match already states (baselines "as they stood when the match began") and the
measurement the formula rests on (each run against the runs before it). So a settlement now
reads the best verified run from before the match began, with the same `played_at` and
`created_at` guards as the median. With that, the change is exactly the documented formula:

- a player with a linked account whose median sits below 90% of their best verified score
  gets the higher baseline PLAN.md section 3 describes;
- a player with no linked account has no Verified runs and keeps the plain median;
- no settled result changes (nothing is re-settled).

`tools/validateVerifiedPbs.mjs` proves `baselineFor` returns `max(800, 0.9 × 1000) = 900`
(it returned 800 before), the backfill, the frozen floor (900 for the match the 1200 was set
in, 1080 for the next), the unlinked player unchanged, and the client refusals.

## 4. SEC-05: Steam sign-in

steam-auth now does what OpenID 2.0 section 11 requires of a relying party:

- the signed `openid.return_to` must be this function's callback with the same `port` and
  `state` the request carries (built from `STEAM_AUTH_FUNCTION_URL`, not read off `req.url`,
  which the platform may present with an internal host);
- `op_endpoint`, `claimed_id`, `identity`, `return_to`, `response_nonce` and `assoc_handle`
  must be in `openid.signed`, or Steam's signature covers none of them;
- the nonce must be under fifteen minutes old and is stored in `steam_openid_nonces`
  (primary key = the replay refusal; pruned after a day);
- `/start` records the attempt (sha256 of the state, and the port) in `steam_signin_attempts`,
  and a callback must complete an attempt that is unused, fresh and on the same port.

The loopback desktop flow is unchanged: it already sends `port` and `state` to `/start`, Steam
returns both in `return_to`, and `steamAuth.ts` still checks `state` itself. A refused attempt
does not burn the honest sign-in. One cost: a sign-in begun on the old function and finished
on the new one is refused once, during the deploy.

## 5. SEC-06: ratings

The only client read of `ratings` is `fetchStanding`, the player's own row. Everybody else's
rating reaches the client through list-duels, find-match and apex-board under the service
role, so there is no screen to migrate. `ratings_read_all` is replaced by `ratings_read_self`.
`attack:rls` asserts zero rows for any other `player_id`, and reads the own row exactly as
`fetchStanding` does.

## 6. SEC-08 proposal: seal the challenger's deltas until the answerer has played

After accepting a duel, the answerer is a participant in the answer match, and
`match_sides_read_participant` lets them read the challenger's side, including the frozen
`deltas` and `match_score`. The accept itself is blind, which is what FAIR-PLAY promises, and
knowing a target cannot improve aim. It can change behaviour at the margin: an answerer who
sees a low target can stop after a safe first round. If the owner wants the score sealed until
the answerer has submitted, the smallest change is to stop copying `deltas` and `match_score`
onto the answer match's challenger side at accept time and have settle-match read them from
the challenger's original side instead, so there is nothing on the answer match to read. This
is a policy decision and is not implemented.

## 7. SEC-09: renderer sinks

Fixed at the source by SEC-03: `display_name` is written only by steam-auth from Steam. As a
guard, `tools/validateRendererSinks.mjs` reads every HTML-writing statement in the renderer
(85 today: `innerHTML =`, `+=`, `outerHTML`, `insertAdjacentHTML`, `document.write`), removes
string literals and anything passed through an escape helper (`esc`, `e`, `escapeHtml`), and
fails on a player-controlled field left over (`displayName`, `display_name`, `opponentName`,
`playerName`, `hostName`, `entrantName`, `challengerName`, `kovaaksUsername`). It passes the
current code with no exceptions list. It is narrow on purpose: it follows no variables, so a
name copied into a local first is not seen. It proves itself on five snippets it must catch,
six it must allow, and one real escape removed from `renderer.js`. The audit's triage script
flags 25 sites on this code, all safe; that is a list for a person to read, not a CI check.

## 8. The Electron sandbox

`preload.cjs` requires only `electron`'s `contextBridge` and `ipcRenderer`, both available to
a sandboxed preload. The main window now sets `sandbox: true`, and the smoke probe window uses
the same preferences explicitly. Checked under Xvfb against a synthetic stats folder: the
smoke test reports `preload: bridge exposed` and `renderer: loaded` (its only failures are the
two that need Supabase credentials, as on base), and `tools/flowScreens.cjs` renders every
screen of the real window with live data from the bridge. Screenshots:
`scratchpad/shots/security/`.

## Tests

Commands, run on this branch:

| Command | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npm run validate:security` | 23 time-integrity, 7 verified-PB, 10 Steam sign-in cases; 85 sinks clean; `attack:rls` no holes |
| `npm run attack:rls` | no holes found |
| `npm run validate:ranked-boundaries` | pass (now includes time integrity and verified PBs) |
| `npm run validate:schema` | pass (new checks: ratings read-self, no client write on players, new tables closed) |
| `npm run validate:submit-run` | 19 cases |
| `npm run validate:server-evidence` | 64 assertions |
| `npm run validate:functions`, `validate:duels`, `validate:tournament` | pass |
| every other suite the fleet brief lists as passing | pass; `validate:standing` passes too |
| `npx tsx src/core/sync/validateSync.ts <synthetic folder>` | upload path validated against 1,500 runs |

Still failing, for the brief's environmental reasons (no stats folder, no KovaaK's install,
HTTP 403): parser, duration, engine, sync (without a folder argument), verify, match, quests
("real history was readable"), ghost, ghost-links, sce, season-files, attack:verify.

### Each PoC, base and fix

The base tree is commit `930efe4` extracted with `git archive`, plus only the test
infrastructure (harnesses, `tools/lib`, the generator); no fix copied.

**SEC-01 and SEC-02 at the submit-run handler** (scratch reproduction of the harness's attack
steps, using only what both trees have):

| Attack | Base | Fix |
|---|---|---|
| Run played 5h before the match, offset +300 | COUNTED (consistent) | refused 409: match started on UTC, run says UTC−5 |
| Second run from another hour in the same match (+240) | COUNTED | refused 409: match started on UTC−2 |
| Run uploaded live 7h ago, restamped with +420 | COUNTED | stored, not counted (rejected, first-seen time outside window) |
| Corrected end 90 minutes in the future | COUNTED | refused 422 |
| Played 37 min after the deadline, stamped back with −43 | COUNTED | refused 409: ran out of time |
| Same run re-exported into a second match | COUNTED | refused 409: already submitted |
| Linked: KovaaK's has the run 5h before the window | COUNTED (consistent) | stored, not counted (rejected, server_time_in_window) |

**The audit's own PoCs**, retargeted at each tree:

| PoC | Base | Fix |
|---|---|---|
| `poc/replayAcrossMatches.mjs` | 2 claim rows, 2 runs: CONFIRMED | second insert raises `TI409`: one row |
| `poc/playerUpdate.mjs` | 3 holes (steam_id, display_name, flags) | 0 holes |
| `poc/tzWindowBypass*.mjs` | bypass | still reproduces: it calls `verifyRun` directly with a hand-chosen offset, and the fix lives at submission and in the database, which the PoC bypasses. Its regression test is the submit-run harness above. |

**The new harnesses on base**:

| Harness | Base | Fix |
|---|---|---|
| `validateVerifiedPbs.mjs` | fails: no `verified_pbs` row after the migration step (nothing writes it) | 7 cases pass |
| `validateSteamAuth.mjs` | fails: the replayed callback mints `one-time-token-2` | 10 cases pass |
| `attackRls.mjs` | 7 findings: steam_id, display_name, flags, avatar rewritten; ratings readable; profile changed (plus the new `tz_offset_minutes` column absent) | no holes |
| `validateTimeIntegrity.mjs` | cannot set up a match clock (no columns) | 23 cases pass |
| `validateRendererSinks.mjs` | passes (the renderer was already clean; it is a guard) | passes |

## Integration: what each match-side path must call

The rules are in one shared helper, `supabase/functions/_shared/timeIntegrity.ts`, and the
database trigger, which applies to every insert into `runs` whatever the match type.

**A function that creates the caller's own side of a match** (find-match, send-duel,
answer-duel, play-fixture today; open-duel, Shadows, Flags, Crowns, race-action and any
other at integration):

```ts
import { matchClock } from "../_shared/timeIntegrity.ts";
// after the one-match and eligibility checks, before creating anything:
const clock = await matchClock(admin, caller.playerId, body);
// then on the caller's own match_sides insert:
{ match_id, player_id: caller.playerId, rating_before, rd_before, ...clock }
```

If the side is written inside SQL (an RPC, as `tournament_open_leg` does), call
`await recordMatchClock(admin, matchId, caller.playerId, clock)` after it. A copied opponent
side needs nothing. If the function validates its body with a field list (`onlyFields`), add
`"tzOffsetMinutes"`. On the client, add `tzOffsetMinutes: matchClockOffset()` to the request
body (`matchClockOffset` is in `src/app/api.ts`). A path that does none of this still works:
submit-run pins the clock on the match's first ranked run, with the same continuity check.

**A function that submits runs to a match** should go through submit-run, which applies every
rule. **A function that writes runs itself** (post-ghost; `daily-submit` if it inserts runs)
must put the offset it applied in `tz_offset_minutes`, refuse
`isFutureDated(endedAt, Date.now())` with `futureMessage`, and, if it grades a run against a
time window, read `firstSeenPlayTime(...)` first and grade against that time. First-seen
pinning, the future-dated skip and (for rows with a `match_id`) the fingerprint claim happen in
the trigger regardless.

## Deployment order

1. **Migration** `20261003000026_time_integrity_and_hardening.sql`. It must precede the
   client: updated clients send `tz_offset_minutes` on history, which needs its column grant,
   or every batch fails. It must precede steam-auth, which needs its tables. It is safe under
   old clients and old functions: the new columns are nullable and the trigger only adds
   refusals the documented rules imply.
2. **Functions**: submit-run, find-match, send-duel, answer-duel, play-fixture, post-ghost,
   steam-auth, and every function that imports `_shared/apogee.ts` (the frozen PB floor is in
   `baselineFor`; settle-match and submit-run use it). `npm run deploy:functions` covers all.
   Matches in flight have no clock and are pinned by their next ranked run. A sign-in begun
   before steam-auth deploys is refused once.
3. **Client** release (offsets on history and match requests, per-file offset on
   submissions, sandboxed window). Old clients keep working until they update.

## Merge hotspots

`supabase/functions/find-match/index.ts` (one import, one Body field, one call, two spreads;
fleet/queue edits this file), `send-duel`, `answer-duel`, `play-fixture`, `post-ghost`
(small, isolated), `submit-run` (substantial), `_shared/apogee.ts` (`baselineFor` only),
`src/app/api.ts` (one import, four request bodies, the submit offset, one helper), `src/app/main.ts` (two
`webPreferences` lines), `src/core/sync/uploadRuns.ts`, `package.json` (two scripts and the
end of the `validate` chain), `tools/attackRls.mjs`, `tools/validateSchema.ts`,
`tools/validateSubmitRun.mjs` (fixture now relative to now), `tools/validateRankedClaims.mjs`
(distinct runs get distinct challenge starts), `FAIR-PLAY.md`, `PLAN.md`, `PRIVACY.md`.
`tools/fixtures/syntheticStats.ts` and `validateSyntheticStats.ts` are cherry-picked unchanged
from fleet/flow `d95382b`, without its package.json script.
