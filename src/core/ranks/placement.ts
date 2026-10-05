/**
 * Matches PLAN.md §4: no visible rank until placements are done.
 *
 * On its own so a pure module can import it: apogeeRanks.ts reads the theme from disk at
 * import time, which an Edge Function cannot carry (core/leaderboard is served by one).
 */
export const PLACEMENT_MATCHES = 10;
