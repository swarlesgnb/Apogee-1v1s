/**
 * #scenario-of-the-day: one season scenario per UTC day, ranked by linked players'
 * verified runs on it that day.
 *
 * Only runs the server graded `verified` or `consistent` count, the same bar the app holds
 * a ranked run to; an unverified run can still be a real one, but the board is the one
 * place a score here is compared against someone else's, so it takes the stricter bar.
 * The pick is seeded by the date, so a restart mid-day re-derives the same scenario.
 */

import { SlashCommandBuilder } from "discord.js";

import type { SeasonScenario } from "../../src/core/season/season.ts";
import { card, type Ctx, type Feature, fmt, requireApogee, STARDUST } from "../core.ts";
import { textChannel } from "../guild.ts";
import { dayNumber, isoDay, pick, seeded } from "../rules.ts";

const PODIUM = [150, 100, 50];

interface SotdRow {
  day: number;
  scenario: string;
  channel_id: string;
  message_id: string;
  finalized: number;
}

export function scenarioForDay(pool: readonly SeasonScenario[], day: number): SeasonScenario {
  const rand = seeded(`sotd:${day}`);
  const yesterday = pick(pool, seeded(`sotd:${day - 1}`));
  let s = pick(pool, rand);
  // Never the same scenario two days running.
  for (let n = 0; n < 5 && s.scenario === yesterday.scenario; n++) s = pick(pool, rand);
  return s;
}

function dayRange(day: number): [string, string] {
  return [new Date(day * 86_400_000).toISOString(), new Date((day + 1) * 86_400_000).toISOString()];
}

async function board(ctx: Ctx, scenario: string, day: number): Promise<{ discord: string; name: string; score: number; acc: number | null }[]> {
  if (!requireApogee(ctx)) return [];
  const links = ctx.store.links();
  const [from, to] = dayRange(day);
  const runs = await ctx.apogee.runsOn(scenario, links.map((l) => l.player_id), from, to);
  const best = new Map<string, (typeof runs)[number]>();
  for (const r of runs) {
    const b = best.get(r.player_id);
    if (!b || r.score > b.score) best.set(r.player_id, r);
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .map((r) => {
      const l = ctx.store.linkByPlayer(r.player_id)!;
      return { discord: l.discord_id, name: l.display_name, score: r.score, acc: r.accuracy };
    });
}

function boardText(rows: Awaited<ReturnType<typeof board>>): string {
  if (rows.length === 0) return "No verified runs yet. Be first.";
  const medal = (n: number) => ["🥇", "🥈", "🥉"][n] ?? `\`${n + 1}.\``;
  return rows
    .slice(0, 10)
    .map((r, n) => `${medal(n)} **${r.name}** · ${fmt(r.score)}${r.acc !== null ? ` · ${(r.acc * 100).toFixed(1)}%` : ""}`)
    .join("\n");
}

function sotdEmbed(s: SeasonScenario, day: number, rows: Awaited<ReturnType<typeof board>>, final: boolean) {
  const ends = Math.floor(((day + 1) * 86_400_000) / 1000);
  return card(`${final ? "Final · " : ""}Scenario of the Day · ${isoDay(day)}`)
    .setDescription(
      [
        `## ${s.label ?? s.scenario}`,
        `**${s.category}**${s.window !== undefined ? ` · ${["Novice", "Intermediate", "Advanced", "Expert"][s.window] ?? ""}` : ""}`,
        s.focus ? `_${s.focus}_` : null,
        "",
        `Search KovaaK's for \`${s.scenario}\`.`,
        final ? "Closed." : `Closes <t:${ends}:R>. Top 3 earn ${PODIUM.join(" / ")} ${STARDUST}.`,
      ]
        .filter((l) => l !== null)
        .join("\n"),
    )
    .addFields({ name: final ? "Podium" : "Board (verified runs, linked players)", value: boardText(rows) });
}

export async function pollSotd(ctx: Ctx): Promise<void> {
  const ch = textChannel(ctx.guild, "sotd");
  if (!ch || ctx.season.scenarios.length === 0) return;
  const today = dayNumber(new Date());

  // Close out any earlier day still open.
  const stale = ctx.store.db.prepare("select * from sotd where finalized = 0 and day < ?").all(today) as unknown as SotdRow[];
  for (const row of stale) {
    const s = ctx.season.scenarios.find((x) => x.scenario === row.scenario);
    const rows = await board(ctx, row.scenario, row.day);
    ctx.store.tx(() => {
      rows.slice(0, PODIUM.length).forEach((r, n) => ctx.store.addStardust(r.discord, PODIUM[n]));
      ctx.store.db.prepare("update sotd set finalized = 1 where day = ?").run(row.day);
    });
    const msg = await ch.messages.fetch(row.message_id).catch(() => null);
    if (msg && s) await msg.edit({ embeds: [sotdEmbed(s, row.day, rows, true)] }).catch(() => undefined);
    if (rows.length > 0) {
      await ch.send({
        content: `🏁 ${isoDay(row.day)} closed. ${rows
          .slice(0, 3)
          .map((r, n) => `<@${r.discord}> +${PODIUM[n]} ${STARDUST}`)
          .join(" · ")}`,
        allowedMentions: { users: rows.slice(0, 3).map((r) => r.discord) },
      });
    }
  }

  const row = ctx.store.db.prepare("select * from sotd where day = ?").get(today) as unknown as SotdRow | undefined;
  const s = row ? ctx.season.scenarios.find((x) => x.scenario === row.scenario) : scenarioForDay(ctx.season.scenarios, today);
  if (!s) return;
  const rows = await board(ctx, s.scenario, today);
  if (!row) {
    const msg = await ch.send({ embeds: [sotdEmbed(s, today, rows, false)] });
    ctx.store.db.prepare("insert into sotd (day, scenario, channel_id, message_id) values (?, ?, ?, ?)").run(today, s.scenario, ch.id, msg.id);
  } else {
    const msg = await ch.messages.fetch(row.message_id).catch(() => null);
    await msg?.edit({ embeds: [sotdEmbed(s, today, rows, false)] }).catch(() => undefined);
  }
}

export const sotd: Feature = {
  name: "sotd",
  commands: [new SlashCommandBuilder().setName("sotd").setDescription("Today's Scenario of the Day and its board.")],
  onCommand: {
    async sotd(ctx, i) {
      const today = dayNumber(new Date());
      const row = ctx.store.db.prepare("select * from sotd where day = ?").get(today) as unknown as SotdRow | undefined;
      const s = row ? ctx.season.scenarios.find((x) => x.scenario === row.scenario) : scenarioForDay(ctx.season.scenarios, today);
      if (!s) {
        await i.reply({ content: "No season pool loaded.", ephemeral: true });
        return;
      }
      await i.deferReply();
      await i.editReply({ embeds: [sotdEmbed(s, today, await board(ctx, s.scenario, today), false)] });
    },
  },
  every: [{ ms: 10 * 60_000, run: pollSotd }],
};
