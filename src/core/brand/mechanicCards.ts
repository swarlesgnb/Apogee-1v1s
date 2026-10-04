/**
 * The share cards for the new mechanics: Apogee Daily, a crown taken or defended, a planted
 * flag answered, and a match against a Shadow with the Shadow ladder behind it.
 *
 * Same contract as shareCard.ts, and drawn with its pieces: a pure function from a typed
 * input (shareInput.ts says where each comes from) to SVG, no Node or DOM, the palette and
 * the insignia passed in, both sizes (1200x675 for a link preview, 1080x1920 for a story).
 * The lockup, the sky, the corner wash, the registration marks, the orbit and the round
 * rows are the result card's own, so the four read as more of the same family rather than
 * four new designs.
 *
 * The rules the result card keeps, these keep:
 *
 * - A card that shows rounds (crown, flag) shows every round's raw score, baseline and
 *   delta for both sides, through the same landscapeRounds()/portraitRounds(). When the
 *   server sent only the two match scores (a Flag answered while you were away, a Crown
 *   defence read from its notice), the card shows those two, side by side, and says
 *   nothing about rounds it was not given.
 * - The daily never names a scenario. It cannot: DailyCardInput has no field for one. Each
 *   scenario is a numbered tile with a mark, coded by shape as well as colour (a triangle
 *   up, a disc, a triangle down), so it survives a colour-blind viewer and a greyscale
 *   repost.
 * - A Shadow card says what the queue says (core/match/shadow.ts): each Shadow is a
 *   percentile day on its own tile, the placement is the queue board's read-out in the
 *   app's words ("about the 53rd percentile from 5 Shadows", or "shows after 3"), and
 *   nothing on it is a tier or a rating, because a Shadow moves neither. "Synthetic,
 *   unrated" is in the kicker.
 * - Anything a player names (a player, a category, a band) carries a fit budget, and the
 *   rasteriser fails the render if it still leaves the canvas.
 */

import { mechanicEmblemSvg, type MechanicId } from "./mechanics.ts";
import type { BrandPalette } from "./palette.ts";
import { ordinalSuffix, shadowLabel } from "../match/shadow.ts";
import {
  SHARE_CARD_SIZES,
  dateLine,
  defs,
  deltaColour,
  esc,
  fmtDelta,
  landscapeRounds,
  lockup,
  orbit,
  placeSvg,
  portraitRounds,
  ratingChangeLine,
  registration,
  shareCardSvg,
  starInk,
  starfield,
  text,
  type CardLayout,
  type ShareCardOptions,
} from "./shareCard.ts";
import type { AnyCardInput, CrownCardInput, DailyCardInput, DailyMark, FlagCardInput, MechanicCardInput, ShadowCardInput } from "./shareInput.ts";

// ---------------------------------------------------------------- words

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** "3 Oct", for the places a year would only crowd the line. */
function shortDate(iso: string | null | undefined): string {
  const full = dateLine(iso);
  return full.replace(/ \d{4}$/, "");
}

function daysBetween(a: string, b: string): number {
  const t = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.max(0, Math.round((t(b) - t(a)) / 86_400_000));
}

/** "3 won, 1 lost" over the tiles on the card; an abandoned Shadow match is a loss, as the ladder counts it. */
function record(series: ShadowCardInput["series"]): string {
  const w = series.filter((m) => m.verdict === "win").length;
  const l = series.filter((m) => m.verdict === "loss" || m.verdict === "forfeit").length;
  const d = series.filter((m) => m.verdict === "draw").length;
  return [`${w} won`, `${l} lost`, d ? `${d} level` : ""].filter(Boolean).join(", ");
}

const signedRating = (n: number) => { const c = Math.round(n); return c > 0 ? `+${c}` : c < 0 ? `−${-c}` : "±0"; };

const latest = (input: ShadowCardInput) => input.series[input.series.length - 1];

/** The app's words for a Shadow result (queue-board.js), short enough for a headline. */
const SHADOW_VERDICT = { win: "Shadow beaten", loss: "Shadow wins", draw: "Level", forfeit: "Abandoned" } as const;
const SHADOW_TILE = { win: "Won", loss: "Lost", draw: "Level", forfeit: "Forfeit" } as const;

