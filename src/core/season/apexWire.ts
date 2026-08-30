/**
 * The contract between the apex board's Edge Function and the client that reads it.
 *
 * WHY THIS IS ITS OWN FILE
 *
 * `apex-board` builds this shape and `src/app/api.ts` destructures it, and until this file
 * existed both wrote it out by hand. Nothing checked that the two agreed: the function is
 * Deno and lives outside `tsconfig`'s `include`, so a field renamed on one side and not the
 * other compiles cleanly on both and fails as `undefined` on a screen.
 *
 * That is the same failure the seed comment warns about in another guise - two derivations
 * of one decision - and the same fix applies. The shape is declared once and imported by
 * both ends, so a change to it cannot land on only one side. `validate:functions` checks
 * that the Edge Function's import of this file still resolves, which is the part `tsc`
 * cannot do.
 *
 * WHAT IS DELIBERATELY ABSENT
 *
 * `player_id`. The board is served rather than read (migration 20260830000015) precisely so
 * the population is not enumerable, and shipping an identifier per row would hand back what
 * withholding the table read was for. The caller finds itself with `you`, which is a flag on
 * the row rather than something to correlate.
 */

/** One place on the board. */
export interface ApexBoardEntry {
  /** 1-based, competition ranking: tied players share a place and the next one skips it. */
  rank: number;
  displayName: string;
  points: number;
  /** Families with a score, out of the category's total. A partial standing is not a bad one. */
  graded: number;
  families: number;
  /** True on the caller's own row. The only identity signal in the response. */
  you: boolean;
}

/** Where the caller sits, whether or not they are on the returned page. */
export interface ApexBoardSelf {
  /**
   * Counted across the whole category, not found in `entries`.
   *
   * Being outside the top page is the normal case and the one that most needs an answer,
   * so this is a count of who is strictly above rather than an index into what was sent.
   */
  rank: number | null;
  points: number;
  graded: number;
  families: number;
  updatedAt: string;
}

export interface ApexBoardPage {
  category: string;
  /** How many players have a standing in this category at all. */
  population: number;
  entries: ApexBoardEntry[];
  /** Null when the caller has never refreshed: absent, rather than present at zero. */
  you: ApexBoardSelf | null;
}
