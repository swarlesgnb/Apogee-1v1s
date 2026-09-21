# Release checklist

What still stands between the local candidate and a public release, and how to re-check
it. The solo campaign rules are in [the solo guide](solo-expedition.md).

## Last local candidate, 2026-09-21

- Installer: `release/candidate-2026-09-21/Apogee-0.4.0-rc.1-setup.exe`
- Unpacked: `release/candidate-2026-09-21/win-unpacked/Apogee.exe`
- Unsigned. Builder messages about running signtool do not mean it was signed.
- Built with `extraMetadata.version=0.4.0-rc.1`; `package.json` stays at `0.3.0`.
- It predates the v3 difficulty journeys: the installer still carries the v2 campaign.
  Rebuild before handing it to anyone.

`validate:release` passed 35 of 36 checks at the time; the one failure is gate 1 below.
`validatePackage` passed 13 of 13 against the archive, and the unpacked build booted in
`--smoke` from outside the repository against 13,618 local runs. Smoke mode puts
settings, progress, logs and Chromium caches in a fresh temporary profile, so it never
touches a real one. The pool validator passes with two warnings, and Electron prints a
console-message deprecation warning; neither is a clean run.

## Gates

1. **The benchmark overall-rank disagreement.** `validate:engine` compares 24
   category/overall results against KovaaK's. Voltaic S5 Intermediate at 135930.08
   overall energy is Diamond locally and Jade on the server, while every category energy
   and rank matches. The suspect is the assumption that the overall threshold is the sum
   of the category thresholds: KovaaK's creator export carries a separate overall array. The live
   benchmark definition endpoint returns 401 without auth. Get the real definition before
   changing the model or the fixtures; a guessed formula, or muting the check, would hide
   exactly the thing it exists to catch.
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
node tools/validatePackage.mjs release/candidate-2026-09-21
```

`validate:release` writes each result under `.cache/release-readiness/`, failures
included.

Rebuilding the candidate:

```powershell
npm.cmd run build:icon
npm.cmd run build:app
& .\node_modules\.bin\electron-builder.cmd --win --publish never --config.directories.output=release/candidate-2026-09-21 --config.extraMetadata.version=0.4.0-rc.1
```

The hash changes on every rebuild, so re-run the package check and the signature check
after it. Run the packaged executable with `--smoke` from a temporary working directory
and keep its stdout and stderr. Use a new candidate directory and version for anything
that goes out to testers.
