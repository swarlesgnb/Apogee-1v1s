# Fair play: what Apogee catches, and what it does not

## The short version

Apogee verifies runs by asking KovaaK's own servers what you scored, rather than by
trusting the file on your disk. A forged or edited stats file does not survive that
check, and every local integrity check was measured against 11,058 genuine runs before
it was allowed to reject anything. **What Apogee cannot catch is a cheat that makes
KovaaK's itself record a real score.** An aimbot or hardware assistance produces a
genuine leaderboard entry, and no amount of reading that entry will reveal it. That
class of cheating is addressed by statistical review of top-end accounts and human
review at the top of the ladder, which is where most competitive games end up. It is a
real limitation.

## How a run is graded

Every submitted run gets a tier, and the tier is shown on the match screen.

| Tier | What it means | Effect on rating |
|---|---|---|
| **Verified** | KovaaK's servers hold a matching record: same hash, challenge start, Steam ID, and time window | Counts in full |
| **Consistent** | No server record, but the file is internally coherent, was played inside the match window, and is within 2% of your verified personal best | Counts in full, flagged |
| **Suspect** | Above your verified personal best with no server record | Counts, held for review, **not** auto-voided |
| **Rejected** | The file contradicts itself, has been submitted before, or was played outside the match window | Match void, account flagged |

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

A rejected run voids the match it belonged to. The account is flagged for review.

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

> Draft. The process below is what the software supports; the turnaround and the
> contact route still need to be confirmed before launch.

If a match was voided and you believe that is wrong, it can be reviewed. What makes a
dispute answerable:

1. **The original stats file.** KovaaK's wrote it to your stats folder and Apogee never
   deletes it. It is the evidence, and without it there is very little to review.
2. **When the match was, and which scenario.** Enough to find the record.
3. **The app log**, via `Help > Open log`. Optional, and it is your choice whether to
   send it; see [PRIVACY.md](PRIVACY.md).

A review re-runs verification against the stored file and the stored verification notes.
The outcome is either that the run is reinstated and the match re-settled, or that the
rejection stands with the specific check that failed named. "It looked suspicious" is
not an outcome; a rejection that cannot be explained in terms of a named check is a bug
in Apogee and will be treated as one.

Two caveats:

- One person answers these today. There is no moderation team. Expect a human
  reply, not a fast one.
- A review will not tell you your account's moderation state. Whether an account is
  under review is deliberately not readable by its subject, because an account that can
  see it is being watched knows exactly when to stop. A dispute answer addresses the
  match, not the flag.

## Reporting someone else

There is no in-app report button yet. Statistical review at the top of the ladder is the
mechanism that is actually built. If you believe a specific account is cheating, the
useful thing to include is the scenario and the scores, not a video of the crosshair.

## Credits

Apogee reads benchmarks and thresholds published by Voltaic, and scenario data that
KovaaK's and the evxl registry make available. The ladder's rank names and tiers
are Apogee's own and are deliberately not Voltaic's, so that a rank here is never
mistaken for a Voltaic rank. See [README.md](README.md) for the full credits.