/** "49th-percentile day": the Shadow's own label (core/match/shadow.ts) without its article. */
const dayLabel = (percentile: number) => shadowLabel(percentile).replace(/^an? /, "");

function matchLine(ms: { you: number | null; them: number | null } | null | undefined): string {
  return ms && (ms.you != null || ms.them != null) ? `Match ${fmtDelta(ms.you)} vs ${fmtDelta(ms.them)}` : "";
}

export function mechanicHeadline(input: MechanicCardInput): string {
  switch (input.kind) {
    case "daily":
      return `Daily #${input.number}`;
    case "crown":
      return input.event === "taken" ? "Crown taken" : "Crown defended";
    case "flag":
      return input.verdict === "win" ? "Flag held" : input.verdict === "loss" ? "Flag lost" : "Draw";
    case "shadow":
      return SHADOW_VERDICT[latest(input).verdict];
  }
}

function kicker(input: MechanicCardInput): string {
  switch (input.kind) {
    case "daily":
      return ["Apogee Daily", input.band].filter(Boolean).join(" · ");
    case "crown":
      // Crown matches are unrated (core/crowns), and the card says so as a ghost card does.
      return ["Crown", input.category, "unrated"].filter(Boolean).join(" · ");
    case "flag":
      return ["Flag answered", input.category].filter(Boolean).join(" · ");
    case "shadow":
      // Named as the queue names it everywhere: synthetic, and no rating moved.
      return ["Shadow match", input.category, "synthetic, unrated"].filter(Boolean).join(" · ");
  }
}

function headlineFill(input: MechanicCardInput, p: BrandPalette): string {
  if (input.kind === "crown") return p.up;
  if (input.kind === "flag") return input.verdict === "win" ? p.up : input.verdict === "loss" ? p.down : p.ink;
  if (input.kind === "shadow") return latest(input).verdict === "win" ? p.up : latest(input).verdict === "loss" ? p.down : p.ink;
  return p.ink;
}

/** The name line: who, and against whom when somebody was on the other side. */
function nameLine(input: MechanicCardInput): string {
  const me = input.player.name;
  if (input.kind === "crown" && input.rival) return `${me}  vs  ${input.rival.name}`;
  if (input.kind === "flag") return `${me}  vs  ${input.challenger.name}`;
  if (input.kind === "shadow") return `${me}  vs  ${shadowLabel(latest(input).percentile)}`;
  return me;
}

/** The figures under the names, one string per line (landscape joins them). */
function figureLines(input: MechanicCardInput): string[] {
  switch (input.kind) {
    case "daily": {
      const played = input.marks.filter((m) => m !== "pending").length;
      return [
        // Every round a first run: nothing to compare yet, as the Daily's share text says.
        input.meanDelta == null ? "Baselines set today" : `Mean ${fmtDelta(input.meanDelta)} over own baselines`,
        played < input.marks.length ? `${played} of ${input.marks.length} played` : "",
        input.provisional ? "provisional baselines" : "",
        input.percentile != null ? `Top ${Math.max(1, Math.ceil(100 - input.percentile))}% today` : "",
      ].filter(Boolean);
    }
    case "crown": {
      const reign = input.event === "taken"
        ? input.rival && input.rivalReignDays != null ? `Ends a ${input.rivalReignDays}-day reign` : ""
        : input.heldSince ? `Held since ${shortDate(input.heldSince)}` : "";
      // Without rounds the two match scores are the card's body; they are not said twice.
      return [input.rounds.length ? matchLine(input.matchScore) : "", reign].filter(Boolean);
    }
    case "flag":
      return [
        input.rounds.length ? matchLine(input.matchScore) : "",
        // The queue board sends the change and not the rating it moved to.
        input.player.rating == null && input.player.ratingChange != null ? `Rated · ${signedRating(input.player.ratingChange)} rating` : ratingChangeLine(input.player.rating, input.player.ratingChange),
        input.standing != null ? `${plural(input.standing, "flag")} still standing` : "",
      ].filter(Boolean);
    case "shadow":
      return [
        matchLine(latest(input).matchScore),
        record(input.series),
        input.streak > 1 ? `Shadow streak ${input.streak}` : "",
      ].filter(Boolean);
  }
}

