/**
 * A Postgres-in-WASM database with every migration applied, and the shipped Crown, race
 * and settlement Edge handlers bundled against it.
 *
 * Shared by validateCrownsDb.ts and validateRaceDb.ts. The pattern is the one
 * validateAtomicSettlement.mjs established: the real handler and the real shared helpers
 * run against a real schema, and only the boundaries a test cannot reach are replaced:
 *
 *   identity       requireCaller returns whoever the test says is calling
 *   transport      handler/json return { status, body } instead of a Response
 *   season pool    loadSeasonPool serves a fixture pool built from seeded scenarios
 *   the sweep      sweepStaleMatches is restated over plain SQL (the real one uses a
 *                  PostgREST embedded join this adapter does not speak) and calls the REAL
 *                  forfeitMatch for anything expired
 *   tournaments    afterLegSettled answers null
 *
 * Everything else, the rate limiter included, is the shipped code. The database adapter
 * speaks the part of supabase-js these functions use and refuses anything else loudly, so
 * a function that starts using a query shape the adapter cannot run fails here rather
 * than passing on a misread query.
 *
 * PGlite is one connection. Overlapping promises interleave at every await, which
 * exercises idempotency and the order checks, but it does not prove the behaviour of two
 * independent connections taking row locks at once. The SQL is written for that case
 * (every decision takes the Crown or race row lock first); this harness cannot run it.
 */

import { PGlite } from "@electric-sql/pglite";
import { build } from "esbuild";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type Row = Record<string, any>;

export async function freshDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(`create schema auth;
    create table auth.users(id uuid primary key default gen_random_uuid());
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.player_id',true),'')::uuid$$;
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;`);
  for (const file of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  }
  await db.exec(readFileSync("supabase/seed.sql", "utf8"));
  return db;
}

export async function makePlayer(db: PGlite, n: number, name: string): Promise<string> {
  const id = (await db.query<{ id: string }>("insert into auth.users default values returning id")).rows[0].id;
  await db.query("insert into players(id, steam_id, display_name) values ($1, $2, $3)", [id, `7656100000${String(n).padStart(7, "0")}`, name]);
  return id;
}

/* ------------------------------------------------------------------ the adapter ---- */

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(value: string): string {
  const v = value.trim();
  if (!IDENT.test(v)) throw new Error(`the test adapter does not speak this column or table: ${JSON.stringify(value)}`);
  return v;
}

/** A JS array as a Postgres array literal: PGlite sends an untyped array as "a,b". */
function arrayLiteral(values: unknown[]): string {
  return `{${values.map((v) => (v == null ? "NULL" : `"${String(v).replace(/["\\]/g, "\\$&")}"`)).join(",")}}`;
}

function encode(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return arrayLiteral(value);
  if (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) return JSON.stringify(value);
  return value;
}

type Op = "select" | "insert" | "update" | "delete";

class Query implements PromiseLike<any> {
  private op: Op = "select";
  private columns = "*";
  private returning: string | null = null;
  private where: string[] = [];
  private values: unknown[] = [];
  private ordering: string[] = [];
  private limitN: number | null = null;
  private single = false;
  private countOnly = false;
  private payload: Row | Row[] | null = null;

  constructor(private db: PGlite, private table: string) {
    ident(table);
  }

  /** Embedded `rel!inner(a, b)` relations, joined on the base table's `<rel, singular>_id`. */
  private embeds: { rel: string; cols: string[] }[] = [];

