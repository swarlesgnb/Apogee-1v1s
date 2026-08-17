"use strict";

/**
 * Apogee renderer.
 *
 * Runs in two hosts from one source, so the desktop app and the shareable preview
 * cannot drift apart:
 *
 *   ELECTRON  `window.apogee` exists (supplied by preload). Data is live: the main
 *             process watches the stats folder and pushes a new snapshot whenever a
 *             run lands.
 *
 *   PREVIEW   `window.__APOGEE_SNAPSHOT__` is inlined by tools/buildUiPreview.ts. Static,
 *             no Electron, opens anywhere.
 *
 * This file is a pure view. It never parses a CSV, computes a delta, or decides a
 * verdict; all of that arrives already settled.
 */

const HOST = typeof window.apogee !== "undefined" ? "electron" : "preview";

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const pct = (v) => (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(1) + "%";
const num = (v) => Math.round(v).toLocaleString();

/**
 * A faceted emblem rather than a plain disc: rank badges are read at a glance and at
 * small sizes, so the silhouette has to carry identity before the colour does.
 */
function badge(tier, uid) {
  const g = "g" + uid;
  const f = "f" + uid;
  return (
    '<svg viewBox="0 0 60 68" role="img" aria-label="' + esc(tier.name) + '">' +
    '<defs><linearGradient id="' + g + '" x1="0" y1="0" x2="0.35" y2="1">' +
    '<stop offset="0" stop-color="' + esc(tier.gradient[1]) + '"/>' +
    '<stop offset="1" stop-color="' + esc(tier.gradient[0]) + '"/></linearGradient>' +
    '<filter id="' + f + '" x="-60%" y="-60%" width="220%" height="220%">' +
    '<feDropShadow dx="0" dy="0" stdDeviation="3.2" flood-color="' + esc(tier.glow) +
    '" flood-opacity="0.85"/></filter></defs>' +
    '<path d="M30 1.5 56.5 15v27.5L30 66.5 3.5 42.5V15z" fill="url(#' + g +
    ')" filter="url(#' + f + ')"/>' +
    '<path d="M30 1.5 56.5 15v27.5L30 66.5 3.5 42.5V15z" fill="none" stroke="' +
    esc(tier.glow) + '" stroke-opacity=".5" stroke-width="1.1"/>' +
    '<path d="M30 12 46 20.5v20L30 55 14 40.5v-20z" fill="none" stroke="#fff" ' +
    'stroke-opacity=".22" stroke-width="1.3"/></svg>'
  );
}

/* ------------------------------------------------------------------ status */

function setStatus(kind, text, path) {
  const dot = $("statusDot");
  dot.className = "dot" + (kind === "scanning" ? " scanning" : kind === "bad" ? " bad" : "");
  $("statusText").textContent = text;
  $("statusPath").textContent = path || "";
}

function showError(message) {
  const banner = $("banner");
  banner.classList.remove("notice");
  if (!message) {
    banner.classList.remove("on");
    return;
  }
  banner.textContent = message;
  banner.classList.add("on");
}

/** The same banner, for something that worked. */
function showNotice(message) {
  const banner = $("banner");
  banner.textContent = message;
  banner.classList.add("on", "notice");
}

/* ------------------------------------------------------------------ render */

let current = null;
let selectedCategory = null;
/** Scenarios the current match asks for, ticked off as runs land. */
let pendingScenarios = [];

function render(data) {
  current = data;
  $("app").hidden = false;
  $("empty").hidden = true;
  $("whoami").hidden = false;

  const me = data.player.apogee;

  $("myBadge").innerHTML = badge(me.tier, "me");
  $("myTier").textContent = me.tier.name;
  $("myTier").style.color = me.tier.color;
  $("myRating").textContent = me.rating + " ±" + me.rd;
  $("myStreak").textContent = data.player.streak + "-day streak";

  $("heroBadge").innerHTML = badge(me.tier, "hero");
  $("heroName").textContent = me.tier.name;
  $("heroName").style.color = me.tier.color;
  $("heroMeta").textContent =
    "rating " + me.rating + " ±" + me.rd +
    "   ·   top " + (100 - me.percentile).toFixed(1) + "%" +
    "   ·   " + num(data.player.totalRuns) + " runs across " + data.player.scenarioCount + " scenarios";
  $("heroPlacement").textContent =
    "Placement is provisional: with no live population yet, your tier is estimated " +
    "from your " + data.benchmark.name + " " + data.benchmark.difficulty + " standing (" +
    data.player.benchmarkRank + ", " + num(data.player.benchmarkEnergy) + " energy).";

  renderCategories(data);

  // The snapshot carries an illustrative match with an invented opponent, which is
  // useful in the preview and dishonest in the real client. In the app it is shown only
  // until a genuine result exists, and is replaced by an empty state instead.
  if (HOST === "electron" && !hasRealResult) renderNoResultYet();
  else if (HOST !== "electron") renderResult(data);

  renderProfile(data);
  renderConsistency(data);
  renderQuests(data);

  $("footnote").textContent =
    (HOST === "electron"
      ? "Live from your KovaaK's stats folder. "
      : "Static preview. ") +
    "Every number here is computed from " + num(data.player.totalRuns) +
    " real runs; the opponent is synthetic. Snapshot " +
    new Date(data.generatedAt).toLocaleString() + ".";
}

function renderCategories(data) {
  const host = $("cats");
  host.textContent = "";
  if (selectedCategory === null) selectedCategory = data.weakest;

  ["Any"].concat(data.categories.map((c) => c.name)).forEach((name) => {
    const b = document.createElement("button");
    b.className = "cat";
    b.type = "button";
    b.textContent = name === data.weakest ? name + " · weakest" : name;
    b.setAttribute("aria-pressed", String(name === selectedCategory));
    b.addEventListener("click", () => {
      selectedCategory = name;
      Array.prototype.forEach.call(host.children, (c) =>
        c.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
      $("opponent").classList.remove("on");
      $("queueBtn").disabled = false;
      $("queueBtn").textContent = "Find opponent";
    });
    host.append(b);
  });
}

function showOpponent(data) {
  const m = data.match;
  const me = data.player.apogee;

  $("oppBadge").innerHTML = badge(m.opponent.tier, "opp");
  $("oppName").textContent = m.opponent.name;
  $("oppTier").textContent = m.opponent.tier.name + " · " + m.opponent.rating;
  $("oppTier").style.color = m.opponent.tier.color;
  $("oppAge").textContent = "stored run · 3 days ago";

  const p = m.winProbability;
  $("oddsBar").innerHTML =
    '<div style="flex:' + p + ';background:' + esc(me.tier.color) + '"></div>' +
    '<div style="flex:' + (1 - p) + ';background:' + esc(m.opponent.tier.color) + '"></div>';
  $("oddsYou").textContent = "you " + (p * 100).toFixed(0) + "%";
  $("oddsThem").textContent = (100 - p * 100).toFixed(0) + "% " + m.opponent.name;

  pendingScenarios = m.rounds.map((r) => ({ label: r.label, done: false }));
  renderTodo();

  $("opponent").classList.add("on");
}

function renderTodo() {
  const list = $("todoList");
  list.textContent = "";

  pendingScenarios.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = s.done ? "done" : "pending";
    li.innerHTML =
      '<span class="n">' + (s.done ? "✓" : i + 1) + "</span>" +
      "<span>" + esc(s.label) + "</span>" +
      (s.tier ? '<span class="tier-tag">' + esc(s.tier) + "</span>" : "");

    // Each scenario opens itself. KovaaK's reads its playlists at startup, so a playlist
    // written mid-session is not in the menu; a deep link needs nothing on disk and
    // nothing refreshed, and works whether or not the game is already running.
    if (!s.done && HOST === "electron" && window.apogee && window.apogee.launchScenario) {
      const play = document.createElement("button");
      play.type = "button";
      play.className = "scen-play";
      play.textContent = "Play";
      play.title = "Open " + s.label + " in KovaaK's";
      play.addEventListener("click", async () => {
        play.disabled = true;
        const prev = play.textContent;
        play.textContent = "Opening…";
        try {
          const r = await window.apogee.launchScenario(s.label);
          if (r && r.error) {
            showError(r.error);
            play.textContent = prev;
          } else {
            play.textContent = "Opened";
          }
        } finally {
          play.disabled = false;
        }
      });
      li.append(play);
    }

    list.append(li);
  });
}

