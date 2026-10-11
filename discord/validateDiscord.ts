/**
 * Hold the community layer to its claims, with no network.
 *
 *   npm run validate:discord
 *
 * Each check is stated as something that must be present, and the counts it ran over are
 * printed, so a check that silently iterated nothing shows up as a zero rather than a pass.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadRankTheme } from "../src/core/ranks/apogeeRanks.ts";
import { loadSeason } from "../src/core/season/season.ts";
import { CATEGORIES, PING_ROLES, roles, SHOP_COLORS } from "./blueprint.ts";
import { ROOT } from "./env.ts";
import { matchCounts } from "./features/bounties.ts";
import { makeQuestion } from "./features/games.ts";
import { scenarioForDay } from "./features/sotd.ts";
import {
  type Bet,
  bountiesForWeek,
  claimDaily,
  dailyReward,
  dayNumber,
  LEVEL_ROLES,
  levelForXp,
  levelProgress,
  linkCode,
  nextWinStreak,
  parseSteamInput,
  seeded,
  settlePot,
  weekNumber,
  weekStart,
  xpForLevel,
} from "./rules.ts";
import { Store } from "./store.ts";

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
}

// -- levels -----------------------------------------------------------------
{
  let consistent = 0;
  for (let l = 0; l <= 100; l++) if (levelForXp(xpForLevel(l)) === l && levelForXp(xpForLevel(l) - 1) === Math.max(0, l - 1)) consistent++;
  check("levelForXp inverts xpForLevel at every boundary 0..100", consistent === 101, `${consistent}/101`);
  const [into, needed] = levelProgress(xpForLevel(7) + 10);
  check("levelProgress reports position inside the level", into === 10 && needed === xpForLevel(8) - xpForLevel(7));
  // ~20 XP a message at a 60 s cooldown.
  const msgsToFive = Math.ceil(xpForLevel(5) / 20);
  const msgsToFifty = Math.ceil(xpForLevel(50) / 20);
  check("level 5 is a first evening (under 60 messages)", msgsToFive < 60, `${msgsToFive} messages`);
  check("level 50 is long-haul (over 10,000 messages)", msgsToFifty > 10_000, `${msgsToFifty} messages`);
  const rankNames = new Set(loadRankTheme().tiers.map((t) => t.name));
  check("no level role reuses an Apogee rank name", LEVEL_ROLES.every((l) => !rankNames.has(l.name)));
}

// -- daily ------------------------------------------------------------------
{
  const d0 = 20_000;
  let s = { lastDay: null as number | null, streak: 0, shields: 0 };
  const rewards: number[] = [];
  for (let d = 0; d < 9; d++) {
    const o = claimDaily(s, d0 + d);
    rewards.push(o.reward);
    s = { lastDay: d0 + d, streak: o.streak, shields: o.shields };
  }
  check("daily climbs for a week then holds", rewards.join(",") === "100,115,130,145,160,175,190,190,190", rewards.join(","));
  check("second claim on the same day is refused", !claimDaily(s, d0 + 8).ok);
  const missed = claimDaily({ lastDay: d0, streak: 5, shields: 0 }, d0 + 2);
  check("a missed day without a shield breaks the streak", missed.streak === 1 && missed.broke);
  const shielded = claimDaily({ lastDay: d0, streak: 5, shields: 1 }, d0 + 2);
  check("a shield bridges exactly one missed day", shielded.streak === 6 && shielded.shields === 0 && shielded.shieldUsed);
  const twoMissed = claimDaily({ lastDay: d0, streak: 5, shields: 3 }, d0 + 3);
  check("a shield does not bridge two missed days", twoMissed.streak === 1 && twoMissed.shields === 3);
  check("dailyReward never decreases with streak", [1, 2, 3, 7, 30].every((n, i, a) => i === 0 || dailyReward(n) >= dailyReward(a[i - 1])));
}

// -- predictions ------------------------------------------------------------
{
  const rand = seeded("pot");
  let conserved = 0;
  let trials = 0;
  for (let t = 0; t < 2000; t++) {
    const bets: Bet[] = [];
    const n = 1 + Math.floor(rand() * 9);
    for (let k = 0; k < n; k++) bets.push({ user: `u${k}`, side: rand() < 0.5 ? "back" : "fade", stake: 1 + Math.floor(rand() * 200) });
    const pot = bets.reduce((a, b) => a + b.stake, 0);
    for (const w of ["back", "fade", "draw"] as const) {
      trials++;
      const paid = [...settlePot(bets, w).values()].reduce((a, b) => a + b, 0);
      if (paid === pot) conserved++;
    }
  }
  check("every settlement pays out exactly the pot", conserved === trials, `${conserved}/${trials}`);
  const one = settlePot(
    [
      { user: "a", side: "back", stake: 50 },
      { user: "b", side: "fade", stake: 50 },
      { user: "c", side: "fade", stake: 50 },
    ],
    "back",
  );
  check("a lone right call takes the pot", one.get("a") === 150 && !one.has("b"));
  const nobody = settlePot([{ user: "a", side: "fade", stake: 50 }], "back");
  check("a pot with no winner refunds", nobody.get("a") === 50);
  check("win streaks: win extends, draw holds, loss resets", nextWinStreak(2, "win") === 3 && nextWinStreak(2, "draw") === 2 && nextWinStreak(2, "loss") === 0);
}

// -- seeded picks, weeks, bounties -----------------------------------------
{
  const season = loadSeason();
  const today = dayNumber(new Date());
  let repeats = 0;
  for (let d = today; d < today + 365; d++) if (scenarioForDay(season.scenarios, d).scenario === scenarioForDay(season.scenarios, d - 1).scenario) repeats++;
  check("scenario of the day never repeats on consecutive days (a year)", repeats === 0, `${repeats} repeats over 365 days`);
  const distinct = new Set(Array.from({ length: 60 }, (_, k) => scenarioForDay(season.scenarios, today + k).scenario)).size;
  check("scenario of the day spreads over the pool (60 days)", distinct >= 30, `${distinct} distinct of ${season.scenarios.length}`);
  check("same day, same pick (restart-safe)", scenarioForDay(season.scenarios, today).scenario === scenarioForDay(season.scenarios, today).scenario);

  let mondays = 0;
  for (let w = 2800; w < 2900; w++) if (weekStart(w).getUTCDay() === 1 && weekNumber(weekStart(w)) === w) mondays++;
  check("weeks start on Monday and round-trip", mondays === 100, `${mondays}/100`);

  const skills = ["Clicking", "Tracking", "Switching"];
  let wellFormed = 0;
  for (let w = 2800; w < 2900; w++) {
    const b = bountiesForWeek(w, skills);
    if (b.length === 3 && b[0].kind === "play" && b[1].kind === "win" && (b[2].kind === "reflex" || b[2].kind === "daily")) wellFormed++;
  }
  check("every week has one play, one win and one Discord bounty", wellFormed === 100, `${wellFormed}/100`);
  check("a skill bounty counts its sub-categories", matchCounts("Precise Tracking", "Tracking") && matchCounts("Tracking", "Tracking"));
  check("a skill bounty does not count another skill or Any", !matchCounts("Static Clicking", "Tracking") && !matchCounts("Any", "Tracking"));

  let triviaOk = 0;
  for (let k = 0; k < 300; k++) {
    const q = makeQuestion({ season });
    if (q.options.length >= 2 && q.options.length <= 5 && new Set(q.options).size === q.options.length && q.answer >= 0 && q.answer < q.options.length) triviaOk++;
  }
  check("trivia questions have distinct options and a valid answer", triviaOk === 300, `${triviaOk}/300`);
}

// -- link codes and Steam input --------------------------------------------
{
  const rand = seeded("codes");
  const codes = new Set(Array.from({ length: 5000 }, () => linkCode(rand)));
  check("link codes avoid look-alike characters", [...codes].every((c) => /^APX-[A-HJ-NP-Z2-9]{6}$/.test(c)));
  check("link codes don't collide in 5,000 draws", codes.size === 5000, `${codes.size}`);
  const cases: [string, string][] = [
    ["76561197960287930", "id64"],
    ["https://steamcommunity.com/profiles/76561197960287930/", "id64"],
    ["https://steamcommunity.com/id/example_name", "vanity"],
    ["example_name", "vanity"],
  ];
  check("Steam ids, profile URLs and vanity names all parse", cases.every(([s, k]) => { const p = parseSteamInput(s); return !!p && k in p; }));
  check("garbage Steam input is refused", parseSteamInput("not a steam profile!!") === null);
}

// -- blueprint --------------------------------------------------------------
{
  const r = roles();
  const names = r.map((x) => x.name);
  check("role names are unique", new Set(names).size === names.length, `${names.length} roles`);
  check("every Apogee tier has a rank role", loadRankTheme().tiers.every((t) => names.includes(t.name)), `${loadRankTheme().tiers.length} tiers`);
  check("every level, shop and ping role is declared", [...LEVEL_ROLES.map((l) => l.name), ...SHOP_COLORS.map((s) => s.name), ...PING_ROLES.map((p) => p.name)].every((n) => names.includes(n)));
  check("role colours are hex", r.every((x) => !x.color || /^#[0-9a-fA-F]{6}$/.test(x.color)));
  const channels = CATEGORIES.flatMap((c) => c.channels);
  const keys = channels.map((c) => c.key);
  check("channel keys are unique", new Set(keys).size === keys.length, `${keys.length} channels`);
  const used = new Set<string>();
  for (const f of readdirSync(join(ROOT, "discord", "features"))) {
    for (const m of readFileSync(join(ROOT, "discord", "features", f), "utf8").matchAll(/(?:textChannel|findChannel|mention)\(ctx\.guild, "([a-z0-9-]+)"\)/g)) used.add(m[1]);
  }
  const missing = [...used].filter((k) => !keys.includes(k));
  check("every channel a feature posts to exists in the blueprint", used.size > 0 && missing.length === 0, `${used.size} referenced${missing.length ? `, missing ${missing.join(", ")}` : ""}`);
  const textNames = channels.filter((c) => c.kind === "text").map((c) => c.name);
  check("text channel names are Discord-legal", textNames.every((n) => /^[a-z0-9-]{1,100}$/.test(n)));
}

// -- read-only against Apogee ----------------------------------------------
{
  const src = readFileSync(join(ROOT, "discord", "apogee.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const writes = src.match(/\.(insert|update|upsert|delete|rpc)\(/g) ?? [];
  const reads = src.match(/\.from\("/g) ?? [];
  check("apogee.ts reads Supabase", reads.length >= 4, `${reads.length} reads`);
  check("apogee.ts never writes to Supabase", writes.length === 0, writes.join(" "));
  let touched = 0;
  for (const f of readdirSync(join(ROOT, "discord", "features"))) {
    if (/createClient|\.from\("(players|ratings|matches|match_sides|runs)"/.test(readFileSync(join(ROOT, "discord", "features", f), "utf8"))) touched++;
  }
  check("features reach Supabase only through apogee.ts", touched === 0, `${touched} files bypass it`);
}

// -- store ------------------------------------------------------------------
{
  const s = new Store(":memory:");
  s.addStardust("a", 100);
  check("stardust can't go below zero", !s.addStardust("a", -101) && s.user("a").stardust === 100);
  let threw = false;
  try {
    s.tx(() => {
      s.addStardust("a", -40);
      throw new Error("boom");
    });
  } catch {
    threw = true;
  }
  check("a failed transaction leaves the balance untouched", threw && s.user("a").stardust === 100);
  s.saveLink({ discord_id: "d1", steam_id: "76561197960287930", player_id: "p1", display_name: "x", linked_at: 1 });
  s.saveLink({ discord_id: "d2", steam_id: "76561197960287930", player_id: "p1", display_name: "x", linked_at: 2 });
  check("a Steam account links to one Discord member at a time", !s.link("d1") && s.link("d2")?.player_id === "p1");
  s.db.close();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
