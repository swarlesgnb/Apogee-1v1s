/**
 * #match-feed and #leaderboard: settled matches by linked players, as they settle.
 *
 * The feed starts from the moment the bot first runs rather than replaying history, so a
 * fresh install doesn't dump every past match into the channel at once.
 */

import { type TextChannel } from "discord.js";

import { PLACEMENT_MATCHES } from "../../src/core/ranks/placement.ts";
import type { SettledSide } from "../apogee.ts";
import { card, type Ctx, type Feature, fmt, hex, requireApogee, STARDUST } from "../core.ts";
import { textChannel } from "../guild.ts";
import { marker } from "../panels.ts";
import { MATCH_STARDUST, nextWinStreak, STREAK_CALLOUTS } from "../rules.ts";

const RESULT = {
  win: { word: "won", color: 0x7ee0a1, icon: "🟢" },
  loss: { word: "lost", color: 0xff8a80, icon: "🔴" },
  draw: { word: "drew", color: 0xb0b6c3, icon: "⚪" },
} as const;

function signed(n: number): string {
  return `${n >= 0 ? "+" : "−"}${fmt(Math.abs(n))}`;
}

async function postSide(ctx: Ctx, feed: TextChannel | undefined, side: SettledSide): Promise<void> {
  const link = ctx.store.linkByPlayer(side.player_id);
  if (!link) return;
  const key = `feed:${side.match_id}:${side.player_id}`;
  if (ctx.store.get(key)) return;
  ctx.store.set(key, "1");

  const u = ctx.store.user(link.discord_id);
  const streak = nextWinStreak(u.win_streak, side.result);
  ctx.store.patchUser(link.discord_id, { win_streak: streak, best_win_streak: Math.max(u.best_win_streak, streak) });
  const reward = MATCH_STARDUST[side.result];
  ctx.store.addStardust(link.discord_id, reward);

  const r = RESULT[side.result];
  const delta =
    side.rating_before !== null && side.rating_after !== null ? side.rating_after - side.rating_before : null;
  const lines = [
    `${r.icon} <@${link.discord_id}> **${r.word}** a ${side.category} match (${side.difficulty})`,
    delta !== null ? `Rating ${fmt(side.rating_before!)} → **${fmt(side.rating_after!)}** (${signed(delta)})` : null,
    side.match_score !== null ? `Match score ${side.match_score >= 0 ? "+" : ""}${(side.match_score * 100).toFixed(1)}% vs baseline` : null,
    side.provisional ? "_Provisional baseline: reduced rating weight._" : null,
    `+${reward} ${STARDUST}`,
  ].filter(Boolean);
  if (STREAK_CALLOUTS[streak] && side.result === "win") lines.push(`🔥 **${streak} in a row**: ${link.display_name} ${STREAK_CALLOUTS[streak]}.`);

  await feed
    ?.send({
      embeds: [card().setColor(r.color).setDescription(lines.join("\n")).setTimestamp(new Date(side.settled_at))],
      allowedMentions: { users: [] },
    })
    .catch(() => undefined);
}

export async function pollFeed(ctx: Ctx): Promise<void> {
  if (!requireApogee(ctx)) return;
  let since = ctx.store.get("feed_since");
  if (!since) {
    since = new Date().toISOString();
    ctx.store.set("feed_since", since);
    return;
  }
  const links = ctx.store.links();
  if (links.length === 0) return;
  const sides = await ctx.apogee.settledSince(
    links.map((l) => l.player_id),
    // Overlap the window by a minute: a match settled while the last poll was in flight
    // would otherwise fall between two polls. The per-side key stops double posts.
    new Date(Date.parse(since) - 60_000).toISOString(),
  );
  const feed = textChannel(ctx.guild, "feed");
  for (const s of sides) {
    await postSide(ctx, feed, s);
    if (s.settled_at > since) since = s.settled_at;
  }
  ctx.store.set("feed_since", since);
}

export async function refreshLeaderboard(ctx: Ctx): Promise<void> {
  if (!requireApogee(ctx)) return;
  const ch = textChannel(ctx.guild, "leaderboard");
  if (!ch) return;
  const links = ctx.store.links();
  const ids = links.map((l) => l.player_id);
  const ratings = await ctx.apogee.ratings(ids);
  const byPlayer = new Map(links.map((l) => [l.player_id, l]));

  const ranked = [...ratings.values()]
    .filter((r) => r.matches_played >= PLACEMENT_MATCHES)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 25);

  const week = await ctx.apogee.settledSince(ids, new Date(Date.now() - 7 * 86_400_000).toISOString());
  const gains = new Map<string, number>();
  for (const s of week) {
    if (s.rating_before === null || s.rating_after === null) continue;
    gains.set(s.player_id, (gains.get(s.player_id) ?? 0) + (s.rating_after - s.rating_before));
  }
  const improved = [...gains.entries()].filter(([, g]) => g > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const medal = (n: number) => ["🥇", "🥈", "🥉"][n] ?? `\`${String(n + 1).padStart(2)}\``;
  const rows = ranked.map((r, n) => {
    const l = byPlayer.get(r.player_id)!;
    const tier = ctx.apogee!.tier(r.tier_id);
    return `${medal(n)} **${l.display_name}** <@${l.discord_id}> · ${fmt(r.rating)}${tier ? ` · ${tier.name}` : ""}`;
  });
  const top = ranked[0] ? ctx.apogee.tier(ranked[0].tier_id) : null;

  const embed = card("Leaderboard · linked players")
    .setColor(top ? hex(top.color) : 0xb8a5ff)
    .setDescription(
      rows.length
        ? rows.join("\n")
        : `Nobody linked has finished placements yet. ${PLACEMENT_MATCHES} ranked matches gets you on here.`,
    )
    .addFields({
      name: "Most improved this week",
      value: improved.length
        ? improved.map(([pid, g]) => `**${byPlayer.get(pid)?.display_name}** ${signed(g)}`).join(" · ")
        : "Nobody's climbed yet this week.",
    })
    .setFooter({ text: marker("leaderboard") })
    .setTimestamp(new Date());

  const recent = await ch.messages.fetch({ limit: 20 });
  const mine = recent.find((m) => m.author.id === ctx.client.user.id && m.embeds[0]?.footer?.text === marker("leaderboard"));
  if (mine) await mine.edit({ embeds: [embed], allowedMentions: { users: [] } });
  else {
    const msg = await ch.send({ embeds: [embed], allowedMentions: { users: [] } });
    await msg.pin().catch(() => undefined);
  }
}

export const feed: Feature = {
  name: "feed",
  every: [
    { ms: 2 * 60_000, run: pollFeed },
    { ms: 60 * 60_000, run: refreshLeaderboard },
  ],
};
