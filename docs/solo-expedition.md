# First Light

Expedition is a permanent local solo campaign alongside KovaaK's. Conquer six destinations, each focused on an aiming discipline, then complete the six-scenario First Light passage. Each destination earns a ship and a profile appearance set. All six clears must be in the same difficulty to open that difficulty's final passage.

Choose any difficulty immediately. Lower difficulties are never prerequisites. Nothing expires, and completed destinations never reset.

## Four different journeys

| Difficulty | Progression | When you miss |
| --- | --- | --- |
| Novice | Enter directly. Meet three targets in order, securing a checkpoint for each. | Retry the current target. Secured checkpoints survive stopping, switching destinations, and restarting the app. |
| Intermediate | Choose one Score attack, Steady set, or Mixed circuit. Completing it opens the ordered three-round finale. | The attempt ends. Your completed route stays cleared, so you can retry the finale immediately. |
| Advanced | Enter unassisted, or complete one optional preparation route to unlock retry support at that destination. | Supported attempts allow one miss, then another try at the current round. A second miss ends the attempt. Unassisted attempts end on the first miss. |
| Expert | Enter trials directly. No introductory activities are required. | A miss or an out-of-order trial scenario ends the attempt. Retry whenever you are ready. |

Advanced preparation is a permanent unlock: each supported attempt receives a fresh retry. Choose an unassisted attempt to earn the destination's Unassisted trophy. For support in the final passage, complete a preparation route at all six destinations; the final passage can be attempted unassisted as soon as all six are cleared.

Novice's first clear banks checkpoints, including in the final passage. Once a destination is cleared, its optional mastery replay uses a strict, fresh attempt. The original clear and its rewards remain permanent.

Unrelated scenarios never affect a trial. Novice ignores out-of-order trial scenarios; only the next expected target can secure a checkpoint. Intermediate, Advanced, and Expert treat an out-of-order trial scenario as a miss. The active attempt explains its exact rules.

## Know what you are working toward

The star chart opens on the **deck**: one next move, in one sentence ("Score 1,285 on Apogee Zenith Novice"), the reason it matters (what the round is part of and the reward it leads to), every round of the current activity as a path from done to upcoming, and one line under **If you miss** stating the rule that applies right now. Before joining, the deck is the difficulty chooser: four cards that each say what a miss costs, with the player's own record against that difficulty's eighteen targets and a suggested starting point.

Beside every target the deck and the destination briefing show the player's best, its percentage of the target, and the median of the latest ten runs, read from every valid local run including those before joining. A label (Beaten before, Within reach at 90%, A stretch at 75%, Far off for now) is context only: nothing is gated or settled on it. The suggested difficulty is the highest one where at least three targets were played and half of them are already met; one met at 80% or better over nine or more played targets points one difficulty higher. It is a suggestion; every difficulty stays open.

**Start** begins the attempt and opens its first scenario in KovaaK's in one step. While a launched run is outstanding the deck says it is listening. When the run lands, a **Signal received** card gives the score against the target, the verdict (checkpoint secured, round cleared, retry used, attempt over, warm-up progress, or practice logged against the selected destination) and what comes next. It is read from the change between two states the main process already settled; it decides nothing.

The selected destination's briefing says what the discipline trains, lists the trial with the player's numbers, and holds the optional warm-ups, Survey, replays and the full rules. After a clear the deck offers the next uncleared destination, then the next difficulty.

The Survey (stored as Discovery) is optional in every difficulty: complete one run on each of three families for a Survey fragment. The warm-ups (stored as routes) are:

- **Score attack:** meet one score target.
- **Steady set:** meet one target three times consecutively on the same scenario. A miss on that scenario resets the streak.
- **Mixed circuit:** meet one target on each of three different families. Each successful scenario remains complete.

Intermediate requires any one warm-up, and the deck offers the three as the next move. Advanced uses any one to unlock retry support. In Novice and Expert they are optional collection activities. Setting a warm-up aside returns to the trial; accepted targets and progress remain saved, and matching new training runs still count. Resume from the Warm-ups section of the briefing.

