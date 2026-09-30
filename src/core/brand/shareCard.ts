/**
 * The shareable result card: one match or rank result as a picture somebody can post.
 *
 * A pure function from a result to SVG markup, with no Node or DOM imports, so the same
 * drawing can come out of a tool (tools/brand/renderShareCard.ts rasterises it in an
 * offscreen Electron window) or, later, out of the client, which already has the result
 * in hand when the settle screen opens. Two layouts: 1200x675 is what X, Discord and
 * Reddit crop a link preview to (16:9), and 1080x1920 is a phone story.
 *
 * What it will not do is leave anything out that the result screen shows. PLAN.md §15
 * lists "I scored more and lost" as a risk whose answer is to show raw scores, baselines
 * and deltas on every result screen, and a card is the result screen the most people will
 * ever see: the snapshot's own demo match is a loss on more raw points. So every round
 * carries both players' score, baseline and delta, and the footer says in one line what
 * decides a round.
 *
 * Text that depends on the player - names, scenario labels - cannot be measured here
 * without font metrics, so it is marked with `data-fit` (its width budget in px) and
 * FIT_TEXT_SCRIPT shrinks, then truncates, anything that overruns once the fonts are
 * really loaded. The rasteriser runs that script and fails the render if text still
 * leaves the canvas.
 */

import type { BrandPalette } from "./palette.ts";
import { rankInk } from "./palette.ts";

export interface CardTier {
  /** "tier-1" .. "tier-8", as in data/apogee_ranks.json; the emblem reads its rung from it. */
  id: string;
  name: string;
  color: string;
}

export interface CardSide {
  score: number | null;
  baseline: number | null;
  /** Fractional gain over baseline: 0.031 is +3.1%. */
  delta: number | null;
}

export interface CardRound {
  scenario: string;
  you: CardSide;
  /** Absent for a seeding match, which has no second side yet. */
  them?: CardSide | null;
}

export interface ShareCardInput {
  kind: "match" | "rank";
  season: string;
  category?: string | null;
  player: {
    name: string;
    tier: CardTier | null;
    rating?: number | null;
    ratingChange?: number | null;
    /** Share of the ladder this player beats, 0..100. */
    percentile?: number | null;
  };
  opponent?: { name: string; tier?: CardTier | null } | null;
  /** Match cards. */
  verdict?: "win" | "loss" | "draw" | null;
  matchScore?: { you: number | null; them: number | null } | null;
  /** Rank cards: `from` null means placements just finished. */
  promotion?: { from: CardTier | null; to: CardTier } | null;
  rounds: CardRound[];
  /** A code a friend can type to answer with a duel. Leaves the slot out when absent. */
  duelCode?: string | null;
  /** ISO date; printed as a plain date so no timezone is implied. */
  playedAt?: string | null;
}

export type CardLayout = "landscape" | "portrait";

export const SHARE_CARD_SIZES: Record<CardLayout, { width: number; height: number }> = {
  landscape: { width: 1200, height: 675 },
  portrait: { width: 1080, height: 1920 },
};

export interface ShareCardOptions {
  layout: CardLayout;
  palette: BrandPalette;
  /**
   * The rank insignia for a tier, as a complete <svg> element drawn in `ink`.
   *
   * Injected rather than drawn here because the client already owns the drawing - it is
   * `badge()` in renderer.js - and a second copy would drift. The tools slice that
   * function out of the renderer; the renderer would pass its own.
   */
  emblem: (tier: CardTier, ink: string) => string;
  /** @font-face rules for the faces below, inlined so the SVG stands on its own. */
  fontCss?: string;
}

export const FONT_DISPLAY = "'Apogee Display', Bahnschrift, 'Segoe UI', sans-serif";
export const FONT_MONO = "'Apogee Mono', 'Cascadia Mono', Consolas, monospace";

/** The rail's mark, the path buildIcon.mjs checks against every copy in the app. */
export const MARK_PATH = "m3 20 9-17 9 17M3 20l9-6 9 6M8 11h8M12 3l0 11";