/** Under the emblem: one line in the accent, one caption. */
function emblemWords(input: MechanicCardInput): [string, string] {
  switch (input.kind) {
    case "daily":
      return [`Streak ${plural(input.streak, "day")}`, "Same draw for everyone"];
    case "crown":
      return [`${input.band} band`, input.event === "taken" ? "New holder" : plural(input.defences, "defence")];
    case "flag": {
      const d = daysBetween(input.plantedAt, input.answeredAt);
      return [d === 0 ? "Answered the same day" : `Stood ${plural(d, "day")}`, `Planted ${shortDate(input.plantedAt)} · answered ${shortDate(input.answeredAt)}`];
    }
    case "shadow": {
      // The queue board's read-out, in queue-board.js's words.
      const pl = input.placement;
      if (pl?.kind === "read") return [`About the ${ordinalSuffix(pl.estimate)} percentile`, `Placement from ${plural(pl.decided, "Shadow")}`];
      if (pl?.kind === "pending") return [`${pl.decided} of ${pl.needed} Shadow results`, `Placement shows after ${pl.needed}`];
      return ["Shadow ladder", "Synthetic · moves no rating"];
    }
  }
}

function ruleLine(input: MechanicCardInput): string {
  switch (input.kind) {
    case "daily":
      return `Each mark is a run against the player's own baseline (near: within ±${(input.nearBand * 100).toFixed(1)}%). No scenario is named.`;
    case "shadow":
      return "A Shadow is a day at a stated percentile of genuine match scores, against own baselines. It moves no rating.";
    case "crown":
      // A Crown is decided on match score against the holder's stored set (core/crowns).
      return input.rounds.length
        ? "Raw scores from KovaaK's stats. The Crown goes to the higher match score; a tie stays with the holder."
        : "A match score is the mean gain over the player's own baselines. The higher one takes the Crown; a tie stays with the holder.";
    default:
      return input.rounds.length
        ? "Raw scores from KovaaK's stats. A round goes to whoever beat their own baseline by more."
        : "A match score is the mean gain over the player's own baselines, from raw scores in KovaaK's stats.";
  }
}

/**
 * The two match scores of a crown or flag result whose rounds the server did not send, as
 * two panels: this player's side, then the other. The side that won carries the up bar.
 */
function scorePanels(p: BrandPalette, input: CrownCardInput | FlagCardInput, box: { x: number; y: number; w: number; h: number }, scale: number, stacked: boolean): string {
  const ms = input.matchScore ?? { you: null, them: null };
  const rival = input.kind === "crown" ? input.rival?.name ?? "Holder" : input.challenger.name;
  const roles = input.kind === "flag" ? ["planted set", "answer"] : input.event === "taken" ? ["challenger", "holder"] : ["holder", "challenger"];
  // A crown result is always the player's to keep (taken or held); a flag can go either way.
  const youWon = input.kind === "crown" ? true : input.verdict === "win";
  const level = input.kind === "flag" && input.verdict === "draw";
  const sides = [
    { name: input.player.name, role: roles[0], score: ms.you, won: youWon && !level },
    { name: rival, role: roles[1], score: ms.them, won: !youWon && !level },
  ];
  const gap = 16 * scale;
  const w = stacked ? box.w : (box.w - gap) / 2;
  const h = stacked ? (box.h - gap) / 2 : box.h;
  const out: string[] = [];
  sides.forEach((side, i) => {
    const x = box.x + (stacked ? 0 : i * (w + gap));
    const y = box.y + (stacked ? i * (h + gap) : 0);
    const pad = 22 * scale;
    out.push(panel(p, x, y, w, h, 8 * scale));
    out.push(`<rect x="${x}" y="${y + 14 * scale}" width="${3 * scale}" height="${h - 28 * scale}" rx="${1.5 * scale}" fill="${level ? p.inkMid : side.won ? p.up : p.down}"/>`);
    out.push(text(side.name, x + pad, y + 36 * scale, { size: 20 * scale, fill: p.ink, weight: 500, fit: w - pad * 2 - 150 * scale }));
    out.push(text(side.role, x + w - pad, y + 36 * scale, { size: 12 * scale, fill: p.inkDim, family: "mono", tracking: 0.16, upper: true, anchor: "end" }));
    out.push(text(fmtDelta(side.score), x + pad, y + h - 46 * scale, { size: 56 * scale, fill: deltaColour(p, side.score), weight: 600, tracking: -0.02 }));
    out.push(text("Match score", x + pad, y + h - 20 * scale, { size: 12 * scale, fill: p.inkDim, family: "mono", tracking: 0.14, upper: true }));
  });
  return out.join("");
}