function renderResult(data) {
  const m = data.match;
  const won = m.verdict === "win";

  $("verdictBig").textContent =
    won ? "Victory" : m.verdict === "draw" ? "Draw" : "Defeat";
  $("verdictBig").style.color =
    won ? "var(--up)" : m.verdict === "draw" ? "var(--ink)" : "var(--down)";
  $("verdictScores").textContent =
    pct(m.playerMatchScore) + " vs " + pct(m.opponentMatchScore) + " against baseline" +
    (m.ratingWeight < 1 ? "   ·   reduced weight (provisional baselines)" : "");
  $("ratingMove").textContent = won ? "+18 SR" : "−14 SR";
  $("ratingMove").style.color = won ? "var(--up)" : "var(--down)";
  $("explain").textContent = m.explanation;

  const body = $("roundsBody");
  body.textContent = "";
  m.rounds.forEach((r) => {
    const youWon = r.you.delta > r.them.delta;
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + esc(r.label) + "</td>" +
      "<td>" + num(r.you.score) + '<div class="base">base ' + num(r.you.baseline) + "</div></td>" +
      '<td class="' + (r.you.delta >= 0 ? "up" : "down") + '">' + pct(r.you.delta) + "</td>" +
      "<td>" + num(r.them.score) + '<div class="base">base ' + num(r.them.baseline) + "</div></td>" +
      '<td class="' + (r.them.delta >= 0 ? "up" : "down") + '">' + pct(r.them.delta) + "</td>" +
      '<td class="' + (youWon ? "won-round" : "") + '">' + (youWon ? "won" : "lost") + "</td>";
    body.append(tr);
  });
}

