/**
 * Chat XP, stardust, /daily, /shop, /profile, /top, /give, /event, the role picker and
 * the invite guard. The Discord-only half of the server: none of it reads Apogee except
 * /profile, which shows the rank alongside.
 */

import { type GuildMember, SlashCommandBuilder } from "discord.js";

import { PING_ROLES, SHOP_COLORS, FAN_ROLES, REGION_ROLES } from "../blueprint.ts";
import { addXp, card, type Ctx, type Feature, fmt, hex, isStaff, memberOf, STARDUST } from "../core.ts";
import { findRole, mention, textChannel } from "../guild.ts";
import {
  CHAT_COOLDOWN_S,
  chatStardust,
  chatXp,
  claimDaily,
  dayNumber,
  levelForXp,
  levelProgress,
  levelRoleFor,
  stormMultiplier,
  weekNumber,
} from "../rules.ts";

const INVITE = /(discord\.gg|discord(app)?\.com\/invite)\/[A-Za-z0-9-]+/i;

const TITLE_PRICE = 300;
const SHIELD_PRICE = 400;
const MAX_SHIELDS = 3;

const PICKABLE = new Set([...FAN_ROLES, ...REGION_ROLES, ...PING_ROLES.map((p) => p.name)]);

function doubleXpUntil(ctx: Ctx): number {
  return Number(ctx.store.get("doublexp_until") ?? 0);
}

