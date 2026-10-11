/**
 * #bot-games: /reflex, /flick, /trivia.
 *
 * Reflex and flick are timed on the bot's own clock, from the moment the edit that shows
 * the target returns to the moment the click arrives, so both ends share one clock and
 * the figure includes the player's round trip to Discord. That is said on every result:
 * a 300 ms here is not a 300 ms on humanbenchmark, and comparing between people on the
 * same server is still fair-ish since everyone pays a ping.
 *
 * Rewards are capped per day so a macro can't farm stardust out of a button.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";

import { card, type Ctx, type Feature, fmt, STARDUST } from "../core.ts";
import { dayNumber, FLICK_MISS_PENALTY_MS, FLICK_ROUNDS, flickScore, REFLEX_FLOOR_MS, weekNumber } from "../rules.ts";

const PAID_ROUNDS_PER_DAY = 10;
const PLAY_REWARD = 10;
const PB_REWARD = 25;
const TRIVIA_REWARD = 30;
const TRIVIA_MS = 30_000;

function newId(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
}

/** Pays for a round if today's allowance isn't spent. Returns what was paid. */
function payRound(ctx: Ctx, user: string, amount: number): number {
  const key = `gamepay:${dayNumber(new Date())}:${user}`;
  const n = Number(ctx.store.get(key) ?? 0);
  if (n >= PAID_ROUNDS_PER_DAY) return 0;
  ctx.store.set(key, String(n + 1));
  ctx.store.addStardust(user, amount);
  return amount;
}

// ---------------------------------------------------------------------------
// Reflex
// ---------------------------------------------------------------------------

interface ReflexSession {
  user: string;
  greenAt: number | null;
  done: boolean;
  timer: NodeJS.Timeout | null;
}
const reflex = new Map<string, ReflexSession>();

function reflexButton(id: string, green: boolean, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`reflex:${id}`)
      .setLabel(green ? "CLICK!" : "Wait for green…")
      .setStyle(green ? ButtonStyle.Success : ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

async function startReflex(ctx: Ctx, i: ChatInputCommandInteraction): Promise<void> {
  const id = newId();
  const s: ReflexSession = { user: i.user.id, greenAt: null, done: false, timer: null };
  reflex.set(id, s);
  await i.reply({
    embeds: [card("⚡ Reflex").setDescription("Click the moment it turns **green**. Click on red and it's a false start.")],
    components: [reflexButton(id, false)],
  });
  const delay = 1500 + Math.random() * 3500;
  s.timer = setTimeout(async () => {
    if (s.done) return;
    await i.editReply({ components: [reflexButton(id, true)] }).catch(() => undefined);
    s.greenAt = Date.now();
    // Abandoned rounds close themselves.
    setTimeout(() => reflex.delete(id), 30_000);
  }, delay);
}

async function clickReflex(ctx: Ctx, i: ButtonInteraction, [id]: string[]): Promise<void> {
  const arrived = Date.now();
  const s = reflex.get(id);
  if (!s || s.done) {
    await i.reply({ content: "That round's over. `/reflex` for another.", ephemeral: true });
    return;
  }
  if (i.user.id !== s.user) {
    await i.reply({ content: "Start your own with `/reflex`.", ephemeral: true });
    return;
  }
  s.done = true;
  if (s.timer) clearTimeout(s.timer);
  reflex.delete(id);
  const ms = s.greenAt === null ? null : arrived - s.greenAt;
  if (ms === null || ms < REFLEX_FLOOR_MS) {
    await i.update({
      embeds: [card("⚡ Reflex · false start").setColor(0xff8a80).setDescription("Too early. Patience is a mechanic too.")],
      components: [reflexButton(id, false, true)],
    });
    return;
  }
  const u = ctx.store.user(i.user.id);
  const pb = u.reflex_best === null || ms < u.reflex_best;
  if (pb) ctx.store.patchUser(i.user.id, { reflex_best: ms });
  const week = weekNumber(new Date());
  ctx.store.db
    .prepare(
      "insert into reflex_week values (?, ?, ?) on conflict (week, discord_id) do update set best = min(best, excluded.best)",
    )
    .run(week, i.user.id, ms);
  const paid = payRound(ctx, i.user.id, PLAY_REWARD + (pb ? PB_REWARD : 0));
  const verdict = ms < 200 ? "Inhuman." : ms < 260 ? "Sharp." : ms < 330 ? "Solid." : ms < 450 ? "Warming up." : "Were you looking?";
  await i.update({
    embeds: [
      card(`⚡ ${ms} ms`)
        .setColor(pb ? 0xffc94d : 0x7ee0a1)
        .setDescription(
          [
            `${verdict}${pb ? " **New personal best!**" : ` PB: ${u.reflex_best} ms`}`,
            paid ? `+${paid} ${STARDUST}` : "Daily game rewards spent; still counts for your PB.",
            "_Includes your ping to Discord._",
          ].join("\n"),
        ),
    ],
    components: [reflexButton(id, true, true)],
  });
}

// ---------------------------------------------------------------------------
// Flick
// ---------------------------------------------------------------------------

const GRID_ROWS = 4;
const GRID_COLS = 5;

interface FlickSession {
  user: string;
  round: number;
  target: number;
  shownAt: number;
  total: number;
  misses: number;
  done: boolean;
}
const flick = new Map<string, FlickSession>();

function grid(id: string, target: number, disabled = false) {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (let c = 0; c < GRID_COLS; c++) {
      const n = r * GRID_COLS + c;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`flick:${id}:${n}`)
          .setEmoji(n === target ? "🎯" : "▪️")
          .setStyle(n === target ? ButtonStyle.Danger : ButtonStyle.Secondary)
          .setDisabled(disabled),
      );
    }
    rows.push(row);
  }
  return rows;
}