function cardDate(input: MechanicCardInput): string | null | undefined {
  return input.kind === "daily" ? input.date : input.kind === "flag" ? input.answeredAt : input.playedAt;
}

const MECHANIC_OF: Record<MechanicCardInput["kind"], MechanicId> = { daily: "daily", crown: "crown", flag: "flag", shadow: "shadow" };

/**
 * The picture on the orbit: the mechanic's emblem, in the brand colour. Never a rank
 * insignia: a Shadow places nobody in a tier, and the other three are not ranks either.
 */
function hero(input: MechanicCardInput, p: BrandPalette): { svg: string; ink: string } {
  return { svg: mechanicEmblemSvg(MECHANIC_OF[input.kind], p.brand), ink: p.brand };
}

// ---------------------------------------------------------------- marks and tiles

/** A daily mark, centred at x,y, `s` across: shape first, colour second. */
function markGlyph(p: BrandPalette, m: DailyMark, x: number, y: number, s: number): string {
  const h = s / 2;
  const tri = h * 0.92;
  if (m === "above") return `<path d="M${x} ${y - tri}L${x + h} ${y + tri * 0.78}H${x - h}Z" fill="${p.up}" stroke="${p.up}" stroke-width="2" stroke-linejoin="round"/>`;
  if (m === "below") return `<path d="M${x} ${y + tri}L${x + h} ${y - tri * 0.78}H${x - h}Z" fill="${p.down}" stroke="${p.down}" stroke-width="2" stroke-linejoin="round"/>`;
  // The share text's own shapes (core/social/daily.ts GLYPH_CHAR): a diamond for near, an
  // open ring for a first run, a dashed ring for one not played.
  if (m === "near") return `<path d="M${x} ${y - h * 0.86}L${x + h * 0.86} ${y}L${x} ${y + h * 0.86}L${x - h * 0.86} ${y}Z" fill="${p.inkMid}" stroke="${p.inkMid}" stroke-width="2" stroke-linejoin="round"/>`;
  if (m === "first") return `<circle cx="${x}" cy="${y}" r="${h * 0.7}" fill="none" stroke="${p.inkMid}" stroke-width="${Math.max(3, s * 0.07)}"/>`;
  return `<circle cx="${x}" cy="${y}" r="${h * 0.7}" fill="none" stroke="${p.inkDim}" stroke-width="2" stroke-dasharray="4 5"/>`;
}

const MARK_LABEL: Record<DailyMark, string> = { above: "Above", near: "Near", below: "Below", first: "First run", pending: "Not played" };
const markInk = (p: BrandPalette, m: DailyMark) => (m === "above" ? p.up : m === "below" ? p.down : m === "pending" ? p.inkDim : p.inkMid);

function panel(p: BrandPalette, x: number, y: number, w: number, h: number, rx: number, dashed = false): string {
  return dashed
    ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="none" stroke="${p.line}" stroke-opacity="${p.lineOpacity * 2.4}" stroke-dasharray="5 6"/>`
    : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${p.panel}" fill-opacity="${p.theme === "dark" ? 0.86 : 1}" stroke="${p.line}" stroke-opacity="${p.lineOpacity}"/>`;
}

/** The daily's tiles in a box: up to three to a row, numbered, never named. */
function dailyTiles(p: BrandPalette, marks: DailyMark[], box: { x: number; y: number; w: number; h: number }, scale: number, perRow: number): string {
  const rows = Math.ceil(marks.length / perRow);
  const gap = 16 * scale;
  const th = (box.h - gap * (rows - 1)) / rows;
  const out: string[] = [];
  marks.forEach((m, i) => {
    const r = Math.floor(i / perRow);
    const inRow = Math.min(perRow, marks.length - r * perRow);
    const tw = (box.w - gap * (inRow - 1)) / inRow;
    const x = box.x + (i % perRow) * (tw + gap);
    const y = box.y + r * (th + gap);
    out.push(panel(p, x, y, tw, th, 8 * scale));
    out.push(text(String(i + 1).padStart(2, "0"), x + 18 * scale, y + 30 * scale, { size: 13 * scale, fill: p.inkDim, family: "mono" }));
    const g = Math.min(64 * scale, tw * 0.36, th * 0.4);
    out.push(markGlyph(p, m, x + tw / 2, y + th * 0.44, g));
    out.push(text(MARK_LABEL[m], x + tw / 2, y + th - 24 * scale, { size: 14 * scale, fill: markInk(p, m), family: "mono", weight: 600, anchor: "middle", tracking: 0.14, upper: true, fit: tw - 24 * scale }));
  });
  return out.join("");
}