Personal Score attack and Steady set targets use 103% and 95% of the latest ten scores' median when at least five prior runs exist. Otherwise they use published targets. Targets freeze on acceptance. Switching away never rerolls a target. Finale standards are published and do not depend on your personal history.

## Rewards and session progress

There are 122 rewards: the existing 115 items plus seven Advanced Unassisted trophies. First clears in any difficulty unlock shared ships, frames, banners, and titles. Each difficulty has its own clear insignias and mastery trophies. Higher difficulties never require re-earning the same ship.

Ships appear on your chart and in the hangar. Frames, banners, titles and insignias can be equipped to your local expedition identity. The chart displays your worn insignia alongside your ship. Relics and trophies remain collection records.

Mastery requires at least 110% of every target in one attempt with no misses or carried checkpoints. Supported Advanced attempts may earn mastery if no retry is used; the Unassisted trophy specifically requires the unassisted approach. Best-clear records compare the weakest round's percentage of its target.

The session recap records earned rewards, completed routes, attempts, new checkpoints, and improved best scores in the expedition log. Score comparisons use only runs recorded since enrollment, not a claimed lifetime personal best. Cosmetics and expedition clears do not change ranked scoring, quest XP, ratings, or matchmaking.

## Playing and saving

Start an activity before playing. Starting a trial, or **Play in KovaaK's** during one, opens the next required scenario and writes `Apogee Expedition First Light.json` to KovaaK's playlists folder. Restart KovaaK's if its menu has not discovered the playlist.

Checkpoint and supported attempts export only the current target, so a miss cannot automatically skip to the next round through that playlist. The result appears in Apogee on its own after the run, with the next target or the retry. Strict attempts export the remaining ordered rounds. Route playlists contain their remaining repetitions; return after a failed Steady set run for the updated requirement.

Progress is saved to `expedition-first-light-v3.json` in Electron's user-data directory, with atomic replacement and `.bak` recovery. V1 and v2 saves remain separate and untouched. Migration preserves rewards, equipment, accepted targets, route progress, and trial history. An already-active legacy attempt retains its original strict rules; new attempts use the new journey rules. Unreadable saves are preserved rather than silently replaced.

V3 uses the unchanged frozen v2 scenario roster and score targets. It changes progression and presentation, not the benchmark definitions. Only valid new post-enrollment runs count toward progress. Older history may inform personal targets. This is local progress, not server-verified competition.

## Design basis

Visible maps and subgoals come from [David Blandy's solo-game design discussion](https://davidblandy.substack.com/p/so-you-want-to-make-a-solo-game); structure with player choice from [The Story Engine's solo RPG guide](https://storyenginedeck.com/blogs/news/a-guide-to-solo-rpg-games); short, interactive explanations from [Roleplaying Tips](https://www.roleplayingtips.com/running-games/running-single-player-campaigns-part-i/). They are tabletop and solo-game advice, so whether the loop is fun and balanced as aim training is a playtesting question.

## Verification

- `npm.cmd run validate:expedition` covers the scenario intel and difficulty suggestion, the legacy evaluator, all four new journeys, all rewards, checkpoint persistence, retry limits, mastery, migration, playlists, and equipment.
- `npm.cmd run validate:expedition-ui` exercises isolated Electron flows with synthetic progress: the difficulty chooser and enrollment, one-click start and launch, the listening state and every verdict card, checkpoint recovery, Intermediate choices, supported/unassisted Advanced clears, Expert misses, reward previews, equipment, keyboard navigation, responsive layouts, and reduced motion. Screenshots go to `.cache/expedition-ui`.
- `npm.cmd run typecheck` and `npm.cmd run smoke` check integration.

None of this covers whether the training is enjoyable, whether the difficulty is balanced, or the hand-off into KovaaK's itself. Those need the four journeys played.
