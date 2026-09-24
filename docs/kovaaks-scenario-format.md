# The KovaaK's scenario file, as the files show it

What building season 2 established about `.sce` files, for anyone authoring or reading one
here. KovaaK's documents the editor, not the file
([wiki](https://wiki.kovaaks.com/en/home/KovaaK's/ScenarioCreation/Intro)), so every point
below says how it was established: counted across the 1,161 scenario files in the local
scenario and workshop folders, read off a template, or inferred and not yet seen in game.
The reader is `src/core/scenario/sce.ts` and `features.ts`; `npm run validate:sce` holds
it to the counts quoted.

## Structure

- **Head, then profiles, then the map.** `key=value` lines for the scenario, then one
  `[Section]` per profile, then `[Map Data]` to the end of the file. The reader round-trips
  every one of the 1,161 files byte for byte, so nothing else is in there.
- **Profiles refer to each other by `Name`.** The head names the player character
  (`PlayerProfile`) and the bots (`AddedBots`, entries `name.bot`, or `name.rot` for a
  Bot Rotation Profile). A bot names its character (`CharacterProfile`), dodge profiles and
  aim profiles; a character names its weapons (`WeaponProfileNames`) and abilities
  (`AbilityProfileNames`). Lists are `;`-separated with empty trailing slots (`BB Gun;;;;;;;`).
- **Names resolve case-insensitively.** Voltaic's Popcorn names its player character
  `player` and its head says `PlayerProfile=Player`, and it plays. Read off the template.
- **Ability names carry the extension the editor unpacks them to.** A character says
  `Ground 1 Blink.abilmov`; the profile's own `Name=` is `Ground 1 Blink`. Read off Voltaic's
  Ground.
- **Per-bot head keys are positional.** `AddedBots`, `BotMaxLives` and `BotTeams` pair up
  by position, so all three change together.
- **Line endings are CRLF**, and the repo keeps them (`*.sce -text` in `.gitattributes`).

## The map

- **3.x files embed the Map Creator's JSON map** verbatim in `[Map Data]`; older files embed
  a Reflex-format map. That embedded copy is how a shared scenario takes its map with it.
  Of the 1,161 files, 635 embed a JSON map and 518 a Reflex one (`validate:sce` prints both).
- **JSON coordinates are Z up; Reflex's are Y up.** A brush's `location` is its minimum
  corner and its `scale` its size over 100: the six walls of Voltaic's Static Cube meet
  exactly under that reading.
- **Map units become world units through `MapScale`.** A target's radius is not scaled; the
  distance to it is. The same radius is a large target at MapScale 1 and a small one at 10.
- **Spawns carry a team mask.** In JSON, `TeamMask` 1 is team A, 2 team B, 3 both. In
  Reflex a spawn names the team that may *not* use it (`Bool8 teamA 0`). `PlayerTeam=2`
  puts the player on B, anything else on A; on the 774 maps whose two groups differ in
  size, that picks the smaller group 93.4% of the time.
- **A spawn can admit only named characters.** `PermittedCharacterProfiles` is a
  comma-separated list; a bot whose character is not on it cannot spawn there. Voltaic's
  maps use it (`Head`, `Drifter`, `Player`), so renaming a character means renaming it in
  the map. Found by season 2 leaving sixty scenarios' targets with nowhere to spawn;
  `validate:season2` now checks every spawn.
- **Spawn volumes** (`SpawnVolume`) are boxes; whether `location` is their centre or corner
  is not settled by any template, so season 2 uses spawn points only.

## Targets

- **Size is `MainBBRadius`** (and `MainBBHeight` for a cylinder), times the head's
  `TargetSizeBaseMultiplier`, which newer files use for their size cuts: "1w2ts perfected
  30% smaller" is its parent with the multiplier at 0.7.
- **Speed is `MaxSpeed`**, times `Timescale` and `TimeDilationBaseMultiplier`, which slow
  every target alike. `IsTargetSizeActive` / `IsTimeDilationActive` make both adapt to the
  player during a run; no fixed geometry describes those, and the model leaves them out.
- **Acceleration decides how a target turns.** `MaxSpeed / Acceleration` is the seconds to
  full speed: a third of a second reverses in a curve, a hundredth in a corner. It is one of
  the three features the tracking model keeps (`data/season-2/difficulty_model.json`).
- **Jump height has two forms**: `JumpVelocity`, or `JumpVelocityMin`/`JumpVelocityMax` in
  newer characters. Voltaic gives all targets one jump velocity and varies height with
  `Gravity`, so hang time and height change together.
- **Distance to a moving target is its dodge profile's**, not its spawn's.
  `MinTargetDistance`/`MaxTargetDistance` is the range it holds from the player; 100,000
  means no limit. Voltaic's Ground bots spawn far away and close to 900-1,100.
- **Strafes**: `MinLRTimeChange`/`MaxLRTimeChange` is the time between reversals,
  `StrafeSwapMinPause`/`MaxPause` a stop before reversing, `ToggleUpDown*` the same for
  fliers (`IsFlyer`, with `FlightVelocityUp`/`Down`).
- **`DamageReactionChangesDirection`** makes a bot reverse after being hit, within
  `DamageReactionMinimumDelay`-`MaximumDelay`, ignoring a `DamageReactionChanceToIgnore`
  share of hits.
- **Health regenerates at `HealthRegenPerSec`** after `HealthRegenDelay`; a negative rate
  makes targets expire, which is how pressure scenarios despawn them.
- **`Untargetable=true` does not mean the player cannot shoot it.** Voltaic's real targets
  carry it. Revosect's Pasu uses small helper bots ("Knocker") to push targets off the
  walls, and nothing in the file marks them as helpers; the reader takes the most numerous
  bot, and among equals the larger, as the target.

## Weapons and scoring

- **Fire mode is `Category=SemiAuto|FullyAuto`.** Voltaic's tracking gun fires while held
  and still says `FullyAutomatic=false`.
- **A tracking gun is a fast hitscan** (`TimeBetweenShots` 0.01) with a tiny
  `DamagePerShot`; scored per hit (`ScorePerHit`), a 60-second run's maximum is 6,000.
- **Score is `ScorePerKill` x kills + `ScorePerHit` x hits + `ScorePerDamage` x damage**,
  times accuracy with `ScoreMultAccuracy`, or times its square root with `MultSqrtAcc` as
  well. The clicking model carries a flag for each; without the plain multiplier's, its
  error at the top 5% of the board rises from 0.102 to 0.112 (`ablation` in the model file).
- **`ScoreToWin` does not end a challenge.** Voltaic's 1w4ts carries `ScoreToWin=1000` and
  its median score is 1,063.
- **A reload economy** (`MagazineMax` with `AmmoPerShot` above 1) is Voltaic's other way to
  make misses cost; `EndChallengeAfterKills` ends a run early.

## Not settled

Played in game, none of the following has been checked, and each is in the playtest list in
docs/season-2.md: that an embedded map under a new `MapName` loads for a scenario placed in
the local folder; that a target with gravity and hops both off holds its height; that a
never-dying tracking target at 5,000 health never dies.