/** True once a genuine match has settled in this session. */
let hasRealResult = false;

/** Empty state for the result tab before any real match has been played. */
function renderNoResultYet() {
  $("verdictBig").textContent = "No matches yet";
  $("verdictBig").style.color = "var(--ink-mid)";
  $("verdictScores").textContent =
    "Queue for a category, play the three scenarios, and the result lands here.";
  $("ratingMove").textContent = "";
  $("explain").textContent =
    "Matches are decided on how far above your own baseline you played, not on raw " +
    "score, so both players get a real contest whatever their rank.";
  $("roundsBody").textContent = "";
}

/**
 * Render a real settled match.
 *
 * Distinct from `renderResult`, which draws the snapshot's illustrative match. This one
 * shows what actually happened, including the rating change and each run's verification
 * tier, because a player is entitled to see why a result went the way it did.
 */
function renderSettled(s) {
  hasRealResult = true;
  const won = s.verdict === "win";
  const isVoid = s.verdict === "void";

  $("verdictBig").textContent = isVoid
    ? "Void"
    : won ? "Victory" : s.verdict === "draw" ? "Draw" : "Defeat";
  $("verdictBig").style.color = isVoid
    ? "var(--ink-mid)"
    : won ? "var(--up)" : s.verdict === "draw" ? "var(--ink)" : "var(--down)";

  $("verdictScores").textContent = isVoid
    ? (s.voidReason || "match could not be settled")
    : pct(s.yourMatchScore ?? 0) + " vs " + pct(s.theirMatchScore ?? 0) +
      " against baseline" +
      (s.ratingWeight < 1 ? `   ·   ${Math.round(s.ratingWeight * 100)}% weight (provisional)` : "");

  const change = s.ratingChange;
  $("ratingMove").textContent = isVoid
    ? "no change"
    : `${change >= 0 ? "+" : "−"}${Math.abs(change)} · ${s.ratingAfter}`;
  $("ratingMove").style.color = isVoid
    ? "var(--ink-dim)"
    : change > 0 ? "var(--up)" : change < 0 ? "var(--down)" : "var(--ink-mid)";

  $("explain").textContent = s.explanation;

  const body = $("roundsBody");
  body.textContent = "";
  s.rounds.forEach((r) => {
    const yours = r.delta ?? 0;
    const theirs = r.opponentDelta ?? 0;
    const youWon = r.counted && yours > theirs;
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + esc(r.scenario) + "</td>" +
      "<td>" + num(r.score) + '<div class="base">base ' + num(r.baseline) +
        (r.verificationTier && r.verificationTier !== "verified"
          ? " · " + esc(r.verificationTier)
          : "") +
        "</div></td>" +
      '<td class="' + (yours >= 0 ? "up" : "down") + '">' +
        (r.counted ? pct(yours) : "—") + "</td>" +
      "<td>—</td>" +
      '<td class="' + (theirs >= 0 ? "up" : "down") + '">' + pct(theirs) + "</td>" +
      '<td class="' + (youWon ? "won-round" : "") + '">' +
        (r.counted ? (youWon ? "won" : "lost") : esc(r.excludedReason || "excluded")) +
      "</td>";
    body.append(tr);
  });
}

