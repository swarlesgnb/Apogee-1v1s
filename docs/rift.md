# Into the Rift — First Flight

Rift is a local solo roguelite played through KovaaK's scenarios. Aim performance supplies an attack; the abilities assembled during the voyage change how that attack resolves. The first playable version is a balance prototype for the planned 0.5.0 update, not a released version or a calibrated difficulty claim.

## Play

Rebuild and launch Apogee with `npm start`, then open **Rift** in the navigation. Choose a difficulty and one of three starting ships:

- **The Conductor:** Capacitor and Overdrive. Earn Charge and choose when to spend it.
- **The Vanguard:** Momentum and Bulwark. Maintain successful runs and accumulate shields.
- **The Daredevil:** Salvager and Glass Reactor. Trade incoming damage for stronger attacks and more spending power.

Each voyage has eight sectors. Ordinary sectors offer three routes across distinct aiming disciplines, including an elite with greater risk and salvage. Routes rejoin at the next sector. Sector four holds the Warden; sector eight holds Event Horizon. Each boss offers two discipline choices and announces its special rule before entering. Waystations appear before sectors four and seven.

Enter an encounter, optionally arm Overdrive, and press **Play in KovaaK's**. The first complete matching run that starts after the round is armed is final. Return to see the original score, base attack, individual ability effects, enemy retaliation, and next action. An unsuccessful launch preserves the armed round; retry opening the scenario or open the named scenario manually. **Refresh** reads the stats folder again.

There are twelve abilities and five equipment slots. A clear offers three unequipped abilities; choose one, replacing a slot when full, or take six salvage. One reroll per reward costs eight salvage. Shops sell three abilities and offer one repair of up to four hull for twelve salvage. Deep Cell grants two Charge on installation and raises capacity to five. Every starting ship can discover every ability.

## Rules

Scenario references come from the first published rank threshold in the chosen difficulty. The entire route and its references are frozen at departure. There is no personal-baseline adjustment during the voyage. All four bands currently have 41 eligible scenarios across six disciplines with known durations.

Base attack is `floor(100 × min(1.5, score / reference))`. Reaching the reference also activates eligible success effects. Attack modifiers resolve in this order: Overdrive, Momentum, Echo Chamber, Giantkiller, then Glass Reactor. Afterglow, Capacitor and Bulwark resolve before retaliation. Clear effects resolve afterward. The result shows the original KovaaK's score separately; no multiplied score is written to training history, quests or ranked ratings.

An enemy that survives retaliates. Shield absorbs damage before hull. The Warden adds two damage to its first retaliation; Event Horizon adds one per subsequent round. Ordinary encounters allow two runs and bosses allow three. Failing to clear within the limit forces a retreat, costs two additional hull through shields and gives no clear reward. Running out of hull ends the voyage. Failing Event Horizon's three-round limit also ends it. Killing an enemy prevents its retaliation.

Extraction is available between encounters and at shops. An active encounter can be abandoned with confirmation. Both actions keep a flight record; starting another voyage resets that voyage's equipment and resources. There are no permanent power upgrades or cosmetic unlocks in this first slice. The last twelve completed, lost or extracted voyages remain in the flight recorder.

## Saves and score receipts

The main process owns the engine and save. The renderer sends choices only. No IPC action accepts a score. `rift-v1.json` lives in Electron's user-data folder, with atomic replacement, a previous valid backup and preservation of unreadable data. Unrecoverable save errors block play instead of silently resetting it. Rift is included in the existing local-progress backup and restore flow.

The shared CSV reader supplies locally coherent runs. Expected scenario durations reject partial runs; unknown durations are ineligible. The receipt identity uses scenario, end time and challenge start. Its start must follow arming. Old, unrelated, duplicate, nonfinite and future receipts cannot settle a round. Local clock parsing handles midnight using the existing duration helper. A voyage can be resumed after closing the app, including recovery of the first valid run played while an armed round was pending. This is local solo evidence, not server-verified competition.

## Validation

- `npm run validate:rift`: 18 named checks covering all four real scenario pools, deterministic maps, three starting builds, combinations, invalid transitions, timing, duplicates, boss behavior, retreat, rewards, shop costs, save recovery, backup integration and twelve simulated complete voyages.
- `npm run validate:rift-ui`: isolated Electron profile, production Rift handlers and service, actual CSV parser, authored-scenario fixture files, and a simulated game launcher. Twelve checks exercise onboarding, connection, launch failure/retry, recreation of the service, bad receipts, result presentation, a complete voyage, replacements, shops, both bosses, ending/extraction, save-error display, narrow layouts and reduced motion. Screenshots and `report.json` are in `.cache/rift-ui`.
- `npm run typecheck`, `npm run build:app`, and `npm run smoke`: the built-desktop smoke probe also opens Rift through the shipped preload and checks its three starting ships, twelve abilities and four difficulty bands.

Synthetic runs establish rule and integration behavior. They do not establish fun, fair difficulty, session length, real-player false rejection rates, or an actual Steam/KovaaK's hand-off. Those require playtesting. Priorities for the first playtest are whether routes change with the build, whether spending Charge feels consequential, whether retreat helps recovery, and whether a loss suggests a different decision next time.

## Design references

The design discussion drew on [Entalto's roguelite tips](https://entaltostudios.com/5-essential-tips-to-make-your-roguelite-game-work/), [Daniel Doan's design advice](https://medium.com/@doandaniel/gamedev-protips-how-to-design-a-truly-compelling-roguelike-game-d4e7e00dee4), [the Roguebook developer interview](https://www.gamedeveloper.com/design/tackling-deckbuilding-design-in-abrakam-s-roguebook), [Tom's agency essay](https://thom.ee/blog/what-makes-or-breaks-agency-in-roguelikes/), and [Goomba Stomp's Balatro analysis](https://goombastomp.com/how-balatro-became-one-of-the-most-addictive-roguelikes/). The specific Rift mechanics and numbers are implementation hypotheses to test.
