/**
 * Keep a category's bands showing the same ranks its ladder says it has.
 *
 * A category carries its ranks twice. `category.rankNames` is the whole climb in order -
 * sixteen of them - and `category.bands[].rankNames` is that list cut into the four windows
 * that actually grade, overlapping by two so a handover has no cliff. The second is what
 * every screen in the app reads; the first is what the season editor edits.
 *
 * Nothing kept them in step, and that is the whole of "the season editor is not saving".
 * It saved perfectly, every time, into a field nothing displays: three ladders' worth of
 * names and colours sat in `category.rankNames` while every screen went on painting the
 * bands. The editor showed the new names because the editor reads what it writes, which is
 * exactly the shape of bug that survives being looked at.
 *
 * Deriving the bands rather than the ladder is the right way round. The bands are slices of
 * one sequence by construction - band `w` is ranks `w * windowSize` through
 * `w * windowSize + windowSize + overlap - 1` - so the ladder is the thing with the
 * information in it and the bands are a view of it. Going the other way would have to
 * reconcile six overlapping copies of every handover rank and pick a winner.
 */

import { windowRankCount } from "./windows.ts";

interface Band {
  window: number;
  rankNames: string[];
  rankColors: Record<string, string>;
  positional?: { topN: number } | null;
}

interface Category {
  name: string;
  rankNames: string[];
  rankColors: Record<string, string>;
  bands?: Band[];
}

interface SeasonLike {
  windowSize?: number;
  windowOverlap?: number;
  categories: Category[];
}

/** Placeholder names `buildSeason` writes for a rank nobody has named. */
const PLACEHOLDER = /^Rank \d+\**$/;

/**
 * Rewrite every band's names and colours from its category's ladder, in place.
 *
 * Returns the categories it changed, so a caller can say so rather than silently doing it.
 *
 * A trailing placeholder on the last band is kept. That rank is held by a place on the
 * board rather than by a score, so it has no entry in the ladder to be derived from - and
 * dropping it would take away the top of every category.
 */
export function syncBandLadders(season: SeasonLike): string[] {
  const size = season.windowSize ?? 4;
  const overlap = season.windowOverlap ?? 0;
  const changed: string[] = [];

  for (const category of season.categories) {
    if (!category.bands?.length) continue;

    const before = JSON.stringify(category.bands.map((b) => [b.rankNames, b.rankColors]));

    for (const band of category.bands) {
      const first = band.window * size;
      const width = windowRankCount(band.window, size, category.rankNames.length, overlap);
      const names = category.rankNames.slice(first, first + width);

      // The positional top rank, where this band has one.
      //
      // It is a rank the ladder does not contain: sixteen names for sixteen scored ranks,
      // and this seventeenth is held by standing in the top few of the board instead. So it
      // has nothing to be derived from and has to be carried across by hand.
      //
      // Recognised by the band declaring `positional`, not by the name matching the
      // placeholder pattern. Matching on the pattern worked only while these were unnamed:
      // the moment somebody named one it stopped being a placeholder, stopped being carried,
      // and the next save would have deleted the top rank of every category.
      const tail = band.rankNames[band.rankNames.length - 1];
      const hasTop =
        tail !== undefined && (band.positional != null || PLACEHOLDER.test(tail)) &&
        !names.includes(tail);
      if (hasTop) names.push(tail);

      const colors: Record<string, string> = {};
      for (const name of names) {
        const from = category.rankColors[name] ?? band.rankColors?.[name];
        if (from) colors[name] = from;
      }

      band.rankNames = names;
      band.rankColors = colors;
    }

    if (JSON.stringify(category.bands.map((b) => [b.rankNames, b.rankColors])) !== before) {
      changed.push(category.name);
    }
  }

  return changed;
}

/**
 * The overall readout takes its names and colours from the rating ladder.
 *
 * These were two eight-rung ladders describing the same position. `data/apogee_ranks.json`
 * says where a player sits against everyone else and the season's overall rank says what
 * their scores are worth - a real distinction, and one that is not measured yet: with no
 * live population, `snapshot.ts` derives the percentile straight from the benchmark rank,
 * so the two are the same number by construction and were only ever two sets of words for
 * it. Carrying both meant every screen naming an overall standing used a vocabulary that
 * appeared nowhere else in the app.
 *
 * Derived rather than copied, so there is one place to edit and they cannot drift. The
 * season file still stores them, because everything downstream reads the season and a
 * published season has to be a complete record of what its ranks were.
 *
 * WHEN THIS STOPS BEING RIGHT
 *
 * The day the ladder has players. Then the rating is a real percentile, the two numbers
 * come apart, and the same word means two things on one screen. The fix then is to label
 * them - "your rating" against "what your scores are worth" - rather than to invent a
 * second vocabulary, because the second vocabulary is what this removed.
 */
export function syncOverallLadder(
  season: { rankNames: string[]; rankColors: Record<string, string> },
  tiers: { name: string; color: string }[],
): boolean {
  // Only when the depths match. A ladder of a different length is a deliberate difference
  // rather than drift, and silently truncating one to the other would lose ranks.
  if (tiers.length !== season.rankNames.length) return false;

  const names = tiers.map((t) => t.name);
  const colors: Record<string, string> = {};
  for (const t of tiers) colors[t.name] = t.color;

  const changed =
    JSON.stringify(names) !== JSON.stringify(season.rankNames) ||
    JSON.stringify(colors) !== JSON.stringify(season.rankColors);

  season.rankNames = names;
  season.rankColors = colors;
  return changed;
}
