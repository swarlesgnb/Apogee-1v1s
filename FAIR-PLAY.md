# Fair play: what Apogee catches, and what it does not

## The short version

Apogee verifies runs by asking KovaaK's own servers what you scored, rather than by
trusting the file on your disk. A forged or edited stats file does not survive that
check, and every local integrity check was measured against 11,058 genuine runs before
it was allowed to reject anything. **What Apogee cannot catch is a cheat that makes
KovaaK's itself record a real score.** An aimbot or hardware assistance produces a
genuine leaderboard entry, and no amount of reading that entry will reveal it. That
class of cheating is addressed by statistical review of top-end accounts and human
review at the top of the ladder, which is the same answer every competitive game
arrives at. It is a real limitation and it is stated here rather than discovered later.

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
server-side verification is unavailable and grading degrades to Consistent. That is
graceful degradation, not suspicion, and it costs you nothing on the ladder.

## What is rejected, and what happens

A run is rejected for one of three reasons, all of which are properties of the file
rather than judgements about you:

- the CSV contradicts itself in a way a genuine file cannot
- the exact file has been submitted before (replay)
- it was played outside the window of the match it was submitted for

A rejected run voids the match it belonged to. The account is flagged for review.

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

Two honest caveats:

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

## Credit where it is due

Apogee reads benchmarks and thresholds published by Voltaic, and scenario data that
KovaaK's and the evxl registry make available. The ladder's rank names and tiers
are Apogee's own and are deliberately not Voltaic's, so that a rank here is never
mistaken for a Voltaic rank. See [README.md](README.md) for the full credits.
