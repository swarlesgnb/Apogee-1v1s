/**
 * /link, and keeping each linked member's rank role equal to their Apogee tier.
 *
 * Ownership is proved through Steam rather than the Apogee client, so linking needed no
 * migration and no client release: the player puts a one-time code in their own Steam
 * profile name, which only the account holder can change, and the bot reads it back
 * through the Web API. The code expires after 30 minutes so an old one sitting in a
 * profile can't be claimed later by someone else who learns it.
 */

import { type GuildMember, SlashCommandBuilder } from "discord.js";

import { VERIFIED_ROLE } from "../blueprint.ts";
import { card, type Ctx, type Feature, fmt, hex, memberOf, NO_APOGEE, requireApogee } from "../core.ts";
import { findRole, textChannel } from "../guild.ts";
import { linkCode, parseSteamInput } from "../rules.ts";

const CODE_TTL_MS = 30 * 60_000;

async function setRankRole(ctx: Ctx, member: GuildMember, tierName: string | null): Promise<void> {
  if (!ctx.apogee) return;
  for (const t of ctx.apogee.tiers) {
    const role = findRole(ctx.guild, t.name);
    if (!role) continue;
    const has = member.roles.cache.has(role.id);
    if (t.name === tierName && !has) await member.roles.add(role).catch(() => undefined);
    if (t.name !== tierName && has) await member.roles.remove(role).catch(() => undefined);
  }
}

async function setVerified(ctx: Ctx, member: GuildMember, on: boolean): Promise<void> {
  const role = findRole(ctx.guild, VERIFIED_ROLE);
  if (!role) return;
  if (on && !member.roles.cache.has(role.id)) await member.roles.add(role).catch(() => undefined);
  if (!on && member.roles.cache.has(role.id)) await member.roles.remove(role).catch(() => undefined);
}

/** Bring every linked member's rank role in line, and celebrate anyone who went up. */
export async function syncRanks(ctx: Ctx): Promise<void> {
  if (!requireApogee(ctx)) return;
  const links = ctx.store.links();
  if (links.length === 0) return;
  const ratings = await ctx.apogee.ratings(links.map((l) => l.player_id));
  const order = new Map(ctx.apogee.tiers.map((t, i) => [t.id, i]));
  for (const l of links) {
    const member = await memberOf(ctx, l.discord_id);
    if (!member) continue;
    const r = ratings.get(l.player_id);
    const tier = ctx.apogee.rankedTier(r);
    await setVerified(ctx, member, true);
    await setRankRole(ctx, member, tier?.name ?? null);

    const prev = ctx.store.db.prepare("select tier_id from rank_state where discord_id = ?").get(l.discord_id) as
      | { tier_id: string | null }
      | undefined;
    const now = tier?.id ?? null;
    if (prev && prev.tier_id !== now && tier && r) {
      const up = prev.tier_id === null || (order.get(tier.id) ?? 0) > (order.get(prev.tier_id) ?? 0);
      if (up) {
        const next = ctx.apogee.tiers[(order.get(tier.id) ?? 0) + 1];
        const placed = prev.tier_id === null;
        const ping = findRole(ctx.guild, "Match Feed Ping");
        const pinged = ping && member.roles.cache.has(ping.id);
        await textChannel(ctx.guild, "promotions")
          ?.send({
            content: pinged ? `<@${member.id}>` : undefined,
            embeds: [
              card(placed ? `${l.display_name} placed into ${tier.name}` : `${l.display_name} ranked up to ${tier.name}`)
                .setColor(hex(tier.color))
                .setThumbnail(member.displayAvatarURL())
                .setDescription(
                  [
                    placed ? "Placements done. Welcome to the ladder." : "🎉 New rank.",
                    `Rating **${fmt(r.rating)}** · ${r.matches_played} matches`,
                    next ? `Next: **${next.name}**` : "That's the top of the ladder.",
                  ].join("\n"),
                ),
            ],
            allowedMentions: { users: pinged ? [member.id] : [] },
          })
          .catch(() => undefined);
      }
    }
    ctx.store.db.prepare("insert or replace into rank_state values (?, ?)").run(l.discord_id, now);
  }
}

