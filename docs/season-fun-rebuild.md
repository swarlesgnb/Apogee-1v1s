# Season 1 fun rebuild

Eighteen of the season's 64 families are replaced and two Novice rungs are swapped, chosen for the scenarios players come back to. Every circuit keeps its size (13, 10, 10, 10, 10, 11) and its order. The other 46 families are unchanged apart from those two rungs, and so are the thresholds of the 182 scenarios they keep, most of them hand-authored.

## How a family was judged

`npm run audit:fun` (`tools/funAudit.ts`) measures every family in the pool and every candidate, and writes `data/fun_audit.json`:

- **replay**: KovaaK's plays per player, weighted towards Novice and Intermediate. A scenario people try once and drop sits near 2; 1wall 6targets small sits at 57.
- **reach**: players on the Novice and Intermediate rungs. A rung nobody has played gives nobody a baseline.
- **consensus**: how many of the 128 benchmarks evxl lists use any of the family's rungs.
- **noise**: median change between consecutive local runs over the median score. It matters because a match is decided on the delta from a baseline, so on a noisy scenario luck decides it. It comes from one player's stats folder, so it is reported and never scored; an unmeasured scenario must not beat a measured one.

The composite is the mean percentile of replay, log reach and consensus across all 82 families measured. Plays per player alone also rewards what is easy to spam (Piano Tiles I 50% SLOW is 64), so it never decides a pick by itself.

Community discussion (r/FPSAimTrainer, read through an archive because reddit.com and X refuse automated reads) settled the rules layered on top: randomness is what players call unfair ("lucky players got scores they don't deserve", about Pasu), fast feedback and a satisfying hit are what they call fun, and the Novice rung decides whether a new player stays.

## What changed

| Category | Replaced → added | Replay | Reach | Composite |
| --- | --- | --- | --- | --- |
| Static Clicking | Diagonal → **Six Targets** | 4.9 → 29.4 | 4,311 → 1,205,883 | 0.04 → 0.87 |
| Static Clicking | Horizontal → **Hipfire** | 5.1 → 17.4 | 5,360 → 545,793 | 0.06 → 0.86 |
| Static Clicking | Evo Gallery → **Tile Frenzy** | 3.9 → 28.7 | 52,425 → 802,410 | 0.15 → 0.78 |
| Static Clicking | Wide Pressure → **Four Targets** | 4.6 → 20.1 | 6,809 → 435,200 | 0.14 → 0.88 |
| Static Clicking | Micro → **Raw Mouse** | 7.6 → 23.1 | 1,606 → 167,640 | 0.43 → 0.74 |
| Dynamic Clicking | Pasu → **Pasu Wall** | 14.9 → 14.8 | 16,359 → 573,127 | 0.51 → 0.64 |
| Dynamic Clicking | Pasu Sequence → **Tamspeed** | 14.1 → 17.8 | 26,701 → 84,639 | 0.30 → 0.45 |
| Dynamic Clicking | Floating Gallery → **Timing** | 5.8 → 13.8 | 60,629 → 500,545 | 0.29 → 0.84 |
| Dynamic Clicking | Wave Click → **Bounceshot** | 6.3 → 14.3 | 45,627 → 379,506 | 0.20 → 0.67 |
| Precise Tracking | PreciseTrack → **Clover Control** | 6.4 → 18.1 | 20,793 → 240,809 | 0.22 → 0.90 |
| Precise Tracking | Vertical Control → **SYW** | 5.8 → 23.8 | 29,235 → 191,258 | 0.13 → 0.56 |
| Precise Tracking | Flower Chase → **PGTI** | 5.5 → 18.0 | 68,264 → 293,520 | 0.29 → 0.86 |
| Reactive Tracking | Strafe Gallery → **Long Strafes** | 6.6 → 26.3 | 34,067 → 304,205 | 0.35 → 0.73 |
| Reactive Tracking | Air Angelic → **Air Angelic** (Air Angelic 4 lineage) | 7.6 → 16.8 | 5,069 → 423,615 | 0.38 → 0.88 |
| Speed Switching | Wave Relay → **beanTS** | 2.9 → 11.0 | 11,041 → 327,085 | 0.07 → 0.81 |
| Speed Switching | PivoTS → **patCircleSwitch** | 7.1 → 11.1 | 39,185 → 77,002 | 0.26 → 0.60 |
| Evasive Switching | Floating Heads → **patTargetSwitch** | 5.0 → 14.3 | 28,469 → 240,474 | 0.09 → 0.56 |
| Evasive Switching | Hop Transfer → **Skeet** | 5.2 → 19.8 | 20,374 → 387,903 | 0.19 → 0.65 |

