# Testing Apogee

For the people trying it, not for the people building it. `SETUP.md` is about standing up
a backend; this is about getting a window on screen and playing a match.

Ten minutes, most of it the installer and the first sign-in.

## What it does to your machine

It reads. KovaaK's writes a CSV into its stats folder every time you finish a scenario;
Apogee parses those files and uploads the scores. Nothing is typed in by hand, and
nothing in the stats folder is ever changed.

The one thing it writes into KovaaK's is playlists: the season's, a playlist for each
match you are in, and the Expedition's, all in `FPSAimTrainer\Saved\SaveGames\Playlists`
and all named `Apogee …`. Old match playlists are cleared out as new ones are written;
nothing whose name does not start with `Apogee` is touched.

What leaves your machine is in [PRIVACY.md](../PRIVACY.md): scores, scenario names,
timestamps and your Steam id. Not your files, not your inputs, not your screen.

## 1. Install

Download `Apogee-0.4.0-setup.exe` from the release page and run it.

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
thing lives in the menu under **Apogee → Choose stats folder…**. Picking the game folder
or the Steam library above it is fine: Apogee finds the `stats` folder inside. A folder
with no KovaaK's stats at all is refused with a note on where it usually is. Your choice
is remembered after that.

A fresh KovaaK's install with no runs yet is fine too; Apogee says the folder was found
and picks up your first run as it lands.

On first launch Apogee also installs Season 1's 164 scenarios into KovaaK's. They exist
nowhere else, and KovaaK's only reads scenarios when it starts, so if the game was open,
restart it before looking for them.

The status bar shows how many runs it found. If that number is zero and you have played
KovaaK's, the folder is wrong.

## 3. Sign in

**Sign in with Steam** opens your normal browser and sends you to Steam's own login.
Apogee never sees your password: Steam signs an assertion, the browser hands it back to
the app on a loopback port, and the server verifies it with Steam directly.

Closed the tab, or signed into the wrong Steam account? Press the button again to start
over, or **Cancel**. You stay signed in between launches, and launching before your
network is up does not sign you out: the app says it is retrying and carries on.

## 4. Your history uploads itself

A match is scored against your own recent runs, so those runs have to be on the server
before the first match means anything. Ranked needs 50 uploaded runs. If your PC holds
enough, Apogee starts the upload the first time you sign in and says so; several thousand
runs takes a minute or two, with a progress bar. If it does not start, the note under the
queue button has an **Upload my runs** button, and so does the **Your history** panel.
Pressing it again is safe; a file already sent is ignored.

After that first upload the app keeps itself current on its own — new runs go up as they
land, and anything played while it was closed goes up on the way in.

## 5. Play a match

Queue a category. When it matches you with somebody, the app gives you three scenarios.

Play them in KovaaK's the way you always would. Apogee is watching the stats folder, so
each run appears in the app a second or two after you finish it. Alt-tab back whenever
you want to look; you do not have to keep the window in front.

Closing Apogee mid-match is safe: on the next launch the match comes back with the
scenarios you already played marked done. If the result cannot be fetched after your
third run, the app retries on its own and offers **Get result**; do not abandon a match
you have finished, because abandoning counts as a loss. The result screen has **Queue
again**.

Scores are graded against **your own** recent runs, not against a global number, so a
match is winnable regardless of rank. Rating, verification and settlement all happen on
the server.

If you want the season's scenarios as practice playlists, the **Season** screen writes
them into KovaaK's for you, and the **Scenarios** screen can install whatever you have
filtered it to. A filled mark on a playlist means it is already there. KovaaK's only reads
playlists when it starts, so restart the game to see new ones. Apogee playlists you
installed before a season change are brought up to date the next time Apogee starts.

## Practice on your own terms: Mixtape

The **Mixtape** tab builds a 3, 6 or 9 scenario set from the season pool: a balanced
mix, the scenarios closest to their next threshold, or the ones you play least. Press
**Open in KovaaK's** for each track, or turn on **Auto-open next track** and the next one
opens as each run lands. Finished sets are kept as recaps. Nothing here is rated.

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

**Logs:** **Apogee → Open log**. **Uninstall:** normal Windows Apps & features. The
`Apogee …` playlists stay in KovaaK's afterwards; delete them from the Playlists folder
above if you want them gone.
