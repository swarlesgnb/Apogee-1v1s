# Release checklist

What still stands between the local candidate and a public release, and how to re-check
it. The solo campaign rules are in [the solo guide](solo-expedition.md).

## 0.4.2, 2026-09-28

- Installer: `release/Apogee-0.4.2-setup.exe`
- SHA-256: `d5e6e26c542ed997001b741f6e9441b8bb3f3754032cee15c52a820b95998608`
- Notes: `release/notes-0.4.2.md`
- Carries the first outside playtest's fixes (onboarding, Expedition's first view, the
  duel take-back loop, off-pool matches), per-band threshold calibration with First Light
  v5 refrozen on it, and five daily quests from 22 kinds. No scenario file changed, so the
  hashes the server holds are 0.4.1's. It needs the functions redeployed and
  `push:season` for the server's side.
- `validatePackage` passed 179 of 179, and the unpacked build booted in `--smoke` from a
  temporary directory. Unsigned (`Get-AuthenticodeSignature` reports NotSigned).
- `validate:release` passed 31 of 35 before v5 was refrozen and `validate:expedition` then
  passed. The three still failing were failing before this version's changes:
  `validate:season-files` (ten scenario values outside the popular-scenario range: Gravclick,
  Blastoff, Thread, Arc, InvadersTS), `beta` (41 unsampled Expert boards, as at rc.4), and
  `audit:look`, whose unlifted-rank-text detector reads `esc(color)` in `badge()` without
  seeing that `color` is `legibleOnDark(...)` two lines above it.

## 0.4.0, 2026-09-25

- Installer: `release/0.4.0/Apogee-0.4.0-setup.exe`
- SHA-256: `57d542cf2774bed3e5476fba880aec8ace6025edbbd8ac8e53366a08544c168f`
- rc.4 with the queue opened at 50 uploaded runs, and `package.json` at 0.4.0.
  `validatePackage` passed 179 of 179 and the unpacked build booted in `--smoke` from a
  temporary directory. Unsigned. The bar is enforced by `find-match` too, so it holds only
  once the functions are redeployed.

## rc.4, 2026-09-25

- Installer: `release/candidate-2026-09-25-rc4/Apogee-0.4.0-rc.4-setup.exe`
- SHA-256: `ec3f105fa22b441beed7747806d1a69af58d05e333fe014301150e0cb60d9445`
- Unpacked: `release/candidate-2026-09-25-rc4/win-unpacked/Apogee.exe`
- The first candidate on Apogee's own Season 1 scenarios: it ships and installs the 164
  `.sce` files, which rc.3 (built the day before that pool landed) does not. Also carries
  the expedition deck, mixtape verdicts, and the first-launch fixes (Unplaced, the
  unsampled apex board, the kept install notice, Steam sign-in errors reaching the app).
  `validate:release` passed 34 of 35; the failure is the apex-board beta blocker, which
  clears when the scenarios are shared in KovaaK's (see [season-1](season-1.md)).
  `validatePackage` passed 179 of 179, and the unpacked build booted in `--smoke` from a
  temporary directory with all 164 scenarios. Unsigned.

rc.3 is on the previous pool and should not go out. Its details follow.

- Installer: `release/candidate-2026-09-23-rc3/Apogee-0.4.0-rc.3-setup.exe`
- SHA-256: `be7de9de60853046ea4d9d00afdf3389dec11a197a26d1e1430ccf9e22b2c270`
- Unpacked: `release/candidate-2026-09-23-rc3/win-unpacked/Apogee.exe`
- Carries the fun rebuild of the Season 1 pool (which needs `sync:reference` and
  `push:season` on the live project), First Light v4, the match and sign-in fixes, the
  season-editor polish, and Mixtape. `validate:release` passed 36 of 36,
  `validatePackage` 14 of 14, and the unpacked build booted in `--smoke` from a temporary
  directory. Unsigned.

rc.2 predates all of that and should not go out. Its details follow.

- Installer: `release/candidate-2026-09-21-rc2/Apogee-0.4.0-rc.2-setup.exe`
- SHA-256: `52765aaebd372db6573b6f2e2c1a1d1dff700bc7a0cb361875303cdb1a0b3a66`
- Unpacked: `release/candidate-2026-09-21-rc2/win-unpacked/Apogee.exe`
- Unsigned (`Get-AuthenticodeSignature` reports NotSigned). Builder messages about running
  signtool do not mean it was signed.
- Built with `extraMetadata.version=0.4.0-rc.2`; `package.json` stays at `0.3.0`. It
  carries the v3 difficulty journeys, the match fixes in migration 19 and the functions
  (which have to be deployed separately), and the pool grid in the season editor.
- rc.1 in `release/candidate-2026-09-21/` predates all of that and should not go out.

`validate:release` passed 35 of 36 checks; the one failure is gate 1 below.
`validatePackage` passed 13 of 13 against the archive, which holds no image, manifest or
player snapshot, and the unpacked build booted in `--smoke` from outside the repository
against the local stats folder. Smoke mode puts settings, progress, logs and Chromium
caches in a fresh temporary profile, so it never touches a real one. Electron prints a
console-message deprecation warning, so the run is not warning-free.

## Gates

1. **The benchmark overall-rank rule, now fitted rather than published.** `validate:engine`
   compares 24 category/overall results against KovaaK's, and summed category thresholds
   disagreed twice: Voltaic S5 Intermediate at 135930.08 and at 139179.96 overall energy is
   Jade on the server, where the summed Jade bar is 142,500. The engine now takes the lowest
   category's threshold at each rank times the number of categories (Jade at 135,000), which
   matches all 24 comparisons; the two rules differ only where categories ask different
   amounts per rank, which in Voltaic S5 is Intermediate alone. What is still unconfirmed is
   the exact published number: KovaaK's creator export carries a separate overall array,
   the definition endpoint returns 401 without auth, and neither public route nor Voltaic's
   sheet (a different energy scale) exposes it. Replace the rule with that array when it
   can be read. The check still runs live on every release, so a third disagreement fails
   it again.
2. **Play the solo path in KovaaK's.** Playlist discovery, scenario launches, stats
   arriving, target difficulty, a failed and retried finale, and whether a full session is
   varied enough to want to finish. None of that shows up in an automated check.
3. **Live account and multiplayer.** Steam login, ten real matches, settlement,
   rejected-run voiding and Suspect handling. These are the existing beta gates.
4. **Release policy and signing.** The live season is still a draft. Rating reset or
   carryover out of beta, API use, benchmark-author permissions and Windows signing are
   all still open.
5. **Install and upgrade on a clean Windows profile.** The archive and the unpacked
   executable are checked; the NSIS wizard, shortcuts, uninstall and upgrading over an
   older install are not.

## Re-checking

```powershell
npm.cmd run validate:release
node tools/validatePackage.mjs release/candidate-2026-09-25-rc4
```

`validate:release` writes each result under `.cache/release-readiness/`, failures
included.

Rebuilding the candidate:

```powershell
npm.cmd run build:icon
npm.cmd run build:app
& .\node_modules\.bin\electron-builder.cmd --win --publish never --config.directories.output=release/candidate-2026-09-25-rc4 --config.extraMetadata.version=0.4.0-rc.4
```

The hash changes on every rebuild, so re-run the package check and the signature check
after it. Run the packaged executable with `--smoke` from a temporary working directory
and keep its stdout and stderr. Use a new candidate directory and version for anything
that goes out to testers.