function renderProfile(data) {
  $("weakNote").textContent = data.weakest + " is your weakest category";

  const maxEnergy = Math.max.apply(null, data.categories.map((c) => c.energy));
  const wmap = $("wmap");
  wmap.textContent = "";

  data.categories.forEach((cat) => {
    const colour = data.benchmark.rankColors[cat.rankName] || "#8892a4";
    const row = document.createElement("div");
    row.className = "wrow";
    row.innerHTML =
      '<div class="lbl">' + esc(cat.name) + "</div>" +
      '<div class="wtrack"><div class="wfill" style="width:' +
        ((cat.energy / maxEnergy) * 100).toFixed(1) +
        "%;background:linear-gradient(90deg," + esc(colour) + "40," + esc(colour) + ')"></div></div>' +
      '<div class="wval">' + num(cat.energy) + " · " + esc(cat.rankName || "—") + "</div>";
    wmap.append(row);
  });

  const body = $("scenBody");
  body.textContent = "";
  data.categories
    .reduce((all, c) => all.concat(c.scenarios), [])
    .sort((a, b) => a.energy - b.energy)
    .forEach((s) => {
      const colour = data.benchmark.rankColors[s.rankName] || "var(--ink-dim)";
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + esc(s.label) + "</td>" +
        "<td>" + esc(s.subCategory || "—") + "</td>" +
        "<td>" + (s.score ? num(s.score) : "—") + "</td>" +
        '<td style="color:' + esc(colour) + '">' + esc(s.rankName || "—") + "</td>" +
        "<td>" + num(s.energy) + "</td>" +
        "<td>" + s.runs + "</td>" +
        "<td>" +
          (s.gap != null
            ? "+" + num(s.gap) + " → " + esc(s.nextRankName)
            : '<span style="color:var(--ink-dim)">max</span>') +
        "</td>";
      body.append(tr);
    });
}

/**
 * Ceiling versus floor.
 *
 * Both ranks come from the same Voltaic energy engine; only the score fed in differs.
 * That is what makes "Diamond ceiling, Platinum floor" a real statement rather than a
 * figure of speech.
 */
function renderConsistency(data) {
  const c = data.consistency;
  if (!c) return;

  const colorOf = (rank) => data.benchmark.rankColors[rank] || "var(--ink-mid)";

  $("ceilRank").textContent = c.ceilingRank || "unranked";
  $("ceilRank").style.color = colorOf(c.ceilingRank);
  $("ceilEnergy").textContent = num(c.ceilingEnergy) + " energy";

  $("floorRank").textContent = c.floorRank || "unranked";
  $("floorRank").style.color = colorOf(c.floorRank);
  $("floorEnergy").textContent = num(c.floorEnergy) + " energy";

  $("gapVal").textContent = (c.gap * 100).toFixed(1) + "%";

  const body = $("consistencyBody");
  body.textContent = "";

  const worst = c.scenarios.length ? c.scenarios[0].gap : 1;

  c.scenarios.forEach((s) => {
    // Bar width is relative to the worst gap, so the ordering is legible at a glance
    // rather than every row looking similar.
    const width = worst > 0 ? Math.max(2, (s.gap / worst) * 90) : 2;
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + esc(s.label) + "</td>" +
      "<td>" + num(s.ceiling) + "</td>" +
      '<td style="color:var(--ink-dim)">' + num(s.median) + "</td>" +
      "<td>" + num(s.floor) + "</td>" +
      "<td>" + (s.gap * 100).toFixed(1) + "%</td>" +
      '<td><span class="gapbar" style="width:' + width.toFixed(0) + 'px"></span></td>';
    body.append(tr);
  });
}

function renderQuests(data) {
  const host = $("questList");
  host.textContent = "";
  data.quests.forEach((q, i) => {
    // Floor quests get a single consistent colour rather than one from the rank ramp:
    // they are a different kind of ask, and looking different is the point.
    const colour = q.isFloor
      ? "var(--warn)"
      : data.theme[Math.min(data.theme.length - 1, 3 + i)].color;

    const el = document.createElement("div");
    el.className = "quest" + (q.isFloor ? " quest-floor" : "");

    // "4 of 5 runs" says what is left far better than "80%" on a quest whose whole
    // point is that every run in the window has to clear the bar.
    const counter = q.steps
      ? '<span class="qsteps">' + q.steps.done + " of " + q.steps.total + " runs</span>"
      : "";

    el.innerHTML =
      "<div><h3>" + esc(q.title) +
        (q.isFloor ? '<span class="floor-tag">floor</span>' : "") +
        "</h3><p>" + esc(q.detail) + "</p></div>" +
      '<div class="xp">' + counter + q.xp + " XP</div>" +
      '<div class="qtrack"><div class="qfill" style="width:' +
        (q.progress * 100).toFixed(1) + "%;background:" + esc(colour) + '"></div></div>';
    host.append(el);
  });
}

