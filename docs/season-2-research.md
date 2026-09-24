# What makes a KovaaK's scenario good

Research behind season 2. Three questions, because a ranked season asks all three of every
scenario in it: does it make players better, do they want to play it again, and does its
score say who played better today. The literature answers the first, the local corpus
answers parts of all three, and some of it only playing can answer.

Every number here that comes from this repository is re-derived by a script, named where it
is used. Numbers from outside are cited.

## What a scenario is

A `.sce` file is self-contained: the scenario's own settings (time limit, scoring, which bots
are added), then one section per profile it uses, then the map. Profiles refer to each other
by name: the scenario names a player character and a list of bots; a bot names a character,
dodge profiles and aim profiles; a character names its weapon
([KovaaK's wiki, Intro to Scenario Creation](https://wiki.kovaaks.com/en/home/KovaaK's/ScenarioCreation/Intro)).
Files saved by a 3.x build embed the Map Creator's JSON map verbatim; older ones embed a
Reflex-format map.

What a player experiences is not in any single key. A target's size is its radius over the
distance it is shot at, and that distance is the spawn geometry scaled by `MapScale`, or, for
a moving bot, the range its dodge profile holds. Its speed is `MaxSpeed` over the same
distance, scaled again by `Timescale` and `TimeDilationBaseMultiplier`.
`TargetSizeBaseMultiplier` shrinks everything: "1w2ts perfected 30% smaller" is its parent
with that key at 0.7. `src/core/scenario/features.ts` turns all of this into angles and
seconds. `npm run validate:sce` checks it against every file on this machine: it round-trips
1,161 files byte for byte and resolves the geometry of 1,153.

## Good for improvement

