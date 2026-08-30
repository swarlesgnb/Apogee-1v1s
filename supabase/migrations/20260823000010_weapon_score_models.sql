-- Weapon-block scoring relations, for runs that have no kill rows.
--
-- `score_model_stat`/`score_model_k` re-derive a score from the summary tail, which
-- works right up until the run is a tracking scenario against an invincible target:
-- those score at a rate, never register a kill, and so carry no kill rows at all --
-- 3,159 of 11,427 runs in the reference corpus. What every one of them does carry is a
-- weapon block, so that is what verification falls back to (PLAN.md section 5).
--
-- Two relations, both learned per scenario the same way the tail model is, and both
-- null where no constant relation was found, in which case the checks skip rather than
-- fail. They live here rather than in the client for the same reason as the tail model:
-- a client asked to supply them would supply whatever made its own score look valid.

alter table scenarios
  -- score = Damage Done * weapon_score_per_damage
  add column if not exists weapon_score_per_damage numeric,
  -- Damage Possible = Shots * weapon_damage_per_shot
  add column if not exists weapon_damage_per_shot  numeric;

comment on column scenarios.weapon_score_per_damage is
  'Rate the score is a multiple of the weapon block''s Damage Done. Re-derives the '
  'score for a run with no kill rows, where score_model_stat has no counter to read.';

comment on column scenarios.weapon_damage_per_shot is
  'Rate Damage Possible is a multiple of Shots. Damage Possible is the only weapon-block '
  'column with no copy in the summary tail, which makes it the one an edit leaves '
  'behind: every other counter is already tied to another and can be rewritten to match.';