/* ------------------------------------------------- quest completion */

/**
 * Completions queue rather than overwrite.
 *
 * Finishing the fifth run of a set can complete two quests at once, and a card that
 * silently replaced the previous one would rob the player of an award they earned.
 */
const celebrationQueue = [];
let celebrating = false;

function showCelebration(payload) {
  celebrationQueue.push(payload);
  if (!celebrating) nextCelebration();
}

function nextCelebration() {
  const payload = celebrationQueue.shift();
  if (!payload) {
    celebrating = false;
    $("celebrate").hidden = true;
    return;
  }

  celebrating = true;
  const { quest, level } = payload;

  const isFloor =
    quest.kind === "floor_rank_up" ||
    quest.kind === "close_the_spread" ||
    quest.kind === "no_disasters";

  $("celebrateKicker").textContent = isFloor ? "Floor raised" : "Quest complete";
  $("celebrateTitle").textContent = quest.title;
  $("celebrateDetail").textContent = quest.detail;
  $("celebrateXp").textContent = "+" + quest.xp + " XP";

  $("celebrateLevel").textContent = "Level " + level.level;
  $("celebrateLevelXp").textContent =
    level.xpIntoLevel.toLocaleString() + " / " + level.xpForNextLevel.toLocaleString();

  $("celebrate").hidden = false;
  // Fill from zero so the bar visibly moves rather than appearing already full.
  $("celebrateFill").style.width = "0%";
  requestAnimationFrame(() => {
    $("celebrateFill").style.width = (level.progress * 100).toFixed(1) + "%";
  });

  // More waiting? Say so, so the button does not look like it dismissed them all.
  $("celebrateClose").textContent =
    celebrationQueue.length > 0 ? `Next (${celebrationQueue.length} more)` : "Nice";
}

function renderProgression(p) {
  const chip = $("levelChip");
  if (!chip) return;
  chip.hidden = false;
  chip.textContent =
    `lvl ${p.level.level} · ${p.level.xpIntoLevel.toLocaleString()}/` +
    `${p.level.xpForNextLevel.toLocaleString()} xp`;
  chip.title = `${p.totalXp.toLocaleString()} XP lifetime · ${p.completedToday} quest(s) done today`;
}

/* ------------------------------------------------------------------ toast */

let toastTimer = null;
function showRunToast(run) {
  $("toastScen").textContent = run.scenario;
  $("toastScore").textContent = num(run.score);
  $("toast").classList.add("on");

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("on"), 4200);

  // Tick the scenario off the match to-do list if it was one we asked for.
  let changed = false;
  pendingScenarios.forEach((s) => {
    if (!s.done && run.scenario.indexOf(s.label) !== -1) {
      s.done = true;
      changed = true;
    }
  });
  if (changed) renderTodo();
}

/* ------------------------------------------------------------------ wiring */

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", "false"));
    tab.setAttribute("aria-selected", "true");
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    $("screen-" + tab.dataset.screen).classList.add("active");
  });
});

/* ------------------------------------------------------------------ match */

/** The live match, once one has been found. Null between matches. */
let activeMatch = null;

/**
 * Render the opponent and the scenarios to play.
 *
 * Takes a real match from the server when there is one, and falls back to the snapshot's
 * illustrative match only in the static preview, where no server exists.
 */