function nextTarget(prev: number): number {
  let t = prev;
  while (t === prev) t = Math.floor(Math.random() * GRID_ROWS * GRID_COLS);
  return t;
}

async function startFlick(ctx: Ctx, i: ChatInputCommandInteraction): Promise<void> {
  const id = newId();
  const s: FlickSession = { user: i.user.id, round: 1, target: nextTarget(-1), shownAt: 0, total: 0, misses: 0, done: false };
  flick.set(id, s);
  await i.reply({
    embeds: [card("🎯 Flick").setDescription(`Hit the 🎯. ${FLICK_ROUNDS} targets, timed. A miss costs ${FLICK_MISS_PENALTY_MS} ms.`)],
    components: grid(id, s.target),
  });
  s.shownAt = Date.now();
  setTimeout(() => flick.delete(id), 120_000);
}

async function clickFlick(ctx: Ctx, i: ButtonInteraction, [id, cell]: string[]): Promise<void> {
  const arrived = Date.now();
  const s = flick.get(id);
  if (!s || s.done) {
    await i.reply({ content: "That round's over. `/flick` for another.", ephemeral: true });
    return;
  }
  if (i.user.id !== s.user) {
    await i.reply({ content: "Start your own with `/flick`.", ephemeral: true });
    return;
  }
  if (Number(cell) !== s.target) {
    s.misses++;
    await i.deferUpdate();
    return;
  }
  s.total += arrived - s.shownAt;
  if (s.round < FLICK_ROUNDS) {
    s.round++;
    s.target = nextTarget(s.target);
    await i.update({
      embeds: [card(`🎯 Flick · ${s.round}/${FLICK_ROUNDS}`).setDescription(`Misses: ${s.misses}`)],
      components: grid(id, s.target),
    });
    s.shownAt = Date.now();
    return;
  }
  s.done = true;
  flick.delete(id);
  const score = flickScore(s.total, s.misses);
  const u = ctx.store.user(i.user.id);
  const pb = u.flick_best === null || score < u.flick_best;
  if (pb) ctx.store.patchUser(i.user.id, { flick_best: score });
  const paid = payRound(ctx, i.user.id, PLAY_REWARD + (pb ? PB_REWARD : 0));
  await i.update({
    embeds: [
      card(`🎯 ${fmt(score)} ms`)
        .setColor(pb ? 0xffc94d : 0x7ee0a1)
        .setDescription(
          [
            `${FLICK_ROUNDS} targets in ${fmt(s.total)} ms, ${s.misses} miss${s.misses === 1 ? "" : "es"} (avg ${fmt(s.total / FLICK_ROUNDS)} ms)`,
            pb ? "**New personal best!**" : `PB: ${fmt(u.flick_best!)} ms`,
            paid ? `+${paid} ${STARDUST}` : "Daily game rewards spent; still counts for your PB.",
            "_Includes your ping to Discord._",
          ].join("\n"),
        ),
    ],
    components: grid(id, -1, true),
  });
}

// ---------------------------------------------------------------------------
// Trivia
// ---------------------------------------------------------------------------

interface TriviaQ {
  question: string;
  options: string[];
  answer: number;
}

interface TriviaSession {
  q: TriviaQ;
  tried: Set<string>;
  done: boolean;
}
const trivia = new Map<string, TriviaSession>();

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let n = a.length - 1; n > 0; n--) {
    const k = Math.floor(Math.random() * (n + 1));
    [a[n], a[k]] = [a[k], a[n]];
  }
  return a;
}

