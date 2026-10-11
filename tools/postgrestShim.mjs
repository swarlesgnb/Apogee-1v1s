/**
 * Just enough of supabase-js's query builder, over PGlite, to run the shipped Edge handlers.
 *
 * The Edge Functions talk to Postgres through PostgREST, which no test here can start. The
 * earlier harnesses (validateAtomicSettlement.mjs) stubbed the handful of calls one handler
 * makes; find-match makes embedded joins, filters on joined columns, counts, bulk inserts
 * and RPCs, so this is a small general translation instead: every call becomes one SQL
 * statement against the real migrated schema, and every result comes back through
 * Postgres's own JSON encoding, so numbers, arrays and timestamps arrive shaped the way
 * PostgREST shapes them (a timestamp keeps its microseconds and its offset).
 *
 * What it supports is what the queue path uses and nothing else:
 *
 *   select(cols, {count, head})    columns, `alias:table!inner(cols)` many-to-one embeds
 *   eq neq lt lte gt gte in is     on a column or on an embedded `table.column`
 *   not(col, "is", null), or("a.is.null,a.neq.x")
 *   order limit maybeSingle single
 *   insert(rows, {defaultToNull}) update upsert(onConflict) delete, each with .select()
 *   rpc(name, params)              named arguments; objects and arrays sent as jsonb
 *
 * An embed's foreign key is found by convention (`players` -> `player_id`), which holds for
 * every embed in the functions today. Anything unsupported throws rather than guessing.
 */

const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`unsupported identifier: ${s}`);
  return `"${s}"`;
};

/** Split on commas that are not inside parentheses. */
function splitTop(list) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const FK = { players: "player_id", matches: "match_id", scenarios: "scenario_id", seasons: "season_id" };

function parseColumns(spec) {
  const plain = [], embeds = [];
  for (const item of splitTop(spec || "*")) {
    const m = /^(?:([a-z_]+):)?([a-z_]+)(!inner)?\((.*)\)$/s.exec(item);
    if (m) {
      const [, alias, table, inner, cols] = m;
      embeds.push({ alias: alias ?? table, table, inner: !!inner, columns: splitTop(cols) });
    } else plain.push(item);
  }
  return { plain, embeds };
}

/** A JS array as a Postgres array literal; PGlite would otherwise send it as "a,b". */
function arrayLiteral(values) {
  const element = (v) => {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return '"' + String(v).replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
  };
  return "{" + values.map(element).join(",") + "}";
}

class Query {
  constructor(db, table) {
    this.db = db; this.table = table; this.op = "select"; this.columns = "*";
    this.filters = []; this.values = []; this.orders = []; this.limitN = null;
    this.singleMode = null; this.countMode = null; this.head = false; this.returning = null;
  }
  param(v) {
    this.values.push(Array.isArray(v) ? arrayLiteral(v)
      : v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v);
    return `$${this.values.length}`;
  }
  col(name) {
    const dot = name.indexOf(".");
    if (dot < 0) return `t.${ident(name)}`;
    const [rel, column] = [name.slice(0, dot), name.slice(dot + 1)];
    return `${ident("e_" + rel)}.${ident(column)}`;
  }
  select(cols = "*", opts = {}) {
    if (this.op === "select") {
      this.columns = cols;
      if (opts.count) { this.countMode = opts.count; this.head = !!opts.head; }
    } else this.returning = cols;
    return this;
  }
  eq(k, v) { this.filters.push(`${this.col(k)} = ${this.param(v)}`); return this; }
  neq(k, v) { this.filters.push(`${this.col(k)} <> ${this.param(v)}`); return this; }
  lt(k, v) { this.filters.push(`${this.col(k)} < ${this.param(v)}`); return this; }
  lte(k, v) { this.filters.push(`${this.col(k)} <= ${this.param(v)}`); return this; }
  gt(k, v) { this.filters.push(`${this.col(k)} > ${this.param(v)}`); return this; }
  gte(k, v) { this.filters.push(`${this.col(k)} >= ${this.param(v)}`); return this; }
  in(k, v) { this.filters.push(`${this.col(k)} = any(${this.param(v)})`); return this; }
  is(k, v) {
    if (v !== null) throw new Error("is() supports null only");
    this.filters.push(`${this.col(k)} is null`); return this;
  }
  not(k, op, v) {
    if (op !== "is" || v !== null) throw new Error("not() supports is.null only");
    this.filters.push(`${this.col(k)} is not null`); return this;
  }
  or(expr) {
    const parts = splitTop(expr).map((p) => {
      const m = /^([a-z_]+)\.(is|eq|neq)\.(.+)$/.exec(p);
      if (!m) throw new Error(`unsupported or(): ${p}`);
      const [, k, op, v] = m;
      if (op === "is") { if (v !== "null") throw new Error("or is.null only"); return `${this.col(k)} is null`; }
      return `${this.col(k)} ${op === "eq" ? "=" : "<>"} ${this.param(v)}`;
    });
    this.filters.push(`(${parts.join(" or ")})`); return this;
  }
  order(k, o = {}) { this.orders.push(`${this.col(k)} ${o.ascending === false ? "desc" : "asc"}`); return this; }
  limit(n) { this.limitN = Number(n); return this; }
  maybeSingle() { this.singleMode = "maybe"; return this; }
  single() { this.singleMode = "one"; return this; }
  insert(rows, opts = {}) { this.op = "insert"; this.rows = Array.isArray(rows) ? rows : [rows]; this.defaultToNull = opts.defaultToNull !== false; return this; }
  upsert(rows, opts = {}) { this.insert(rows); this.op = "upsert"; this.onConflict = opts.onConflict; return this; }
  update(vals) { this.op = "update"; this.vals = vals; return this; }
  delete() { this.op = "delete"; return this; }

