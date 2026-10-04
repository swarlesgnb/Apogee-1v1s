# What Apogee collects, and what it does not

Apogee reads a folder that another program wrote, and uploads some of it to a server so
a ladder can be settled. People are right to be suspicious of a tool that reads their
files and sends them somewhere, so this lists exactly what is sent.

This describes what the software actually does. If something here disagrees with the
code, the code is the bug.

## What leaves your machine

When you sign in. Steam tells Apogee your SteamID64, display name, avatar URL and
country, and those are stored. Signing in is done through Steam itself; Apogee never
sees your Steam password.

When a run is uploaded. KovaaK's writes a CSV for every scenario you play. Apogee
sends that file's contents, and stores what it parses out:

- the scenario name, your score, accuracy, average time-to-kill, kills, hits and misses
- when it was played, and how long it ran
- the game version, average FPS and resolution
- your sensitivity settings: cm/360, DPI and FOV
- a SHA-256 of the file, which is what stops the same run being submitted twice

For runs that are part of a match, the per-kill rows are kept as well, so that a
disputed score can be re-derived from the file rather than taken on trust. For ordinary
history they are discarded, because they decide nothing.

The sensitivity and hardware fields are listed above rather than folded into "technical
data" on purpose: they are in the file KovaaK's writes, they are uploaded, and some
players consider their config private. Nothing displays them to anyone else today.

Your KovaaK's username, if you provide one. This is a kovaaks.com registration,
separate from Steam. It is stored only once KovaaK's has confirmed the username belongs
to your Steam account. Leaving it empty is normal and supported; verification degrades
to a lower tier instead of failing.

When a finished Apogee Daily is posted to the day's board (signed in only). The three
runs go up as files, exactly as a match run does, and the server stores your entry for
that day and band: the scenario names, scores, baselines, one above/near/below mark per
scenario and the mean. Other players see only the board's distribution and how many
played: never your name, your entry or your scores. Signed out, the Daily never leaves
your machine.

When you post or answer an open challenge. The challenge stores a code, your three
scenarios and your run set, like any duel. Anyone you give the code to sees your display
name, the category and band, and whether you have finished; never your score before they
have played. Answers are unrated.

Nothing else. No keystrokes, no mouse input, no screen capture, no process list, no
scanning of any folder other than the KovaaK's stats folder you point it at.

## Discord, only if you turn it on

"Show what I'm playing on Discord" (Links & Discord, at the top of the app) is off by
default. Turned on, Apogee talks to the Discord app already running on your computer,
over Discord's local connection, and your Discord friends can see:

- what kind of thing you are playing: a ranked match, a duel, an open challenge, a
  tournament match, a ghost race, or Apogee Daily and its number;
- its category (for example Precise Tracking) or the Daily's band;
- how long you have been at it.

Never your score, rating, rank, opponent's name or any code. Apogee does not send any
of this to its own server or anywhere else; it goes from Apogee to the Discord app on
your machine, and Discord shows it under its own privacy terms. Turning the setting off
clears it at once. A build made without a Discord application id cannot turn it on at
all.

## What never leaves your machine

- Crash logs. Errors are written to a file on your own computer
  (`Help > Open log`). They are never uploaded. If you want to send one with a bug
  report, that is your decision to make each time.
- Your local match and quest state, beyond what the ladder needs.

## Who can see it

Your player row is readable only by you. This is enforced by the database, not by
the client:

- Row-level security restricts every player table to the signed-in owner's rows.
- Moderation flags are not readable even by you: an account that can see it is under
  review knows exactly when to stop.
- Opponent information reaches your client only as the server chooses to release it:
  a display name and the scores of the match you are actually in.

Clients have no write access at all to ratings, matches, match sides, baselines or
verified personal bests. Those are computed server-side. This is the same rule that
makes the anti-cheat meaningful, and it has the side effect that no other player can
alter anything of yours.

## Third parties

| Who | What they get | Why |
|---|---|---|
| **Steam** | An authentication request | To prove the account is yours |
| **kovaaks.com** | Your KovaaK's username, to read your own recent scores | Server-side verification: their records are the referee |
| **Supabase** | Everything listed above, as the hosting provider | It is where the database and functions run |
| **Discord** | Only if you turn presence on: what you are playing, its category or Daily number, and for how long | Rich Presence for your Discord friends |

Ordinary server request metadata, including IP addresses, is handled by the hosting
provider as part of serving a request.

## Deleting your data

Every table hangs off your account with `on delete cascade`, so deleting the account
deletes the runs, ratings, matches, baselines and quest state with it. There is no
soft-delete and no archived copy.

To request deletion, open an issue or use the contact address in the README. It is done
by hand for now; making it self-service is on the list.

Uninstalling the app removes it from your computer but does not delete server-side data
on its own; ask for deletion if that is what you want.

## Changes

This file is versioned in the repository. `git log PRIVACY.md` is the change history,
and it is the real one.
