# Evasive switching rework

The local circuit now has 11 families and 44 scenarios, up from 10 and 40. It introduces 23 scenario selections and retires 19. Floating Heads and Layered Chase add short floating-head clears and route choices across two stacked chambers. The complete season has 256 scenarios.

The rework addresses physical scenario selection, not just score labels. The previous Novice pool included `tamTargetSwitch Smooth Hard 30% Larger`; other families mixed authors and movement tasks, and Domi's Expert choice was justified by comparing top scores from different edits. Those comparisons cannot establish physical difficulty.

| Family | Novice change | Progression |
| --- | --- | --- |
| Pasu Switch | PasuTS Entry: 15% larger and 15% slower | One PasuTS lineage through Intermediate, Advanced and Elite |
| Floating Heads | New Floatswitch Entry, with 0.2-second clears | Entry, Intermediate, Advanced, Elite |
| Chamber Relay | ControlTS Entry Speed: larger, slower entry targets and shorter clears | Existing Intermediate, Advanced and Elite editions retained |
| Penta Bounce | Penta Bounce Entry Speed: generous bouncing targets and shorter clears | Existing upper editions retained |
| Arc Transfer | B180T Easy Slower | Easy, standard, then Regen; regeneration arrives at Expert |
| FlyTS | FlyTS Entry Speed: larger entry targets and shorter clears | Existing upper editions retained |
| Layered Chase | New DriftTS Entry Speed | Intermediate, Advanced, Elite in the same two-chamber lineage |
| Domi Relay | Existing Easier cut retained | Easy, standard, Hard replaces the mixed Avasive ending |
| tamTargetSwitch Smooth | Entry replaces Hard 30% Larger | Authored Entry, Novice, Intermediate and Elite editions |

Hop Transfer and Regen Control retain their scenarios and score targets. Regeneration drills come at the end of the circuit. Smooth Relay is retired: its previous Expert board had only 145 sampled entries and almost tied upper targets.

Each new selection has an exact-name and leaderboard-ID check from the [KovaaK's scenario catalogue](https://kovaaks.com/kovaaks/scenarios), frozen in `data/evasive_rework_evidence.json`. Existing leaderboard samples remain unchanged; missing distributions and positional anchors were sampled from KovaaK's. New scenarios use the existing season percentile curve with the stricter two-rank crossover factors, capped at the demonstrated record. Retained scenarios in the same band keep their existing targets and provenance, including the established upper-band challenge. All 36 target arrays can be reproduced from `data/evasive_rework_calibration.json`.

PasuTS, Floatswitch and domiSwitch Hard need explicit aim-type corrections because the catalogue's broad Clicking tag conflicts with the authored firing task. These corrections distinguish catalogue descriptions from measured local runs. The original measured-correction checks remain in place, and seed generation uses the same corrections as pool validation.

The prior expansion and theory audits reconstruct the pre-rework circuit from the saved before-state; `validate:evasive` checks the current circuit, exact identities, target arithmetic, queue categories, playlists and rank handovers. The curation validator checks every current family and the editor round trip.

This is a local draft. Named variant ladders and larger/slower entry edits provide a better-supported progression, but do not prove equal effort between families. Sparse Expert boards remain provisional. Gameplay difficulty and enjoyment have not been playtested. Publishing the backend season and building an installer are separate from this local rework.

Validation passed: TypeScript, app build, desktop smoke, pool, aim types, threshold provenance, rationale, current curation, historical expansion/theory audits, dedicated evasive regression checks, season editing, standings, playlist format and matchmaking. The smoke check rendered all 256 scenario rows and 24 band cards.

The broader daily-quest variety check fails because one quest appears on 10 of 28 sampled days. Running the same check against the prior committed season produces the identical failure. The season build also retains the existing Static Clicking warnings for the top rank on Micro and Wide Pressure. Neither diagnostic is evidence of an evasive regression.
