-- The scenario's own firing rate, for the one check with an absolute anchor.
--
-- Every other local relation is a RATIO -- score to damage, damage possible to shots,
-- hits plus misses to shots -- and a ratio is blind to a uniform scale. An attacker who
-- multiplies the score, the hits, the misses, the shots and both damage columns by the
-- same factor leaves every one of those relations intact, and the file stays exactly as
-- coherent as it started. Measured against the reference corpus: a x3 forgery of that
-- shape raised one run from 18,770 to 56,310 with no hard check failing and no advisory
-- raised. This column is what sees it.
--
-- It only means anything where a scenario's shots are engine TICKS rather than human
-- clicks -- the weapon fires continuously, so the shot count is a property of the
-- scenario and the clock rather than of the player. That is gated on the corpus, not
-- assumed: a scenario qualifies only where its fastest run sits within 2% of its median
-- one. Where it does not qualify the value is null and the check skips, because the
-- alternative is a bound built from one player's clicking speed, which a faster player
-- clears by playing well.
--
-- Paired with `duration_seconds`, which the rate is a rate over. Both or neither: a rate
-- with no length to multiply by verifies nothing.

alter table scenarios
  -- shots the scenario fires per second, at its own fixed rate
  add column if not exists shots_per_second numeric;

comment on column scenarios.shots_per_second is
  'Fitted firing rate, in shots per second, for scenarios whose shots are engine ticks '
  'rather than clicks. Null where the rate is a matter of how fast the player clicks, '
  'in which case the shots_per_second check skips rather than bounding a player by '
  'another player''s speed. Read with duration_seconds; neither is useful alone.';
