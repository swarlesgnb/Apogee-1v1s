# Weakness-specific benchmark rebuild

September 13, 2026. Local draft revision; not published to the live season.

## Design

The [Voltaic x Aimlabs weakness-specific routines](https://docs.google.com/document/d/1oNUBAaLovS0oMLn0_z3BEPT0_txlRtugr0Qzxqp0SvI/edit?tab=t.0) informed this pass. The document teaches Aimlabs tasks. Its principles are translated into verified KovaaK's variants; the authors did not select or endorse this Apogee pool.

Keep the existing four bands and six tests per non-static category. Give each test a distinct job, make the training cue useful during play, and preserve fixed score targets. Static Clicking's nine families and 36 scenarios are unchanged. Seven non-static families are replaced, introducing 26 scenarios while retaining the season's 39 families / 156 scenarios.

## Revised circuits

| Category | Ordered circuit |
| --- | --- |
| Dynamic Clicking | Pasu → PipeClick → Bounce → Angelic → **Pasu Sequence** → Popcorn |
| Precise Tracking | Smoothbot → **Centering** → PreciseTrack → Whisphere → **Vertical Control** → Controlsphere |
| Reactive Tracking | Ground Plaza → Air Reading → Air Angelic → Strafe Gallery → Leapstrafes → **Recovery** |
| Speed Switching | DotTS → **Vox Pace** → EddieTS → PivoTS → Pokeball → psalmTS |
| Evasive Switching | Pasu Switch → **Regen Control** → **Arc Transfer** → Hop Transfer → tamTargetSwitch Smooth → FlyTS |

The exact four rungs and reasons are in `data/pool_curation.json`. Pool membership, training cues and practice playlists use this same order. Existing scenario names retain their own score history; replacement scenarios do not inherit scores or thresholds from retired tests.

## How the theory changes the benchmark

| Document principle | Apogee application |
| --- | --- |
| Initial acquisition, correction, confirmation and route planning | Static Clicking stays as it was. DotTS, PivoTS and Pokeball retain the acquisition/finish contrast in switching. Cues allow corrections instead of demanding a perfect first flick. |
| Dynamic target reading across axes, arcs and distances | Pasu, PipeClick, Angelic, Bounce and Popcorn retain contrasting paths. The category guide replaces apex-only/stop-only advice with reading into the shot. |
| Repeated clicks while matching movement | Pasu Sequence adds three-hit moving targets. It replaces HopClick, leaving two arc families rather than three. This is not VT Multiclick, whose catalogue description specifies single-hit static targets. |
| Separate stability from overwhelming reactive difficulty | Centering isolates horizontal velocity matching. Vertical Control gives pure vertical smoothness its own test. Smoothbot, Whisphere, PreciseTrack and Controlsphere retain broad arcs, curves and fine corrections. |
| Observe actual changes instead of predicting the next turn | Ground, aerial and leap tests remain; Recovery adds random slowing/stopping followed by teleport reacquisition. Novice and Intermediate change mechanics deliberately and need a handover playtest. |
| Choose a difficulty that permits clean learning | Precise and Reactive guides explicitly recommend an easier cut when movement becomes unreadable or the player starts guessing. No blanket instruction to underaim, tense harder, or use one joint for every motion. |
| Carry speed into smaller targets | Vox Pace moves from large/standard range targets to Viscose Varied's shrinking targets, then a smaller fixed rAim test. Only its Advanced rung shrinks during the run. |
| Short bursts for speed development | The Speed guide suggests optional short practice bursts on an easier cut. Benchmark runs retain their native duration and scoring; no short run is represented as a complete scored attempt. |
| Complete kills under regeneration pressure | Regen Control adds wiggling regenerative targets and a change in time to kill. Arc Transfer finishes with regenerative bounce variants. Smooth tam and Expert Pasu Switch retain other regenerative patterns. |
| Keep reading the field while tracking an evasive target | Evasive guidance distinguishes selecting the next target from leaving the current one early. FlyTS, Hop Transfer, Pasu Switch and the two arc/regen patterns retain different movement demands. |

The aim is broader skill coverage within a manageable circuit, not one scored slot for every task in a long training routine. Pure reactive Z-axis work, dedicated dash switching and automatic-player-motion drills are not separately isolated by this pool. The selected geometry provides some related demands, but those gaps are not fully covered. The document's game examples motivate variety; this benchmark does not measure transfer into a particular FPS.

## Practice beside the benchmark

These are suggested training protocols, not new grading rules or a compulsory full routine:

1. **Read first:** one comfortable-band run, then the current-band run. If you are guessing turns, practise the easier task again before raising difficulty.
2. **Pace into precision:** use an easier Speed Switching cut for a short freeplay burst, then try to retain the clean transfers in a complete challenge run. Viscose Varied supplies the shrinking-target demand without an artificial duration multiplier.
3. **Finish the target:** pick Regen Control, Arc Transfer or the retained Smooth family. Notice whether the miss came from the initial landing, lost contact, or leaving before the kill. Repeat for that specific reason, not just another score roll.
4. **Confirm every click:** use Pasu Sequence to keep reading between hits, then revisit a one-shot dynamic test. Do not treat a memorised apex as the only useful shot window.

The default category playlists remain six scenarios. The app does not automatically install extra scenarios or turn freeplay bursts into ranked results.

## Evidence and calibration

New names and leaderboard IDs were checked against KovaaK's public scenario catalogue. Each new target set is cut once from its own sampled leaderboard using the existing Apogee rank percentiles. Dated distributions and apex anchors are committed; the score targets do not move on launch. Existing retained variants keep their previous targets and provenance.

`data/benchmark_theory.json` records the replacement identities, source and Static Clicking fingerprint. `data/scenario_rationale.json` links family decisions to the training reference and exact catalogue entries. Metadata gaps stay null rather than getting invented aim types or body-part labels. Category queue availability is checked through the actual selection predicate and generated identities.

Some specialised Expert boards fall below the existing population floor. Each exception names the board size and the limitation in `pool.json`; these remain provisional draft calibration choices. A percentile of different player populations is not proof of equal skill across bands. No target is set above its sampled leaderboard record. The retained EddieTS and FlyTS Elite adjustments remain reproducible from their original frozen evidence; the removed bounceTS adjustment is retired.

Direct VT/Voltaic-named picks are reduced from the previous mix. Community edits can still descend from Voltaic work, so a name count is not a claim of independent authorship. The intent is useful variants and varied mechanics, not hiding provenance.

## Verification and playtest boundary

`validate:theory` checks the frozen static fingerprint, all 26 new identities through pool/season/generated reference data, category queue eligibility, source dates, the selected mechanics against catalogue descriptions, and the reviewed ceiling on direct Voltaic names. Existing curation, pool, threshold, season, practice and UI checks remain in place.

Still needs human playtesting: the three-click and vertical Expert steps, stop-to-teleport handover, changing TTK in Regen Control, cross-author Arc Transfer progression, and whether the circuits are enjoyable over repeated sessions. Catalogue descriptions, score samples and a rendered preview cannot establish that. No live match or in-game run was part of this pass.

Deployment remains separate: the rebuilt local client and generated reference files must not be confused with the server's published season. No backend publication or installer release is performed by this revision.