  joins(embeds) {
    return embeds.map((e) => {
      const fk = FK[e.table];
      if (!fk) throw new Error(`no foreign key convention for ${e.table}`);
      return ` ${e.inner ? "join" : "left join"} ${ident(e.table)} ${ident("e_" + e.alias)} on ${ident("e_" + e.alias)}."id" = t.${ident(fk)}`;
    }).join("");
  }
  where() { return this.filters.length ? ` where ${this.filters.join(" and ")}` : ""; }

  async run() {
    const { plain, embeds } = parseColumns(this.columns);
    if (this.op === "select") {
      const from = `${ident(this.table)} t${this.joins(embeds)}`;
      if (this.countMode) {
        const r = await this.db.query(`select count(*)::int as n from ${from}${this.where()}`, this.values);
        return { data: this.head ? null : [], count: r.rows[0].n, error: null };
      }
      const cols = [
        ...plain.map((c) => (c === "*" ? "t.*" : `t.${ident(c)}`)),
        ...embeds.map((e) => `json_build_object(${e.columns.map((c) => `'${c}', ${ident("e_" + e.alias)}.${ident(c)}`).join(", ")}) as ${ident(e.alias)}`),
      ];
      const order = this.orders.length ? ` order by ${this.orders.join(", ")}` : "";
      const sql = `select coalesce(json_agg(r order by r."__ord"), '[]'::json) as rows from (` +
        `select ${cols.join(", ")}, row_number() over (${order || "order by (select 1)"}) as "__ord" ` +
        `from ${from}${this.where()}${order}${this.limitN != null ? ` limit ${this.limitN}` : ""}) r`;
      return this.shape((await this.db.query(sql, this.values)).rows[0].rows);
    }
    if (embeds.length) throw new Error("embeds are not supported on writes");
    const ret = this.returning ? parseColumns(this.returning).plain : null;
    const wrap = (stmt) => ret
      ? `with w as (${stmt} returning *) select coalesce(json_agg(r), '[]'::json) as rows from (select ${ret.map((c) => (c === "*" ? "w.*" : `w.${ident(c)}`)).join(", ")} from w) r`
      : stmt;
    let sql;
    if (this.op === "insert" || this.op === "upsert") {
      const keys = [...new Set(this.rows.flatMap((r) => Object.keys(r)))];
      const tuples = this.rows.map((row) => `(${keys.map((k) => (k in row ? this.param(row[k]) : this.defaultToNull ? "null" : "default")).join(", ")})`);
      sql = `insert into ${ident(this.table)} (${keys.map(ident).join(", ")}) values ${tuples.join(", ")}`;
      if (this.op === "upsert") {
        const conflict = String(this.onConflict).split(",").map((s) => ident(s.trim()));
        sql += ` on conflict (${conflict.join(", ")}) do update set ${keys.map((k) => `${ident(k)} = excluded.${ident(k)}`).join(", ")}`;
      }
    } else if (this.op === "update") {
      const sets = Object.entries(this.vals).map(([k, v]) => `${ident(k)} = ${this.param(v)}`);
      sql = `update ${ident(this.table)} t set ${sets.join(", ")}${this.where()}`;
    } else {
      sql = `delete from ${ident(this.table)} t${this.where()}`;
    }
    const r = await this.db.query(wrap(sql), this.values);
    return ret ? this.shape(r.rows[0].rows) : { data: null, error: null };
  }
  shape(rows) {
    for (const row of rows) delete row.__ord;
    if (this.singleMode === "maybe") {
      if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows for maybeSingle" } };
      return { data: rows[0] ?? null, error: null };
    }
    if (this.singleMode === "one") {
      if (rows.length !== 1) return { data: null, error: { code: "PGRST116", message: `${rows.length} rows for single` } };
      return { data: rows[0], error: null };
    }
    return { data: rows, error: null };
  }
  then(resolve, reject) {
    return this.run()
      .catch((e) => ({ data: null, error: { code: e.code ?? "XX000", message: e.message } }))
      .then(resolve, reject);
  }
}

export function createAdmin(db, { onQuery, onRpc } = {}) {
  return {
    from(table) { onQuery?.(table); return new Query(db, table); },
    async rpc(name, params = {}) {
      const keys = Object.keys(params);
      const values = keys.map((k) => {
        const v = params[k];
        return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
      });
      try {
        const r = await db.query(`select ${ident(name)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(", ")}) as result`, values);
        onRpc?.(name, r.rows[0].result);
        return { data: r.rows[0].result, error: null };
      } catch (e) {
        return { data: null, error: { code: e.code ?? "XX000", message: e.message } };
      }
    },
  };
}