Rung swaps: Wide wall's Novice `ww6t Avasive Easier` (225 entries) becomes `Wide Wall 6Targets`; DotTS's Novice `wobin DotTS Easy` (441) becomes `VT DotTS Novice S5`.

Dynamic Clicking goes from four Pasu-style families to three. Pasu Wall keeps Pasu on the lineage players actually play; its replay is level with the family it replaces, and it reaches about thirty-five times the players. No Voltaic rung is added to Evasive Switching.

## What was tried and not kept

- **Thin Gauntlet** for Spectral Chase: its challenge mode runs two to three minutes.
- **1wall5targets_pasu Reload** in Pasu Wall: 86 seconds across 50 local runs.
- **FloatTS Angelic** for Pasu Switch: no Expert rung clears the board floor (the best, Ava FloatTS Angelic, has 636 entries). Pasu Switch stays rather than ship a rung the pool's own rule refuses.
- **PGTI Voltaic Gold** as a harder PGTI: its bot is enlarged from Easy, so it is easier.
- **VT Multiclick** for Cat Click: single-hit static clicking, as the theory audit notes, not a dynamic task.
- Expert rungs under the floor were swapped rather than excused: Timing ends on `Floating Heads Timing Extra Small Speed` (2,115) instead of the FIXED Extra Small edit, and Clover Control on Viscose's `cloverRawControl Viscose Hard 50cm` (2,460) instead of the author's Hard.

## Targets

New rungs are cut the way the evasive rework cut its rungs: the season curve for the ranks a window grades, the two crossover ranks below Expert at 0.5 and 0.4 of their fractions, and a tail capped backward from the floored world record. No new rung sits on a thin board. All 74 target arrays reproduce from `data/season_fun_rebuild_calibration.json`.

Boards past half a million entries put rank 500, the last record anchor, above the top 0.1%, leaving a gap before the percentile distribution takes over. `apexRanksFor` in `src/core/season/apex.ts` adds one anchor at the 0.1% rank on those boards; three of the new ones need it.

## First Light v4

First Light v2 names every replaced family in its route pools and six of them in its finales, so `data/expeditions/first-light-v4.json` (`tools/buildExpeditionV4.ts`) rebuilds the roster from the shipping season with v3's progression. Destinations, names and every reward are unchanged. On upgrade, rewards, cosmetics, run history and trials carry over, a route keeps its progress when every scenario it accepted is still offered, and one that named a retired scenario starts fresh. Older saves are never rewritten.

## Checks

`npm run validate:rebuild` (also in `validate:curation`) holds the rebuild to its claims: every added family measures above the family whose slot it took, the other 46 families and their thresholds are unchanged outside the two swapped rungs, every new rung has an exact identity, reaches its category queue, has no measured or announced run over 60 seconds (lengths come from local runs, so most new rungs are unmeasured until someone plays them) and reproduces its targets, and every rank of every band is earned at its own targets. The expansion, theory and evasive-rework audits still check the pool they were written for, reconstructed by `tools/funRebuildHistory.ts`.

## Not covered

Enjoyment and cross-scenario difficulty are measured by proxy, not playtested. The noise figures cover one player's runs. X was not read. `validate:engine` fails independently of this change: for one player's Voltaic S5 Intermediate overall rank, KovaaK's reports rank 2 at the energy the engine grades rank 1.
