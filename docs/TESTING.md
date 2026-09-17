# Testing Apogee

For the people trying it, not for the people building it. `SETUP.md` is about standing up
a backend; this is about getting a window on screen and playing a match.

Ten minutes, most of it the installer and the first sign-in.

## What it does to your machine

It reads. KovaaK's writes a CSV into its stats folder every time you finish a scenario;
Apogee parses those files and uploads the scores. Nothing is typed in by hand, and
nothing is written back into the stats folder or into KovaaK's.

What leaves your machine is in [PRIVACY.md](../PRIVACY.md): scores, scenario names,
timestamps and your Steam id. Not your files, not your inputs, not your screen.

## 1. Install

Download `Apogee-0.3.0-setup.exe` and run it.

Windows will show a blue **Windows protected your PC** box, because the installer is not
code-signed. Click **More info**, then **Run anyway**. A signing certificate is a few
hundred dollars a year and this is a test build; if that trade is not one you want to
make, do not install it. That is a reasonable answer.

The installer is per-user, so it never asks for an administrator password, and it lets
you choose where it goes.

## 2. First launch

Apogee looks for the KovaaK's stats folder by reading the Steam install location out of
the registry and walking your Steam libraries, so a normal install is found without
being asked. It looks for:

```
<steam library>\steamapps\common\FPSAimTrainer\FPSAimTrainer\stats
```

If it cannot find it, the status bar at the bottom says so and offers a button. The same
thing lives in the menu under **Apogee → Choose stats folder…**. Pick the `stats` folder
itself, not the `FPSAimTrainer` folder above it. It is remembered after that.

The status bar shows how many runs it found. If that number is zero and you have played
KovaaK's, the folder is wrong.

## 3. Sign in

**Sign in with Steam** opens your normal browser and sends you to Steam's own login.
Apogee never sees your password: Steam signs an assertion, the browser hands it back to
the app on a loopback port, and the server verifies it with Steam directly.

## 4. Upload your history, once

**This does not happen by itself, and nothing works properly until it is done.**

On the Play screen there is a **Your history** panel with an **Upload** button. Press it.

A match is scored against your own recent runs, so those runs have to be on the server
before the first match means anything. Several thousand runs takes a minute or two and
there is a progress bar. It is safe to press again; a file already sent is ignored.

After that first upload the app keeps itself current on its own — new runs go up as they
land, and anything played while it was closed goes up on the way in.

## 5. Play a match

Queue a category. When it matches you with somebody, the app gives you three scenarios.

Play them in KovaaK's the way you always would. Apogee is watching the stats folder, so
each run appears in the app a second or two after you finish it. Alt-tab back whenever
you want to look; you do not have to keep the window in front.

Scores are graded against **your own** recent runs, not against a global number, so a
match is winnable regardless of rank. Rating, verification and settlement all happen on
the server.

## 6. Saturday's tournament

Round-robin groups, then a single-elimination bracket. Every fixture is an ordinary
3-scenario match. **Tournament matches are unrated** — nothing that happens in the
bracket moves your ladder rating.

Two things worth knowing:

- **Check in before it starts.** Joining is not checking in. The draw only counts
  checked-in entrants, and anybody who has not checked in when the host starts it is not
  in a group.
- **Each fixture is played as two legs.** Whoever presses Play first plays their three
  scenarios; the other player then answers the same three. Yours being done does not mean
  the fixture is done.

## What to report, and how

The menu has **Apogee → Copy diagnostics**. It puts a few hundred characters on your
clipboard — build stamp, run count, stats folder, sign-in state, last failure. Paste that
with the report; it answers most of the questions that otherwise take four messages.

Worth reporting:

- A score that reads wrong, or a run that did not appear in the app.
- A match that settled the wrong way, or did not settle.
- Anything that says `No handler registered for apogee:…` — that is a broken build, not
  something you did.
- A rank or number that is obviously nonsense.

**Logs:** **Apogee → Open log**. **Uninstall:** normal Windows Apps & features. It leaves
nothing in the KovaaK's folder.
