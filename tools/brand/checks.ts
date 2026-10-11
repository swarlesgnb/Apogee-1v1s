/**
 * What a finished picture is held to, read from the rasteriser's measurements of every
 * piece of text in it (kit.ts `report`): it stays inside the safe margin, it stays out of
 * the parts a platform covers, no two lines collide, and every line clears its contrast
 * floor against what is actually drawn behind it.
 *
 * Contrast uses src/core/report/contrast.ts, the measure the rank sheet and the palette
 * are proved with. Text under 24px (or under 18.66px and not bold) is held to WCAG's
 * 4.5:1, larger text to 3:1, the same split WCAG makes for large type.
 */

import { contrast, mix } from "../../src/core/report/contrast.ts";
import { relative } from "node:path";

import { rasterizeReport, root, type RasterJob, type TextMetric } from "./kit.ts";

export interface TextChecks {
  /** Text keeps this far inside each edge, in output pixels: one number, or left, top, right, bottom. */
  inset?: number | [number, number, number, number];
  /** Areas text must stay out of, in output pixels: an avatar that covers a header, say. */
  avoid?: { name: string; rect: [number, number, number, number] }[];
  /** A round crop text must stay inside (a server icon). */
  circle?: { cx: number; cy: number; r: number };
  /** Default true: no two text boxes may intersect by more than a pixel. */
  overlap?: boolean;
  /** Default true. Transparent assets have no ground to measure against and skip it. */
  contrast?: boolean;
}

/** WCAG body text and large text. */
export const BODY_FLOOR = 4.5;
export const LARGE_FLOOR = 3;

export function isLarge(t: TextMetric): boolean {
  return t.size >= 24 || (t.size >= 18.66 && t.weight >= 600);
}

/** The ink a text actually paints over `bg` once its opacity is applied. */
function painted(t: TextMetric, bg: string): string {
  return t.opacity >= 0.999 ? t.fill : mix(bg, t.fill, Math.round(t.opacity * 100));
}

export function textContrast(t: TextMetric): number | null {
  if (!t.bg || !/^#[0-9a-f]{6}$/i.test(t.fill)) return null;
  return contrast(painted(t, t.bg), t.bg);
}

const short = (s: string) => (s.length > 40 ? s.slice(0, 39) + "…" : s);

export function checkText(label: string, width: number, height: number, texts: TextMetric[], o: TextChecks = {}): string[] {
  const fails: string[] = [];
  const shown = texts.filter((t) => t.s.trim() && t.w > 0 && t.h > 0);
  const [il, it, ir, ib] = typeof o.inset === "number" ? [o.inset, o.inset, o.inset, o.inset] : o.inset ?? [0, 0, 0, 0];
  for (const t of shown) {
    const name = `"${short(t.s)}"`;
    if (t.x < il - 0.5 || t.y < it - 0.5 || t.x + t.w > width - ir + 0.5 || t.y + t.h > height - ib + 0.5) {
      fails.push(`${label}: ${name} is inside the safe margin (box ${t.x.toFixed(0)},${t.y.toFixed(0)} ${t.w.toFixed(0)}x${t.h.toFixed(0)})`);
    }
    for (const a of o.avoid ?? []) {
      const [ax, ay, aw, ah] = a.rect;
      if (t.x < ax + aw && t.x + t.w > ax && t.y < ay + ah && t.y + t.h > ay) fails.push(`${label}: ${name} is under the ${a.name}`);
    }
    if (o.circle) {
      const { cx, cy, r } = o.circle;
      const corners = [[t.x, t.y], [t.x + t.w, t.y], [t.x, t.y + t.h], [t.x + t.w, t.y + t.h]];
      if (corners.some(([x, y]) => Math.hypot(x - cx, y - cy) > r)) fails.push(`${label}: ${name} leaves the round crop`);
    }
    if (o.contrast !== false) {
      const ratio = textContrast(t);
      const floor = isLarge(t) ? LARGE_FLOOR : BODY_FLOOR;
      if (ratio != null && ratio < floor) fails.push(`${label}: ${name} is ${ratio.toFixed(2)}:1 (${t.fill} on ${t.bg}), under ${floor}:1`);
    }
  }
  if (o.overlap !== false) {
    for (let i = 0; i < shown.length; i++) {
      for (let j = i + 1; j < shown.length; j++) {
        const a = shown[i];
        const b = shown[j];
        // A text box is the font's whole line box, ascent to descent, and the ascent runs
        // about a fifth of an em above the tallest glyph. Display lines set tighter than
        // that (a 108px title on 118px leading) are not touching, so the top of each box is
        // pulled down to where ink can be before two boxes are compared.
        const top = (m: TextMetric) => m.y + 0.22 * m.size;
        const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(top(a), top(b));
        if (dx > 1 && dy > 1) fails.push(`${label}: "${short(a.s)}" and "${short(b.s)}" overlap`);
      }
    }
  }
  return fails;
}

/**
 * Rasterise a batch and hold every job that carries `checks` to them. Returns the
 * failures; the caller decides whether they stop the build (the generators do).
 */
export function renderChecked(jobs: RasterJob[], label: string): { failures: string[]; measured: number; worst: { ratio: number; text: string; job: string } | null } {
  for (const j of jobs) if (j.checks) j.report = true;
  const { ok, reports } = rasterizeReport(jobs, label);
  const failures: string[] = ok ? [] : [`rasterising ${label} reported a failure (see FAIL lines above)`];
  let measured = 0;
  let worst: { ratio: number; text: string; job: string } | null = null;
  jobs.forEach((j, i) => {
    const r = reports[i];
    if (!j.checks || !r) return;
    measured++;
    const name = relative(root, j.pngOut).replace(/\\/g, "/");
    failures.push(...checkText(name, j.width, j.height, r, j.checks));
    const w = j.checks.contrast === false ? null : worstContrast(r);
    if (w && (!worst || w.ratio < worst.ratio)) worst = { ...w, job: name };
  });
  return { failures, measured, worst };
}

/** The lowest contrast any text reached, for the summary line. */
export function worstContrast(texts: TextMetric[]): { ratio: number; text: string } | null {
  let worst: { ratio: number; text: string } | null = null;
  for (const t of texts) {
    const r = textContrast(t);
    if (r != null && (!worst || r < worst.ratio)) worst = { ratio: r, text: t.s };
  }
  return worst;
}