/**
 * The Shadow ladder: one tile per recent Shadow, the shared match last, each a percentile
 * day and how it went. Before the placement shows, the results it still needs are dashed
 * "To play" tiles, so the card counts to the read-out the way the queue screen does.
 */
function shadowTileCount(input: ShadowCardInput): number {
  return input.placement?.kind === "pending" ? Math.max(input.series.length, input.placement.needed) : input.series.length;
}

function shadowTiles(p: BrandPalette, input: ShadowCardInput, box: { x: number; y: number; w: number; h: number }, scale: number, perRow: number): string {
  const n = shadowTileCount(input);
  const rows = Math.ceil(n / perRow);
  const gap = 12 * scale;
  const th = (box.h - gap * (rows - 1)) / rows;
  const tw = (box.w - gap * (perRow - 1)) / perRow;
  const tall = th >= 120 * scale;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = box.x + (i % perRow) * (tw + gap);
    const y = box.y + Math.floor(i / perRow) * (th + gap);
    const m = input.series[i];
    const pad = 16 * scale;
    out.push(panel(p, x, y, tw, th, 8 * scale, !m));
    out.push(text(m && i === input.series.length - 1 ? "Latest" : String(i + 1).padStart(2, "0"), x + pad, y + 26 * scale, { size: 13 * scale, fill: p.inkDim, family: "mono", tracking: m && i === input.series.length - 1 ? 0.1 : 0, upper: true }));
    if (!m) {
      out.push(text("To play", x + pad, y + th - (tall ? 24 : 16) * scale, { size: 13 * scale, fill: p.inkDim, family: "mono", tracking: 0.1, upper: true, fit: tw - pad * 2 }));
      continue;
    }
    const ink = m.verdict === "win" ? p.up : m.verdict === "loss" || m.verdict === "forfeit" ? p.down : p.inkMid;
    out.push(`<rect x="${x}" y="${y + 12 * scale}" width="${3 * scale}" height="${th - 24 * scale}" rx="${1.5 * scale}" fill="${ink}"/>`);
    out.push(text(SHADOW_TILE[m.verdict], x + tw - pad, y + 26 * scale, { size: 13 * scale, fill: ink, family: "mono", weight: 600, anchor: "end", tracking: 0.14, upper: true }));
    if (tall) {
      // The percentile large, what it is a percentile of beneath it.
      out.push(text(ordinalSuffix(m.percentile), x + pad, y + th / 2 + 10 * scale, { size: 34 * scale, fill: p.ink, weight: 600, fit: tw - pad * 2 }));
      out.push(text("percentile day", x + pad, y + th / 2 + 34 * scale, { size: 12 * scale, fill: p.inkMid, family: "mono", tracking: 0.1, upper: true, fit: tw - pad * 2, fitMin: 9 }));
      const ms = m.matchScore ? `${fmtDelta(m.matchScore.you)} vs ${fmtDelta(m.matchScore.them)}` : "";
      if (ms) out.push(text(ms, x + pad, y + th - 22 * scale, { size: 12 * scale, fill: p.inkDim, family: "mono", fit: tw - pad * 2, fitMin: 10 }));
    } else {
      out.push(text(dayLabel(m.percentile), x + pad, y + th - 16 * scale, { size: 16 * scale, fill: p.ink, weight: 600, fit: tw - pad * 2 }));
    }
  }
  return out.join("");
}

// ---------------------------------------------------------------- layouts

function seedOf(input: MechanicCardInput): string {
  return `${input.kind}|${input.player.name}|${input.season}|${"number" in input ? input.number : ""}`;
}

