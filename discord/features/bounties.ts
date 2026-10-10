/**
 * #bounties: three goals a week, checked against real data and claimed with /bounties.
 *
 * Ranked goals are counted from settled match_sides since the week began, so they cannot
 * be claimed by saying so. A match's category is a skill ("Tracking"), one of its
 * sub-categories ("Precise Tracking") or "Any"; a skill bounty counts the skill and every
 * sub-category under it, and an "Any" match counts for no skill in particular.
 */

import { SlashCommandBuilder } from "discord.js";

import { FAN_ROLES } from "../blueprint.ts";
import { card, type Ctx, type Feature, fmt, STARDUST } from "../core.ts";
import { findRole, mention, textChannel } from "../guild.ts";
import { type Bounty, bountiesForWeek, describeBounty, weekNumber, weekStart } from "../rules.ts";

/** The three skills, which is what a bounty can name. */
export const BOUNTY_SKILLS = FAN_ROLES;

export function matchCounts(category: string, skill: string | null): boolean {
  return skill === null || category.includes(skill);
}

async function progress(ctx: Ctx, userId: string, b: Bounty, week: number): Promise<number | null> {
  const u = ctx.store.user(userId);
  switch (b.kind) {
    case "reflex": {
      const r = ctx.store.db.prepare("select best from reflex_week where week = ? and discord_id = ?").get(week, userId) as
        | { best: number }
        | undefined;
      return r && r.best < b.ms ? 1 : 0;
    }
    case "daily":
      return u.daily_week === week ? u.daily_count_week : 0;
    case "play":
    case "win": {
      const link = ctx.store.link(userId);
      if (!link || !ctx.apogee) return null;
      const sides = await ctx.apogee.resultsSince(link.player_id, weekStart(week).toISOString());
      if (b.kind === "play") return sides.length;
      return sides.filter((s) => s.result === "win" && matchCounts(s.category, b.category)).length;
    }
  }
}

function target(b: Bounty): number {
  return b.kind === "reflex" ? 1 : b.count;
}

export async function postBounties(ctx: Ctx): Promise<void> {
  const week = weekNumber(new Date());
  if (ctx.store.get("bounty_week") === String(week)) return;
  const ch = textChannel(ctx.guild, "bounties");
  if (!ch) return;
  const list = bountiesForWeek(week, BOUNTY_SKILLS);
  const ends = Math.floor(weekStart(week + 1).getTime() / 1000);
  const ping = findRole(ctx.guild, "Events Ping");
  await ch.send({
    content: ping ? `<@&${ping.id}>` : undefined,
    embeds: [
      card("This week's bounties")
        .setDescription(
          list.map((b, n) => `**${n + 1}.** ${describeBounty(b)} · **${fmt(b.reward)} ${STARDUST}**`).join("\n") +
            `\n\nCheck and claim with \`/bounties\`. Ends <t:${ends}:R>.` +
            `\nRanked goals need a linked account: ${mention(ctx.guild, "link")}`,
        ),
    ],
    allowedMentions: { roles: ping ? [ping.id] : [] },
  });
  ctx.store.set("bounty_week", String(week));
}

export const bounties: Feature = {
  name: "bounties",
  commands: [new SlashCommandBuilder().setName("bounties").setDescription("This week's bounties: your progress, and claim what you've done.")],
  onCommand: {
    async bounties(ctx, i) {
      await i.deferReply({ ephemeral: true });
      const week = weekNumber(new Date());
      const list = bountiesForWeek(week, BOUNTY_SKILLS);
      const lines: string[] = [];
      let earned = 0;
      for (const [n, b] of list.entries()) {
        const claimed = !!ctx.store.db
          .prepare("select 1 from bounty_claims where week = ? and idx = ? and discord_id = ?")
          .get(week, n, i.user.id);
        if (claimed) {
          lines.push(`✅ ${describeBounty(b)} · claimed`);
          continue;
        }
        const have = await progress(ctx, i.user.id, b, week);
        if (have === null) {
          lines.push(`🔗 ${describeBounty(b)} · link your account to track this`);
          continue;
        }
        const need = target(b);
        if (have >= need) {
          ctx.store.tx(() => {
            ctx.store.db.prepare("insert or ignore into bounty_claims values (?, ?, ?)").run(week, n, i.user.id);
            ctx.store.addStardust(i.user.id, b.reward);
          });
          earned += b.reward;
          lines.push(`🎯 ${describeBounty(b)} · **done, +${fmt(b.reward)} ${STARDUST}**`);
        } else {
          lines.push(`▫️ ${describeBounty(b)} · ${b.kind === "reflex" ? "not yet" : `${have}/${need}`}`);
        }
      }
      await i.editReply({
        embeds: [card("Your bounties").setDescription(lines.join("\n") + (earned ? `\n\nClaimed **${fmt(earned)} ${STARDUST}**.` : ""))],
      });
    },
  },
  every: [{ ms: 30 * 60_000, run: postBounties }],
};
