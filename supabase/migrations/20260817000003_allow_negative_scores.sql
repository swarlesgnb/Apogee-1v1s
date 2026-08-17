-- Allow negative scores.
--
-- `runs_score_sane` required `score >= 0`. That is wrong: pressure scenarios subtract
-- for misses, so a genuine run can finish below zero. Three such runs exist in the
-- corpus this project was built against (−500 on `darkPressure`, −160 and −54 on
-- `AKTK 1w2ts wide microstrafe`), and they are perfectly valid.
--
-- The same mistake was made in the verification checks and corrected there when it was
-- measured against real data, but the database constraint was left behind. The symptom
-- was a backfill that failed partway through with a constraint violation, on the one
-- batch that happened to contain a pressure run.
--
-- The bound now limits magnitude only, which is all it was ever meant to do: catch
-- `Score:,999999999` without having an opinion about the sign.

alter table runs drop constraint if exists runs_score_sane;

alter table runs
  add constraint runs_score_sane
    check (score > -10000000 and score < 10000000);

comment on constraint runs_score_sane on runs is
  'Magnitude bound only. Scores may legitimately be negative: pressure scenarios '
  'subtract for misses.';
