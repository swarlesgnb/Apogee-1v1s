/**
 * What every feature is handed, and the few helpers more than one feature needs.
 */

import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  EmbedBuilder,
  type Guild,
  type GuildMember,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";

import type { Season } from "../src/core/season/season.ts";
import type { Apogee } from "./apogee.ts";
import { ACCENT } from "./blueprint.ts";
import { findRole, textChannel } from "./guild.ts";
import { LEVEL_ROLES, levelForXp, levelRoleFor } from "./rules.ts";
import type { Store } from "./store.ts";

export interface Ctx {
  client: Client<true>;
  guild: Guild;
  store: Store;
  /** Null when the Supabase keys are absent; Apogee-backed features then say so. */
  apogee: Apogee | null;
  season: Season;
  log(line: string): void;
}

export interface CommandDef {
  name: string;
  toJSON(): unknown;
}

export interface Feature {
  name: string;
  commands?: CommandDef[];
  onCommand?: Record<string, (ctx: Ctx, i: ChatInputCommandInteraction) => Promise<void>>;
  /** Keyed by the customId prefix before the first colon. */
  onButton?: Record<string, (ctx: Ctx, i: ButtonInteraction, args: string[]) => Promise<void>>;
  onMessage?(ctx: Ctx, m: Message): Promise<void>;
  onReaction?(ctx: Ctx, r: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void>;
  /** Pollers. Each runs once at startup, then every `ms`. A throw is logged, never fatal. */
  every?: { ms: number; run(ctx: Ctx): Promise<void> }[];
}

export const STARDUST = "✦";

export function card(title?: string): EmbedBuilder {
  const e = new EmbedBuilder().setColor(ACCENT);
  return title ? e.setTitle(title) : e;
}

export function hex(color: string): number {
  return parseInt(color.replace("#", ""), 16);
}

export function requireApogee(ctx: Ctx): ctx is Ctx & { apogee: Apogee } {
  return ctx.apogee !== null;
}

export const NO_APOGEE =
  "Apogee isn't connected on this bot right now (no Supabase key), so that one's unavailable.";

/**
 * Add XP, and when it crosses a level, swap the level role and say so.
 * The only path XP is written through, so the role can never disagree with the number.
 */
export async function addXp(ctx: Ctx, member: GuildMember, amount: number): Promise<void> {
  const u = ctx.store.user(member.id);
  const before = levelForXp(u.xp);
  const xp = u.xp + amount;
  ctx.store.patchUser(member.id, { xp });
  const after = levelForXp(xp);
  if (after > before) {
    await syncLevelRole(ctx, member, after);
    const games = textChannel(ctx.guild, "games");
    const role = levelRoleFor(after);
    const crossed = role !== levelRoleFor(before);
    await games
      ?.send({
        content: crossed
          ? `🚀 <@${member.id}> reached **level ${after}** and is now **${role}**.`
          : `⬆️ <@${member.id}> reached **level ${after}**.`,
        allowedMentions: { users: crossed ? [member.id] : [] },
      })
      .catch(() => undefined);
  }
}

export async function syncLevelRole(ctx: Ctx, member: GuildMember, level: number): Promise<void> {
  const want = levelRoleFor(level);
  for (const { name } of LEVEL_ROLES) {
    const role = findRole(ctx.guild, name);
    if (!role) continue;
    const has = member.roles.cache.has(role.id);
    if (name === want && !has) await member.roles.add(role).catch(() => undefined);
    if (name !== want && has) await member.roles.remove(role).catch(() => undefined);
  }
}

export async function memberOf(ctx: Ctx, id: string): Promise<GuildMember | null> {
  return ctx.guild.members.fetch(id).catch(() => null);
}

export function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function isStaff(member: GuildMember | null): boolean {
  if (!member) return false;
  return member.permissions.has("Administrator") || member.roles.cache.some((r) => r.name === "Admin" || r.name === "Mod");
}
