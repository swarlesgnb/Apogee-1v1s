-- Apex points become a mean per family, not a sum over them.
--
-- WHY
--
-- A category's apex points were the sum of its families', and the overall was the sum of
-- the categories'. That made the number a fact about how many families a category holds as
-- much as about the player. Season 1 now grades six categories of uneven depth - eleven
-- families in Precise Tracking against six in Evasive Switching - so identical play up the
-- two boards read almost two to one apart, and the overall added those uneven numbers
-- together.
--
-- The season's own ladder never had this problem, which is what makes the sum wrong rather
-- than merely different: a category's energy thresholds are `familyCount * ENERGY_PER_RANK
-- * rank`, so a category rank has always been the MEAN family rank, and the overall rank
-- has always been the mean of each category's fraction along its own ladder. The apex board
-- was the one measure left counting families.
--
-- WHY A MIGRATION RATHER THAN LETTING IT REWRITE ITSELF
--
-- `refresh-apex` rewrites a player's rows whenever they open the Apex screen, so the board
-- would spend an unbounded stretch holding summed rows for everybody who has not been back
-- and mean rows for everybody who has - sorted against each other, in one index, on numbers
-- that are not the same measure. The rescale is exact because `family_count` is already
-- stored per row, so no standing is estimated or lost here.

update apex_standing
   set points = points / family_count
 where category <> 'Overall'
   and family_count > 0;

-- The overall is the mean of the player's own category rows, which is the same weighting
-- the derived overall rank uses: each category counts once, whatever its depth. It has to
-- run after the update above, and does.
update apex_standing as a
   set points = c.mean_points
  from (
    select player_id, avg(points) as mean_points
      from apex_standing
     where category <> 'Overall'
     group by player_id
  ) as c
 where a.player_id = c.player_id
   and a.category = 'Overall';

-- An overall row whose category rows are all gone is a standing about nothing. Cannot
-- happen through `refresh-apex`, which writes the overall only when a category graded, but
-- it can happen through a season whose categories were renamed - which is exactly what
-- happened when Clicking became Static Clicking.
delete from apex_standing a
 where a.category = 'Overall'
   and not exists (
     select 1 from apex_standing b
      where b.player_id = a.player_id
        and b.category <> 'Overall'
   );

comment on column apex_standing.points is
  '-log10 of the fraction from the top, averaged over the category''s families - and over '
  'the categories for the Overall row. A whole point is ten times fewer players above you. '
  'Never caps. Averaged rather than summed so a deeper category does not outscore a '
  'shallower one for the same play; see 20260902000016.';

-- The categories are the season's, and the season's are six sub-skills now rather than the
-- three aim types. Free text on purpose: a season owns what it grades, and a check
-- constraint here would mean a migration every time one is renamed. The 20260816 comment on
-- `scenarios.aim_type` still holds and is a different column - that one really is KovaaK's
-- own three, and stays three.
comment on column apex_standing.category is
  'A season category - "Static Clicking", "Evasive Switching" - or "Overall" for the mean '
  'of them. Matches season_scenarios.category; not KovaaK''s aim type.';