function bar(into: number, needed: number, width = 14): string {
  const filled = Math.round((into / needed) * width);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

function shopItems(): { id: string; label: string; price: number }[] {
  return [
    ...SHOP_COLORS.map((c) => ({ id: c.item, label: `${c.name} name colour`, price: c.price })),
    { id: "title", label: "Custom profile title", price: TITLE_PRICE },
    { id: "shield", label: `Streak Shield (forgives one missed /daily, hold up to ${MAX_SHIELDS})`, price: SHIELD_PRICE },
  ];
}

async function equipColor(ctx: Ctx, member: GuildMember, roleName: string | null): Promise<void> {
  for (const c of SHOP_COLORS) {
    const role = findRole(ctx.guild, c.name);
    if (!role) continue;
    const has = member.roles.cache.has(role.id);
    if (c.name === roleName && !has) await member.roles.add(role);
    if (c.name !== roleName && has) await member.roles.remove(role);
  }
  ctx.store.patchUser(member.id, { color_role: roleName });
}

export const community: Feature = {
  name: "community",

  commands: [
    new SlashCommandBuilder().setName("daily").setDescription("Claim today's stardust. Come back tomorrow to build a streak."),
    new SlashCommandBuilder()
      .setName("profile")
      .setDescription("Level, stardust, streaks and Apogee rank.")
      .addUserOption((o) => o.setName("user").setDescription("Someone else's profile")),
    new SlashCommandBuilder()
      .setName("top")
      .setDescription("Server leaderboards.")
      .addStringOption((o) =>
        o
          .setName("board")
          .setDescription("Which board")
          .setRequired(true)
          .addChoices(
            { name: "Stardust", value: "stardust" },
            { name: "Level", value: "xp" },
            { name: "Reflex", value: "reflex_best" },
            { name: "Flick", value: "flick_best" },
            { name: "Best win streak", value: "best_win_streak" },
          ),
      ),
    new SlashCommandBuilder()
      .setName("give")
      .setDescription("Send someone stardust.")
      .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
      .addIntegerOption((o) => o.setName("amount").setDescription("How much").setRequired(true).setMinValue(1).setMaxValue(100000)),
    new SlashCommandBuilder()
      .setName("shop")
      .setDescription("Spend stardust.")
      .addSubcommand((s) => s.setName("view").setDescription("What's for sale"))
      .addSubcommand((s) =>
        s
          .setName("buy")
          .setDescription("Buy something")
          .addStringOption((o) =>
            o
              .setName("item")
              .setDescription("What")
              .setRequired(true)
              .addChoices(...shopItems().map((i) => ({ name: `${i.label.split(" (")[0]} · ${i.price}`, value: i.id }))),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("equip")
          .setDescription("Wear a name colour you own")
          .addStringOption((o) =>
            o
              .setName("color")
              .setDescription("Which")
              .setRequired(true)
              .addChoices({ name: "None", value: "none" }, ...SHOP_COLORS.map((c) => ({ name: c.name, value: c.item }))),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("title")
          .setDescription("Set your profile title (buy it first)")
          .addStringOption((o) => o.setName("text").setDescription("Up to 32 characters").setRequired(true).setMaxLength(32)),
      ),
    new SlashCommandBuilder()
      .setName("event")
      .setDescription("Start a community event (staff).")
      .setDefaultMemberPermissions(0x10000000000n /* ModerateMembers */)
      .addSubcommand((s) =>
        s
          .setName("double-xp")
          .setDescription("Double chat XP for a while")
          .addIntegerOption((o) => o.setName("hours").setDescription("How long").setRequired(true).setMinValue(1).setMaxValue(72)),
      ),
  ],

  onCommand: {
    async daily(ctx, i) {
      const u = ctx.store.user(i.user.id);
      const now = new Date();
      const today = dayNumber(now);
      const out = claimDaily({ lastDay: u.daily_day, streak: u.daily_streak, shields: u.shields }, today);
      if (!out.ok) {
        const next = (today + 1) * 86_400_000;
        await i.reply({ content: `Already claimed. Next one <t:${Math.floor(next / 1000)}:R>.`, ephemeral: true });
        return;
      }
      const storm = stormMultiplier(now);
      const reward = Math.round(out.reward * storm);
      const week = weekNumber(now);
      ctx.store.patchUser(i.user.id, {
        daily_day: today,
        daily_streak: out.streak,
        shields: out.shields,
        stardust: u.stardust + reward,
        daily_week: week,
        daily_count_week: u.daily_week === week ? u.daily_count_week + 1 : 1,
      });
      const lines = [`+${reward} ${STARDUST}${storm > 1 ? " (Stardust Storm ×1.5)" : ""}`, `Streak: **${out.streak}** day${out.streak === 1 ? "" : "s"} 🔥`];
      if (out.shieldUsed) lines.push("🛡️ A Streak Shield covered your missed day.");
      if (out.broke) lines.push("Your old streak ended. A Streak Shield in `/shop` saves it next time.");
      if (out.streak < 7) lines.push(`Day 7 pays ${100 + 15 * 6} ${STARDUST}.`);
      await i.reply({ embeds: [card("Daily claimed").setDescription(lines.join("\n"))] });
    },

    async profile(ctx, i) {
      const target = i.options.getUser("user") ?? i.user;
      const u = ctx.store.user(target.id);
      const level = levelForXp(u.xp);
      const [into, needed] = levelProgress(u.xp);
      const e = card(`${target.displayName}${u.title ? ` · ${u.title}` : ""}`)
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: "Level", value: `**${level}** ${levelRoleFor(level) ?? ""}\n${bar(into, needed)} ${fmt(into)}/${fmt(needed)}`, inline: false },
          { name: "Stardust", value: `${fmt(u.stardust)} ${STARDUST}`, inline: true },
          { name: "Daily streak", value: `${u.daily_streak} 🔥${u.shields ? ` · ${u.shields} 🛡️` : ""}`, inline: true },
          { name: "Win streak", value: `${u.win_streak} (best ${u.best_win_streak})`, inline: true },
          { name: "Reflex PB", value: u.reflex_best ? `${u.reflex_best} ms` : "-", inline: true },
          { name: "Flick PB", value: u.flick_best ? `${fmt(u.flick_best)} ms` : "-", inline: true },
        );
      const link = ctx.store.link(target.id);
      if (!link) {
        e.addFields({ name: "Apogee", value: `Not linked. ${mention(ctx.guild, "link")}` });
      } else if (ctx.apogee) {
        const r = (await ctx.apogee.ratings([link.player_id])).get(link.player_id);
        const tier = ctx.apogee.rankedTier(r);
        e.addFields({
          name: `Apogee · ${link.display_name}`,
          value: !r
            ? "No ranked matches yet."
            : tier
              ? `**${tier.name}** · ${fmt(r.rating)} rating · ${r.matches_played} matches`
              : `In placements: ${r.matches_played}/10 · ${fmt(r.rating)} provisional`,
        });
        if (tier) e.setColor(hex(tier.color));
      }
      await i.reply({ embeds: [e] });
    },

    async top(ctx, i) {
      const board = i.options.getString("board", true) as "stardust" | "xp" | "reflex_best" | "flick_best" | "best_win_streak";
      const asc = board === "reflex_best" || board === "flick_best";
      const rows = asc ? ctx.store.topAsc(board) : ctx.store.top(board);
      const label = { stardust: "Stardust", xp: "Level", reflex_best: "Reflex", flick_best: "Flick", best_win_streak: "Best win streak" }[board];
      const medal = (n: number) => ["🥇", "🥈", "🥉"][n] ?? `\`${n + 1}.\``;
      const value = (r: (typeof rows)[number]) =>
        board === "xp"
          ? `level ${levelForXp(r.xp)}`
          : board === "stardust"
            ? `${fmt(r.stardust)} ${STARDUST}`
            : board === "best_win_streak"
              ? `${r.best_win_streak} wins`
              : `${fmt((r as never)[board])} ms`;
      await i.reply({
        embeds: [
          card(`Top · ${label}`).setDescription(
            rows.length ? rows.map((r, n) => `${medal(n)} <@${r.discord_id}> · ${value(r)}`).join("\n") : "Nobody yet. Be first.",
          ),
        ],
        allowedMentions: { users: [] },
      });
    },

    async give(ctx, i) {
      const to = i.options.getUser("user", true);
      const amount = i.options.getInteger("amount", true);
      if (to.bot || to.id === i.user.id) {
        await i.reply({ content: "Pick another person.", ephemeral: true });
        return;
      }
      const ok = ctx.store.tx(() => {
        if (!ctx.store.addStardust(i.user.id, -amount)) return false;
        ctx.store.addStardust(to.id, amount);
        return true;
      });
      await i.reply(
        ok
          ? { content: `<@${i.user.id}> sent <@${to.id}> **${fmt(amount)} ${STARDUST}**.` }
          : { content: `You don't have ${fmt(amount)} ${STARDUST}.`, ephemeral: true },
      );
    },

    async shop(ctx, i) {
      const sub = i.options.getSubcommand();
      const member = await memberOf(ctx, i.user.id);
      if (!member) return;
      const u = ctx.store.user(i.user.id);

      if (sub === "view") {
        const owned = new Set(ctx.store.owned(i.user.id));
        await i.reply({
          embeds: [
            card("Shop")
              .setDescription(
                shopItems()
                  .map((it) => `${owned.has(it.id) ? "✅" : "▫️"} **${it.label}** · ${fmt(it.price)} ${STARDUST}`)
                  .join("\n") + `\n\nYou have **${fmt(u.stardust)} ${STARDUST}**. \`/shop buy\` to buy, \`/shop equip\` to wear a colour.`,
              ),
          ],
          ephemeral: true,
        });
        return;
      }

      if (sub === "buy") {
        const id = i.options.getString("item", true);
        const item = shopItems().find((x) => x.id === id);
        if (!item) return;
        if (id !== "shield" && ctx.store.owns(i.user.id, id)) {
          await i.reply({ content: "You already own that.", ephemeral: true });
          return;
        }
        if (id === "shield" && u.shields >= MAX_SHIELDS) {
          await i.reply({ content: `You're holding the most shields you can (${MAX_SHIELDS}).`, ephemeral: true });
          return;
        }
        const ok = ctx.store.tx(() => {
          if (!ctx.store.addStardust(i.user.id, -item.price)) return false;
          if (id === "shield") ctx.store.patchUser(i.user.id, { shields: u.shields + 1 });
          else ctx.store.grant(i.user.id, id);
          return true;
        });
        if (!ok) {
          await i.reply({ content: `That's ${fmt(item.price)} ${STARDUST}; you have ${fmt(u.stardust)}.`, ephemeral: true });
          return;
        }
        const color = SHOP_COLORS.find((c) => c.item === id);
        if (color) await equipColor(ctx, member, color.name);
        await i.reply({
          content:
            `Bought **${item.label.split(" (")[0]}**.` +
            (color ? " Equipped." : id === "title" ? " Set it with `/shop title`." : ""),
          ephemeral: true,
        });
        return;
      }

      if (sub === "equip") {
        const id = i.options.getString("color", true);
        if (id === "none") {
          await equipColor(ctx, member, null);
          await i.reply({ content: "Colour removed.", ephemeral: true });
          return;
        }
        const color = SHOP_COLORS.find((c) => c.item === id);
        if (!color || !ctx.store.owns(i.user.id, id)) {
          await i.reply({ content: "You don't own that one yet. `/shop buy` it first.", ephemeral: true });
          return;
        }
        await equipColor(ctx, member, color.name);
        await i.reply({ content: `Wearing **${color.name}**.`, ephemeral: true });
        return;
      }

      if (sub === "title") {
        if (!ctx.store.owns(i.user.id, "title")) {
          await i.reply({ content: `A custom title is ${TITLE_PRICE} ${STARDUST} in \`/shop buy\`.`, ephemeral: true });
          return;
        }
        const text = i.options
          .getString("text", true)
          .replace(/<[@#&!][^>]*>|https?:\/\/\S+|@everyone|@here/g, "")
          .trim()
          .slice(0, 32);
        ctx.store.patchUser(i.user.id, { title: text || null });
        await i.reply({ content: text ? `Title set: **${text}**` : "Title cleared.", ephemeral: true });
      }
    },

    async event(ctx, i) {
      if (!isStaff(await memberOf(ctx, i.user.id))) {
        await i.reply({ content: "Staff only.", ephemeral: true });
        return;
      }
      const hours = i.options.getInteger("hours", true);
      const until = Date.now() + hours * 3_600_000;
      ctx.store.set("doublexp_until", String(until));
      const ping = findRole(ctx.guild, "Events Ping");
      await textChannel(ctx.guild, "announcements")?.send({
        content: `${ping ? `<@&${ping.id}> ` : ""}⚡ **Double XP** is on until <t:${Math.floor(until / 1000)}:t> (<t:${Math.floor(until / 1000)}:R>). Go talk aim.`,
        allowedMentions: { roles: ping ? [ping.id] : [] },
      });
      await i.reply({ content: `Double XP for ${hours}h.`, ephemeral: true });
    },
  },

  onButton: {
    async role(ctx, i, args) {
      const name = args.join(":");
      if (!PICKABLE.has(name)) return;
      const role = findRole(ctx.guild, name);
      const member = await memberOf(ctx, i.user.id);
      if (!role || !member) {
        await i.reply({ content: "That role is missing; a mod needs to rerun provisioning.", ephemeral: true });
        return;
      }
      // Regions are one-of: picking EU takes NA off.
      if (REGION_ROLES.includes(name)) {
        for (const r of REGION_ROLES) {
          const other = findRole(ctx.guild, r);
          if (other && r !== name && member.roles.cache.has(other.id)) await member.roles.remove(other);
        }
      }
      const has = member.roles.cache.has(role.id);
      if (has) await member.roles.remove(role);
      else await member.roles.add(role);
      await i.reply({ content: has ? `Removed **${name}**.` : `Added **${name}**.`, ephemeral: true });
    },
  },

  async onMessage(ctx, m) {
    if (!m.member) return;

    if (INVITE.test(m.content) && !isStaff(m.member)) {
      await m.delete().catch(() => undefined);
      await textChannel(ctx.guild, "modlog")
        ?.send({ content: `Removed an invite link from <@${m.author.id}> in <#${m.channelId}>.`, allowedMentions: { users: [] } })
        .catch(() => undefined);
      const note = await (m.channel.isSendable() ? m.channel.send({ content: `<@${m.author.id}> invite links aren't allowed here.` }).catch(() => null) : null);
      setTimeout(() => note?.delete().catch(() => undefined), 8000);
      return;
    }

    const u = ctx.store.user(m.author.id);
    const now = Date.now();
    if (now - u.last_chat_at < CHAT_COOLDOWN_S * 1000) return;
    ctx.store.patchUser(m.author.id, { last_chat_at: now });
    const xp = chatXp(Math.random) * (now < doubleXpUntil(ctx) ? 2 : 1);
    ctx.store.addStardust(m.author.id, Math.round(chatStardust(Math.random) * stormMultiplier(new Date(now))));
    await addXp(ctx, m.member, xp);
  },
};

export async function welcomeMember(ctx: Ctx, member: GuildMember): Promise<void> {
  await textChannel(ctx.guild, "general")
    ?.send({
      content: `Welcome <@${member.id}> 👋 Link your Apogee account in ${mention(ctx.guild, "link")} to get your rank role, and grab roles in ${mention(ctx.guild, "roles")}. Try \`/daily\` for your first stardust.`,
      allowedMentions: { users: [member.id] },
    })
    .catch(() => undefined);
}
