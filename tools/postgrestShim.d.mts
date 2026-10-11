/** Types for postgrestShim.mjs: a supabase-js-shaped admin client over a PGlite database. */
export function createAdmin(
  db: unknown,
  hooks?: { onQuery?: (table: string) => void; onRpc?: (name: string, result: unknown) => void },
): any;