export const link: Feature = {
  name: "link",

  commands: [
    new SlashCommandBuilder()
      .setName("link")
      .setDescription("Link your Apogee account.")
      .addSubcommand((s) =>
        s
          .setName("start")
          .setDescription("Get a code to prove your Steam account")
          .addStringOption((o) =>
            o.setName("steam").setDescription("Steam profile URL, vanity name or SteamID64").setRequired(true),
          ),
      )
      .addSubcommand((s) => s.setName("confirm").setDescription("Check the code on your Steam profile"))
      .addSubcommand((s) => s.setName("status").setDescription("What you're linked to"))
      .addSubcommand((s) => s.setName("remove").setDescription("Unlink")),
  ],

  onCommand: {
    async link(ctx, i) {
      const sub = i.options.getSubcommand();
      if (!requireApogee(ctx)) {
        await i.reply({ content: NO_APOGEE, ephemeral: true });
        return;
      }
      const apogee = ctx.apogee;

      if (sub === "status") {
        const l = ctx.store.link(i.user.id);
        await i.reply({
          content: l
            ? `Linked to **${l.display_name}** (Steam ${l.steam_id}) since <t:${Math.floor(l.linked_at / 1000)}:D>.`
            : "Not linked. `/link start` to begin.",
          ephemeral: true,
        });
        return;
      }

      if (sub === "remove") {
        const member = await memberOf(ctx, i.user.id);
        ctx.store.unlink(i.user.id);
        if (member) {
          await setVerified(ctx, member, false);
          await setRankRole(ctx, member, null);
        }
        await i.reply({ content: "Unlinked. Your rank role is gone; stardust and levels stay.", ephemeral: true });
        return;
      }

      if (!apogee.steamKey) {
        await i.reply({ content: "Linking needs a Steam Web API key on the bot, and this one has none yet.", ephemeral: true });
        return;
      }

      if (sub === "start") {
        await i.deferReply({ ephemeral: true });
        const parsed = parseSteamInput(i.options.getString("steam", true));
        if (!parsed) {
          await i.editReply("That doesn't look like a Steam profile. Paste the URL from your profile page.");
          return;
        }
        const steamId = "id64" in parsed ? parsed.id64 : await apogee.resolveVanity(parsed.vanity);
        if (!steamId) {
          await i.editReply("Couldn't find that Steam profile.");
          return;
        }
        const player = await apogee.playerBySteam(steamId);
        if (!player) {
          await i.editReply("That Steam account hasn't signed in to Apogee yet. Open the client once, then try again.");
          return;
        }
        const taken = ctx.store.linkByPlayer(player.id);
        if (taken && taken.discord_id !== i.user.id) {
          await i.editReply("That Apogee account is already linked to someone else here. Ask a mod if it's yours.");
          return;
        }
        const code = linkCode(Math.random);
        ctx.store.savePending(i.user.id, steamId, code);
        await i.editReply({
          embeds: [
            card("Almost there")
              .setDescription(
                [
                  `Found **${player.display_name}** on Apogee.`,
                  "",
                  `**1.** Add \`${code}\` anywhere in your Steam profile name (Edit Profile → Profile Name).`,
                  "**2.** Save, then run `/link confirm` here.",
                  "**3.** Change your name back. The code is only checked once.",
                  "",
                  "The code expires in 30 minutes.",
                ].join("\n"),
              ),
          ],
        });
        return;
      }

      if (sub === "confirm") {
        await i.deferReply({ ephemeral: true });
        const p = ctx.store.pending(i.user.id);
        if (!p || Date.now() - p.created_at > CODE_TTL_MS) {
          await i.editReply("No live code. Run `/link start` first.");
          return;
        }
        const names = await apogee.steamNames(p.steam_id);
        if (!names) {
          await i.editReply("Steam didn't return that profile. Try again in a minute.");
          return;
        }
        const seen = `${names.persona} ${names.real}`.toUpperCase();
        if (!seen.includes(p.code)) {
          await i.editReply(
            `Steam shows your name as **${names.persona}**, without \`${p.code}\`. Steam can take a minute to update after you save; try again shortly.`,
          );
          return;
        }
        const player = await apogee.playerBySteam(p.steam_id);
        if (!player) {
          await i.editReply("That Steam account isn't on Apogee anymore.");
          return;
        }
        ctx.store.saveLink({
          discord_id: i.user.id,
          steam_id: p.steam_id,
          player_id: player.id,
          display_name: player.display_name,
          linked_at: Date.now(),
        });
        // A fresh link starts from the current tier, so it isn't announced as a promotion.
        const r = (await apogee.ratings([player.id])).get(player.id);
        const tier = apogee.rankedTier(r);
        ctx.store.db.prepare("insert or replace into rank_state values (?, ?)").run(i.user.id, tier?.id ?? null);
        const member = await memberOf(ctx, i.user.id);
        if (member) {
          await setVerified(ctx, member, true);
          await setRankRole(ctx, member, tier?.name ?? null);
        }
        await i.editReply(
          `Linked to **${player.display_name}**. ` +
            (tier ? `You're **${tier.name}**; the role is yours.` : "Finish your placement matches and your rank role arrives on its own.") +
            " You can change your Steam name back now.",
        );
      }
    },
  },

  every: [{ ms: 5 * 60_000, run: syncRanks }],
};
