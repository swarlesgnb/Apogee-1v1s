/**
 * The slice of supabase-js the Edge Functions use, answered by a PGlite database.
 *
 * Shared by the security validators (validateTimeIntegrity, validateVerifiedPbs,
 * validateSteamAuth) so a shipped handler can run against the real migrations with only
 * its transport replaced. Identifiers are checked against a strict pattern and every
 * value is a bound parameter, so a test cannot be fooled by SQL built from its own data.
 *
 * Errors come back the way PostgREST reports them, `{ code, message }` with the SQLSTATE
 * as the code, because handlers branch on `23505`, `55000` and the trigger's own codes.
 */
import assert from "node:assert/strict";

const ident = (s) => { assert.match(s, /^[a-z_][a-z0-9_]*$/, `identifier ${s}`); return s; };

/** What PGlite should receive for a value PostgREST would have taken as JSON. */
export const toParam = (v) =>
  v === undefined ? null
    : Array.isArray(v) && v.every((x) => x === null || typeof x !== "object") ? v
    : v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v)
    : v;

export function restClient(db, { rpc } = {}) {
  return {
    async rpc(name, params) {
      if (!rpc) throw new Error(`no rpc ${name} in this test`);
      return rpc(name, params);
    },
    from(table) {
      ident(table);
      const st = { op: "select", columns: "*", returning: null, where: [], values: [], order: [], limit: "", single: false };
      const param = (v) => { st.values.push(toParam(v)); return `$${st.values.length}`; };
      const cols = (list) => list.split(",").map((c) => ident(c.trim())).join(", ");
      const q = {
        select(list = "*") {
          if (st.op === "select") st.columns = list === "*" ? "*" : cols(list);
          else st.returning = list === "*" ? "*" : cols(list);
          return q;
        },
        eq(k, v) { st.where.push(`${ident(k)} = ${param(v)}`); return q; },
        neq(k, v) { st.where.push(`${ident(k)} <> ${param(v)}`); return q; },
        gt(k, v) { st.where.push(`${ident(k)} > ${param(v)}`); return q; },
        gte(k, v) { st.where.push(`${ident(k)} >= ${param(v)}`); return q; },
        lt(k, v) { st.where.push(`${ident(k)} < ${param(v)}`); return q; },
        lte(k, v) { st.where.push(`${ident(k)} <= ${param(v)}`); return q; },
        in(k, v) { st.where.push(`${ident(k)} = any(${param(v)})`); return q; },
        is(k, v) { assert.equal(v, null); st.where.push(`${ident(k)} is null`); return q; },
        not(k, op, v) { assert.ok(op === "is" && v === null); st.where.push(`${ident(k)} is not null`); return q; },
        or(expr) {
          const parts = expr.split(",").map((p) => {
            const m = /^([a-z_]+)\.(eq|neq|is)\.(.+)$/.exec(p);
            assert.ok(m, `or() term ${p}`);
            if (m[2] === "is") { assert.equal(m[3], "null"); return `${ident(m[1])} is null`; }
            return `${ident(m[1])} ${m[2] === "eq" ? "=" : "<>"} ${param(m[3])}`;
          });
          st.where.push(`(${parts.join(" or ")})`);
          return q;
        },
        order(k, o) { st.order.push(`${ident(k)} ${o?.ascending === false ? "desc" : "asc"}`); return q; },
        limit(n) { st.limit = ` limit ${Number(n)}`; return q; },
        maybeSingle() { st.single = true; return q; },
        insert(rows) { st.op = "insert"; st.rows = [rows].flat(); return q; },
        update(row) { st.op = "update"; st.row = row; return q; },
        delete() { st.op = "delete"; return q; },
        upsert(rows, opts) { st.op = "upsert"; st.rows = [rows].flat(); st.conflict = opts?.onConflict; return q; },
        then(ok, fail) { return run().then(ok, fail); },
      };
      const where = () => (st.where.length ? ` where ${st.where.join(" and ")}` : "");
      async function run() {
        let sql;
        if (st.op === "select") {
          sql = `select ${st.columns} from ${table}${where()}${st.order.length ? ` order by ${st.order.join(", ")}` : ""}${st.limit}`;
        } else if (st.op === "insert" || st.op === "upsert") {
          const keys = Object.keys(st.rows[0]).map(ident);
          const tuples = st.rows.map((r) => `(${keys.map((k) => param(r[k])).join(", ")})`);
          sql = `insert into ${table} (${keys.join(", ")}) values ${tuples.join(", ")}`;
          if (st.op === "upsert") {
            const conflict = st.conflict.split(",").map((c) => ident(c.trim()));
            sql += ` on conflict (${conflict.join(", ")}) do update set ` +
              keys.filter((k) => !conflict.includes(k)).map((k) => `${k} = excluded.${k}`).join(", ");
          }
          if (st.returning) sql += ` returning ${st.returning}`;
        } else if (st.op === "delete") {
          sql = `delete from ${table}${where()}`;
        } else {
          const sets = Object.keys(st.row).map((k) => `${ident(k)} = ${param(st.row[k])}`);
          sql = `update ${table} set ${sets.join(", ")}${where()}`;
          if (st.returning) sql += ` returning ${st.returning}`;
        }
        try {
          const r = await db.query(sql, st.values);
          return { data: st.single ? r.rows[0] ?? null : r.rows, error: null };
        } catch (e) {
          return { data: null, error: { code: e.code, message: e.message } };
        }
      }
      return q;
    },
  };
}

/** A fresh database with Supabase's roles and grants, every migration and the seed. */
export async function migratedDatabase(PGlite, readFileSync, readdirSync, { before } = {}) {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text unique);
    create or replace function auth.uid() returns uuid
      language sql stable as $$ select nullif(current_setting('test.player_id', true), '')::uuid $$;
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  `);
  const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
  for (const f of files.filter((f) => !before || f < before)) {
    await db.exec(readFileSync(`supabase/migrations/${f}`, "utf8"));
  }
  await db.exec(readFileSync("supabase/seed.sql", "utf8"));
  return {
    db,
    /** Apply the migrations held back by `before`. */
    async finish() {
      for (const f of files.filter((f) => before && f >= before)) {
        await db.exec(readFileSync(`supabase/migrations/${f}`, "utf8"));
      }
    },
  };
}
