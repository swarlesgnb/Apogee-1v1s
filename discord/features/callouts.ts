/**
 * #callouts: challenge someone publicly, then settle it in an Apogee duel.
 *
 * The bot only makes the challenge loud. It never creates the duel, because duels are
 * the server's (send-duel decides the scenarios and the result); accepting here tells
 * both players where to send it from.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from "discord.js";

import { FAN_ROLES } from "../blueprint.ts";
import { card, type Feature } from "../core.ts";

const TAUNTS = [
  "thinks they can take you.",
  "says your crosshair placement is a rumour.",
  "wants to see if your flicks are real.",
  "has been watching your clips and is not impressed.",
  "says you're all wrist and no arm.",
  "is calling you out. Publicly. Right now.",
];

function row(id: string, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`callout:${id}:accept`).setLabel("Accept").setEmoji("⚔️").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`callout:${id}:decline`).setLabel("Duck it").setEmoji("🐔").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

export const callouts: Feature = {
  name: "callouts",

  commands: [
    new SlashCommandBuilder()
      .setName("callout")
      .setDescription("Challenge someone to a ranked duel.")
      .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
      .addStringOption((o) =>
        o
          .setName("skill")
          .setDescription("What you'll play")
          .addChoices({ name: "Any", value: "Any" }, ...FAN_ROLES.map((f) => ({ name: f, value: f }))),
      )
      .addStringOption((o) => o.setName("message").setDescription("Say something").setMaxLength(140)),
    new SlashCommandBuilder()
      .setName("rivals")
      .setDescription("Callout record.")
      .addUserOption((o) => o.setName("user").setDescription("Whose")),
  ],

  onCommand: {
    async callout(ctx, i) {
      const target = i.options.getUser("user", true);
      if (target.bot || target.id === i.user.id) {
        await i.reply({ content: "Pick a real opponent.", ephemeral: true });
        return;
      }
      const skill = i.options.getString("skill") ?? "Any";
      const said = i.options.getString("message")?.replace(/@everyone|@here/g, "");
      const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
      ctx.store.db
        .prepare("insert into callouts values (?, ?, ?, ?, 'open', ?)")
        .run(id, i.user.id, target.id, skill, Date.now());
      const taunt = TAUNTS[Math.floor(Math.random() * TAUNTS.length)];
      await i.reply({
        content: `<@${target.id}>`,
        embeds: [
          card("⚔️ Callout")
            .setDescription(
              [`<@${i.user.id}> ${taunt}`, said ? `> ${said}` : null, "", `**${skill}** · ranked duel · three scenarios`]
                .filter((l) => l !== null)
                .join("\n"),
            )
            .setThumbnail(i.user.displayAvatarURL()),
        ],
        components: [row(id)],
        allowedMentions: { users: [target.id] },
      });
    },

    async rivals(ctx, i) {
      const who = i.options.getUser("user") ?? i.user;
      const rows = ctx.store.db
        .prepare("select challenger, target, status from callouts where challenger = ? or target = ?")
        .all(who.id, who.id) as { challenger: string; target: string; status: string }[];
      const issued = rows.filter((r) => r.challenger === who.id).length;
      const received = rows.filter((r) => r.target === who.id);
      const accepted = received.filter((r) => r.status === "accepted").length;
      const ducked = received.filter((r) => r.status === "declined").length;
      const foes = new Map<string, number>();
      for (const r of rows) {
        const other = r.challenger === who.id ? r.target : r.challenger;
        foes.set(other, (foes.get(other) ?? 0) + 1);
      }
      const rival = [...foes.entries()].sort((a, b) => b[1] - a[1])[0];
      await i.reply({
        embeds: [
          card(`${who.displayName}'s callouts`).setDescription(
            [
              `Issued **${issued}** · received **${received.length}** · accepted **${accepted}** · ducked **${ducked}** 🐔`,
              rival ? `Biggest rival: <@${rival[0]}> (${rival[1]} callouts)` : "No rival yet.",
            ].join("\n"),
          ),
        ],
        allowedMentions: { users: [] },
      });
    },
  },

  onButton: {
    async callout(ctx, i, [id, action]) {
      const c = ctx.store.db.prepare("select * from callouts where id = ?").get(id) as
        | { challenger: string; target: string; category: string; status: string }
        | undefined;
      if (!c || c.status !== "open") {
        await i.reply({ content: "This callout is already answered.", ephemeral: true });
        return;
      }
      if (i.user.id !== c.target) {
        await i.reply({ content: "Not your callout to answer.", ephemeral: true });
        return;
      }
      const accepted = action === "accept";
      ctx.store.db.prepare("update callouts set status = ? where id = ?").run(accepted ? "accepted" : "declined", id);
      await i.update({ components: [row(id, true)] });
      await i.followUp({
        content: accepted
          ? `⚔️ <@${c.target}> **accepted**. <@${c.challenger}>, send the duel from Apogee's **Play** screen (${c.category}): open the duel picker and find their name. Settle it there; post the result card here.`
          : `🐔 <@${c.target}> ducked <@${c.challenger}>. Noted.`,
        allowedMentions: { users: [c.challenger, c.target] },
      });
    },
  },
};
