/**
 * Starboard for #clips, and /warn and /timeout that leave a trail in #mod-log.
 */

import { SlashCommandBuilder } from "discord.js";

import { card, type Ctx, type Feature, isStaff, memberOf, STARDUST } from "../core.ts";
import { findChannel, textChannel } from "../guild.ts";
import { STAR_REWARD, STAR_THRESHOLD } from "../rules.ts";

const MODERATE = 0x10000000000n; // ModerateMembers

async function modlog(ctx: Ctx, text: string): Promise<void> {
  await textChannel(ctx.guild, "modlog")?.send({ content: text, allowedMentions: { users: [] } }).catch(() => undefined);
}

export const moderation: Feature = {
  name: "moderation",

  commands: [
    new SlashCommandBuilder()
      .setName("warn")
      .setDescription("Warn a member (logged).")
      .setDefaultMemberPermissions(MODERATE)
      .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Why").setRequired(true).setMaxLength(300)),
    new SlashCommandBuilder()
      .setName("timeout")
      .setDescription("Time a member out (logged).")
      .setDefaultMemberPermissions(MODERATE)
      .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
      .addIntegerOption((o) => o.setName("minutes").setDescription("How long").setRequired(true).setMinValue(1).setMaxValue(40320))
      .addStringOption((o) => o.setName("reason").setDescription("Why").setRequired(true).setMaxLength(300)),
    new SlashCommandBuilder()
      .setName("warnings")
      .setDescription("A member's warnings.")
      .setDefaultMemberPermissions(MODERATE)
      .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true)),
  ],

  onCommand: {
    async warn(ctx, i) {
      if (!isStaff(await memberOf(ctx, i.user.id))) {
        await i.reply({ content: "Staff only.", ephemeral: true });
        return;
      }
      const who = i.options.getUser("user", true);
      const reason = i.options.getString("reason", true);
      ctx.store.db.prepare("insert into warns (discord_id, mod_id, reason, at) values (?, ?, ?, ?)").run(who.id, i.user.id, reason, Date.now());
      const n = (ctx.store.db.prepare("select count(*) as n from warns where discord_id = ?").get(who.id) as { n: number }).n;
      await who.send(`You were warned in ${ctx.guild.name}: ${reason}`).catch(() => undefined);
      await modlog(ctx, `⚠️ <@${i.user.id}> warned <@${who.id}> (#${n}): ${reason}`);
      await i.reply({ content: `Warned <@${who.id}>. That's warning ${n}.`, ephemeral: true });
    },

    async timeout(ctx, i) {
      if (!isStaff(await memberOf(ctx, i.user.id))) {
        await i.reply({ content: "Staff only.", ephemeral: true });
        return;
      }
      const who = i.options.getUser("user", true);
      const minutes = i.options.getInteger("minutes", true);
      const reason = i.options.getString("reason", true);
      const member = await memberOf(ctx, who.id);
      if (!member || !member.moderatable) {
        await i.reply({ content: "Can't time that member out (they may outrank the bot).", ephemeral: true });
        return;
      }
      await member.timeout(minutes * 60_000, reason);
      await modlog(ctx, `⏳ <@${i.user.id}> timed out <@${who.id}> for ${minutes} min: ${reason}`);
      await i.reply({ content: `Timed out <@${who.id}> for ${minutes} min.`, ephemeral: true });
    },

    async warnings(ctx, i) {
      const who = i.options.getUser("user", true);
      const rows = ctx.store.db
        .prepare("select mod_id, reason, at from warns where discord_id = ? order by at desc limit 15")
        .all(who.id) as { mod_id: string; reason: string; at: number }[];
      await i.reply({
        embeds: [
          card(`Warnings · ${who.displayName}`).setDescription(
            rows.length ? rows.map((r) => `<t:${Math.floor(r.at / 1000)}:d> by <@${r.mod_id}>: ${r.reason}`).join("\n") : "None.",
          ),
        ],
        ephemeral: true,
        allowedMentions: { users: [] },
      });
    },
  },

  async onReaction(ctx, reaction) {
    if (reaction.emoji.name !== "⭐") return;
    const clips = findChannel(ctx.guild, "clips");
    if (!clips || reaction.message.channelId !== clips.id) return;
    if (reaction.partial) await reaction.fetch().catch(() => undefined);
    const msg = reaction.message.partial ? await reaction.message.fetch().catch(() => null) : reaction.message;
    if (!msg || msg.author?.bot) return;
    // The poster's own star doesn't count.
    const users = await reaction.users.fetch().catch(() => null);
    const count = users ? users.filter((u) => u.id !== msg.author?.id && !u.bot).size : 0;
    if (count < STAR_THRESHOLD) return;
    if (ctx.store.db.prepare("select 1 from starboard where message_id = ?").get(msg.id)) return;
    const hof = textChannel(ctx.guild, "hof");
    if (!hof) return;
    const attachment = msg.attachments.find((a) => a.contentType?.startsWith("image/"));
    const video = msg.attachments.find((a) => a.contentType?.startsWith("video/"));
    const e = card()
      .setAuthor({ name: msg.author!.displayName, iconURL: msg.author!.displayAvatarURL() })
      .setDescription(`${msg.content || "​"}\n\n[Jump to clip](${msg.url})`)
      .setFooter({ text: `⭐ ${count}` })
      .setTimestamp(msg.createdAt);
    if (attachment) e.setImage(attachment.url);
    const posted = await hof.send({ content: video ? video.url : undefined, embeds: [e] });
    ctx.store.db.prepare("insert into starboard values (?, ?)").run(msg.id, posted.id);
    ctx.store.addStardust(msg.author!.id, STAR_REWARD);
    await msg.reply({ content: `⭐ Made #hall-of-fame. +${STAR_REWARD} ${STARDUST}`, allowedMentions: { repliedUser: false } }).catch(() => undefined);
  },
};
