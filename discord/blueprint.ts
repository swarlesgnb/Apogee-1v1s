/**
 * The server, declared.
 *
 * provision.ts applies this to the guild by name: it creates what is missing and corrects
 * what drifted, and never deletes anything, so a channel added by hand survives a rerun.
 * Rank roles come from data/apogee_ranks.json through loadRankTheme(), the same file the
 * client ranks players with, so a renamed or recoloured tier follows on the next
 * provision rather than living in two places.
 */

import { loadRankTheme } from "../src/core/ranks/apogeeRanks.ts";
import { LEVEL_ROLES } from "./rules.ts";

export const ACCENT = 0xb8a5ff;

export interface RoleSpec {
  name: string;
  color?: string;
  hoist?: boolean;
  mentionable?: boolean;
  /** Names of Discord permission flags (PermissionFlagsBits keys). */
  permissions?: string[];
  group: "staff" | "shop" | "rank" | "level" | "verified" | "ping" | "fan";
}

export type Access =
  /** Everyone reads and talks. */
  | "open"
  /** Everyone reads; only staff and the bot post. Buttons and slash commands still work. */
  | "readonly"
  /** Everyone reads; nobody types, but slash commands are allowed. */
  | "commands"
  /** Staff only. */
  | "staff";

export interface ChannelSpec {
  key: string;
  name: string;
  kind: "text" | "voice";
  topic?: string;
  access: Access;
  slowmode?: number;
}

export interface CategorySpec {
  name: string;
  access?: Access;
  channels: ChannelSpec[];
}

export const STAFF_ROLES = ["Admin", "Mod"];
export const VERIFIED_ROLE = "Verified";

/** Shop colours. Bought with stardust; the display colour wins over rank because it was chosen. */
export const SHOP_COLORS: { item: string; name: string; color: string; price: number }[] = [
  { item: "color:nebula", name: "Nebula Pink", color: "#ff7ad9", price: 600 },
  { item: "color:comet", name: "Comet Blue", color: "#5cc8ff", price: 600 },
  { item: "color:solar", name: "Solar Gold", color: "#ffc94d", price: 600 },
  { item: "color:aurora", name: "Aurora Green", color: "#5dffa8", price: 600 },
  { item: "color:void", name: "Void Violet", color: "#9b6bff", price: 900 },
  { item: "color:redshift", name: "Redshift", color: "#ff5a4f", price: 900 },
];

export const FAN_ROLES = ["Clicking", "Tracking", "Switching"];
export const REGION_ROLES = ["NA", "EU", "Asia", "OCE", "SA"];
export const PING_ROLES = [
  { name: "Match Feed Ping", note: "your rank-ups and streaks" },
  { name: "Events Ping", note: "Stardust Storms and community events" },
  { name: "Patch Ping", note: "new Apogee builds" },
];

export function rankRoles(): RoleSpec[] {
  // Highest tier first, so it sits highest in the role list and its colour wins.
  return [...loadRankTheme().tiers].reverse().map((t) => ({
    name: t.name,
    color: t.color,
    hoist: true,
    group: "rank" as const,
  }));
}

/** Top-down order: the position a role is placed at is its index in this list. */
export function roles(): RoleSpec[] {
  return [
    {
      name: "Admin",
      color: "#ffffff",
      hoist: true,
      permissions: ["Administrator"],
      group: "staff",
    },
    {
      name: "Mod",
      color: "#b8a5ff",
      hoist: true,
      permissions: ["ModerateMembers", "ManageMessages", "KickMembers", "MuteMembers", "MoveMembers", "ManageThreads"],
      group: "staff",
    },
    ...SHOP_COLORS.map((c) => ({ name: c.name, color: c.color, group: "shop" as const })),
    ...rankRoles(),
    ...[...LEVEL_ROLES].reverse().map((l) => ({ name: l.name, color: l.color, group: "level" as const })),
    { name: VERIFIED_ROLE, color: "#c2d99d", group: "verified" },
    ...FAN_ROLES.map((name) => ({ name, group: "fan" as const })),
    ...REGION_ROLES.map((name) => ({ name, group: "fan" as const })),
    ...PING_ROLES.map((p) => ({ name: p.name, mentionable: true, group: "ping" as const })),
  ];
}