function choose(right: string, pool: string[]): { options: string[]; answer: number } {
  const wrong = shuffle(pool.filter((p) => p !== right)).slice(0, 3);
  const options = shuffle([right, ...wrong]);
  return { options, answer: options.indexOf(right) };
}

/** Questions built from the season itself, so they stay true when the season changes. */
export function makeQuestion(ctx: Pick<Ctx, "season">): TriviaQ {
  const s = ctx.season;
  const scenarios = s.scenarios;
  const categories = [...new Set(scenarios.map((x) => x.category))];
  const kinds = ["category", "rank", "arm"] as const;
  const kind = kinds[Math.floor(Math.random() * kinds.length)];

  if (kind === "rank" && s.rankNames.length >= 4) {
    const n = Math.floor(Math.random() * (s.rankNames.length - 1));
    return { question: `Which Apogee rank comes right after **${s.rankNames[n]}**?`, ...choose(s.rankNames[n + 1], s.rankNames) };
  }
  if (kind === "arm") {
    const armed = scenarios.filter((x) => (x as { arm?: string }).arm);
    const arms = [...new Set(armed.map((x) => (x as { arm?: string }).arm!))];
    if (armed.length && arms.length >= 3) {
      const x = armed[Math.floor(Math.random() * armed.length)];
      const c = choose((x as { arm?: string }).arm!, arms);
      return { question: `What does **${x.label ?? x.scenario}** load most?`, ...c };
    }
  }
  const x = scenarios[Math.floor(Math.random() * scenarios.length)];
  return { question: `Which category is **${x.label ?? x.scenario}** in this season?`, ...choose(x.category, categories) };
}

function triviaRow(id: string, q: TriviaQ, disabled = false, reveal = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    q.options.map((o, n) =>
      new ButtonBuilder()
        .setCustomId(`trivia:${id}:${n}`)
        .setLabel(o.slice(0, 80))
        .setStyle(reveal && n === q.answer ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(disabled),
    ),
  );
}

async function startTrivia(ctx: Ctx, i: ChatInputCommandInteraction): Promise<void> {
  const q = makeQuestion(ctx);
  const id = newId();
  const s: TriviaSession = { q, tried: new Set(), done: false };
  trivia.set(id, s);
  const closes = Math.floor((Date.now() + TRIVIA_MS) / 1000);
  await i.reply({
    embeds: [card("🧠 Trivia").setDescription(`${q.question}\n\nFirst right answer wins **${TRIVIA_REWARD} ${STARDUST}**. One guess each. Closes <t:${closes}:R>.`)],
    components: [triviaRow(id, q)],
  });
  setTimeout(async () => {
    if (s.done) return;
    s.done = true;
    trivia.delete(id);
    await i
      .editReply({
        embeds: [card("🧠 Trivia · time").setDescription(`${q.question}\n\nNobody got it. It was **${q.options[q.answer]}**.`)],
        components: [triviaRow(id, q, true, true)],
      })
      .catch(() => undefined);
  }, TRIVIA_MS);
}

async function answerTrivia(ctx: Ctx, i: ButtonInteraction, [id, pickN]: string[]): Promise<void> {
  const s = trivia.get(id);
  if (!s || s.done) {
    await i.reply({ content: "That one's closed. `/trivia` for another.", ephemeral: true });
    return;
  }
  if (s.tried.has(i.user.id)) {
    await i.reply({ content: "One guess each.", ephemeral: true });
    return;
  }
  s.tried.add(i.user.id);
  if (Number(pickN) !== s.q.answer) {
    await i.reply({ content: "Nope.", ephemeral: true });
    return;
  }
  s.done = true;
  trivia.delete(id);
  ctx.store.addStardust(i.user.id, TRIVIA_REWARD);
  await i.update({
    embeds: [
      card("🧠 Trivia · solved")
        .setColor(0x7ee0a1)
        .setDescription(`${s.q.question}\n\n<@${i.user.id}> got it: **${s.q.options[s.q.answer]}**. +${TRIVIA_REWARD} ${STARDUST}`),
    ],
    components: [triviaRow(id, s.q, true, true)],
    allowedMentions: { users: [] },
  });
}

export const games: Feature = {
  name: "games",
  commands: [
    new SlashCommandBuilder().setName("reflex").setDescription("Click when it turns green. How fast are you?"),
    new SlashCommandBuilder().setName("flick").setDescription(`Hit ${FLICK_ROUNDS} targets as fast as you can.`),
    new SlashCommandBuilder().setName("trivia").setDescription("A question about this season. First right answer wins."),
  ],
  onCommand: { reflex: startReflex, flick: startFlick, trivia: startTrivia },
  onButton: { reflex: clickReflex, flick: clickFlick, trivia: answerTrivia },
};
