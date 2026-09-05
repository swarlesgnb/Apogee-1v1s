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

      // The positional top rank, where this band has one. Recognised by being a
      // placeholder at the end rather than by its index, because a named top rank is a
      // thing somebody may have done and must not be thrown away.
      const tail = band.rankNames[band.rankNames.length - 1];
      if (tail !== undefined && PLACEHOLDER.test(tail)) names.push(tail);

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