function showRealMatch(match, data) {
  const me = data.player.apogee;

  // A seeding match has no opponent: the pool was empty, so the server handed out three
  // scenarios to play against nobody. Everything downstream is identical, which is the
  // point, so only the opponent card changes.
  if (match.seeding || !match.opponent) {
    $("oppBadge").innerHTML = badge(me.tier, "opp");
    $("oppName").textContent = "No opponent yet";
    $("oppTier").textContent = "seeding the pool";
    $("oppTier").style.color = me.tier.color;
    $("oppAge").textContent =
      match.poolSize == null
        ? "match already in progress"
        : match.poolSize === 0
          ? "you are first in this category"
          : `pool of ${match.poolSize}, none close enough to your rating`;

    // No odds to show against nobody, and a half-filled bar would imply a coin flip.
    $("oddsBar").innerHTML =
      '<div style="flex:1;background:' + esc(me.tier.color) + ';opacity:.25"></div>';
    $("oddsYou").textContent = "unrated";
    $("oddsThem").textContent = "nothing at stake";
  } else {
    const oppTier = data.match.opponent.tier;

    $("oppBadge").innerHTML = badge(oppTier, "opp");
    $("oppName").textContent = match.opponent.displayName;
    $("oppTier").textContent = `rating ${match.opponent.rating}` +
      (match.opponent.provisional ? " · provisional" : "");
    $("oppTier").style.color = oppTier.color;

    const played = new Date(match.opponent.playedAt);
    const days = Math.max(0, Math.round((Date.now() - played.getTime()) / 86400000));
    $("oppAge").textContent =
      `stored run · ${days === 0 ? "today" : days === 1 ? "yesterday" : days + " days ago"}` +
      ` · pool of ${match.poolSize}`;

    const p = match.winProbability ?? 0.5;
    $("oddsBar").innerHTML =
      '<div style="flex:' + p + ';background:' + esc(me.tier.color) + '"></div>' +
      '<div style="flex:' + (1 - p) + ';background:' + esc(oppTier.color) + '"></div>';
    $("oddsYou").textContent = "you " + (p * 100).toFixed(0) + "%";
    $("oddsThem").textContent = (100 - p * 100).toFixed(0) + "% " + match.opponent.displayName;
  }

  pendingScenarios = match.scenarios.map((s) => ({
    id: s.id,
    label: s.name,
    done: false,
    tier: null,
  }));
  renderTodo();

  // A new match means a new playlist to write, so the button goes back to offering it.
  $("playMatchBtn").textContent = "Play in KovaaK's";
  $("playMatchBtn").disabled = false;
  $("matchHint").textContent = match.resumed
    ? "You already had this match open. Finish it, or abandon it to queue again."
    : match.seeding || !match.opponent
      ? "Nothing is rated yet. Play these three and your run set becomes the first " +
        "entry in the pool. Only your first run on each counts."
      : "Only your first run on each scenario counts. Apogee picks them up automatically.";

  $("matchActions").hidden = false;
  $("opponent").classList.add("on");
}

$("queueBtn").addEventListener("click", async () => {
  if (!current) return;

  const btn = $("queueBtn");

  if (HOST !== "electron") {
    // No server in the preview; show the illustrative match instead.
    showOpponent(current);
    return;
  }

  btn.disabled = true;
  btn.textContent = "Searching…";
  $("searching").classList.add("on");
  $("opponent").classList.remove("on");
  showError(null);

  const result = await window.apogee.findMatch(selectedCategory, current.benchmark.difficulty);

  $("searching").classList.remove("on");
  btn.disabled = false;

  if (result.error) {
    btn.textContent = "Find opponent";
    showError(result.error);
    return;
  }

  // Neither an empty pool nor an existing match is an error now: the server hands back
  // a seeding match for the first, and the match you already have for the second, so
  // there is always something on screen and always a way out of it.
  btn.textContent = result.match.resumed
    ? "Match already open"
    : result.match.seeding
      ? "Seeding the pool"
      : "Match in progress";
  activeMatch = result.match;
  showRealMatch(result.match, current);
});

/* ------------------------------------------------------------------ account */

function renderSession(session, configured) {
  const btn = $("btnSignIn");
  const panel = $("signedIn");
  if (!btn || !panel) return;

  // The header holds the sign-in control, so it has to be visible before there is any
  // snapshot to show. Otherwise a new user with no stats yet has nothing to click.
  $("whoami").hidden = false;

  if (session) {
    btn.hidden = true;
    panel.hidden = false;
    $("accountName").textContent = session.displayName;
    // The SteamID is shown truncated: enough to confirm the right account is linked,
    // without putting a full identifier on screen during a stream.
    $("accountSteam").textContent = `steam …${String(session.steamId).slice(-6)}`;
    return;
  }

  panel.hidden = true;
  btn.hidden = false;
  btn.disabled = !configured;
  btn.textContent = configured ? "Sign in with Steam" : "Sign-in unavailable";
  btn.title = configured
    ? "Opens your browser to authenticate with Steam"
    : "This build has no Supabase settings. Fill in .env and rebuild.";
}

