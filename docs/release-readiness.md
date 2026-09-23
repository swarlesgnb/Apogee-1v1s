# Release checklist

What still stands between the local candidate and a public release, and how to re-check
it. The solo campaign rules are in [the solo guide](solo-expedition.md).

## Last local candidate, 2026-09-21

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
node tools/validatePackage.mjs release/candidate-2026-09-21-rc2
```

`validate:release` writes each result under `.cache/release-readiness/`, failures
included.

Rebuilding the candidate:

```powershell
npm.cmd run build:icon
npm.cmd run build:app
& .\node_modules\.bin\electron-builder.cmd --win --publish never --config.directories.output=release/candidate-2026-09-21-rc2 --config.extraMetadata.version=0.4.0-rc.2
```

The hash changes on every rebuild, so re-run the package check and the signature check
after it. Run the packaged executable with `--smoke` from a temporary working directory
and keep its stdout and stderr. Use a new candidate directory and version for anything
that goes out to testers.
