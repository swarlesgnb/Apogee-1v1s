/**
 * The bot's own state, in a local SQLite file.
 *
 * Deliberately not Supabase: nothing here is a fact about play, and the database's rule is
 * that clients get no write path into anything that matters. Links, XP and stardust are
 * Discord's business; losing this file costs the community layer its memory and nothing
 * else, because rank roles and the feed are re-derived from Apogee on the next poll.
 *
 * node:sqlite rather than better-sqlite3: it ships with Node 22, so there is no native
 * module to rebuild against Electron's ABI in the same node_modules.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ROOT } from "./env.ts";

export interface UserRow {
  discord_id: string;
  xp: number;
  stardust: number;
  last_chat_at: number;
  daily_day: number | null;
  daily_streak: number;
  daily_count_week: number;
  daily_week: number | null;
  shields: number;
  title: string | null;
  color_role: string | null;
  reflex_best: number | null;
  flick_best: number | null;
  win_streak: number;
  best_win_streak: number;
}

export interface LinkRow {
  discord_id: string;
  steam_id: string;
  player_id: string;
  display_name: string;
  linked_at: number;
}

const SCHEMA = `
create table if not exists users (
  discord_id text primary key,
  xp integer not null default 0,
  stardust integer not null default 0,
  last_chat_at integer not null default 0,
  daily_day integer,
  daily_streak integer not null default 0,
  daily_count_week integer not null default 0,
  daily_week integer,
  shields integer not null default 0,
  title text,
  color_role text,
  reflex_best integer,
  flick_best integer,
  win_streak integer not null default 0,
  best_win_streak integer not null default 0
);
create table if not exists links (
  discord_id text primary key,
  steam_id text not null unique,
  player_id text not null unique,
  display_name text not null,
  linked_at integer not null
);
create table if not exists pending_links (
  discord_id text primary key,
  steam_id text not null,
  code text not null,
  created_at integer not null
);
create table if not exists owned (
  discord_id text not null,
  item text not null,
  primary key (discord_id, item)
);
create table if not exists kv (key text primary key, value text not null);
create table if not exists rank_state (discord_id text primary key, tier_id text);
create table if not exists predictions (
  id text primary key,
  match_id text not null,
  player_id text not null,
  subject text not null,
  channel_id text not null,
  message_id text not null,
  opened_at integer not null,
  settled integer not null default 0
);
create table if not exists bets (
  prediction_id text not null,
  discord_id text not null,
  side text not null,
  stake integer not null,
  primary key (prediction_id, discord_id)
);
create table if not exists sotd (
  day integer primary key,
  scenario text not null,
  channel_id text not null,
  message_id text not null,
  finalized integer not null default 0
);
create table if not exists bounty_claims (
  week integer not null,
  idx integer not null,
  discord_id text not null,
  primary key (week, idx, discord_id)
);
create table if not exists reflex_week (
  week integer not null,
  discord_id text not null,
  best integer not null,
  primary key (week, discord_id)
);
create table if not exists warns (
  id integer primary key autoincrement,
  discord_id text not null,
  mod_id text not null,
  reason text not null,
  at integer not null
);
create table if not exists callouts (
  id text primary key,
  challenger text not null,
  target text not null,
  category text,
  status text not null,
  at integer not null
);
create table if not exists starboard (
  message_id text primary key,
  board_message_id text not null
);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(file = join(ROOT, "discord", ".data", "apogee-bot.db")) {
    if (file !== ":memory:") mkdirSync(join(file, ".."), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("pragma journal_mode = wal;");
    this.db.exec(SCHEMA);
  }

  // -- users ---------------------------------------------------------------

  user(id: string): UserRow {
    this.db.prepare("insert or ignore into users (discord_id) values (?)").run(id);
    return this.db.prepare("select * from users where discord_id = ?").get(id) as unknown as UserRow;
  }

  patchUser(id: string, patch: Partial<Omit<UserRow, "discord_id">>): void {
    this.user(id);
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const sql = `update users set ${keys.map((k) => `${k} = ?`).join(", ")} where discord_id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => (patch as Record<string, never>)[k]), id);
  }

  /** Adds (or with a negative amount, takes) stardust. Refuses to go below zero. */
  addStardust(id: string, amount: number): boolean {
    this.user(id);
    const r = this.db
      .prepare("update users set stardust = stardust + ? where discord_id = ? and stardust + ? >= 0")
      .run(amount, id, amount);
    return Number(r.changes) === 1;
  }

  top(column: "stardust" | "xp" | "best_win_streak", limit = 10): UserRow[] {
    return this.db
      .prepare(`select * from users where ${column} > 0 order by ${column} desc limit ?`)
      .all(limit) as unknown as UserRow[];
  }

  topAsc(column: "reflex_best" | "flick_best", limit = 10): UserRow[] {
    return this.db
      .prepare(`select * from users where ${column} is not null order by ${column} asc limit ?`)
      .all(limit) as unknown as UserRow[];
  }

  // -- links ---------------------------------------------------------------

  link(discordId: string): LinkRow | undefined {
    return this.db.prepare("select * from links where discord_id = ?").get(discordId) as unknown as
      | LinkRow
      | undefined;
  }

  linkByPlayer(playerId: string): LinkRow | undefined {
    return this.db.prepare("select * from links where player_id = ?").get(playerId) as unknown as
      | LinkRow
      | undefined;
  }

  links(): LinkRow[] {
    return this.db.prepare("select * from links").all() as unknown as LinkRow[];
  }

  saveLink(row: LinkRow): void {
    this.db.prepare("delete from links where discord_id = ? or steam_id = ? or player_id = ?").run(
      row.discord_id,
      row.steam_id,
      row.player_id,
    );
    this.db
      .prepare("insert into links values (?, ?, ?, ?, ?)")
      .run(row.discord_id, row.steam_id, row.player_id, row.display_name, row.linked_at);
    this.db.prepare("delete from pending_links where discord_id = ?").run(row.discord_id);
  }

  unlink(discordId: string): void {
    this.db.prepare("delete from links where discord_id = ?").run(discordId);
    this.db.prepare("delete from rank_state where discord_id = ?").run(discordId);
  }

  pending(discordId: string): { steam_id: string; code: string; created_at: number } | undefined {
    return this.db
      .prepare("select steam_id, code, created_at from pending_links where discord_id = ?")
      .get(discordId) as unknown as { steam_id: string; code: string; created_at: number } | undefined;
  }

  savePending(discordId: string, steamId: string, code: string): void {
    this.db
      .prepare("insert or replace into pending_links values (?, ?, ?, ?)")
      .run(discordId, steamId, code, Date.now());
  }

  // -- kv ------------------------------------------------------------------

  get(key: string): string | undefined {
    const r = this.db.prepare("select value from kv where key = ?").get(key) as { value: string } | undefined;
    return r?.value;
  }

  set(key: string, value: string): void {
    this.db.prepare("insert or replace into kv values (?, ?)").run(key, value);
  }

  // -- shop ----------------------------------------------------------------

  owns(discordId: string, item: string): boolean {
    return !!this.db.prepare("select 1 from owned where discord_id = ? and item = ?").get(discordId, item);
  }

  grant(discordId: string, item: string): void {
    this.db.prepare("insert or ignore into owned values (?, ?)").run(discordId, item);
  }

  owned(discordId: string): string[] {
    return (this.db.prepare("select item from owned where discord_id = ?").all(discordId) as { item: string }[]).map(
      (r) => r.item,
    );
  }

  /** Several writes as one: a purchase must not take the stardust and miss the item. */
  tx<T>(fn: () => T): T {
    this.db.exec("begin");
    try {
      const out = fn();
      this.db.exec("commit");
      return out;
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }
}