// ---------------------------------------------------------------- formatting

export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** Scores are whole in most scenarios and one decimal in a few; never more. */
export function fmtScore(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const whole = Math.abs(n - Math.round(n)) < 0.05;
  return n.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 1, maximumFractionDigits: whole ? 0 : 1 });
}

/** A signed percentage. A true zero prints as 0.0% rather than +0.0%, which reads as a gain. */
export function fmtDelta(d: number | null | undefined, digits = 1): string {
  if (d == null || !Number.isFinite(d)) return "—";
  const pct = d * 100;
  if (Math.abs(pct) < 0.5 * 10 ** -digits) return (0).toFixed(digits) + "%";
  return (pct > 0 ? "+" : "−") + Math.abs(pct).toFixed(digits) + "%";
}

/**
 * How many decimals a round needs so its two deltas do not print the same when they are
 * not. +0.40% against +0.41% is a lost round; printed as +0.4% against +0.4% it looks
 * like the card got the result wrong.
 */
export function roundDigits(r: CardRound): number {
  const a = r.you.delta;
  const b = r.them?.delta;
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || a === b) return 1;
  for (let d = 1; d < 4; d++) if (fmtDelta(a, d) !== fmtDelta(b, d)) return d;
  return 4;
}

/**
 * The round's result from the deltas alone, with the labels the client's
 * roundPresentation() uses: a round with no opponent side is recorded, not won.
 */
export function roundOutcome(r: CardRound): "won" | "lost" | "draw" | "recorded" | "unavailable" {
  const a = r.you.delta;
  const b = r.them?.delta;
  if (a == null || !Number.isFinite(a)) return "unavailable";
  if (b == null || !Number.isFinite(b)) return "recorded";
  // Exact equality, as roundPresentation() has it: the card must never call a round the
  // settle screen called differently.
  if (a === b) return "draw";
  return a > b ? "won" : "lost";
}

const OUTCOME_LABEL = { won: "Won", lost: "Lost", draw: "Draw", recorded: "Recorded", unavailable: "Unavailable" } as const;

function deltaColour(p: BrandPalette, d: number | null | undefined): string {
  if (d == null || !Number.isFinite(d) || Math.abs(d) < 5e-4) return p.inkMid;
  return d > 0 ? p.up : p.down;
}

function outcomeColour(p: BrandPalette, o: ReturnType<typeof roundOutcome>): string {
  return o === "won" ? p.up : o === "lost" ? p.down : p.inkMid;
}

function headline(input: ShareCardInput): string {
  if (input.kind === "rank") return input.promotion?.to.name ?? input.player.tier?.name ?? "Unranked";
  if (input.verdict === "win") return "Victory";
  if (input.verdict === "loss") return "Defeat";
  if (input.verdict === "draw") return "Draw";
  // No verdict is a seeding run with nobody on the other side yet. With a code it is an
  // open challenge, and the card is the invitation.
  return input.duelCode ? "Beat this" : "Recorded";
}

function kicker(input: ShareCardInput): string {
  if (input.kind === "rank") {
    const from = input.promotion?.from;
    return from ? `Promoted from ${from.name}` : "Placements complete";
  }
  const what = input.verdict ? "Ranked match" : input.duelCode ? "Open duel" : "Seeding match";
  return [what, input.category].filter(Boolean).join(" · ");
}

function standingLine(input: ShareCardInput): string {
  const p = input.player;
  const parts: string[] = [];
  if (p.percentile != null && Number.isFinite(p.percentile)) {
    // "Top 56%" rather than "p43.7": nobody outside the client knows which way p runs.
    parts.push(`Top ${Math.max(1, Math.ceil(100 - p.percentile))}%`);
  }
  if (p.rating != null) parts.push(`Rating ${Math.round(p.rating)}`);
  return parts.join(" · ");
}

/** Under the emblem: what the emblem is, and how far up the ladder it sits. */
function emblemCaption(input: ShareCardInput): string {
  const pc = input.player.percentile;
  const top = pc != null && Number.isFinite(pc) ? ` · Top ${Math.max(1, Math.ceil(100 - pc))}%` : "";
  return `Apogee rank${top}`;
}

