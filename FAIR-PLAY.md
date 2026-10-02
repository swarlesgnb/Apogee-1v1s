# Fair play: what Apogee catches, and what it does not

## The short version

Apogee compares runs with records from KovaaK's servers when a linked account and
matching record are available. Verified requires a matching score, nonempty scenario
hash and challenge start, and a server timestamp within three minutes of the run's
corrected end time. For a ranked match, that server timestamp must also lie inside
the match window. Missing evidence never earns Verified.

Without that evidence, local consistency checks can catch contradictory edits but
cannot prove a file is genuine. Coherent forgeries can still receive Consistent and
count under the current rating policy. **What Apogee cannot catch is a cheat that makes
KovaaK's itself record a real score.** An aimbot or hardware assistance produces a
genuine leaderboard entry, and no amount of reading that entry will reveal it. That
class of cheating would need further evidence and human review. Automated account
review, moderation queues and an appeal workflow are not implemented.

## How a run is graded

Every submitted run gets a tier, and the tier is shown on the match screen.

| Tier | What it means | Effect on rating |
|---|---|---|
| **Verified** | A record from the linked account matches the score, hash, challenge start and time window | Counts |
| **Consistent** | The available checks pass, but there is no matching server record | Counts |
| **Suspect** | The grading core received evidence of an unusual score or accuracy | Counts; reasons are stored, with no automatic review workflow |
| **Rejected** | A hard consistency or match-window check fails | Excluded; an incomplete set of counted rounds voids settlement |

Rating weight also depends on whether the baselines are provisional. Verification
alone does not guarantee a full-weight rating change. Replayed submissions are refused
before saving another run; they do not automatically flag an account or void a match.

The live submission path looks for a matching server record. It does not currently
supply the grading core with an unrelated personal-best record or an accuracy ceiling,
so those Suspect checks are not active in that path.

Two things about that table are deliberate.

Suspect does not void anything. An earlier draft auto-voided any score above the
verified personal best with no server record. Measured against real data, that was
wrong often enough to be unusable: local personal bests legitimately exceed server ones
for ordinary reasons. A check that flags honest players is worse than no check.

Consistent is a normal, full-credit outcome. A kovaaks.com webapp account is a
separate signup from Steam, and plenty of players have never made one. Without it,
server-side verification is unavailable and grading degrades to Consistent. It is not
treated as suspicious and costs nothing on the ladder.

## What is rejected, and what happens

A run is rejected for one of three reasons, all of which are properties of the file
rather than judgements about you:

- the CSV contradicts itself in a way a genuine file cannot
- the exact file has been submitted before (replay)
- it was played outside the window of the match it was submitted for

A saved rejected run is excluded when the match settles. A refused replay saves no
second run. Neither action currently writes an account moderation flag.

A ranked run's player, scenario and claimed play time can be used only once, even if
the CSV formatting changes. Its first server receipt determines attempt order.
This prevents cosmetic replays; it does not authenticate a forged play time.

Settlement commits the match result, rating history and affected ratings together.
Retries return the existing terminal result. A failed or stale rating calculation
leaves the match unchanged so it can be retried. These server protections require the
corresponding database migrations and function deployment.

## Duels

A duel is a rated match against somebody you named rather than somebody the queue
found. It is the one place in Apogee where a player chooses who they are measured
against, which is why it gets its own section.

The player receiving a duel cannot see how the challenger did. The challenger's score is never copied
onto the duel; it stays on their side of their own match, which the other player has no
read on. Accepting or declining is done blind, in both directions. Picking off the
matches you were going to win is the exact thing the one-match-at-a-time rule exists to
stop, and this is that rule pointed the other way.

Hunting weaker players pays close to nothing. Rating is Glicko-2, so the gain from
beating somebody far below you shrinks toward zero as the gap widens while the upset
loss stays at full price. For a settled player at 1800, one match:

| Opponent | Win | Loss | Losing costs |
|---|---|---|---|
| 1800 | +10.18 | -10.18 | 1x the win |
| 1400 | +1.96 | -18.80 | 9.6x |
| 1200 | +0.68 | -20.21 | 29.8x |
| 800 | +0.07 | -20.89 | 285.7x |

Six hundred points down, a win is worth two thirds of a point and a loss costs twenty.
A ladder climbed by picking easy duels is slower than one climbed by queueing, which is
why there is no rule against it. Re-derive the table with `npm run validate:glicko`.

Everything after the accept is the ordinary path. Same three scenarios, read from
the one row that says what they were; same submission, verification, tiers, forfeit and
settlement described above. A duel is not graded more gently or more harshly than a
queued match, and once it has settled the ladder cannot tell the two apart.

Declining costs no rating and carries no flag; it sets the duel to declined and stops
there. The player who sent it can see that it was declined, which is the point of
answering. Ignoring it is also allowed: a duel nobody answers expires after seven days.

## Disputing a voided match

There is no implemented appeal or automatic reinstatement workflow. The contact route
and review process still need to be established. Keep the following for investigation:

If a match was voided and you believe that is wrong, it can be reviewed. What makes a
dispute answerable:

1. **The original stats file.** KovaaK's wrote it to your stats folder and Apogee never
   deletes it. It is the evidence, and without it there is very little to review.
2. **When the match was, and which scenario.** Enough to find the record.
3. **The app log**, via `Help > Open log`. Optional, and it is your choice whether to
   send it; see [PRIVACY.md](PRIVACY.md).

Verification notes record which checks failed. A terminal match cannot simply be
submitted again to change its result; correcting a historical result would need a
separate, auditable administrative process that has not been built.

## Reporting someone else

There is no in-app report button or automated statistical review of accounts yet.
Scenario names, scores and dates are useful evidence for a future review process.

## Credits

Apogee reads benchmarks and thresholds published by Voltaic, and scenario data that
KovaaK's and the evxl registry make available. The ladder's rank names and tiers
are Apogee's own and are deliberately not Voltaic's, so that a rank here is never
mistaken for a Voltaic rank. See [README.md](README.md) for the full credits.
