# Into the Rift

Rift is a local solo roguelite played through KovaaK's scenarios. Each run you play becomes an attack worth **Thrust × Flux**: your score supplies Thrust, the discipline's planet level supplies Flux, and the anomalies you collect add Thrust, add Flux or multiply Flux, one after another, left to right. Encounter hulls grow about 2.5× per system, so a build has to multiply rather than add to reach the final star.

The first flight (`rift-v1.json`) resolved every run as a flat sum of "+N damage" abilities. Its first playtest found nothing worth deciding: the abilities never changed what to play or in what order. This version replaces it outright. A first-flight save is left untouched on disk and is not read.

## Play

Rebuild and launch Apogee with `npm start`, open **Rift**, choose a difficulty and a vessel:

- **The Drifter:** +1 Jump every encounter. Starts with Pulsar and 8 ✦.
- **The Prospector:** starts with Asteroid Miner and 14 ✦. Buys early, grows on interest.
- **The Cartographer:** starts with Ion Drive and two star charts.
- **The Glass Wing:** one hull, six anomaly slots and a Volatile Reactor.

A voyage is four **systems**. Each has a Moon (hull ×1), a Planet (×1.5) and a Star (×2) whose hazard is announced in advance. Base hull per system is 300, 800, 2,000 and 5,000. Moons and planets can be **skipped** for a signal (a supply cache, a free anomaly, a rare in the next shop, two planet levels, or an extra salvo); a skip gives up that body's stardust and shop. Stars cannot be skipped.

Each encounter deals a **hand** of three scenarios, preferring different disciplines, and gives two **salvos** (runs) and two **Jumps** (redraw one card). Each card shows what it would deal at exactly the reference. Pick one and press **Play**; the first complete matching run that started after you armed it fires the salvo. The played card is replaced afterwards.

## Scoring

- Grade from score ÷ reference: below 80% **Drift**, from 80% **Graze**, from 100% **Strike**, from 115% **Nova**.
- Thrust starts at 100 × the ratio, capped at 2×. The planet adds 20 Thrust per level and sets Flux to level + 1. Star charts level a planet.
- Halley's Comet, if primed, doubles Flux. Then every lit anomaly resolves left to right. Order matters (`+4` then `×2.5` beats the reverse), and the rail can be reordered between salvos. Gravitational Lens retriggers its left neighbour; Binary Star copies its right neighbour, including any growth.
- Damage is `floor(Thrust × Flux)` and accumulates across salvos until the hull breaks.

The result screen replays the breakdown one trigger at a time and lights each anomaly as it fires. The final numbers are in the page from the start, so skipping the animation or reduced motion loses nothing. The original KovaaK's score is shown separately and is never written to training history, quests or ranked ratings.

## Anomalies, comets and hazards

There are 35 anomalies in three rarities (shop odds 55/33/12). The build archetypes they were written for:

- **Discipline specialist:** Tidal Lock, Railgun, Tractor Beam, Phase Lance, Terraformer, Observatory, Cartographer.
- **Variety:** Solar Sail, Constellation.
- **Pure aim:** Overclock, Graviton Hammer, Supernova Core, Accretion Disk, Event Horizon.
- **Economy:** Asteroid Miner, Gas Giant, Dyson Sphere.
- **Sacrifice:** Black Hole, Scrap Halo, Nebula Seed, Comet Tail.
- **Few slots:** Dark Matter, Singularity.
- **Risk:** Volatile Reactor, Distress Beacon, Last Light, Orbital Station.

Two slots hold comets and star charts: Halley's Comet, Wormhole, Mirror Moon, Golden Comet, Nebula Seed, Aurora, and a chart for any discipline. Star hazards: Brown Dwarf (½ Flux), Eclipse (leftmost anomaly dark), Magnetar (locked to the first discipline played), Dead Star (no Jumps), Neutron Star (references +10%), White Dwarf (no Thrust above the reference), Blue Giant (1.5× hull, +5 ✦). The fourth star is always the **Collapsar**, which darkens the rightmost lit anomaly after each salvo.

## Economy and failure

Breaking a body pays 3/4/5 ✦, plus 1 ✦ per unspent salvo, plus interest of 1 ✦ per 5 held (capped at 5, or 10 with Gas Giant), then opens a shop: two anomalies, a star chart and a comet. Anomaly rerolls cost 3 ✦, rising by 1 per reroll in the same shop. Anomalies sell for half their price.

Failing a moon or planet costs 1 hull and its reward. Failing a star, or losing the last hull, ends the voyage. Extraction is available between encounters and at shops. After the fourth star, **Go deeper** continues into systems whose hull grows about 2.5× each; the voyage's record is refreshed when it finally ends.

## Saves and score receipts

The main process owns the engine and save. The renderer sends choices only, and no IPC action accepts a score; hand previews and the system route are computed in the main process and sent with the view. `rift-v2.json` lives in Electron's user-data folder with atomic replacement, a previous valid backup and preservation of unreadable data. Unrecoverable save errors block play instead of silently resetting it. Both save versions are included in the local-progress backup.

The shared CSV reader supplies locally coherent runs. Expected scenario durations reject partial runs; unknown durations are ineligible. A receipt is identified by scenario, end time and challenge start, and must start after the salvo was armed. Old, unrelated, duplicate, nonfinite and future receipts cannot settle a salvo. A voyage resumes after closing the app, including recovery of the first valid run played while a salvo was armed. This is local solo evidence, not server-verified competition.

## Validation

- `npm run validate:rift`: 25 checks against all four real season pools: frozen references, seeded hands and hazards, refused out-of-phase actions, receipt rules, the scoring formula and its preview, ordering, Lens and Binary, grade-conditioned anomalies, discipline chaining, every hazard, hull growth, payouts and interest, shop rules, skips, failure, Black Hole and growth, every comet, a sweep proving every scoring anomaly fires under some condition, save recovery, malformed saves, midnight durations, the service, and the deep Rift.
- The same suite simulates 640 voyages with a greedy pilot that plays the best-previewed target and buys the rarest affordable anomaly but never plans order or synergy. It asserts that buying nothing never finishes even at 1.3× the reference, that the win rate rises strictly with aim, and that every vessel finishes at least once at 1.15×. It prints the measured rates; when this was written they were 27% / 43% / 62% / 73% at 0.85× / 1× / 1.15× / 1.3×.
- `npm run validate:rift-ui`: isolated Electron profile, production Rift handlers, service and CSV parser, authored-scenario fixtures and a simulated launcher. 13 checks cover onboarding, the map, hand previews and Jumps, launch failure and retry, recreation, bad receipts, the Thrust × Flux breakdown, shop reroll, buy, reorder and sell, a full voyage into the deep Rift, narrow layouts and reduced motion, ending and extraction, and read errors. The full-voyage check seeds high planet levels into the save rather than earning a build. Screenshots and `report.json` are in `.cache/rift-ui`.

Simulated pilots establish rules and relative balance. They do not establish fun, human difficulty, session length or an actual Steam/KovaaK's hand-off; those need playtesting. Questions for the next playtest: does the hand preview make the target choice feel like a decision, do players reorder anomalies once they own a Lens or a multiplier, are skips ever worth taking, and does a full voyage fit one session.