if (HOST === "electron") {
  const api = window.apogee;

  $("btnRescan").addEventListener("click", () => api.rescan());
  $("btnOpen").addEventListener("click", () => api.openStatsFolder());
  const choose = () => api.chooseFolder();
  $("btnChoose").addEventListener("click", choose);
  $("emptyChoose").addEventListener("click", choose);

  $("btnSignIn").addEventListener("click", async () => {
    const result = await api.signIn();
    if (result && result.error) showError(result.error);
  });

  $("btnSignOut").addEventListener("click", async () => {
    await api.signOut();
  });

  api.onSession((session) => {
    renderSession(session, true);
    // Uploading only makes sense once there is an account to attach runs to.
    $("uploadRow").hidden = !session;
  });

  // ---- history upload ----------------------------------------------------
  $("uploadBtn").addEventListener("click", async () => {
    const btn = $("uploadBtn");
    btn.disabled = true;
    $("uploadTrack").hidden = false;
    showError(null);

    const result = await api.uploadHistory();

    btn.disabled = false;
    if (result.error) {
      showError(result.error);
      return;
    }

    const r = result.result;
    const b = result.baselines;
    $("uploadTitle").textContent = "History uploaded";
    $("uploadSub").textContent =
      `${r.uploaded.toLocaleString()} runs on the server` +
      (b ? ` · ${b.solid} baselines ready` : "") +
      (r.skipped ? ` · ${r.skipped} unreadable files skipped` : "") +
      (r.errors.length ? ` · ${r.errors.length} batch error(s)` : "");
    btn.textContent = "Upload again";
    if (r.errors.length) showError(r.errors[0]);
  });

  api.onUploadProgress((p) => {
    if (p.phase === "baselines") {
      $("uploadFill").style.width = "100%";
      $("uploadSub").textContent = "Computing your baselines…";
      return;
    }
    const pct = p.total ? (p.uploaded / p.total) * 100 : 0;
    $("uploadFill").style.width = pct.toFixed(1) + "%";
    $("uploadSub").textContent =
      `${p.uploaded.toLocaleString()} of ${p.total.toLocaleString()} runs` +
      ` · batch ${p.batch}/${p.batches}`;
  });

  // ---- match lifecycle ---------------------------------------------------
  api.onMatch((match) => {
    activeMatch = match;
    if (!match) {
      $("opponent").classList.remove("on");
      $("matchActions").hidden = true;
      $("queueBtn").textContent = "Find opponent";
      $("queueBtn").disabled = false;
    }
  });

  api.onMatchProgress((p) => {
    if (p.status === "submitted") {
      const s = pendingScenarios.find((x) => x.id === p.scenarioId);
      if (s) {
        s.done = true;
        s.tier = p.verificationTier;
        renderTodo();
      }
      $("matchHint").textContent = p.remaining && p.remaining.length
        ? `${p.remaining.length} scenario(s) left`
        : "All runs in. Settling…";
    } else if (p.status === "failed") {
      showError(`Could not submit that run: ${p.message}`);
    } else if (p.status === "already-submitted") {
      $("matchHint").textContent = p.message;
    }
  });

  api.onMatchSettled((settled) => {
    activeMatch = null;
    $("matchActions").hidden = true;
    $("opponent").classList.remove("on");
    $("queueBtn").textContent = "Find opponent";
    $("queueBtn").disabled = false;
    renderSettled(settled);

    // Jump to the result, because that is the payoff and nobody should have to hunt
    // for it after finishing three scenarios.
    document.querySelector('.tab[data-screen="result"]').click();
  });

  // Abandoning a contested match is a forfeit and costs a loss, so it asks first. A
  // seeding match has no opponent and costs nothing, so it does not.
  $("cancelMatchBtn").addEventListener("click", async () => {
    const contested = activeMatch && !activeMatch.seeding && activeMatch.opponent;

    if (contested) {
      const name = activeMatch.opponent.displayName;
      const ok = window.confirm(
        `Forfeit this match against ${name}?\n\n` +
          "It counts as a loss and your rating drops. You can queue again straight away.",
      );
      if (!ok) return;
    }

    const btn = $("cancelMatchBtn");
    btn.disabled = true;
    btn.textContent = "Ending…";

    try {
      const result = await api.cancelMatch();

      if (result && result.error) showError(result.error);
      else if (result && result.rated) {
        showError(null);
        showNotice(
          `Forfeited. ${result.ratingBefore} → ${result.ratingAfter} (${result.ratingChange})`,
        );
      } else if (result && result.message) {
        showError(null);
        showNotice(result.message);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = "Abandon match";
      $("queueBtn").textContent = "Find opponent";
      $("queueBtn").disabled = false;
      $("opponent").classList.remove("on");
      activeMatch = null;
    }
  });

  // Writes the three scenarios into KovaaK's as a playlist, then starts the game.
  //
  // Two steps, not one, because KovaaK's registers no URL scheme: nothing can launch it
  // straight into a scenario, so the playlist has to be waiting on disk. The button says
  // what the player then has to do rather than pretending the game opened itself.
  $("playMatchBtn").addEventListener("click", async () => {
    const btn = $("playMatchBtn");

    // The shareable preview runs this same file with no main process behind it.
    if (HOST !== "electron" || !api.launchMatch) {
      $("matchHint").textContent =
        "Launching KovaaK's only works in the desktop app.";
      return;
    }

    btn.disabled = true;
    btn.textContent = "Starting…";

    try {
      const result = await api.launchMatch();

      if (result && result.error) {
        showError(result.error);
        btn.textContent = "Play in KovaaK's";
        return;
      }

      // KovaaK's opens directly in the first scenario. The other two are in the
      // playlist, which is the only way to reach them: a local playlist cannot be
      // deep-linked, only a published one.
      $("matchHint").textContent = !result.launched
        ? `Playlist "${result.playlistName}" is ready, but Steam did not start the game. ` +
          "Launch KovaaK's yourself and pick it from Playlists."
        : result.jumpedTo
          ? `Opening ${result.jumpedTo}. For the other two, open Playlists and pick ` +
            `"${result.playlistName}".`
          : `In KovaaK's, open Playlists and pick "${result.playlistName}".`;

      // Back to an offer, not a state. Left reading "Opening KovaaK's" it looks stuck,
      // and pressing it again is a reasonable thing to want.
      btn.textContent = "Play in KovaaK's";
    } catch (err) {
      showError(String(err));
      btn.textContent = "Play in KovaaK's";
    } finally {
      // Re-enable regardless: writing again is harmless and is the obvious thing to try
      // if the game was already running when the playlist landed.
      btn.disabled = false;
    }
  });

  // ---- quests ------------------------------------------------------------
  api.onProgression(renderProgression);
  api.onQuestComplete(showCelebration);

  $("celebrateClose").addEventListener("click", nextCelebration);

  // Escape dismisses, because a modal that traps you is worse than no modal.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("celebrate").hidden) nextCelebration();
  });

  api.onSigningIn(({ signingIn }) => {
    const btn = $("btnSignIn");
    btn.disabled = signingIn;
    btn.textContent = signingIn ? "Check your browser…" : "Sign in with Steam";
    if (!signingIn) $("signinHelp").hidden = true;
  });

  // If the browser does not appear, the flow is still completable by hand. Showing the
  // link turns a dead end into an inconvenience.
  api.onSignInUrl(({ url }) => {
    const help = $("signinHelp");
    help.hidden = false;
    $("signinLink").textContent = url;
    $("signinLink").dataset.url = url;
  });

  $("signinCopy").addEventListener("click", async () => {
    const url = $("signinLink").dataset.url || "";
    try {
      await navigator.clipboard.writeText(url);
      $("signinCopy").textContent = "Copied";
    } catch {
      $("signinCopy").textContent = "Select and copy";
    }
    setTimeout(() => { $("signinCopy").textContent = "Copy link"; }, 1800);
  });

  api.onSnapshot((snapshot) => {
    showError(null);
    render(snapshot);
    setStatus("ok", "Watching", snapshot ? currentPath : "");
  });

  api.onRun((run) => showRunToast(run));

  api.onScanning(({ scanning }) => {
    setStatus(scanning ? "scanning" : "ok", scanning ? "Scanning…" : "Watching", currentPath);
  });

  api.onError((message) => {
    showError(message);
    setStatus("bad", "Problem", currentPath);
  });

  var currentPath = "";
  api.getState().then((state) => {
    currentPath = state.statsDir || "";
    renderSession(state.session, state.configured);
    if (state.snapshot) {
      render(state.snapshot);
      setStatus("ok", "Watching", currentPath);
    } else {
      setStatus(state.lastError ? "bad" : "scanning", state.lastError ? "Problem" : "Scanning…", currentPath);
      if (state.lastError) {
        showError(state.lastError);
        $("emptyText").textContent = state.lastError;
      }
    }
  });
} else {
  // Static preview: the snapshot is inlined, and neither folder controls nor sign-in
  // apply without a main process behind them.
  //
  // The controls are removed rather than merely hidden. A disabled-looking button that
  // silently does nothing reads as a broken app, and a preview shared with someone else
  // gives them no way to know the difference.
  $("status").remove();
  const account = $("account");
  if (account) account.remove();

  const note = $("previewNote");
  if (note) note.hidden = false;

  render(window.__APOGEE_SNAPSHOT__);
}