function landscape(input: MechanicCardInput, o: ShareCardOptions): string {
  const p = o.palette;
  const { width: W, height: H } = SHARE_CARD_SIZES.landscape;
  const L = 64;
  const R = W - 64;
  const out: string[] = [];
  out.push(defs(p, W, H, o.fontCss, W * 0.92, 0));
  out.push(starfield(seedOf(input), W, H, 46, starInk(p), [[L, 120, 700, 240], [40, 372, 1120, 250], [L, 30, W - 128, 70], [820, 120, 330, 240], [L, 612, R - L, 40]]));
  out.push(registration(W, H, 22, 14, p.ink, 0.22));

  out.push(lockup(p, L, 80, 30));
  out.push(text(input.season, R, 74, { size: 13, fill: p.inkDim, family: "mono", anchor: "end", tracking: 0.18, upper: true, fit: 600 }));
  out.push(`<path d="M${L} 110H${R}" stroke="${p.line}" stroke-opacity="${p.lineOpacity * 1.6}"/>`);

  out.push(text(kicker(input), L, 160, { size: 14, fill: p.brand, family: "mono", tracking: 0.2, upper: true, fit: 700 }));
  out.push(text(mechanicHeadline(input), L - 5, 262, { size: 112, fill: headlineFill(input, p), weight: 600, tracking: -0.035, fit: 720 }));
  out.push(text(nameLine(input), L, 312, { size: 28, fill: p.ink, weight: 500, fit: 720 }));
  out.push(text(figureLines(input).join("   ·   "), L, 346, { size: 15, fill: p.inkMid, family: "mono", tracking: 0.04, fit: 720 }));

  const ex = 986;
  const h = hero(input, p);
  out.push(orbit(p, ex, 208, 150, 52, -14, h.ink));
  out.push(placeSvg(h.svg, ex - 66, 142, 132, 132));
  const [accent, caption] = emblemWords(input);
  out.push(text(accent, ex, 306, { size: 24, fill: p.brand, weight: 600, anchor: "middle", fit: 300 }));
  out.push(text(caption, ex, 334, { size: 12, fill: p.inkDim, family: "mono", anchor: "middle", tracking: 0.16, upper: true, fit: 300 }));

  if (input.kind === "daily") {
    out.push(text("Today's draw", L + 16, 392, { size: 11, fill: p.inkDim, family: "mono", tracking: 0.18, upper: true }));
    out.push(text("Against own baseline", R - 16, 392, { size: 11, fill: p.inkDim, family: "mono", tracking: 0.18, upper: true, anchor: "end" }));
    out.push(dailyTiles(p, input.marks, { x: L, y: 404, w: R - L, h: 186 }, 1, 6));
  } else if (input.kind === "shadow") {
    const n = shadowTileCount(input);
    out.push(text(input.series.length > 1 ? `Last ${plural(input.series.length, "Shadow")}` : "Shadow ladder", L + 16, 392, { size: 11, fill: p.inkDim, family: "mono", tracking: 0.18, upper: true }));
    out.push(text("Each Shadow is a percentile day", R - 16, 392, { size: 11, fill: p.inkDim, family: "mono", tracking: 0.18, upper: true, anchor: "end" }));
    out.push(shadowTiles(p, input, { x: L, y: 404, w: R - L, h: 186 }, 1, n <= 5 ? n : Math.ceil(n / 2)));
  } else if (!input.rounds.length) {
    out.push(text("Match", L + 16, 392, { size: 11, fill: p.inkDim, family: "mono", tracking: 0.18, upper: true }));
    out.push(text("Mean gain over own baselines", R - 16, 392, { size: 11, fill: p.inkDim, family: "mono", tracking: 0.18, upper: true, anchor: "end" }));
    out.push(scorePanels(p, input, { x: L, y: 404, w: R - L, h: 186 }, 1, false));
  } else {
    const them = input.kind === "crown" ? input.rival?.name ?? "Holder" : input.challenger.name;
    out.push(landscapeRounds(p, input.rounds, { first: "Scenario", you: input.player.name, them }));
  }

  const fy = 638;
  out.push(text(ruleLine(input), L, fy, { size: 12, fill: p.inkDim, family: "mono", fit: R - L - 160 }));
  const d = dateLine(cardDate(input));
  if (d) out.push(text(d, R, fy, { size: 12, fill: p.inkDim, family: "mono", anchor: "end", tracking: 0.1, upper: true }));
  return wrap(W, H, out.join(""), input);
}

