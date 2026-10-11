/**
 * Build the server from blueprint.ts.
 *
 *   npm run bot:provision              apply
 *   npm run bot:provision -- --dry-run say what would change, change nothing
 *
 * Idempotent: everything is matched by name, created when missing and corrected when it
 * drifted. Nothing is ever deleted, so a channel or role added by hand survives. A second
 * run straight after the first should report no changes, which is the check that it
 * converged rather than fighting itself.
 */

import {
  ChannelType,
  Client,
  type Guild,
  GatewayIntentBits,
  type GuildChannel,
  type OverwriteResolvable,
  PermissionFlagsBits,
  type PermissionResolvable,
  PermissionsBitField,
  type TextChannel,
} from "discord.js";

import { loadRankTheme } from "../src/core/ranks/apogeeRanks.ts";
import { type Access, CATEGORIES, roles, STAFF_ROLES } from "./blueprint.ts";
import { discordEnv } from "./env.ts";
import { findCategory, findChannel, findRole, mention } from "./guild.ts";
import { marker, panels } from "./panels.ts";

type Log = (line: string) => void;

const flag = (names: string[] | undefined): bigint =>
  (names ?? []).reduce((acc, n) => {
    const bit = (PermissionFlagsBits as Record<string, bigint>)[n];
    if (bit === undefined) throw new Error(`unknown permission ${n}`);
    return acc | bit;
  }, 0n);

const POSTING = [
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
];

function overwrites(guild: Guild, access: Access | undefined): OverwriteResolvable[] {
  const everyone = guild.roles.everyone.id;
  const staff = STAFF_ROLES.map((n) => findRole(guild, n)).filter((r) => r !== undefined);
  switch (access) {
    case undefined:
    case "open":
      return [];
    case "readonly":
      return [
        { id: everyone, deny: POSTING },
        ...staff.map((r) => ({ id: r.id, allow: [PermissionFlagsBits.SendMessages] })),
      ];
    case "commands":
      return [
        { id: everyone, deny: POSTING, allow: [PermissionFlagsBits.UseApplicationCommands] },
        ...staff.map((r) => ({ id: r.id, allow: [PermissionFlagsBits.SendMessages] })),
      ];
    case "staff":
      return [
        { id: everyone, deny: [PermissionFlagsBits.ViewChannel] },
        ...staff.map((r) => ({ id: r.id, allow: [PermissionFlagsBits.ViewChannel] })),
      ];
  }
}

/** Overwrites as a comparable string, so drift is detected without a write. */
function signature(list: { id: string; allow: bigint; deny: bigint }[]): string {
  return list
    .filter((o) => o.allow !== 0n || o.deny !== 0n)
    .map((o) => `${o.id}:${o.allow}:${o.deny}`)
    .sort()
    .join("|");
}

function wantedSignature(want: OverwriteResolvable[]): string {
  return signature(
    want.map((o) => {
      const w = o as { id: string; allow?: PermissionResolvable; deny?: PermissionResolvable };
      return {
        id: w.id,
        allow: new PermissionsBitField(w.allow ?? 0n).bitfield,
        deny: new PermissionsBitField(w.deny ?? 0n).bitfield,
      };
    }),
  );
}

function currentSignature(ch: GuildChannel): string {
  return signature(
    [...ch.permissionOverwrites.cache.values()].map((o) => ({
      id: o.id,
      allow: o.allow.bitfield,
      deny: o.deny.bitfield,
    })),
  );
}

/**
 * A same-named channel outside every blueprint category: Discord's starter #general sits
 * in "Text Channels". Without this, creating ARENA first makes the category-scoped lookup
 * miss it and a second #general appears beside the one people already know.
 */
function stray(guild: Guild, name: string, kind: "text" | "voice"): GuildChannel | undefined {
  const ours = new Set(CATEGORIES.map((c) => findCategory(guild, c.name)?.id).filter((id) => id !== undefined));
  const type = kind === "voice" ? ChannelType.GuildVoice : ChannelType.GuildText;
  return guild.channels.cache.find(
    (c) => c.type === type && c.name === name && !(c.parentId && ours.has(c.parentId)),
  ) as GuildChannel | undefined;
}