  private cols(spec: string, allowEmbed = false): string {
    if (spec.trim() === "*") return "*";
    // Split on commas outside parentheses.
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of spec) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        parts.push(cur);
        cur = "";
      } else cur += ch;
    }
    parts.push(cur);
    const plain: string[] = [];
    for (const part of parts) {
      const m = /^\s*([a-z_]+)!inner\(([^()]*)\)\s*$/.exec(part);
      if (m && allowEmbed && m[1] === "matches") this.embeds.push({ rel: "matches", cols: m[2].split(",").map((c) => ident(c)) });
      else plain.push(ident(part));
    }
    return plain.join(", ");
  }
  select(spec = "*", opts?: { count?: string; head?: boolean }) {
    if (this.op === "insert" || this.op === "update") this.returning = this.cols(spec);
    else {
      this.columns = this.cols(spec, true);
      if (opts?.count) this.countOnly = true;
    }
    return this;
  }
  /** A filter key: `col`, or `rel.col` on an embedded relation. */
  private key(k: string): string {
    const [a, b] = k.split(".");
    if (b !== undefined) return `${ident(a)}.${ident(b)}`;
    return this.embeds.length ? `t.${ident(a)}` : ident(a);
  }
  insert(rows: Row | Row[], _opts?: unknown) { this.op = "insert"; this.payload = rows; return this; }
  update(row: Row) { this.op = "update"; this.payload = row; return this; }
  delete() { this.op = "delete"; return this; }
  private cond(key: string, sql: (p: string) => string, value: unknown) {
    this.values.push(encode(value));
    this.where.push(sql(`$${this.values.length}`).replace("§", this.key(key)));
    return this;
  }
  eq(k: string, v: unknown) { return this.cond(k, (p) => `§ = ${p}`, v); }
  neq(k: string, v: unknown) { return this.cond(k, (p) => `§ <> ${p}`, v); }
  lt(k: string, v: unknown) { return this.cond(k, (p) => `§ < ${p}`, v); }
  lte(k: string, v: unknown) { return this.cond(k, (p) => `§ <= ${p}`, v); }
  gt(k: string, v: unknown) { return this.cond(k, (p) => `§ > ${p}`, v); }
  gte(k: string, v: unknown) { return this.cond(k, (p) => `§ >= ${p}`, v); }
  in(k: string, v: unknown[]) { return this.cond(k, (p) => `§ = any(${p})`, v); }
  is(k: string, v: null) {
    if (v !== null) throw new Error("the test adapter only speaks is(col, null)");
    this.where.push(`${this.key(k)} is null`);
    return this;
  }
  not(k: string, op: string, v: null) {
    if (op !== "is" || v !== null) throw new Error("the test adapter only speaks not(col, 'is', null)");
    this.where.push(`${this.key(k)} is not null`);
    return this;
  }
  or(spec: string) {
    const terms = spec.split(",").map((term) => {
      const m = /^([a-z_]+)\.(eq|neq|is)\.(.+)$/.exec(term.trim());
      if (!m) throw new Error(`the test adapter does not speak this or(): ${spec}`);
      const [, col, op, val] = m;
      if (op === "is") {
        if (val !== "null") throw new Error(`the test adapter does not speak this or(): ${spec}`);
        return `${ident(col)} is null`;
      }
      this.values.push(val);
      return `${ident(col)}::text ${op === "eq" ? "=" : "<>"} $${this.values.length}`;
    });
    this.where.push(`(${terms.join(" or ")})`);
    return this;
  }
  order(k: string, o?: { ascending?: boolean }) { this.ordering.push(`${this.key(k)} ${o?.ascending === false ? "desc" : "asc"}`); return this; }
  limit(n: number) { if (!Number.isInteger(n)) throw new Error("limit must be an integer"); this.limitN = n; return this; }
  maybeSingle() { this.single = true; return this; }

  private whereSql() { return this.where.length ? ` where ${this.where.join(" and ")}` : ""; }

  async run(): Promise<{ data: any; error: any; count?: number }> {
    try {
      if (this.op === "select") {
        if (this.countOnly) {
          const r = await this.db.query<{ n: number }>(`select count(*)::int as n from ${this.table}${this.whereSql()}`, this.values);
          return { data: null, error: null, count: r.rows[0].n };
        }
        // Only the one embedded shape these functions use: a side joined to its match.
        const embedded = this.embeds.map((e) =>
          `json_build_object(${e.cols.map((c) => `'${c}', ${e.rel}.${c}`).join(", ")}) as ${e.rel}`);
        const base = this.embeds.length
          ? `${[...this.columns.split(", ").filter(Boolean).map((c) => `t.${c}`), ...embedded].join(", ")} from ${this.table} t ` +
            "join matches on matches.id = t.match_id"
          : `${this.columns} from ${this.table}`;
        const sql = `select ${base}${this.whereSql()}` +
          (this.ordering.length ? ` order by ${this.ordering.join(", ")}` : "") +
          (this.limitN != null ? ` limit ${this.limitN}` : "");
        const r = await this.db.query<Row>(sql, this.values);
        return { data: this.single ? r.rows[0] ?? null : r.rows, error: null };
      }
      if (this.op === "insert") {
        // Row by row, each with its own columns: what `defaultToNull: false` asks PostgREST for.
        const rows = Array.isArray(this.payload) ? this.payload : [this.payload!];
        const out: Row[] = [];
        for (const row of rows) {
          const keys = Object.keys(row).map(ident);
          const vals = Object.values(row).map(encode);
          const r = await this.db.query<Row>(
            `insert into ${this.table} (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})` +
              (this.returning ? ` returning ${this.returning}` : ""),
            vals,
          );
          out.push(...r.rows);
        }
        return { data: this.returning ? (this.single ? out[0] ?? null : out) : null, error: null };
      }
      if (this.op === "update") {
        const row = this.payload as Row;
        const keys = Object.keys(row).map(ident);
        const base = this.values.length;
        const sets = keys.map((k, i) => `${k} = $${base + i + 1}`);
        const r = await this.db.query<Row>(
          `update ${this.table} set ${sets.join(", ")}${this.whereSql()}` + (this.returning ? ` returning ${this.returning}` : ""),
          [...this.values, ...Object.values(row).map(encode)],
        );
        return { data: this.returning ? (this.single ? r.rows[0] ?? null : r.rows) : null, error: null };
      }
      const r = await this.db.query<Row>(`delete from ${this.table}${this.whereSql()}`, this.values);
      return { data: r.rows, error: null };
    } catch (err: any) {
      if (/test adapter/.test(String(err?.message))) throw err;
      return { data: null, error: { code: err?.code, message: err?.message } };
    }
  }

  then<A, B>(ok?: ((v: any) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.run().then(ok, bad);
  }
}

