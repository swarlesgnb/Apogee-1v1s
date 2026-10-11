/**
 * Finding the blueprint's channels and roles in the live guild.
 *
 * By name, scoped to the category for channels, because that is what provision.ts keys on
 * and what an admin sees. Ids are never stored: a channel recreated by hand under the same
 * name is picked up without anyone editing a config.
 */

import {
  ChannelType,
  type Guild,
  type Role,
  type TextChannel,
  type VoiceChannel,
} from "discord.js";

import { CATEGORIES, channelSpec } from "./blueprint.ts";

function categoryOf(key: string): string {
  for (const c of CATEGORIES) if (c.channels.some((ch) => ch.key === key)) return c.name;
  throw new Error(`no category holds ${key}`);
}

export function findCategory(guild: Guild, name: string) {
  return guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === name);
}

export function findChannel(guild: Guild, key: string): TextChannel | VoiceChannel | undefined {
  const spec = channelSpec(key);
  const parent = findCategory(guild, categoryOf(key));
  const type = spec.kind === "voice" ? ChannelType.GuildVoice : ChannelType.GuildText;
  return guild.channels.cache.find(
    (c) => c.type === type && c.name === spec.name && (!parent || c.parentId === parent.id),
  ) as TextChannel | VoiceChannel | undefined;
}

export function textChannel(guild: Guild, key: string): TextChannel | undefined {
  const c = findChannel(guild, key);
  return c && c.type === ChannelType.GuildText ? (c as TextChannel) : undefined;
}

export function findRole(guild: Guild, name: string): Role | undefined {
  return guild.roles.cache.find((r) => r.name === name);
}

export function mention(guild: Guild, key: string): string {
  const c = findChannel(guild, key);
  return c ? `<#${c.id}>` : `#${channelSpec(key).name}`;
}
