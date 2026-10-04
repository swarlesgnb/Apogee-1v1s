# Fair play: what Apogee catches, and what it does not

## The short version

Apogee compares runs with records from KovaaK's servers when a linked account and
matching record are available. Verified requires a matching score, nonempty scenario
hash and challenge start, and a server timestamp within three minutes of the run's
corrected end time. For a ranked match, that server timestamp must also lie inside
the match window. Missing evidence never earns Verified, and never rejects a run; a
record of the same run that places it outside the match window does reject it.

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
| **Rejected** | A hard consistency or match-window check fails, including a KovaaK's record of the same run timed outside the match | Excluded; an incomplete set of counted rounds voids settlement |

Rating weight also depends on whether the baselines are provisional. Verification
alone does not guarantee a full-weight rating change. Replayed submissions are refused
before saving another run; they do not automatically flag an account or void a match.

A baseline is the median of your last 50 runs on a scenario, floored at 90% of the
best score KovaaK's has confirmed for you there: the best of your runs Apogee graded
Verified. A match uses the floor as it stood when the match began, so a personal best
set during a match never raises that match's baseline. Without a linked account there
are no Verified runs and the baseline is the median alone.

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

A run is rejected for one of these reasons, all of which are properties of the file
or of KovaaK's record of it rather than judgements about you:

- the CSV contradicts itself in a way a genuine file cannot
- it was played outside the window of the match it was submitted for
- KovaaK's has a record of this exact run (same score, scenario hash and challenge start
  to the millisecond) timed outside that window. A missing record never does this; only
  a record that contradicts the run's time.

Some submissions are refused before anything is saved:

- the same performance has already counted in a match (a replay). This is decided by
  the scenario, the challenge start and the score, so a re-exported file, a renamed file
  or a different time zone setting is still the same run.
- the run's time zone differs from the one its match started with. Every run in a
  match uses the PC clock the match began on; a daylight-saving change during the match
  is accepted.
- the run's end time is more than fifteen minutes ahead of the server's clock.
- the run reaches the server more than fifteen minutes after its match ran out of time.
- a ranked run from a client too old to say which time zone it was played in.

A new match is refused, with the time it will be accepted, when the PC's time zone
differs from the one on your own uploads from the last six hours. Daylight-saving
changes are accepted at once; a time zone changed by travel is accepted six hours after
your last run in the old one.

A saved rejected run is excluded when the match settles. A refused submission saves no
match run. None of these actions currently writes an account moderation flag.

A run keeps the play time it was first uploaded with. The app uploads every run as
history the moment it lands, so a run cannot later be stamped into a match it was not
played in. Its first server receipt determines attempt order.

**What the time checks cannot do.** KovaaK's writes only a local wall clock into the
stats file, and the time zone that turns it into a moment comes from your PC. For a
player with a linked kovaaks.com account, KovaaK's own timestamp settles when a run was
played. Without one, a player who never lets the app upload as they play and keeps a
false time zone consistently for weeks can still submit a run played some hours before
a match. Such a run grades Consistent and counts, which is the same limit as any other
coherent forgery above.

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