export interface Admin {
  from(table: string): Query;
  rpc(name: string, params: Row): Promise<{ data: any; error: any }>;
  calls: { rpc: string[] };
}

export function adminFor(db: PGlite): Admin {
  const signatures = new Map<string, { names: string[]; types: string[] }>();
  const calls = { rpc: [] as string[] };
  return {
    calls,
    from: (table: string) => new Query(db, table),
    async rpc(name: string, params: Row) {
      ident(name);
      calls.rpc.push(name);
      if (!signatures.has(name)) {
        const r = await db.query<{ names: string[]; types: string[] }>(
          `select p.proargnames as names, array(select format_type(t, null) from unnest(p.proargtypes::oid[]) t) as types
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`,
          [name],
        );
        if (r.rows.length !== 1) throw new Error(`no single function called ${name}`);
        signatures.set(name, r.rows[0]);
      }
      const sig = signatures.get(name)!;
      const args: string[] = [];
      const values: unknown[] = [];
      for (const [i, arg] of sig.names.entries()) {
        if (!(arg in params)) continue;
        const v = params[arg];
        values.push(sig.types[i] === "jsonb" ? (v == null ? null : JSON.stringify(v)) : Array.isArray(v) ? arrayLiteral(v) : v);
        args.push(`${arg} => $${values.length}::${sig.types[i]}`);
      }
      const extra = Object.keys(params).filter((k) => !sig.names.includes(k));
      if (extra.length) throw new Error(`${name} has no parameter ${extra.join(", ")}`);
      try {
        const r = await db.query<{ result: unknown }>(`select ${name}(${args.join(", ")}) as result`, values);
        return { data: r.rows[0]?.result ?? null, error: null };
      } catch (err: any) {
        return { data: null, error: { code: err?.code, message: err?.message } };
      }
    },
  };
}

/* ------------------------------------------------------------- the handlers ---- */

export interface Response { status: number; body: any }
export type Handler = (body: unknown) => Promise<Response>;

export interface Season {
  name: string;
  windows: string[];
  /** window index -> selectable scenarios */
  pools: Map<number, { id: number; name: string; aimType: string | null; subCategory: string | null }[]>;
}

export interface Harness {
  db: PGlite;
  admin: Admin;
  as(playerId: string): void;
  season: Season;
  handlers: Record<string, Handler>;
}