**Difficulty should sit at the edge of the player's ability.** The challenge point framework
([Guadagnoli & Lee, 2004](https://www.researchgate.net/publication/8574634_Challenge_Point_A_Framework_for_Conceptualizing_the_Effects_of_Various_Practice_Conditions_in_Motor_Learning))
separates *nominal* difficulty (the task) from *functional* difficulty (the task for this
player), and puts the most learning at an intermediate functional difficulty: hard enough to
produce information about errors, not so hard that nothing can be learned from them.
[Wilson et al. (2019)](https://www.nature.com/articles/s41467-019-12552-4) derive an optimum
near 85% success for a broad class of gradient learners. It is a model result, not a
measurement of aiming, but it points the same way. For a season this argues for bands, and
for a band a player can place into rather than one ladder everyone climbs from the bottom.

**Fitts' law describes a flick.** Movement time grows with the index of difficulty,
ID = log2(D/W + 1), for distance D and target width W
([Fitts's law](https://en.wikipedia.org/wiki/Fitts%27s_law)). In a first-person task
[Boudaoud, Spjut & Kim (NVIDIA, 2022)](https://arxiv.org/abs/2203.12050) spanned 0.83 to
5.50 bits and measured typical completion times of 0.4 to 0.8 s, with an optimal sensitivity
zone of 20 to 80 cm/360. Across KovaaK's static clicking scenarios the same law holds on
scores: the logarithm of seconds per kill rises with the Fitts ID of the flick to the nearest
live target, by 0.277 per bit at the board median, so each bit costs about 32% more time per
kill (`tools/fitDifficulty.ts`, clicking class). Size and distance are therefore not
two knobs but one, their ratio, and a band ladder can step it deliberately.

**Isolate what is being trained.** Voltaic's taxonomy splits clicking into static and
dynamic, tracking into precise and reactive, and switching into speed and evasive
([Voltaic](https://voltaic.gg/)). The
[Voltaic x Aimlabs weakness routines](https://docs.google.com/document/d/1oNUBAaLovS0oMLn0_z3BEPT0_txlRtugr0Qzxqp0SvI/edit?tab=t.0),
already the basis of season 1's theory pass, go further: separate stability from reactive
difficulty, observe changes rather than predict them, and carry speed into smaller targets.
A scenario that mixes two skills produces one score for two causes, and a player who is weak
in one of them cannot tell which.

**Cover the axes the popular pool neglects.** Of the 58 static clicking scenarios on this
machine with 10,000 or more players, 51 spread targets over a field wider than it is tall
(`tools/scenarioScience.ts`). Vertical stopping gets the least practice of any flick.

## What benchmark authors say

Voltaic's own account of its Season 5 benchmarks
([announcement](https://blog.voltaic.gg/announcing-the-voltaic-season-5-aiming-benchmarks-beta-for-kovaaks/))
states the same priorities from the author's side, and season 2 takes most of them:

- **Remove randomness that is not the skill.** "Unnecessary randomness … is suboptimal for
  benchmarking"; Pasu's targets are repelled from walls so boundaries do not decide a run.
  Season 2's arcs (every static target the same size) come from the same instinct.
- **One knob per behaviour.** Targets share a jump velocity and differ in gravity, so jump
  height and hang time vary together and predictably. Hopper's bands step gravity alone.
- **Kill time is a difficulty lever.** DotTS's longer time to kill separates it from
  Pokeball's. Finisher and Mender use it the same way.
- **Accuracy pressure without an accuracy multiplier.** Voltaic uses square-root accuracy
  scoring where "every shot matters", and a reload economy (a miss on ww5t Intermediate costs
  30% of the magazine) where speed matters. Season 2 uses neither: in a match decided on a
  delta, the multiplier's added noise (above) costs more than the precision pressure gains,
  and the reload economy is unmeasured: only three reload-economy scenarios have eight or more
  runs in the local history (median noise 5.9%, against 4.8% across all scenarios without an
  accuracy multiplier; `tools/scenarioScience.ts`), too few to say whether it shares the
  multiplier's cost.
- **Diamond spawn fields** "so that nearby spawns are more likely to be diagonally
  oriented" were tried and not kept: with several targets alive the square grid already
  spreads flicks close to uniformly, and the diamond traded away vertical flicks
  (`tools/season2/design.ts`, `arc`).

## Fun, or at least replayed

KovaaK's catalogue gives plays and players for every scenario. Plays per player (replay) is
the closest measurable thing to "people come back to it", and players (reach) to "people try
it". Over 614 catalogued scenarios with 300 or more players, against every design feature the
reader extracts (`tools/scenarioScience.ts`):

| Feature | Replay (Spearman) | Reach (Spearman) |
| --- | ---: | ---: |
| Bot under gravity | +0.10 | +0.13 |
| Accuracy multiplier | -0.11 | -0.16 |
| Targets alive at once | -0.11 | -0.00 |
| Target size | -0.07 | +0.16 |
| Time limit | -0.06 | +0.14 |

The strongest replay correlation with anything a file states is 0.114. Fun is mostly not in
the geometry: it is in feel, feedback and fashion, which the file does not record and a
correlation cannot find. What the data does say is modest and consistent: players come back
to arcs and bounces; they play less of scenarios that multiply the score by accuracy; bigger
targets draw more first tries. Season 1's fun rebuild reached the same view from the other
side, from community discussion: randomness is what players call unfair, and a fast,
satisfying hit is what they call fun (docs/season-fun-rebuild.md).

## Fair in a ranked match

A match is decided on the change from a baseline (PLAN.md §3), so a scenario's run-to-run
noise is its unfairness: on a noisy scenario, luck picks the winner. KovaaK's scenarios are
reliable measurements between sessions. A pilot of four scenarios with ten players found
test-retest ICCs of 0.947 to 0.995
([Frontiers in Sports and Active Living, 2024](https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2024.1309991/full)).
Within a player, though, the noise differs a lot by design. Over 296 scenarios with at least
eight runs in the local stats folder, median run-to-run change as a share of the median score
(`tools/scenarioScience.ts`):

| Feature | Noise (Spearman) |
| --- | ---: |
| Time limit | **-0.36** |
| Target size | -0.20 |
| Accuracy multiplier | +0.16 |
| Targets alive at once | +0.13 |
| Shots to kill | -0.13 |
| Regenerating target | -0.12 |

Longer runs are steadier, which is expected: more events per run average out more luck. The
accuracy multiplier adds noise, 5.8% median against 4.8% without. It compounds the miss rate
into the score a second time. This is one player's history, so the sizes describe one
player's consistency, but the directions are the design rules.

## Predicting a board before anyone plays

A season needs thresholds, and a new scenario has no board to cut them from.
`src/core/scenario/difficulty.ts` learns how a file becomes a board from every scenario that
has both. It first turns scores into comparable quantities (seconds per kill; share of the
maximum score as a logit), then fits one least-squares model per class and board fraction.
Leave-one-out median error at the board median (`data/season-2/difficulty_model.json`):

| Class | Scenarios | Features | LOO median | LOO 90th pct |
| --- | ---: | --- | ---: | ---: |
| Clicking | 201 | nearest-flick Fitts ID, log angular speed, log shots to kill, accuracy multiplier, square-root accuracy multiplier | 0.129 (about 14% in time per kill) | 0.412 |
| Tracking | 174 | log speed/size, log strafe period, log seconds to full speed | 0.399 logit (about 10 points of share mid-board) | 0.999 |
| Switching | 86 | log speed/size, log time to kill | 0.141 logit | 0.438 |

Every feature earns its place: removing any one raises the leave-one-out error at both the
top 5% and the median of the board (`ablation` in the model file). Three that were tried
did not, and were removed one at a time: switching's Fitts ID, tracking's "leaves the
ground" flag, and then tracking's log size, which carried nothing the speed-to-size ratio
did not once the flag was gone. Two that were added: whether a clicking score is multiplied
by accuracy or by its square root. Without them the fit averaged that penalty into every
scenario, and predicted Voltaic's 1w4ts, scored on square-root accuracy, 15-25% above its
board, which also means it predicted every unmultiplied scenario - all of season 2's -
below its own.

One bias the model keeps, narrower than it first looked: Voltaic's Aether, the template
the three flying families are built on, is over-predicted at every tier, by 0.14, 0.30 and
0.90 logit at the median for Novice, Intermediate and Advanced (`residualsAtMedian` in the
model file). Flying targets as a group are not: across all 41 in the tracking class the
mean miss is +0.12 with a spread of 0.66, and 21 are over-predicted, which is no more than
chance (`fliers` in the model file). A flag for flying targets was tried and made the fit worse at the median. So nothing is corrected, and Lift, Loop and Wasp are named as the thresholds
likeliest to be set too high.

Two findings shaped how the model is used.

- **Crowds differ by difficulty.** The median score on Voltaic S5 Floating Heads barely moves
  from Novice (598) to Intermediate (568), although the target shrinks and speeds up: a harder
  scenario draws a stronger crowd. A pooled model predicts the board of a typical crowd.
- **A sibling's board was measured too.** Predicting a variant from another variant's board
  is worse than the pooled fit for clicking (0.144 against 0.129) and switching (0.152
  against 0.141), and better for tracking (0.283 against 0.399). No season-2 scenario
  has a sibling with a board, so the pooled fit is the only option until one does.

How sharply a target turns matters to tracking and is in the file: seconds to reach full
speed, `MaxSpeed / Acceleration`. Without it tracking's error at the top 5% and the median is
0.455 and 0.440; with it, 0.395 and 0.399. It is also what lets the model tell Glide's
gentle reversals from Duel's sharp ones.

Which bot is "the target" is a judgement the reader makes, and it once made it wrongly:
Revosect's Pasu fills its arena with small helper bots that push targets off the walls, as
many of one kind as there are targets, and the reader took a helper for the target. That
scenario sat 13x off the model until ties went to the larger bot. The file has no flag
that separates the two: `Untargetable=true` is on Voltaic's real targets as well.

The flick itself was once mis-measured too. The nearest-flick estimate drew the other live
targets with replacement, so a flick could land on the spawn it started from; on a map with
as many targets as spawns that happened on most draws. Drawing without replacement moved the
clicking fit's error at the median from 0.199 to 0.143 and the Fitts slope from 0.19 to 0.27
per bit.

The model is weakest where the file says least: moving targets whose paths the dodge profile
only sketches (Popcorn's variants are two of its five worst clicking misses, listed as
`worstMisses` in the model file), and path-spawning or pressure scenarios
(excluded from its classes). Season 2's static families sit squarely in its domain; its
moving families carry the wider error.

## The rules season 2 follows

| Rule | Reason |
| --- | --- |
| 60 seconds for every scenario | Noise falls with length (-0.36); 60 s is the length of the popular benchmarks it replaces. |
| No accuracy multiplier | More noise (5.8% vs 4.8%), less replay (-0.11) and less reach (-0.16). |
| One skill per family, both axes covered | Isolating a skill makes a score diagnostic; the popular pool under-trains vertical movement. |
| Static targets on an arc, not a wall | On a flat wall a target far to the side is further away and smaller, so where it spawns becomes luck. |
| Band steps of 0.87x size, 1.10x speed, 0.87x strafe period | The progression Voltaic S5 applies across its own families, which players already accept as even. |
| Scoring per kill (clicking) or per landed tick (holding fire) | The two forms whose boards the model can predict; neither multiplies by accuracy. |
| Arcs and bounces in several families | The one feature with more replay and more reach. |
| Every value within what real files use | Nothing here has been played; the game has at least loaded values like these (`validate:season2`). |

## What only playing can answer

- **Feel.** Whether Glide's reversals read as smooth or sluggish, whether Feint's jukes feel
  fair, whether Hopper's arcs are satisfying. The file cannot say, and neither can a board.
- **Band spacing.** The model sees only small differences between switching bands (about 1%
  per band at the median for still targets). Thresholds still rise across bands, because each
  band grades stricter percentiles, but whether an Advanced player feels the step needs play.
- **Engine behaviour at the edges.** Pendulum's floaters hold their height with gravity and
  hops off. Switching targets float at spawn height. Tracking targets never die. Each is
  inferred from how the templates behave, not seen.
- **Thresholds.** Every one is a prediction with the error above. They should be recut from
  Apogee's own runs as soon as there are enough; `pool.json` already names that as season 2's
  job ("Measuring the real step needs Apogee's own population").