export async function provision(guild: Guild, opts: { dryRun: boolean; log: Log }): Promise<number> {
  const { dryRun, log } = opts;
  let changes = 0;
  const change = (line: string) => {
    changes++;
    log(`${dryRun ? "would " : ""}${line}`);
  };

  await guild.roles.fetch();
  await guild.channels.fetch();

  // -- roles ---------------------------------------------------------------
  const spec = roles();
  for (const r of spec) {
    const color = r.color ? parseInt(r.color.slice(1), 16) : 0;
    const permissions = flag(r.permissions);
    const existing = findRole(guild, r.name);
    if (!existing) {
      change(`create role ${r.name}`);
      if (!dryRun) {
        await guild.roles.create({
          name: r.name,
          colors: { primaryColor: color },
          hoist: !!r.hoist,
          mentionable: !!r.mentionable,
          permissions,
        });
      }
      continue;
    }
    const drift: string[] = [];
    if (existing.colors.primaryColor !== color) drift.push("color");
    if (existing.hoist !== !!r.hoist) drift.push("hoist");
    if (existing.mentionable !== !!r.mentionable) drift.push("mentionable");
    if (existing.permissions.bitfield !== permissions) drift.push("permissions");
    if (drift.length) {
      change(`update role ${r.name} (${drift.join(", ")})`);
      if (!dryRun && existing.editable) {
        await existing.edit({
          colors: { primaryColor: color },
          hoist: !!r.hoist,
          mentionable: !!r.mentionable,
          permissions,
        });
      }
    }
  }

  // Stack the blueprint's roles directly under the bot's own role, in blueprint order.
  // Discord refuses to let a bot move anything above itself, so the bot's role has to be
  // dragged to the top by hand once; provision says so instead of failing.
  if (!dryRun) await guild.roles.fetch();
  const me = guild.members.me;
  if (me) {
    const ceiling = me.roles.highest.position;
    const ours = spec.map((r) => findRole(guild, r.name)).filter((r) => r !== undefined);
    const misplaced = ours.some((r) => r.position >= ceiling);
    if (misplaced) {
      log(
        `! the bot's role "${me.roles.highest.name}" sits below some Apogee roles. In Server Settings → Roles, drag it to the top, then rerun.`,
      );
    } else {
      const sorted = [...ours].sort((a, b) => b.position - a.position).map((r) => r.name);
      const want = ours.map((r) => r.name);
      if (sorted.join("|") !== want.join("|")) {
        change("reorder roles");
        if (!dryRun) {
          await guild.roles.setPositions(ours.map((r, i) => ({ role: r.id, position: ceiling - 1 - i })));
        }
      }
    }
  }

  // -- categories and channels ---------------------------------------------
  for (const [ci, cat] of CATEGORIES.entries()) {
    let parent = findCategory(guild, cat.name);
    if (!parent) {
      change(`create category ${cat.name}`);
      if (!dryRun) {
        parent = await guild.channels.create({
          name: cat.name,
          type: ChannelType.GuildCategory,
          permissionOverwrites: overwrites(guild, cat.access),
        });
      }
    } else if (currentSignature(parent as GuildChannel) !== wantedSignature(overwrites(guild, cat.access))) {
      change(`fix permissions on category ${cat.name}`);
      if (!dryRun) await (parent as GuildChannel).permissionOverwrites.set(overwrites(guild, cat.access));
    }
    if (parent && !dryRun && "position" in parent && parent.position !== ci) {
      await (parent as GuildChannel).setPosition(ci);
    }

    for (const [i, ch] of cat.channels.entries()) {
      const want = overwrites(guild, ch.access);
      const existing = findChannel(guild, ch.key) ?? stray(guild, ch.name, ch.kind);
      if (!existing) {
        change(`create #${ch.name} in ${cat.name}`);
        if (!dryRun) {
          await guild.channels.create({
            name: ch.name,
            type: ch.kind === "voice" ? ChannelType.GuildVoice : ChannelType.GuildText,
            parent: parent?.id,
            topic: ch.kind === "text" ? ch.topic : undefined,
            rateLimitPerUser: ch.slowmode,
            permissionOverwrites: want,
            position: i,
          });
        }
        continue;
      }
      if (parent && existing.parentId !== parent.id) {
        change(`move #${ch.name} into ${cat.name}`);
        if (!dryRun) await existing.setParent(parent.id, { lockPermissions: false });
      }
      if (ch.kind === "text") {
        const t = existing as TextChannel;
        if ((t.topic ?? "") !== (ch.topic ?? "")) {
          change(`set topic of #${ch.name}`);
          if (!dryRun) await t.setTopic(ch.topic ?? null);
        }
        if ((t.rateLimitPerUser ?? 0) !== (ch.slowmode ?? 0)) {
          change(`set slowmode of #${ch.name}`);
          if (!dryRun) await t.setRateLimitPerUser(ch.slowmode ?? 0);
        }
      }
      if (currentSignature(existing) !== wantedSignature(want)) {
        change(`fix permissions on #${ch.name}`);
        if (!dryRun) await existing.permissionOverwrites.set(want);
      }
    }
  }

  // -- panels --------------------------------------------------------------
  if (!dryRun) await guild.channels.fetch();
  const rankNames = loadRankTheme().tiers.map((t) => t.name);
  for (const p of panels(rankNames, (k) => mention(guild, k))) {
    const ch = findChannel(guild, p.channel) as TextChannel | undefined;
    if (!ch) {
      if (!dryRun) log(`! #${p.channel} missing, panel ${p.key} skipped`);
      else change(`post panel ${p.key}`);
      continue;
    }
    const recent = await ch.messages.fetch({ limit: 50 });
    const mine = recent.find(
      (m) => m.author.id === guild.client.user.id && m.embeds.some((e) => e.footer?.text === marker(p.key)),
    );
    const body = { embeds: p.embeds, components: p.components };
    if (!mine) {
      change(`post panel ${p.key}`);
      if (!dryRun) {
        const msg = await ch.send(body);
        await msg.pin().catch(() => undefined);
      }
    } else {
      const now = JSON.stringify(mine.embeds.map((e) => e.description) .concat(mine.embeds.flatMap((e) => e.fields.map((f) => f.value))));
      const next = JSON.stringify(
        p.embeds.map((e) => e.data.description).concat(p.embeds.flatMap((e) => (e.data.fields ?? []).map((f) => f.value))),
      );
      if (now !== next || mine.components.length !== p.components.length) {
        change(`update panel ${p.key}`);
        if (!dryRun) await mine.edit(body);
      }
    }
  }

  return changes;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const env = discordEnv();
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const ready = new Promise<void>((res) => client.once("clientReady", () => res()));
  await client.login(env.token);
  await ready;
  try {
    const guild = await client.guilds.fetch(env.guildId);
    console.log(`${dryRun ? "Dry run against" : "Provisioning"} ${guild.name}`);
    const n = await provision(guild, { dryRun, log: (l) => console.log("  " + l) });
    console.log(n === 0 ? "No changes: the server matches the blueprint." : `${n} change(s)${dryRun ? " pending" : " applied"}.`);
  } finally {
    await client.destroy();
  }
}

if (process.argv[1] && /provision\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