/** Bundle the named Edge Functions with the boundaries above and capture their handlers. */
export async function loadHandlers(db: PGlite, season: Season, names: string[]): Promise<Harness> {
  mkdirSync(".cache/arena-handlers", { recursive: true });
  const real = resolve("supabase/functions/_shared/apogee.ts").replaceAll("\\", "/");
  const admin = adminFor(db);
  const g = globalThis as any;
  g.__arenaAdmin = admin;
  g.__arenaSeason = season;
  g.__arenaDb = db;
  const harness: Harness = { db, admin, season, handlers: {}, as: (id) => { g.__arenaCaller = id; } };

  const boundary = `
    export * from ${JSON.stringify(real)};
    import * as real from ${JSON.stringify(real)};
    export const handler = (fn) => async (req) => {
      try { return await fn(req, globalThis.__arenaAdmin); }
      catch (err) {
        if (err instanceof real.HttpError) return { status: err.status, body: { error: err.message } };
        throw err;
      }
    };
    export const json = (body, status = 200) => ({ status, body });
    export const requireCaller = async () => {
      const playerId = globalThis.__arenaCaller;
      if (!playerId) throw new real.HttpError(401, "missing Authorization header");
      return { playerId, steamId: "", displayName: "", kovaaksUsername: null };
    };
    export const loadSeasonPool = async (_admin, windowIndex) => {
      const s = globalThis.__arenaSeason;
      const selectable = s.pools.get(windowIndex) ?? [];
      if (selectable.length === 0) throw new real.HttpError(404, s.name + " has no scenarios in window " + windowIndex);
      return { season: { id: "season", name: s.name, status: "published", windows: s.windows }, windowName: s.windows[windowIndex] ?? ("window " + (windowIndex + 1)), selectable };
    };
    export const sweepStaleMatches = async (admin, playerId, updateRating) => {
      const db = globalThis.__arenaDb;
      const open = (await db.query(
        "select m.id, m.status, m.category, m.difficulty, m.scenario_ids, m.expires_at, m.created_at from match_sides ms join matches m on m.id = ms.match_id " +
        "where ms.player_id = $1 and m.status in ('open','awaiting_runs') and (ms.submitted_at is null or ms.submitted_at >= m.created_at)", [playerId])).rows;
      let live = null;
      for (const m of open) {
        if (m.expires_at && new Date(m.expires_at).getTime() < Date.now()) await real.forfeitMatch(admin, m.id, playerId, updateRating);
        else live = live ?? { matchId: m.id, match: m };
      }
      return live;
    };
  `;

  for (const name of names) {
    const outfile = `.cache/arena-handlers/${name}.mjs`;
    await build({
      entryPoints: [`supabase/functions/${name}/index.ts`],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
      plugins: [{
        name: "arena-boundaries",
        setup(b) {
          // Every import of the shared helpers, "../_shared/apogee.ts" from a function and
          // "./apogee.ts" from a sibling helper alike, goes through the boundary.
          b.onResolve({ filter: /(^|\/)apogee\.ts$/ }, (args) =>
            args.namespace === "arena" ? { path: real, namespace: "file" } : { path: "boundary", namespace: "arena" });
          b.onResolve({ filter: /\/_shared\/tournament\.ts$/ }, () => ({ path: "tournament", namespace: "arena" }));
          b.onResolve({ filter: /^jsr:/ }, () => ({ path: "client", namespace: "arena" }));
          b.onLoad({ filter: /.*/, namespace: "arena" }, (args) => ({
            resolveDir: process.cwd(),
            loader: "js",
            contents: args.path === "boundary" ? boundary
              : args.path === "tournament" ? "export const afterLegSettled = async () => null;"
              : "export function createClient() { throw new Error('No network in this test'); }",
          }));
        },
      }],
    });
    let captured: ((req: Request) => Promise<Response>) | null = null;
    g.Deno = { env: { get: () => "" }, serve: (fn: (req: Request) => Promise<Response>) => { captured = fn; } };
    await import(`${pathToFileURL(resolve(outfile)).href}?v=${Date.now()}`);
    if (!captured) throw new Error(`${name} did not register a handler`);
    const fn: (req: Request) => Promise<Response> = captured;
    harness.handlers[name] = (body: unknown) =>
      fn(new Request(`https://local.invalid/${name}`, { method: "POST", body: JSON.stringify(body ?? {}) }));
  }
  return harness;
}

/* ------------------------------------------------------------ fixtures ---- */