export const CATEGORIES: CategorySpec[] = [
  {
    name: "START HERE",
    channels: [
      { key: "welcome", name: "welcome", kind: "text", access: "readonly", topic: "What Apogee is and how this place works." },
      { key: "rules", name: "rules", kind: "text", access: "readonly", topic: "Short, and enforced." },
      {
        key: "link",
        name: "link-your-account",
        kind: "text",
        access: "commands",
        topic: "/link start with your Steam profile, then /link confirm. Unlocks rank roles and the match feed.",
      },
      { key: "roles", name: "pick-roles", kind: "text", access: "readonly", topic: "Click to pick your aim type, region and pings." },
    ],
  },
  {
    name: "APOGEE",
    channels: [
      { key: "announcements", name: "announcements", kind: "text", access: "readonly", topic: "Seasons, builds, events." },
      { key: "patch", name: "patch-notes", kind: "text", access: "readonly", topic: "What changed in each build." },
      { key: "feed", name: "match-feed", kind: "text", access: "readonly", topic: "Every settled ranked match by a linked player, live." },
      { key: "promotions", name: "promotions", kind: "text", access: "readonly", topic: "Rank-ups. Go say congrats in #general." },
      { key: "leaderboard", name: "leaderboard", kind: "text", access: "readonly", topic: "Linked players by rating. Refreshed hourly." },
      { key: "feedback", name: "feedback", kind: "text", access: "open", topic: "Ideas, gripes, what felt off in a match.", slowmode: 30 },
      { key: "bugs", name: "bug-reports", kind: "text", access: "open", topic: "What happened, what you expected, your build stamp from the status bar.", slowmode: 30 },
    ],
  },
  {
    name: "ARENA",
    channels: [
      { key: "general", name: "general", kind: "text", access: "open", topic: "Talk aim." },
      { key: "sotd", name: "scenario-of-the-day", kind: "text", access: "readonly", topic: "One scenario a day. Verified runs only. Top 3 earn stardust." },
      { key: "bounties", name: "bounties", kind: "text", access: "readonly", topic: "Three goals a week. /bounties to check and claim." },
      { key: "callouts", name: "callouts", kind: "text", access: "open", topic: "/callout someone. Settle it in a ranked duel." },
      { key: "predictions", name: "predictions", kind: "text", access: "readonly", topic: "Back or fade a linked player's live match with stardust." },
      { key: "clips", name: "clips", kind: "text", access: "open", topic: "Your best moments. 5 ⭐ puts it in #hall-of-fame." },
      { key: "hof", name: "hall-of-fame", kind: "text", access: "readonly", topic: "Clips the server starred." },
      { key: "setups", name: "setups", kind: "text", access: "open", topic: "Sens, cm/360, mouse, pad, FOV." },
      { key: "games", name: "bot-games", kind: "text", access: "open", topic: "/reflex /flick /trivia /daily /shop /profile" },
      { key: "offtopic", name: "off-topic", kind: "text", access: "open", topic: "Anything else." },
    ],
  },
  {
    name: "VOICE",
    channels: [
      { key: "v-lobby", name: "Lobby", kind: "voice", access: "open" },
      { key: "v-duel1", name: "Duel Room 1", kind: "voice", access: "open" },
      { key: "v-duel2", name: "Duel Room 2", kind: "voice", access: "open" },
      { key: "v-duel3", name: "Duel Room 3", kind: "voice", access: "open" },
      { key: "v-scrim", name: "Scrim Chat", kind: "voice", access: "open" },
    ],
  },
  {
    name: "STAFF",
    access: "staff",
    channels: [
      { key: "modlog", name: "mod-log", kind: "text", access: "staff", topic: "Warns, timeouts, deleted invites." },
      { key: "botadmin", name: "bot-admin", kind: "text", access: "staff", topic: "Bot status and admin commands." },
    ],
  },
];

export type ChannelKey = (typeof CATEGORIES)[number]["channels"][number]["key"];

export function channelSpec(key: string): ChannelSpec {
  for (const c of CATEGORIES) for (const ch of c.channels) if (ch.key === key) return ch;
  throw new Error(`no channel with key ${key}`);
}