function portrait(input: MechanicCardInput, o: ShareCardOptions): string {
  const p = o.palette;
  const { width: W, height: H } = SHARE_CARD_SIZES.portrait;
  const L = 80;
  const R = W - 80;
  const C = W / 2;
  const out: string[] = [];
  out.push(defs(p, W, H, o.fontCss, W * 0.85, 120));
  out.push(starfield(seedOf(input) + "|p", W, H, 90, starInk(p), [[L, 60, R - L, 90], [140, 600, 800, 560], [L - 10, 1180, R - L + 20, 720], [260, 200, 560, 480]]));
  out.push(registration(W, H, 32, 22, p.ink, 0.22));

  out.push(lockup(p, L, 126, 42));
  out.push(text(input.season, R, 118, { size: 18, fill: p.inkDim, family: "mono", anchor: "end", tracking: 0.18, upper: true, fit: 420 }));

  const h = hero(input, p);
  out.push(orbit(p, C, 420, 380, 120, -12, h.ink));
  out.push(placeSvg(h.svg, C - 140, 280, 280, 280));
  const [accent, caption] = emblemWords(input);
  out.push(text(accent, C, 646, { size: 40, fill: p.brand, weight: 600, anchor: "middle", fit: 820 }));
  out.push(text(caption, C, 686, { size: 18, fill: p.inkDim, family: "mono", anchor: "middle", tracking: 0.18, upper: true, fit: 820 }));

  out.push(text(kicker(input), C, 790, { size: 20, fill: p.brand, family: "mono", anchor: "middle", tracking: 0.2, upper: true, fit: 880 }));
  out.push(text(mechanicHeadline(input), C, 948, { size: 176, fill: headlineFill(input, p), weight: 600, anchor: "middle", tracking: -0.035, fit: 900 }));
  out.push(text(nameLine(input), C, 1030, { size: 42, fill: p.ink, weight: 500, anchor: "middle", fit: 900 }));
  figureLines(input).slice(0, 2).forEach((l, i) => out.push(text(l, C, 1082 + i * 36, { size: 22, fill: p.inkMid, family: "mono", anchor: "middle", tracking: 0.04, fit: 900 })));

  if (input.kind === "daily") {
    const rows = Math.ceil(input.marks.length / 3);
    out.push(dailyTiles(p, input.marks, { x: L, y: 1190, w: R - L, h: rows === 1 ? 420 : 500 }, 1.5, 3));
  } else if (input.kind === "shadow") {
    const n = shadowTileCount(input);
    const perRow = n <= 3 ? n : n === 4 ? 2 : n <= 6 ? 3 : 4;
    out.push(shadowTiles(p, input, { x: L, y: 1190, w: R - L, h: 500 }, 1.35, perRow));
  } else if (!input.rounds.length) {
    out.push(scorePanels(p, input, { x: L, y: 1190, w: R - L, h: 500 }, 1.5, true));
  } else {
    const them = input.kind === "crown" ? input.rival?.name ?? "Holder" : input.challenger.name;
    out.push(portraitRounds(p, input.rounds, { you: input.player.name, them }));
  }

  const d = dateLine(cardDate(input));
  if (d) out.push(text(d, C, 1780, { size: 18, fill: p.inkDim, family: "mono", anchor: "middle", tracking: 0.14, upper: true }));
  out.push(text(ruleLine(input), C, 1852, { size: 16, fill: p.inkDim, family: "mono", anchor: "middle", fit: R - L }));
  return wrap(W, H, out.join(""), input);
}

function wrap(w: number, h: number, body: string, input: MechanicCardInput): string {
  const title = `${input.player.name}: ${mechanicHeadline(input)}, ${input.season}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>${body}</svg>`;
}

export function mechanicCardSvg(input: MechanicCardInput, options: ShareCardOptions): string {
  return options.layout === "portrait" ? portrait(input, options) : landscape(input, options);
}

/** Any card, result or mechanic, by its kind: the one entry point a caller needs. */
export function anyCardSvg(input: AnyCardInput, options: ShareCardOptions): string {
  return input.kind === "daily" || input.kind === "crown" || input.kind === "flag" || input.kind === "shadow"
    ? mechanicCardSvg(input, options)
    : shareCardSvg(input, options);
}

export type { CardLayout };