/** A season over seeded scenarios: two categories in each of two bands, four scenarios each. */
export async function fixtureSeason(db: PGlite): Promise<Season> {
  const ids = (await db.query<{ id: number; name: string }>("select id, name from scenarios order by id limit 16")).rows;
  if (ids.length < 16) throw new Error("the seed has fewer than 16 scenarios");
  // Durations are cleared so a run's own length can never mark it abandoned by accident;
  // the test that wants an abandoned run sets one back.
  await db.query("update scenarios set duration_seconds = null where id = any($1::bigint[])", [ids.map((s) => s.id)]);
  const pick = (from: number, category: string) =>
    ids.slice(from, from + 4).map((s) => ({ id: Number(s.id), name: s.name, aimType: category.includes("Tracking") ? "Tracking" : "Switching", subCategory: category }));
  return {
    name: "Season 1",
    windows: ["Novice", "Intermediate"],
    pools: new Map([
      [0, [...pick(0, "Precise Tracking"), ...pick(4, "Speed Switching")]],
      [1, [...pick(8, "Precise Tracking"), ...pick(12, "Speed Switching")]],
    ]),
  };
}

let fileSerial = 0;

/**
 * A `Challenge Start:` time of day no other run here shares. KovaaK's writes one into every
 * file, and the time-integrity trigger (migration 26) reads it as part of a ranked run's
 * identity, so two different test runs with the same score must not both leave it empty.
 */
export function distinctChallengeStart(n: number): string {
  const ms = n * 1001;
  const two = (v: number) => String(v).padStart(2, "0");
  return `${two(Math.floor(ms / 3_600_000) % 24)}:${two(Math.floor(ms / 60_000) % 60)}:${two(Math.floor(ms / 1000) % 60)}.${String(ms % 1000).padStart(3, "0")}`;
}

/** Five earlier runs at `score` on every scenario of a season, so every baseline is `score`. */
export async function history(db: PGlite, playerId: string, season: Season, score = 100): Promise<void> {
  for (const pool of season.pools.values()) {
    for (const s of pool) {
      for (let i = 0; i < 5; i++) {
        await db.query(
          `insert into runs (player_id, scenario_name, score, played_at, created_at, csv_sha256, verification_tier)
           values ($1, $2, $3, now() - interval '3 days' + make_interval(mins => $4), now() - interval '3 days', $5, 'consistent')`,
          [playerId, s.name, score, i, `history-${++fileSerial}`],
        );
      }
    }
  }
  // Fifty runs is the queue's eligibility bar; top it up so requireEligible passes.
  for (let i = 0; i < 50; i++) {
    await db.query(
      `insert into runs (player_id, scenario_name, score, played_at, created_at, csv_sha256, verification_tier)
       values ($1, 'unrelated scenario', 1, now() - interval '5 days', now() - interval '5 days', $2, 'consistent')`,
      [playerId, `filler-${++fileSerial}`],
    );
  }
}

/** Land one run in a match, as submit-run would store it. */
export async function land(
  db: PGlite,
  playerId: string,
  matchId: string,
  scenarioId: number,
  score: number,
  tier = "consistent",
  durationSeconds: number | null = null,
): Promise<void> {
  const name = (await db.query<{ name: string }>("select name from scenarios where id = $1", [scenarioId])).rows[0].name;
  await db.query(
    `insert into runs (player_id, scenario_name, score, played_at, csv_sha256, verification_tier, match_id, duration_seconds, challenge_start)
     values ($1, $2, $3, clock_timestamp(), $4, $5, $6, $7, $8)`,
    [playerId, name, score, `match-run-${++fileSerial}`, tier, matchId, durationSeconds, distinctChallengeStart(fileSerial)],
  );
}

export async function matchScenarios(db: PGlite, matchId: string): Promise<number[]> {
  return ((await db.query<{ scenario_ids: number[] }>("select scenario_ids from matches where id = $1", [matchId])).rows[0].scenario_ids).map(Number);
}

/** Play all three of a match at the given scores (one per scenario). */
export async function playAll(db: PGlite, playerId: string, matchId: string, scores: number[], tiers?: string[]): Promise<void> {
  const ids = await matchScenarios(db, matchId);
  for (const [i, id] of ids.entries()) await land(db, playerId, matchId, id, scores[i], tiers?.[i] ?? "consistent");
}

export async function snapshotRatings(db: PGlite): Promise<string> {
  const r = await db.query("select player_id, rating, rd, volatility, matches_played from ratings order by player_id");
  const h = await db.query("select count(*)::int as n from rating_history");
  return JSON.stringify({ ratings: r.rows, history: h.rows });
}

let failures = 0;
export function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}
export function failed(): number {
  return failures;
}