function ratingLine(input: ShareCardInput): string {
  const p = input.player;
  if (p.rating == null) return "";
  if (p.ratingChange == null || !Number.isFinite(p.ratingChange)) return `Rating ${Math.round(p.rating)}`;
  const before = Math.round(p.rating - p.ratingChange);
  const change = Math.round(p.ratingChange);
  const signed = change > 0 ? `+${change}` : change < 0 ? `−${-change}` : "±0";
  return `Rating ${before} → ${Math.round(p.rating)} (${signed})`;
}

function dateLine(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return "";
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m[2]) - 1];
  return `${Number(m[3])} ${month} ${m[1]}`;
}

// ---------------------------------------------------------------- drawing

/** Deterministic, so the same result always draws the same sky. */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Square stars, the atlas plates' own device (tools/buildAtlas.mjs), kept out of the
 * rectangles text sits in so no glyph ever has a dot behind it.
 */
function starfield(seed: string, w: number, h: number, count: number, ink: string, avoid: [number, number, number, number][]): string {
  const r = rng(seed);
  const out: string[] = [];
  for (let tries = 0; out.length < count && tries < count * 20; tries++) {
    const x = Math.round(r() * w);
    const y = Math.round(r() * h);
    if (avoid.some(([ax, ay, aw, ah]) => x > ax - 6 && x < ax + aw + 6 && y > ay - 6 && y < ay + ah + 6)) continue;
    const big = r() < 0.18;
    const s = big ? 3 : 2;
    const o = (big ? 0.34 : 0.16 + r() * 0.14).toFixed(2);
    out.push(`<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${ink}" opacity="${o}"/>`);
  }
  return out.join("");
}

/** On paper a near-black square reads as dust, not a star, so the light sky is slate. */
function starInk(p: BrandPalette): string {
  return p.theme === "dark" ? p.ink : p.inkDim;
}

/** Corner registration marks, as on the atlas plates. */
function registration(w: number, h: number, inset: number, arm: number, ink: string, opacity: number): string {
  const d = [
    `M${inset} ${inset + arm}V${inset}H${inset + arm}`,
    `M${w - inset - arm} ${inset}H${w - inset}V${inset + arm}`,
    `M${inset} ${h - inset - arm}V${h - inset}H${inset + arm}`,
    `M${w - inset - arm} ${h - inset}H${w - inset}V${h - inset - arm}`,
  ].join("");
  return `<path d="${d}" fill="none" stroke="${ink}" stroke-opacity="${opacity}" stroke-width="1.5"/>`;
}

/** Place a complete <svg> element at a position and size inside another. */
export function placeSvg(markup: string, x: number, y: number, w: number, h: number): string {
  return markup.replace(/^<svg\b/, `<svg x="${x}" y="${y}" width="${w}" height="${h}"`);
}

function text(
  s: string,
  x: number,
  y: number,
  o: { size: number; fill: string; family?: "display" | "mono"; weight?: number; anchor?: "start" | "middle" | "end"; tracking?: number; fit?: number; fitMin?: number; opacity?: number; upper?: boolean },
): string {
  const family = o.family === "mono" ? FONT_MONO : FONT_DISPLAY;
  const attrs = [
    `x="${x}"`, `y="${y}"`,
    `font-family="${family}"`, `font-size="${o.size}"`, `font-weight="${o.weight ?? 500}"`,
    `fill="${o.fill}"`,
    o.anchor && o.anchor !== "start" ? `text-anchor="${o.anchor}"` : "",
    o.tracking ? `letter-spacing="${(o.tracking * o.size).toFixed(2)}"` : "",
    o.fit ? `data-fit="${o.fit}"` : "",
    o.fit && o.fitMin ? `data-fit-min="${o.fitMin}"` : "",
    o.opacity != null ? `opacity="${o.opacity}"` : "",
  ].filter(Boolean);
  return `<text ${attrs.join(" ")}>${esc(o.upper ? s.toUpperCase() : s)}</text>`;
}

