# Season 1 variety expansion

The season adds four families to each of its six categories, with one exact scenario per family in each of the four bands. That adds 96 scenarios: 252 total, 63 per band. Static Clicking grows from nine to thirteen families; every other category grows from six to ten. The original circuits remain first in playlist order, followed by the additions.

| Category | Added families |
| --- | --- |
| Static Clicking | Multiclick Gallery, Vox Gallery, Reload Rush, Micro Chain |
| Dynamic Clicking | Floating Gallery, Sky Gallery, Wave Click, Bounce Gallery |
| Precise Tracking | DVD Chase, Flower Chase, Sphere Cruise, Snake Sweep |
| Reactive Tracking | Spectral Chase, Celestial Chase, Air Gauntlet, Close Strafe Chase |
| Speed Switching | Vox Blitz, Wave Relay, Sky Relay, Dev Blitz |
| Evasive Switching | Drift Relay, Penta Bounce, Chamber Relay, Smooth Relay |

The additions emphasize room clearing, continuous kill chains, flowing paths, layered galleries and distinctive arenas. These are design selections for variety; catalogue descriptions and leaderboard activity do not establish that every player will find them fun. Mixed-author or mixed-release handovers are explicitly noted in the curation and need in-game playtesting.

## Two-rank overlap and harder crossover targets

Every lower band grades six ranks, advancing four new ranks and reaching two ranks into the next band. Expert grades four score ranks plus its existing positional title. The rank names already had this overlap; the expansion keeps it and verifies it through the scoring engine. For example, Static Clicking's Novice band can award Crossbow and Musket, the first two Intermediate rank names.

The first four targets on every existing scenario remain unchanged. Each lower band's final two targets now use stricter shares of that scenario's own leaderboard: half the previous ladder fraction for the first crossover rank and two-fifths for the second. The actual target is at least one point above its prior target, capped to leave two ascending scores at or below the demonstrated record. The first Novice crossover therefore aims at the top 13% rather than 26%, and the second at the top 7.2% rather than 18%. A prior authored target can be higher than the percentile cut, in which case that prior target plus one remains the minimum.

Four existing Static Clicking tails had targets above their sampled records. Those tails are corrected at the record cap and explicitly marked as repairs rather than described as increases. Original Expert targets are preserved. Category energy thresholds scale with the expanded family counts, so adding scenarios does not make the ranks cheaper.

The new SmoothTS Revosect Expert ladder also needs a recorded ceiling adjustment: its small board has tied top percentiles, and rounding would otherwise put the last target above the record. Its targets are capped backward from the floored record with at least one point between ranks. That makes the scores attainable, but does not establish that its closely spaced top ranks feel distinct in play.

Ranks remain earned within each band: an exceptional Novice run can award a shared rank name, but does not fabricate scores or completions on Intermediate scenarios. Different scenario boards contain different player populations; these targets are a frozen draft calibration, not proof of equal difficulty across bands.

## Evidence and reproduction

- `data/season_expansion.json` records the exact 96 names, family rationale and crossover rule.
- `data/season_expansion_calibration.json` records original family fingerprints, before/after targets, source dates and record caps.
- `data/scenario_taxonomy.json` records live exact-name and leaderboard-ID checks against the [KovaaK's catalogue](https://kovaaks.com/kovaaks/scenarios).
- `data/leaderboard_percentiles.json` and `data/leaderboard_apex.json` retain existing evidence and add missing samples from [KovaaK's global leaderboard endpoint](https://kovaaks.com/webapp-backend/leaderboard/scores/global). Every sample has its own date; they are not all new measurements.
- `data/pool_curation.json` and `data/scenario_rationale.json` include all six expanded circuits and their focus cues.

`npx tsx tools/expandSeason.ts --sample` checks and resumes missing evidence. The initial `--apply` is intentionally one-shot: it refuses to overwrite the saved baseline. Normal subsequent builds use `npm run build:season`. `npm run validate:expansion` reproduces all crossover adjustments, checks preservation of the core, verifies both queue categories for the new scenarios, and exercises all eighteen two-rank handovers through the energy calculation.

The local season and generated client/reference files are the deliverables. This change does not publish a backend season or create an installer. Human playtesting is still needed for enjoyment, band transitions, and sparse Expert leaderboards.
