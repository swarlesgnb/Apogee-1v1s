/**
 * #predictions: back or fade a linked player's open ranked match with stardust.
 *
 * Betting closes PREDICTION_WINDOW_MS after the card posts. A match takes three scenarios
 * plus queueing, so the window shuts well before anyone could know the result, and the
 * player whose match it is can't bet on it at all. The pot is parimutuel (settlePot), so a
 * prediction never mints or burns stardust; a void match refunds everyone.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

import { card, type Ctx, type Feature, fmt, requireApogee, STARDUST } from "../core.ts";
import { textChannel } from "../guild.ts";
import { type Bet, PREDICTION_STAKE, PREDICTION_WINDOW_MS, settlePot } from "../rules.ts";

interface PredictionRow {
  id: string;
  match_id: string;
  player_id: string;
  subject: string;
  channel_id: string;
  message_id: string;
  opened_at: number;
  settled: number;
}

function buttons(id: string, disabled: boolean, counts: { back: number; fade: number }) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`bet:${id}:back`)
      .setLabel(`Back · ${counts.back}`)
      .setEmoji("📈")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`bet:${id}:fade`)
      .setLabel(`Fade · ${counts.fade}`)
      .setEmoji("📉")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

function betsFor(ctx: Ctx, id: string): Bet[] {
  return (
    ctx.store.db.prepare("select discord_id, side, stake from bets where prediction_id = ?").all(id) as {
      discord_id: string;
      side: "back" | "fade";
      stake: number;
    }[]
  ).map((b) => ({ user: b.discord_id, side: b.side, stake: b.stake }));
}

function counts(bets: Bet[]) {
  return { back: bets.filter((b) => b.side === "back").length, fade: bets.filter((b) => b.side === "fade").length };
}

export async function pollPredictions(ctx: Ctx): Promise<void> {
  if (!requireApogee(ctx)) return;
  const ch = textChannel(ctx.guild, "predictions");
  if (!ch) return;
  const links = ctx.store.links();

  // Open new cards.
  const open = await ctx.apogee.openSides(links.map((l) => l.player_id));
  for (const s of open) {
    const id = `${s.match_id}:${s.player_id}`;
    if (ctx.store.db.prepare("select 1 from predictions where id = ?").get(id)) continue;
    // A match first seen long after it opened is past its betting window already.
    if (Date.now() - Date.parse(s.created_at) > PREDICTION_WINDOW_MS) continue;
    const link = ctx.store.linkByPlayer(s.player_id);
    if (!link) continue;
    const r = (await ctx.apogee.ratings([s.player_id])).get(s.player_id);
    const tier = ctx.apogee.rankedTier(r);
    const closes = Math.floor((Date.now() + PREDICTION_WINDOW_MS) / 1000);
    const msg = await ch.send({
      embeds: [
        card(`🎲 ${link.display_name} is in a match`)
          .setDescription(
            [
              `<@${link.discord_id}> just queued **${s.category}** (${s.difficulty}).`,
              r ? `${tier ? tier.name : "Placements"} · ${fmt(r.rating)} rating` : "First ranked match.",
              "",
              `Back them or fade them for **${PREDICTION_STAKE} ${STARDUST}**. Winners split the pot.`,
              `Betting closes <t:${closes}:R>.`,
            ].join("\n"),
          ),
      ],
      components: [buttons(id, false, { back: 0, fade: 0 })],
      allowedMentions: { users: [] },
    });
    ctx.store.db
      .prepare("insert into predictions (id, match_id, player_id, subject, channel_id, message_id, opened_at) values (?, ?, ?, ?, ?, ?, ?)")
      .run(id, s.match_id, s.player_id, link.discord_id, ch.id, msg.id, Date.now());
  }

  // Lock and settle.
  const live = ctx.store.db.prepare("select * from predictions where settled = 0").all() as unknown as PredictionRow[];
  for (const p of live) {
    const outcome = await ctx.apogee.sideOutcome(p.match_id, p.player_id);
    const msg = await ch.messages.fetch(p.message_id).catch(() => null);
    const bets = betsFor(ctx, p.id);
    if (outcome === null) {
      const lockKey = `pred_locked:${p.id}`;
      if (Date.now() - p.opened_at > PREDICTION_WINDOW_MS && !ctx.store.get(lockKey)) {
        ctx.store.set(lockKey, "1");
        await msg?.edit({ components: [buttons(p.id, true, counts(bets))] }).catch(() => undefined);
      }
      continue;
    }
    const winner = outcome === "win" ? "back" : outcome === "loss" ? "fade" : "draw";
    const payouts = settlePot(bets, winner);
    ctx.store.tx(() => {
      for (const [user, amount] of payouts) ctx.store.addStardust(user, amount);
      ctx.store.db.prepare("update predictions set settled = 1 where id = ?").run(p.id);
    });
    const pot = bets.reduce((s, b) => s + b.stake, 0);
    const winners = winner === "draw" ? [] : bets.filter((b) => b.side === winner);
    const verdict =
      outcome === "win" ? "**Won.** Backers cash in." : outcome === "loss" ? "**Lost.** Faders cash in." : "**Draw or void.** Every stake refunded.";
    const paid =
      winners.length > 0
        ? winners.map((b) => `<@${b.user}> +${fmt(payouts.get(b.user) ?? 0)} ${STARDUST}`).join(" · ")
        : bets.length > 0
          ? "Stakes refunded."
          : "Nobody called it.";
    if (msg) {
      const e = msg.embeds[0];
      await msg
        .edit({
          embeds: [
            card(e?.title ?? "Match")
              .setDescription(`${verdict}\nPot: ${fmt(pot)} ${STARDUST}\n${paid}`)
              .setColor(outcome === "win" ? 0x7ee0a1 : outcome === "loss" ? 0xff8a80 : 0xb0b6c3),
          ],
          components: [buttons(p.id, true, counts(bets))],
          allowedMentions: { users: [] },
        })
        .catch(() => undefined);
    }
  }
}

export const predictions: Feature = {
  name: "predictions",

  onButton: {
    async bet(ctx, i, args) {
      const side = args.pop() as "back" | "fade";
      const id = args.join(":");
      const p = ctx.store.db.prepare("select * from predictions where id = ?").get(id) as unknown as PredictionRow | undefined;
      if (!p || p.settled || Date.now() - p.opened_at > PREDICTION_WINDOW_MS) {
        await i.reply({ content: "Betting on this one is closed.", ephemeral: true });
        return;
      }
      if (p.subject === i.user.id) {
        await i.reply({ content: "You can't bet on your own match. Go win it.", ephemeral: true });
        return;
      }
      if (ctx.store.db.prepare("select 1 from bets where prediction_id = ? and discord_id = ?").get(id, i.user.id)) {
        await i.reply({ content: "You've already called this one.", ephemeral: true });
        return;
      }
      const ok = ctx.store.tx(() => {
        if (!ctx.store.addStardust(i.user.id, -PREDICTION_STAKE)) return false;
        ctx.store.db.prepare("insert into bets values (?, ?, ?, ?)").run(id, i.user.id, side, PREDICTION_STAKE);
        return true;
      });
      if (!ok) {
        await i.reply({ content: `You need ${PREDICTION_STAKE} ${STARDUST}. \`/daily\` is a start.`, ephemeral: true });
        return;
      }
      await i.update({ components: [buttons(id, false, counts(betsFor(ctx, id)))] });
      await i.followUp({ content: `${side === "back" ? "Backed" : "Faded"} for ${PREDICTION_STAKE} ${STARDUST}.`, ephemeral: true });
    },
  },

  every: [{ ms: 60_000, run: pollPredictions }],
};