function lockup(p: BrandPalette, x: number, y: number, size: number): string {
  // The rail sets the mark at 31x36 beside 29px type; this keeps that ratio at any size.
  const markH = size * 1.2;
  const markW = markH * (24 / 24);
  return (
    `<svg x="${x}" y="${y - markH * 0.86}" width="${markW}" height="${markH}" viewBox="0 0 24 24" fill="none" stroke="${p.brand}" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="${MARK_PATH}"/></svg>` +
    text("apogee", x + markW + size * 0.4, y, { size, fill: p.ink, weight: 500, tracking: -0.03 })
  );
}

function defs(p: BrandPalette, w: number, h: number, fontCss: string | undefined, gx: number, gy: number): string {
  // The client's body::before: one faint wash from a corner, not a glow behind content.
  const wash = p.theme === "dark" ? "#324452" : "#c9d6e2";
  const washOpacity = p.theme === "dark" ? 0.42 : 0.55;
  return (
    `<defs>` +
    (fontCss ? `<style>${fontCss}</style>` : "") +
    `<radialGradient id="wash" cx="${gx}" cy="${gy}" r="${Math.max(w, h) * 0.62}" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="${wash}" stop-opacity="${washOpacity}"/><stop offset="1" stop-color="${wash}" stop-opacity="0"/></radialGradient>` +
    `</defs>` +
    `<rect width="${w}" height="${h}" fill="${p.ground}"/><rect width="${w}" height="${h}" fill="url(#wash)"/>`
  );
}

/**
 * A thin orbit behind the emblem, with a point at apogee: the end of the major axis, the
 * farthest the orbit gets from what it circles. Drawn on the upper end so the point is
 * also the highest thing on the path, which is the name's other sense.
 */
function orbit(p: BrandPalette, cx: number, cy: number, rx: number, ry: number, tilt: number, tint: string): string {
  const a = (tilt * Math.PI) / 180;
  const px = cx + rx * Math.cos(a);
  const py = cy + rx * Math.sin(a);
  return (
    `<g fill="none" stroke="${p.line}" stroke-opacity="${p.lineOpacity * 2.2}">` +
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" transform="rotate(${tilt} ${cx} ${cy})"/>` +
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx * 1.14}" ry="${ry * 1.2}" transform="rotate(${tilt} ${cx} ${cy})" stroke-dasharray="1 7"/>` +
    `</g><circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.5" fill="${tint}"/>`
  );
}

function slot(p: BrandPalette, code: string, x: number, y: number, w: number, h: number, scale: number): string {
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${6 * scale}" fill="${p.panel}" stroke="${p.brand}" stroke-opacity=".55"/>` +
    text("Duel code", x + 16 * scale, y + h / 2 + 4.5 * scale, { size: 12 * scale, fill: p.inkDim, family: "mono", tracking: 0.16, upper: true }) +
    text(code, x + w - 16 * scale, y + h / 2 + 7 * scale, { size: 21 * scale, fill: p.brand, family: "mono", weight: 600, anchor: "end", tracking: 0.08, fit: w - 150 * scale })
  );
}

// ---------------------------------------------------------------- layouts

function landscape(input: ShareCardInput, o: ShareCardOptions): string {
  const p = o.palette;
  const { width: W, height: H } = SHARE_CARD_SIZES.landscape;
  const L = 64;
  const R = W - 64;
  const seed = `${input.player.name}|${input.season}|${input.rounds.map((r) => r.scenario).join("|")}`;
  const tier = input.kind === "rank" ? input.promotion?.to ?? input.player.tier : input.player.tier;
  const tierInk = tier ? rankInk(p, tier.color) : p.inkDim;
  const out: string[] = [];

  out.push(defs(p, W, H, o.fontCss, W * 0.92, 0));
  out.push(starfield(seed, W, H, 46, starInk(p), [[L, 120, 700, 240], [40, 372, 1120, 250], [L, 30, W - 128, 70], [820, 120, 330, 240]]));
  out.push(registration(W, H, 22, 14, p.ink, 0.22));

  // Header: the lockup, and what this was.
  out.push(lockup(p, L, 80, 30));
  const where = [input.season, input.kind === "rank" ? "Rank update" : null].filter(Boolean).join(" · ");
  out.push(text(where, R, 74, { size: 13, fill: p.inkDim, family: "mono", anchor: "end", tracking: 0.18, upper: true, fit: 600 }));
  out.push(`<path d="M${L} 110H${R}" stroke="${p.line}" stroke-opacity="${p.lineOpacity * 1.6}"/>`);

  // Hero, left: the verdict, then who, then the numbers that decided it.
  out.push(text(kicker(input), L, 160, { size: 14, fill: p.brand, family: "mono", tracking: 0.2, upper: true, fit: 700 }));
  const hl = headline(input);
  const hlFill = input.kind === "rank" ? tierInk : input.verdict === "win" ? p.up : input.verdict === "loss" ? p.down : p.ink;
  out.push(text(hl, L - 5, 262, { size: 112, fill: hlFill, weight: 600, tracking: -0.035, fit: 720 }));

  if (input.kind === "match" && input.opponent) {
    out.push(text(`${input.player.name}  vs  ${input.opponent.name}`, L, 312, { size: 28, fill: p.ink, weight: 500, fit: 720 }));
    const ms = input.matchScore;
    const scoreLine = ms ? `Match ${fmtDelta(ms.you)} vs ${fmtDelta(ms.them)}` : "";
    out.push(text([scoreLine, ratingLine(input)].filter(Boolean).join("   ·   "), L, 346, { size: 15, fill: p.inkMid, family: "mono", tracking: 0.04, fit: 720 }));
  } else {
    out.push(text(input.player.name, L, 312, { size: 28, fill: p.ink, weight: 500, fit: 720 }));
    out.push(text(ratingLine(input), L, 346, { size: 15, fill: p.inkMid, family: "mono", tracking: 0.04, fit: 720 }));
  }

  // Hero, right: the emblem on its orbit.
  const ex = 986;
  if (tier) {
    out.push(orbit(p, ex, 208, 150, 52, -14, tierInk));
    out.push(placeSvg(o.emblem(tier, tierInk), ex - 64, 132, 128, 138));
    // A rank card's headline and kicker already say the tier and where it came from; a
    // third "Lunar -> Odyssey" under the emblem was the same fact again.
    if (input.kind === "match") {
      out.push(text(tier.name, ex, 306, { size: 24, fill: tierInk, weight: 600, anchor: "middle", fit: 300 }));
    }
    out.push(text(emblemCaption(input), ex, input.kind === "match" ? 334 : 318, { size: 12, fill: p.inkDim, family: "mono", anchor: "middle", tracking: 0.16, upper: true, fit: 300 }));
  } else {
    out.push(text("In placements", ex, 250, { size: 24, fill: p.inkMid, weight: 500, anchor: "middle" }));
  }

  // Rounds.
  const colYou = 500;
  const colThem = 760;
  const colOut = R - 16;
  const top = 404;
  out.push(text(input.kind === "rank" ? "Last match" : "Scenario", L + 16, top - 12, { size: 11, fill: p.inkDim, family: "mono", tracking: 0.18, upper: true }));
  out.push(text(input.player.name, colYou, top - 12, { size: 11, fill: p.inkDim, family: "mono", tracking: 0.18, upper: true, fit: 200, fitMin: 11 }));
  out.push(text(input.opponent?.name ?? "Opponent", colThem, top - 12, { size: 11, fill: p.inkDim, family: "mono", tracking: 0.18, upper: true, fit: 200, fitMin: 11 }));
  out.push(text("Round", colOut, top - 12, { size: 11, fill: p.inkDim, family: "mono", tracking: 0.18, upper: true, anchor: "end" }));
  const rows = input.rounds.slice(0, 3);
  rows.forEach((r, i) => {
    const y = top + i * 66;
    const h = 58;
    const oc = roundOutcome(r);
    out.push(`<rect x="${L}" y="${y}" width="${R - L}" height="${h}" rx="7" fill="${p.panel}" fill-opacity="${p.theme === "dark" ? 0.86 : 1}" stroke="${p.line}" stroke-opacity="${p.lineOpacity}"/>`);
    // A bar in the round's colour on the leading edge: the result reads before the numbers.
    out.push(`<rect x="${L}" y="${y + 12}" width="3" height="${h - 24}" rx="1.5" fill="${outcomeColour(p, oc)}"/>`);
    out.push(text(String(i + 1).padStart(2, "0"), L + 22, y + 36, { size: 13, fill: p.inkDim, family: "mono" }));
    out.push(text(r.scenario, L + 62, y + 37, { size: 22, fill: p.ink, weight: 500, fit: colYou - L - 62 - 28 }));
    const digits = roundDigits(r);
    const side = (s: CardSide | null | undefined, x: number) => {
      if (!s) {
        out.push(text("No run yet", x, y + 36, { size: 14, fill: p.inkDim, family: "mono" }));
        return;
      }
      out.push(text(fmtScore(s.score), x, y + 28, { size: 22, fill: p.ink, weight: 600 }));
      out.push(text(`base ${fmtScore(s.baseline)}`, x, y + 47, { size: 12, fill: p.inkDim, family: "mono", tracking: 0.02 }));
      out.push(text(fmtDelta(s.delta, digits), x + 214, y + 37, { size: 19, fill: deltaColour(p, s.delta), family: "mono", weight: 600, anchor: "end" }));
    };
    side(r.you, colYou);
    side(r.them, colThem);
    out.push(text(OUTCOME_LABEL[oc], colOut, y + 36, { size: 13, fill: outcomeColour(p, oc), family: "mono", weight: 600, anchor: "end", tracking: 0.14, upper: true }));
  });

  // Footer: the rule, and the way back in.
  const fy = 638;
  const rule = input.rounds.some((r) => r.them)
    ? "Raw scores from KovaaK's stats. A round goes to whoever beat their own baseline by more."
    : "Raw scores from KovaaK's stats, against the player's own baseline.";
  const hasCode = !!input.duelCode;
  out.push(text(rule, L, fy, { size: 12, fill: p.inkDim, family: "mono", fit: hasCode ? 700 : R - L - 160 }));
  if (hasCode) out.push(slot(p, input.duelCode as string, R - 300, fy - 27, 300, 40, 1));
  else if (input.playedAt) out.push(text(dateLine(input.playedAt), R, fy, { size: 12, fill: p.inkDim, family: "mono", anchor: "end", tracking: 0.1, upper: true }));

  return wrap(W, H, out.join(""), input);
}

function portrait(input: ShareCardInput, o: ShareCardOptions): string {
  const p = o.palette;
  const { width: W, height: H } = SHARE_CARD_SIZES.portrait;
  const L = 80;
  const R = W - 80;
  const C = W / 2;
  const seed = `${input.player.name}|${input.season}|${input.rounds.map((r) => r.scenario).join("|")}|p`;
  const tier = input.kind === "rank" ? input.promotion?.to ?? input.player.tier : input.player.tier;
  const tierInk = tier ? rankInk(p, tier.color) : p.inkDim;
  const out: string[] = [];

  out.push(defs(p, W, H, o.fontCss, W * 0.85, 120));
  out.push(starfield(seed, W, H, 90, starInk(p), [[L, 60, R - L, 90], [140, 690, 800, 470], [L - 10, 1180, R - L + 20, 720], [260, 200, 560, 480]]));
  out.push(registration(W, H, 32, 22, p.ink, 0.22));

  out.push(lockup(p, L, 126, 42));
  out.push(text(input.season, R, 118, { size: 18, fill: p.inkDim, family: "mono", anchor: "end", tracking: 0.18, upper: true, fit: 420 }));

  // The emblem is the picture on a story; everything else hangs from it.
  if (tier) {
    out.push(orbit(p, C, 420, 380, 120, -12, tierInk));
    out.push(placeSvg(o.emblem(tier, tierInk), C - 150, 255, 300, 323));
    // On a rank card the headline below is the tier's name; naming it here as well put
    // "Odyssey" on the story three times.
    if (input.kind === "match") {
      out.push(text(tier.name, C, 646, { size: 40, fill: tierInk, weight: 600, anchor: "middle", fit: 820 }));
      out.push(text(emblemCaption(input), C, 686, { size: 18, fill: p.inkDim, family: "mono", anchor: "middle", tracking: 0.18, upper: true, fit: 820 }));
    }
  }

  out.push(text(kicker(input), C, 790, { size: 20, fill: p.brand, family: "mono", anchor: "middle", tracking: 0.2, upper: true, fit: 880 }));
  const hlFill = input.kind === "rank" ? tierInk : input.verdict === "win" ? p.up : input.verdict === "loss" ? p.down : p.ink;
  out.push(text(headline(input), C, 948, { size: 176, fill: hlFill, weight: 600, anchor: "middle", tracking: -0.035, fit: 900 }));
  if (input.kind === "match" && input.opponent) {
    out.push(text(`${input.player.name}  vs  ${input.opponent.name}`, C, 1030, { size: 42, fill: p.ink, weight: 500, anchor: "middle", fit: 900 }));
    const ms = input.matchScore;
    if (ms) out.push(text(`Match ${fmtDelta(ms.you)} vs ${fmtDelta(ms.them)}`, C, 1082, { size: 22, fill: p.inkMid, family: "mono", anchor: "middle", tracking: 0.04, fit: 900 }));
    const rl = ratingLine(input);
    if (rl) out.push(text(rl, C, 1118, { size: 22, fill: p.inkMid, family: "mono", anchor: "middle", tracking: 0.04, fit: 900 }));
  } else {
    out.push(text(input.player.name, C, 1030, { size: 42, fill: p.ink, weight: 500, anchor: "middle", fit: 900 }));
    // A rank card has no caption under its emblem, so the standing goes here; a seeding
    // card's caption already says it.
    const sl = input.kind === "rank" ? standingLine(input) : ratingLine(input);
    if (sl) out.push(text(sl, C, 1082, { size: 22, fill: p.inkMid, family: "mono", anchor: "middle", tracking: 0.04, fit: 900 }));
  }

  const top = 1190;
  const rows = input.rounds.slice(0, 3);
  rows.forEach((r, i) => {
    const y = top + i * 176;
    const h = 160;
    const oc = roundOutcome(r);
    out.push(`<rect x="${L}" y="${y}" width="${R - L}" height="${h}" rx="12" fill="${p.panel}" fill-opacity="${p.theme === "dark" ? 0.86 : 1}" stroke="${p.line}" stroke-opacity="${p.lineOpacity}"/>`);
    out.push(`<rect x="${L}" y="${y + 20}" width="4" height="${h - 40}" rx="2" fill="${outcomeColour(p, oc)}"/>`);
    out.push(text(String(i + 1).padStart(2, "0"), L + 32, y + 50, { size: 18, fill: p.inkDim, family: "mono" }));
    out.push(text(r.scenario, L + 80, y + 52, { size: 32, fill: p.ink, weight: 500, fit: R - L - 80 - 200 }));
    out.push(text(OUTCOME_LABEL[oc], R - 32, y + 50, { size: 18, fill: outcomeColour(p, oc), family: "mono", weight: 600, anchor: "end", tracking: 0.14, upper: true }));
    const digits = roundDigits(r);
    const side = (label: string, s: CardSide | null | undefined, x: number, w: number) => {
      out.push(text(label, x, y + 94, { size: 14, fill: p.inkDim, family: "mono", tracking: 0.16, upper: true, fit: w - 130, fitMin: 14 }));
      if (!s) {
        out.push(text("No run yet", x, y + 132, { size: 20, fill: p.inkDim, family: "mono" }));
        return;
      }
      out.push(text(fmtScore(s.score), x, y + 134, { size: 34, fill: p.ink, weight: 600 }));
      out.push(text(`base ${fmtScore(s.baseline)}`, x + w, y + 94, { size: 15, fill: p.inkDim, family: "mono", anchor: "end" }));
      out.push(text(fmtDelta(s.delta, digits), x + w, y + 134, { size: 28, fill: deltaColour(p, s.delta), family: "mono", weight: 600, anchor: "end" }));
    };
    const half = (R - L - 80 - 32 - 40) / 2;
    side(input.player.name, r.you, L + 80, half);
    side(input.opponent?.name ?? "Opponent", r.them, L + 80 + half + 40, half);
    if (i < rows.length) out.push(`<path d="M${L + 80 + half + 20} ${y + 76}V${y + h - 22}" stroke="${p.line}" stroke-opacity="${p.lineOpacity * 1.5}"/>`);
  });

  const rule = input.rounds.some((r) => r.them)
    ? "Raw scores from KovaaK's stats. A round goes to whoever beat their own baseline by more."
    : "Raw scores from KovaaK's stats, against the player's own baseline.";
  if (input.duelCode) out.push(slot(p, input.duelCode, L, 1740, R - L, 64, 1.35));
  else if (input.playedAt) out.push(text(dateLine(input.playedAt), C, 1780, { size: 18, fill: p.inkDim, family: "mono", anchor: "middle", tracking: 0.14, upper: true }));
  out.push(text(rule, C, 1852, { size: 16, fill: p.inkDim, family: "mono", anchor: "middle", fit: R - L }));

  return wrap(W, H, out.join(""), input);
}

function wrap(w: number, h: number, body: string, input: ShareCardInput): string {
  const title = `${input.player.name}: ${headline(input)}, ${input.season}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>${body}</svg>`;
}

export function shareCardSvg(input: ShareCardInput, options: ShareCardOptions): string {
  return options.layout === "portrait" ? portrait(input, options) : landscape(input, options);
}

/**
 * Shrinks, then truncates, every <text data-fit="px"> that overruns once the real fonts
 * are loaded, and returns what still spills off the canvas. Plain script so it can run
 * in any page: the rasteriser evaluates it with the card's <svg> as `root`.
 *
 * A name is shrunk to at most 70% of its set size before it is cut, because a shorter
 * name at a readable size tells a viewer more than the whole name at an unreadable one.
 * Labels already set small carry data-fit-min at their own size and are only ever cut:
 * a 32-character name shrunk into a column header came out at 9px, which is not text.
 */
export const FIT_TEXT_SCRIPT = `(function (root) {
  var problems = [];
  var vb = root.viewBox.baseVal;
  root.querySelectorAll('text[data-fit]').forEach(function (t) {
    var max = Number(t.getAttribute('data-fit'));
    var size = Number(t.getAttribute('font-size'));
    var floor = t.hasAttribute('data-fit-min') ? Number(t.getAttribute('data-fit-min')) : Math.max(9, Math.floor(size * 0.7));
    var ls = t.getAttribute('letter-spacing');
    var ratio = ls ? Number(ls) / size : 0;
    while (t.getComputedTextLength() > max && size > floor) {
      size -= 1;
      t.setAttribute('font-size', String(size));
      if (ratio) t.setAttribute('letter-spacing', (ratio * size).toFixed(2));
    }
    if (t.getComputedTextLength() > max) {
      var s = t.textContent;
      while (s.length > 1 && t.getComputedTextLength() > max) {
        s = s.slice(0, -1);
        t.textContent = s.replace(/\\s+$/, '') + '\\u2026';
      }
    }
    t.removeAttribute('data-fit');
    t.removeAttribute('data-fit-min');
  });
  root.querySelectorAll('text').forEach(function (t) {
    var b = t.getBBox();
    if (b.x < vb.x - 0.5 || b.y < vb.y - 0.5 || b.x + b.width > vb.x + vb.width + 0.5 || b.y + b.height > vb.y + vb.height + 0.5) {
      problems.push('"' + t.textContent + '" leaves the canvas');
    }
  });
  return problems;
})`;
