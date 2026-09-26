/**
 * The public page: the season's pool and what each rank costs, readable without the app.
 *
 * Asking someone to install an unsigned Windows app, sign in with Steam and upload fifty
 * runs before they have seen anything is most of why nobody gets as far as a match. This
 * is the part that costs them nothing: every scenario the season ranks, the score each
 * rank needs on it, a playlist code to go and play them, and their own scores dropped
 * into the table from their stats folder or their KovaaK's name. The app is then the
 * answer to "prove it, against somebody at your level", not a prerequisite for finding
 * out.
 *
 * It shows thresholds rather than who holds what. A board of named players only draws
 * people once it is full, and at a handful it advertises that the place is empty; the
 * thresholds read the same with nobody on them. It also keeps the page on the right side
 * of 20260817000004: nothing about any player is published here.
 *
 * DERIVED   every scenario, threshold, rank name and colour, the playlist names, the
 *           queue's run requirement, the provisional-threshold count, the palette (the
 *           first :root block of the client's cosmic.css) and the category marks (the
 *           client's DISCIPLINES table). Read from where the app reads them, so the page
 *           cannot drift from the app a visitor then downloads.
 * AUTHORED  the download and source links and the playlist share codes, in
 *           data/site.json, because none of them exist until somebody publishes
 *           something.
 *
 * One file. The only requests it makes are the display face from Google Fonts, for
 * visitors without Bahnschrift, and KovaaK's API when a visitor asks it to.
 */

import type { Season, SeasonBand, SeasonCategory, SeasonScenario } from "../season/season.ts";
import { practicePlaylists, type PracticePlaylist } from "../season/practice.ts";
import { legibleOn, RANK_TEXT_CONTRAST } from "./contrast.ts";

export interface SiteConfig {
  downloadUrl: string;
  sourceUrl: string;
  /** Playlist share code by practice playlist name. */
  shareCodes: Record<string, string>;
}

/** A category's mark as the client draws it: a 24-unit stroke path and its ink. */
export interface Mark {
  ink: string;
  path: string;
}

export interface SiteInputs {
  season: Season;
  config: SiteConfig;
  /** MIN_RUNS_TO_QUEUE, passed in so the page states the number find-match enforces. */
  minRunsToQueue: number;
  /** Custom properties from cosmic.css, without the leading dashes. */
  palette: Record<string, string>;
  marks: Record<string, Mark>;
  /** siteClient.ts, bundled. */
  script: string;
}

/** Where KovaaK's keeps stats on a default Steam install, shown for finding the folder. */
const DEFAULT_STATS_PATH = String.raw`C:\Program Files (x86)\Steam\steamapps\common\FPSAimTrainer\FPSAimTrainer\stats`;

/** The client's ascent mark, from the wordmark in index.html. */
const BRAND_MARK = "m3 20 9-17 9 17M3 20l9-6 9 6M8 11h8M12 3l0 11";

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function svg(path: string, cls: string, width = 1.5): string {
  return (
    `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`
  );
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const word = (n: number) => WORDS[n] ?? String(n);

export function renderSite(inputs: SiteInputs): string {
  const { season, config, minRunsToQueue, palette, marks, script } = inputs;
  const windows = season.windows?.length ? season.windows : [season.name];
  const playlists = practicePlaylists(season);
  const codes = config.shareCodes;
  const panel = palette.panel;
  if (!panel) throw new Error("cosmic.css has no --panel; the page sets rank names against it");

  /** Rank names sit on the card surface, so they are corrected for that and not the page. */
  const nameColor = (hex: string) => legibleOn(hex, panel, RANK_TEXT_CONTRAST);
  const liveLookup = season.scenarios.some((s) => s.leaderboardId);

  const blob = (file: string) => `${config.sourceUrl.replace(/\/+$/, "")}/blob/main/${file}`;

  // ---- pieces -------------------------------------------------------------------------

  const playlistLine = (playlist: PracticePlaylist | undefined, label: string) => {
    if (!playlist) return "";
    const code = codes[playlist.name]?.trim();
    return `
      <div class="playlist">
        <span class="pl-label">${esc(label)}</span>
        ${
          code
            ? `<code class="pl-code">${esc(code)}</code><button type="button" class="btn btn-quiet btn-sm" data-copy="${esc(code)}">Copy code</button>`
            : `<span class="pl-none">Share code coming with the Workshop release</span>`
        }
      </div>`;
  };

  const ladder = (band: SeasonBand) =>
    `<ol class="ladder">${band.rankNames
      .map((name, i) => {
        const raw = band.rankColors[name] ?? palette["ink-dim"];
        const top = band.positional && i >= band.rankMaxes.length;
        return (
          `<li style="--c:${esc(raw)}"><span class="rung"></span>` +
          `<span class="rn" style="color:${esc(nameColor(raw))}">${esc(name)}</span>` +
          (top ? `<span class="rk-top">Top ${band.positional!.topN}</span>` : "") +
          `</li>`
        );
      })
      .join("")}</ol>`;

  const row = (s: SeasonScenario, band: SeasonBand) => {
    const cells = band.rankNames.map((name, i) => {
      const c = esc(band.rankColors[name] ?? palette["ink-dim"]);
      return i < s.rankMaxes.length
        ? `<td class="num" style="--c:${c}">${fmt.format(s.rankMaxes[i])}</td>`
        : `<td class="num pos" style="--c:${c}">Top ${band.positional?.topN ?? ""}</td>`;
    });
    const label = s.label ?? s.scenario;
    return (
      `<tr data-scenario="${esc(s.scenario)}">` +
      `<th scope="row"><span class="sc-label">${esc(label)}</span>` +
      (s.focus ? `<span class="sc-focus">${esc(s.focus)}</span>` : "") +
      `<span class="sc-name">${esc(s.scenario)}</span></th>` +
      cells.join("") +
      `<td class="yours"><input type="number" inputmode="decimal" min="0" step="any" ` +
      `placeholder="Score" aria-label="Your score on ${esc(label)}"><output aria-live="polite"></output></td></tr>`
    );
  };

  const category = (c: SeasonCategory, w: number) => {
    const band = c.bands?.[w];
    const scenarios = season.scenarios.filter((s) => s.category === c.name && (s.window ?? 0) === w);
    if (!band || scenarios.length === 0) return "";
    const mark = marks[c.name];
    const playlist = playlists.find((p) => p.category === c.name && p.window === w);
    // What the score boxes need to name the rank they find; they cannot import anything.
    const bandData = {
      names: band.rankNames,
      colors: Object.fromEntries(
        band.rankNames.map((n) => [n, nameColor(band.rankColors[n] ?? palette["ink-dim"])]),
      ),
      topN: band.positional?.topN ?? null,
    };
    const heads = band.rankNames
      .map((n) => {
        const raw = band.rankColors[n] ?? palette["ink-dim"];
        return `<th scope="col" class="num" style="color:${esc(nameColor(raw))}">${esc(n)}</th>`;
      })
      .join("");
    return `
      <section class="category" id="${slug(windows[w])}-${slug(c.name)}" style="--ink-cat:${esc(mark.ink)}" data-band="${esc(JSON.stringify(bandData))}">
        <header class="cat-head">
          <div class="cat-title">
            <span class="cat-mark">${svg(mark.path, "icon", 1.4)}</span>
            <div>
              <h3>${esc(c.name)}</h3>
              <p class="cat-count">${scenarios.length} scenarios · ${band.rankNames.length} ranks</p>
            </div>
          </div>
          ${c.description ? `<p class="cat-desc">${esc(c.description)}</p>` : ""}
          ${ladder(band)}
          ${playlistLine(playlist, "Playlist")}
        </header>
        <div class="scroll" tabindex="0" role="region" aria-label="${esc(c.name)} ${esc(windows[w])} thresholds">
          <table>
            <thead><tr><th scope="col">Scenario</th>${heads}<th scope="col" class="yours-h">Your score</th></tr></thead>
            <tbody>${scenarios.map((s) => row(s, band)).join("")}</tbody>
          </table>
        </div>
      </section>`;
  };

  // `source` is written by the season tools and read by validateThresholds from the raw
  // JSON; SeasonScenario does not carry it, so it is read the same way here. The note's
  // wording follows the kinds actually present, so it cannot outlive the thresholds.
  const kindOf = (s: SeasonScenario) => (s as { source?: { kind?: string } }).source?.kind ?? "";
  const predicted = season.scenarios.filter((s) => ["predicted", "calibrated"].includes(kindOf(s))).length;
  const calibrated = season.scenarios.filter((s) => kindOf(s) === "calibrated").length;
  const provisional =
    predicted === 0
      ? ""
      : `<aside class="note"><b>Provisional thresholds.</b> ${
          predicted === season.scenarios.length
            ? "Every threshold this season"
            : `${predicted} of the ${season.scenarios.length} thresholds`
        } was predicted from the scenario file, because the scenarios are new and there are
        not enough real scores to cut ranks from yet.${
          calibrated
            ? ` ${calibrated === predicted ? "All of them were" : `${calibrated} were`} then adjusted
        against playtest runs, and against the same players' scores on real KovaaK's
        leaderboards.`
            : ""
        } They get recut from real runs, and ranks can move when they do.</aside>`;

  const tabs = windows
    .map(
      (w, i) =>
        `<button type="button" role="tab" id="tab-${slug(w)}" data-slug="${slug(w)}" aria-controls="band-${slug(w)}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${esc(w)}</button>`,
    )
    .join("");

  const panels = windows
    .map((w, i) => {
      const all = playlists.find((p) => p.category === null && p.window === i);
      const jumps = season.categories
        .filter((c) => c.bands?.[i])
        .map(
          (c) =>
            `<a href="#${slug(w)}-${slug(c.name)}" style="--ink-cat:${esc(marks[c.name].ink)}">${svg(marks[c.name].path, "icon", 1.6)}${esc(c.name)}</a>`,
        )
        .join("");
      return `
      <div class="band" role="tabpanel" id="band-${slug(w)}" aria-labelledby="tab-${slug(w)}" tabindex="-1"${i === 0 ? "" : " hidden"}>
        <nav class="jumps" aria-label="${esc(w)} categories">${jumps}</nav>
        ${all ? `<div class="all">${playlistLine(all, `Every ${w} scenario, one playlist`)}</div>` : ""}
        ${season.categories.map((c) => category(c, i)).join("")}
      </div>`;
    })
    .join("");

  const lookup = liveLookup
    ? `
        <form class="lookup" id="lookup">
          <label for="lookup-name">KovaaK's username</label>
          <div class="field">
            <input id="lookup-name" name="username" autocomplete="off" spellcheck="false" placeholder="Your KovaaK's name">
            <button type="submit" class="btn btn-primary">Look up</button>
          </div>
          <p class="status" id="lookup-status" aria-live="polite"></p>
        </form>
        <div class="or"><span>or read it from this PC</span></div>`
    : "";

  // The client data the script needs, and nothing it can already read off the table.
  const siteData = {
    windows,
    liveLookup,
    scenarios: season.scenarios.map((s) => ({
      scenario: s.scenario,
      window: s.window ?? 0,
      rankMaxes: s.rankMaxes,
      leaderboardId: s.leaderboardId,
    })),
  };

  const rootVars = Object.entries(palette)
    .map(([k, v]) => `--${k}:${v};`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Apogee · Ranked 1v1 for KovaaK's</title>
<meta name="description" content="Ranked 1v1 for KovaaK's. Every ${esc(season.name)} scenario, the score each rank needs, and where yours land.">
<meta name="theme-color" content="${esc(palette.ground)}">
<meta property="og:title" content="Apogee · Ranked 1v1 for KovaaK's">
<meta property="og:description" content="${season.scenarios.length} scenarios, ${season.categories.length} categories, and the score each rank needs. Find where yours land.">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${palette.brand}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${BRAND_MARK}"/></svg>`,
  )}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    ${rootVars}
    /* Bahnschrift is the client's display face and ships with Windows. Barlow is the
       nearest open DIN, for everyone else. */
    --display: "Bahnschrift", "Barlow", "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
    --font: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", sans-serif;
    --mono: "Cascadia Mono", ui-monospace, Consolas, "SF Mono", "Roboto Mono", monospace;
    --ease-out: cubic-bezier(.22, 1, .36, 1);
    --press: 140ms;
    --surface: 180ms;
    --r: 10px;
    --r-sm: 6px;
    --max: 1180px;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html { color-scheme: dark; scroll-behavior: smooth; scroll-padding-top: 88px; -webkit-text-size-adjust: 100%; }
  @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
  body {
    margin: 0; background: var(--ground); color: var(--ink);
    font: 15px/1.55 var(--font); -webkit-font-smoothing: antialiased;
    overflow-x: hidden;
  }
  a { color: inherit; }
  :focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; border-radius: 2px; }
  .wrap { max-width: var(--max); margin: 0 auto; padding: 0 24px; }

  /* The sky: one soft field of light and three orbits, drawn once behind everything. */
  .sky { position: absolute; inset: 0 0 auto; height: 980px; pointer-events: none; overflow: hidden; z-index: 0; }
  .sky::before {
    content: ""; position: absolute; left: -12%; top: -220px; width: 900px; height: 760px;
    background: radial-gradient(closest-side, rgba(229,237,176,.075), rgba(163,195,225,.035) 55%, transparent);
    filter: blur(8px);
  }
  .sky svg { position: absolute; right: -260px; top: -300px; width: 1100px; height: 1100px; color: var(--cosmic-line); }
  .sky::after {
    content: ""; position: absolute; inset: auto 0 0; height: 240px;
    background: linear-gradient(transparent, var(--ground));
  }

  /* ---- bar ---- */
  .bar {
    position: sticky; top: 0; z-index: 20;
    background: color-mix(in srgb, var(--ground) 94%, transparent);
    backdrop-filter: saturate(140%) blur(14px); -webkit-backdrop-filter: saturate(140%) blur(14px);
    border-bottom: 1px solid transparent; transition: border-color var(--surface) var(--ease-out);
  }
  .bar.scrolled { border-bottom-color: var(--rule); }
  .bar .wrap { display: flex; align-items: center; gap: 24px; height: 68px; }
  .brand { display: flex; align-items: center; gap: 12px; text-decoration: none; margin-right: auto; }
  .brand .mark { width: 26px; height: 26px; color: var(--brand); }
  .brand .word { font: 600 23px/1 var(--display); letter-spacing: -.01em; }
  .brand .cap {
    font: 500 9.5px/1.25 var(--mono); letter-spacing: .22em; text-transform: uppercase; color: var(--ink-dim);
    border-left: 1px solid var(--rule-2); padding-left: 12px; max-width: 130px;
  }
  .bar nav { display: flex; align-items: center; gap: 4px; }
  .bar nav a.link { text-decoration: none; color: var(--ink-mid); font-size: 14px; padding: 8px 12px; border-radius: var(--r-sm); transition: color var(--press), background var(--press); }
  .bar nav a.link:hover { color: var(--ink); background: var(--control); }

  /* ---- buttons ---- */
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    font: 600 14px/1 var(--font); text-decoration: none; cursor: pointer;
    height: 40px; padding: 0 18px; border-radius: var(--r-sm); border: 1px solid var(--rule-2);
    background: var(--control); color: var(--ink); white-space: nowrap;
    transition: background var(--press) var(--ease-out), border-color var(--press) var(--ease-out), transform var(--press) var(--ease-out);
  }
  .btn:hover { background: var(--control-hi); border-color: var(--rule-3); }
  .btn:active { transform: scale(.97); }
  .btn-primary { background: var(--brand); color: var(--brand-ink); border-color: var(--brand); }
  .btn-primary:hover { background: #f0f6c6; border-color: #f0f6c6; }
  .btn-quiet { background: transparent; }
  .btn-sm { height: 30px; padding: 0 12px; font-size: 13px; }
  .btn-lg { height: 48px; padding: 0 22px; font-size: 15px; }
  .btn .icon { width: 16px; height: 16px; }

  .eyebrow {
    display: flex; align-items: center; gap: 10px; margin: 0 0 18px;
    font: 500 11px/1 var(--mono); letter-spacing: .2em; text-transform: uppercase; color: var(--brand-dim);
  }
  .eyebrow::before { content: ""; width: 22px; height: 1px; background: var(--brand); }

  /* ---- hero ---- */
  main { position: relative; z-index: 1; }
  .hero { display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(0, .92fr); gap: 56px; align-items: start; padding: 88px 0 40px; }
  .hero h1 {
    font: 500 clamp(52px, 7.4vw, 96px)/.94 var(--display); letter-spacing: -.02em; margin: 0 0 26px;
    text-wrap: balance;
  }
  .hero h1 .soft { color: var(--ink-dim); }
  .hero .lede { font-size: 18px; line-height: 1.6; color: var(--ink-mid); max-width: 30em; margin: 0 0 34px; }
  .cta { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 26px; }
  .facts { display: flex; flex-wrap: wrap; gap: 8px 22px; margin: 0; padding: 0; list-style: none; color: var(--ink-dim); font-size: 13px; }
  .facts li { display: flex; align-items: center; gap: 8px; }
  .facts li::before { content: ""; width: 4px; height: 4px; border-radius: 50%; background: var(--brand-line); }

  /* ---- finder ---- */
  .finder {
    position: relative; border: 1px solid var(--rule); border-radius: 14px; padding: 28px;
    background: linear-gradient(160deg, var(--card), var(--panel) 60%, var(--well));
    box-shadow: 0 1px 0 rgba(255,255,255,.04) inset, 0 30px 80px -30px rgba(0,0,0,.7);
  }
  .finder::before {
    content: ""; position: absolute; inset: -1px; border-radius: inherit; pointer-events: none;
    background: linear-gradient(160deg, rgba(229,237,176,.35), transparent 38%) border-box;
    -webkit-mask: linear-gradient(#000 0 0) padding-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor; mask-composite: exclude; border: 1px solid transparent;
  }
  .finder h2 { font: 500 28px/1.1 var(--display); margin: 0 0 10px; letter-spacing: -.01em; }
  .finder .finder-intro { color: var(--ink-mid); margin: 0 0 22px; }
  .lookup label { display: block; font-size: 13px; color: var(--ink-dim); margin-bottom: 8px; }
  .field { display: flex; gap: 8px; }
  .field input {
    flex: 1; min-width: 0; height: 40px; padding: 0 14px; border-radius: var(--r-sm);
    background: var(--sunk); border: 1px solid var(--rule-2); color: var(--ink); font: 15px var(--font);
    transition: border-color var(--press);
  }
  .field input:focus { border-color: var(--brand-line); outline: none; box-shadow: 0 0 0 3px rgba(229,237,176,.12); }
  .or { display: flex; align-items: center; gap: 14px; margin: 22px 0; color: var(--ink-dim); font-size: 12px; }
  .or::before, .or::after { content: ""; flex: 1; height: 1px; background: var(--rule); }
  .folder-path {
    display: flex; align-items: center; gap: 8px; margin: 14px 0 0; padding: 10px 12px;
    background: var(--sunk); border: 1px solid var(--rule); border-radius: var(--r-sm);
  }
  .folder-path code { flex: 1; min-width: 0; font: 12px/1.45 var(--mono); color: var(--ink-mid); overflow-wrap: anywhere; }
  .status { min-height: 1.5em; margin: 12px 0 0; font-size: 13.5px; color: var(--ink-mid); }
  .status b { color: var(--ink); }
  .status.live::before {
    content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 8px; border-radius: 50%;
    background: var(--up); box-shadow: 0 0 0 0 rgba(180,230,207,.6); animation: pulse 2.4s var(--ease-out) infinite;
    vertical-align: 1px;
  }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(180,230,207,.55); } 70%, 100% { box-shadow: 0 0 0 8px rgba(180,230,207,0); } }
  .status:empty { min-height: 0; margin: 0; }
  .to-ranks { display: flex; width: fit-content; align-items: center; gap: 6px; margin-top: 10px; color: var(--brand); font-weight: 600; font-size: 14px; text-decoration: none; }
  .to-ranks[hidden] { display: none; }
  .to-ranks .icon { width: 15px; height: 15px; transition: transform var(--press) var(--ease-out); }
  .to-ranks:hover .icon { transform: translateY(2px); }
  .suggest { background: none; border: 0; padding: 0; color: var(--brand); font: inherit; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
  .fine { margin: 18px 0 0; font-size: 12.5px; color: var(--ink-dim); display: flex; gap: 8px; align-items: flex-start; }
  .fine .icon { width: 15px; height: 15px; flex: none; margin-top: 2px; color: var(--brand-dim); }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  /* ---- steps ---- */
  .section { padding: 88px 0 0; }
  .section h2.big { font: 500 clamp(34px, 4.4vw, 48px)/1.04 var(--display); letter-spacing: -.015em; margin: 0 0 16px; }
  .section .intro { color: var(--ink-mid); font-size: 16.5px; max-width: 40em; margin: 0 0 36px; }
  .steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--rule); }
  .steps li { padding: 26px 26px 6px 0; }
  .steps li + li { padding-left: 26px; border-left: 1px solid var(--rule); }
  .steps .n { font: 500 12px var(--mono); color: var(--brand); letter-spacing: .08em; }
  .steps h3 { font: 500 21px/1.2 var(--display); margin: 14px 0 8px; }
  .steps p { margin: 0; color: var(--ink-mid); font-size: 14.5px; }

  /* ---- ranks ---- */
  .note {
    max-width: 46em; margin: -8px 0 36px; padding: 14px 18px; border-radius: var(--r-sm);
    background: rgba(236,211,148,.06); border: 1px solid rgba(236,211,148,.22); color: var(--ink-mid); font-size: 14px;
  }
  .note b { color: var(--warn); font-weight: 600; }
  .tabbar { position: sticky; top: 68px; z-index: 10; background: color-mix(in srgb, var(--ground) 90%, transparent); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); margin: 0 -24px; padding: 0 24px; }
  [role=tablist] { position: relative; display: flex; gap: 4px; border-bottom: 1px solid var(--rule); overflow-x: auto; scrollbar-width: none; }
  [role=tablist]::-webkit-scrollbar { display: none; }
  [role=tab] {
    background: none; border: 0; color: var(--ink-dim); cursor: pointer; flex: none;
    font: 500 17px/1 var(--display); padding: 18px 18px 17px; transition: color var(--press);
  }
  [role=tab]:hover { color: var(--ink-mid); }
  [role=tab][aria-selected=true] { color: var(--ink); }
  .tab-marker {
    position: absolute; left: 0; bottom: -1px; height: 2px; width: 0; background: var(--brand);
    transition: transform 260ms var(--ease-out), width 260ms var(--ease-out);
  }
  .band { padding-top: 24px; }
  .band:focus { outline: none; }
  .band:not([hidden]) { animation: rise 240ms var(--ease-out); }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
  @media (prefers-reduced-motion: reduce) { .band:not([hidden]) { animation: none; } .tab-marker { transition: none; } }
  .jumps { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
  .jumps a {
    display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 14px 0 10px;
    border: 1px solid var(--rule); border-radius: 999px; text-decoration: none; font-size: 13.5px; color: var(--ink-mid);
    transition: border-color var(--press), color var(--press), background var(--press);
  }
  .jumps a .icon { width: 17px; height: 17px; color: var(--ink-cat); }
  .jumps a:hover { color: var(--ink); border-color: var(--rule-2); background: var(--panel); }
  .all { margin: 0 0 28px; }

  .category {
    border: 1px solid var(--rule); border-radius: var(--r); margin-bottom: 20px; overflow: hidden;
    background: var(--panel); scroll-margin-top: 150px;
  }
  .cat-head { padding: 26px 28px 22px; background: linear-gradient(180deg, color-mix(in srgb, var(--ink-cat) 5%, var(--panel)), var(--panel) 70%); }
  .cat-title { display: flex; align-items: center; gap: 16px; margin-bottom: 14px; }
  .cat-mark {
    display: grid; place-items: center; width: 46px; height: 46px; flex: none; border-radius: 10px;
    color: var(--ink-cat); background: color-mix(in srgb, var(--ink-cat) 9%, var(--well));
    border: 1px solid color-mix(in srgb, var(--ink-cat) 30%, var(--rule));
  }
  .cat-mark .icon { width: 25px; height: 25px; }
  .cat-title h3 { font: 500 24px/1.1 var(--display); margin: 0; letter-spacing: -.005em; }
  .cat-count { margin: 4px 0 0; font: 12px var(--mono); color: var(--ink-dim); letter-spacing: .02em; }
  .cat-desc { color: var(--ink-mid); margin: 0 0 20px; max-width: 72ch; font-size: 14.5px; }

  .ladder { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 4px; list-style: none; margin: 0 0 18px; padding: 0; }
  .ladder li { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
  .ladder .rung { height: 4px; border-radius: 2px; background: var(--c); box-shadow: 0 0 0 1px rgba(255,255,255,.06) inset; }
  .ladder .rn { font: 600 13px/1.2 var(--font); overflow-wrap: anywhere; }
  .ladder .rk-top { font: 10.5px var(--mono); color: var(--ink-dim); letter-spacing: .06em; text-transform: uppercase; margin-top: -4px; }

  .playlist { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; font-size: 13.5px; }
  .pl-label { font: 500 10.5px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--ink-dim); }
  .pl-none { color: var(--ink-dim); }
  .pl-code { font: 13px var(--mono); padding: 6px 10px; border-radius: var(--r-sm); background: var(--sunk); border: 1px solid var(--rule); color: var(--brand); }

  .scroll { overflow-x: auto; border-top: 1px solid var(--rule); }
  .scroll:focus-visible { outline-offset: -2px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { padding: 13px 14px; text-align: left; border-bottom: 1px solid var(--rule); vertical-align: top; }
  thead th {
    position: sticky; top: 0; font: 600 12.5px/1.2 var(--font); white-space: nowrap;
    background: var(--well); padding-top: 11px; padding-bottom: 11px;
  }
  thead th:first-child, .yours-h { color: var(--ink-dim); font-family: var(--mono); font-weight: 500; font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; }
  tbody tr:last-child > * { border-bottom: 0; }
  tbody tr { transition: background var(--surface); }
  tbody tr:hover { background: rgba(255,255,255,.018); }
  tbody th { font-weight: 400; min-width: 250px; padding-left: 28px; }
  .sc-label { display: block; font: 500 16px/1.3 var(--display); }
  .sc-focus { display: block; color: var(--ink-mid); font-size: 13px; margin-top: 3px; }
  .sc-name { display: block; color: var(--ink-dim); font: 11px var(--mono); margin-top: 6px; }
  td.num {
    text-align: right; font: 13.5px var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap;
    color: var(--ink-mid); padding-top: 15px;
  }
  thead th.num { text-align: right; }
  td.num.pos { color: var(--ink-dim); font-size: 11.5px; letter-spacing: .04em; }
  td.num.met { color: var(--ink); box-shadow: inset 0 -2px 0 var(--c); }
  .yours { min-width: 210px; padding-right: 28px; }
  .yours input {
    width: 112px; height: 34px; padding: 0 10px; border-radius: var(--r-sm);
    background: var(--sunk); border: 1px solid var(--rule-2); color: var(--ink); font: 13.5px var(--mono);
    transition: border-color var(--press);
  }
  .yours input::placeholder { color: var(--ink-dim); opacity: .7; }
  .yours input:focus { outline: none; border-color: var(--brand-line); box-shadow: 0 0 0 3px rgba(229,237,176,.12); }
  .yours input::-webkit-inner-spin-button { display: none; }
  .yours output { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; font-size: 13px; color: var(--ink-mid); }
  .yours output:empty { display: none; }
  .yours output b { font-weight: 650; }
  .yours .unranked { color: var(--ink-dim); }
  .yours .src { font: 10px var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--brand-dim); margin-top: 2px; }
  tr.fresh { animation: fresh 1600ms var(--ease-out); }
  @keyframes fresh { from { background: rgba(229,237,176,.12); } to { background: transparent; } }

  /* ---- closing ---- */
  .closer {
    margin: 96px 0 0; padding: 56px; border-radius: 16px; border: 1px solid var(--rule);
    background: radial-gradient(120% 140% at 0% 0%, rgba(229,237,176,.08), transparent 55%), var(--panel);
    display: grid; grid-template-columns: 1fr auto; gap: 32px; align-items: center;
  }
  .closer h2 { font: 500 clamp(30px, 3.6vw, 42px)/1.05 var(--display); margin: 0 0 12px; letter-spacing: -.01em; }
  .closer p { margin: 0; color: var(--ink-mid); max-width: 36em; }
  footer { margin-top: 72px; border-top: 1px solid var(--rule); }
  footer .wrap { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 28px; padding-top: 26px; padding-bottom: 40px; color: var(--ink-dim); font-size: 13px; }
  footer .brand .word { font-size: 18px; }
  footer .brand .mark { width: 20px; height: 20px; }
  footer nav { display: flex; flex-wrap: wrap; gap: 6px 20px; }
  footer a { text-decoration: none; }
  footer a:hover { color: var(--ink); }
  footer .aside { flex-basis: 100%; }

  /* ---- smaller screens ---- */
  @media (max-width: 980px) {
    .hero { grid-template-columns: 1fr; gap: 48px; padding: 56px 0 72px; }
    .steps { grid-template-columns: repeat(2, 1fr); }
    .steps li:nth-child(3) { padding-left: 0; border-left: 0; }
    .steps li:nth-child(n+3) { border-top: 1px solid var(--rule); }
    .closer { grid-template-columns: 1fr; padding: 40px; }
  }
  @media (max-width: 720px) {
    .wrap { padding: 0 16px; }
    .tabbar { margin: 0 -16px; padding: 0 16px; top: 60px; }
    .bar .wrap { height: 60px; gap: 12px; }
    .brand .cap, .bar nav a.link { display: none; }
    .bar .btn { height: 36px; padding: 0 14px; font-size: 13px; }
    .hero .lede { font-size: 16.5px; }
    .finder { padding: 22px 18px; }
    .steps { grid-template-columns: 1fr; }
    .steps li, .steps li + li { padding: 22px 0 4px; border-left: 0; }
    .steps li + li { border-top: 1px solid var(--rule); }
    .cat-head { padding: 22px 18px 18px; }
    .ladder { grid-auto-flow: row; grid-template-columns: repeat(3, minmax(0, 1fr)); row-gap: 12px; }
    .closer { padding: 30px 22px; }
    /* The score box is the last column, so the scenario name stays put while a row
       scrolls under it. */
    tbody th, thead th:first-child { position: sticky; left: 0; z-index: 2; min-width: 150px; max-width: 150px; padding-left: 16px; }
    tbody th { background: var(--panel); box-shadow: 1px 0 0 var(--rule); }
    .sc-focus { display: none; }
    .yours { padding-right: 16px; }
  }
</style>
</head>
<body>
<div class="sky" aria-hidden="true">
  <svg viewBox="0 0 1100 1100" fill="none" stroke="currentColor">
    <circle cx="550" cy="550" r="300"/><circle cx="550" cy="550" r="420" stroke-dasharray="2 7"/><circle cx="550" cy="550" r="540"/>
    <circle cx="276" cy="673" r="3.5" fill="currentColor"/><circle cx="908" cy="760" r="2.5" fill="currentColor"/><circle cx="160" cy="330" r="2" fill="currentColor"/>
  </svg>
</div>

<header class="bar">
  <div class="wrap">
    <a class="brand" href="#top" aria-label="Apogee, back to top">
      ${svg(BRAND_MARK, "mark", 1.65)}<span class="word">apogee</span><span class="cap">Ranked aim training</span>
    </a>
    <nav aria-label="Page">
      <a class="link" href="#how">How it works</a>
      <a class="link" href="#ranks">Ranks</a>
      <a class="btn btn-primary" href="${esc(config.downloadUrl)}">Download</a>
    </nav>
  </div>
</header>

<main id="top">
  <div class="wrap">
    <section class="hero">
      <div>
        <p class="eyebrow">${esc(season.name)} · KovaaK's</p>
        <h1>Ranked 1v1<br><span class="soft">for KovaaK's.</span></h1>
        <p class="lede">Three scenarios, one opponent near your rating. Each round goes to
        whoever beats their own baseline by more. Scores come straight from KovaaK's stats
        files, so nothing is ever typed in.</p>
        <div class="cta">
          <a class="btn btn-primary btn-lg" href="${esc(config.downloadUrl)}">${svg("M12 3v12m0 0 5-5m-5 5-5-5M4 20h16", "icon", 1.8)}Download for Windows</a>
          <a class="btn btn-lg" href="#ranks">See the ranks</a>
        </div>
        <ul class="facts">
          <li>Free</li>
          <li>Open source</li>
          <li>${season.scenarios.length} scenarios, ${word(season.categories.length)} categories</li>
        </ul>
      </div>

      <aside class="finder" id="find" aria-labelledby="find-title">
        <p class="eyebrow">Find your rank</p>
        <h2 id="find-title">Where do your scores land?</h2>
        <p class="finder-intro">Every rank is a score on a scenario you can play today. Bring your runs and the
        table below fills itself in.</p>
        ${lookup}
        <button type="button" class="btn ${liveLookup ? "" : "btn-primary "}btn-lg" id="folder-open" style="width:100%">
          ${svg("M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z", "icon", 1.7)}Open your stats folder
        </button>
        <input type="file" id="folder-input" webkitdirectory multiple class="visually-hidden" tabindex="-1" aria-hidden="true">
        <div class="folder-path">
          <code>${esc(DEFAULT_STATS_PATH)}</code>
          <button type="button" class="btn btn-quiet btn-sm" data-copy="${esc(DEFAULT_STATS_PATH)}">Copy</button>
        </div>
        <p class="status" id="folder-status" aria-live="polite"></p>
        <a class="to-ranks" id="to-ranks" href="#ranks" hidden>See where they land ${svg("M12 5v14m0 0 6-6m-6 6-6-6", "icon", 1.8)}</a>
        <p class="fine">${svg("M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6Z", "icon", 1.6)}<span>Read in this tab and never uploaded. In Chrome and Edge the page keeps
        watching, so a run you finish in KovaaK's shows up here within seconds.</span></p>
      </aside>
    </section>

    <section class="section" id="how" aria-labelledby="how-title">
      <p class="eyebrow">How a match works</p>
      <h2 class="big" id="how-title">Your aim, against someone at your level.</h2>
      <p class="intro">The queue opens once ${minRunsToQueue} of your runs have uploaded, which the
      app does from the history KovaaK's already keeps. If you have played KovaaK's for a while, you are probably there already.</p>
      <ol class="steps">
        <li><span class="n">01</span><h3>Category</h3><p>Pick one of the ${word(season.categories.length)} below, or all of them.</p></li>
        <li><span class="n">02</span><h3>Match</h3><p>You're paired with someone near your rating.</p></li>
        <li><span class="n">03</span><h3>Play</h3><p>Three scenarios in KovaaK's, as normal. Apogee writes the playlist for you.</p></li>
        <li><span class="n">04</span><h3>Results</h3><p>Each round goes to whoever beat their own baseline by more. Ratings settle on the server.</p></li>
      </ol>
    </section>

    <section class="section" id="ranks" aria-labelledby="ranks-title">
      <p class="eyebrow">${esc(season.name)}</p>
      <h2 class="big" id="ranks-title">The ranks.</h2>
      <p class="intro">Each category is graded in ${word(windows.length)} difficulty bands, and each band
      is its own ladder. A rank on a scenario is the furthest column your best score reaches.</p>
      ${provisional}
      <div class="tabbar"><div role="tablist" aria-label="Difficulty">${tabs}<span class="tab-marker" aria-hidden="true"></span></div></div>
      ${panels}
    </section>

    <section class="closer" aria-labelledby="closer-title">
      <div>
        <h2 id="closer-title">Found your rank? Come defend it.</h2>
        <p>Queue a category and play someone who lands where you do. Windows only, for now.</p>
      </div>
      <a class="btn btn-primary btn-lg" href="${esc(config.downloadUrl)}">${svg("M12 3v12m0 0 5-5m-5 5-5-5M4 20h16", "icon", 1.8)}Download Apogee</a>
    </section>
  </div>
</main>

<footer>
  <div class="wrap">
    <a class="brand" href="#top">${svg(BRAND_MARK, "mark", 1.65)}<span class="word">apogee</span></a>
    <nav aria-label="Project">
      <a href="${esc(config.sourceUrl)}">Source</a>
      <a href="${esc(blob("FAIR-PLAY.md"))}">Fair play</a>
      <a href="${esc(blob("PRIVACY.md"))}">Privacy</a>
      <a href="${esc(blob("TERMS.md"))}">Terms</a>
    </nav>
    <span class="aside">Apogee is an independent project and is not affiliated with KovaaK's.</span>
  </div>
</footer>

<script type="application/json" id="site-data">${JSON.stringify(siteData).replace(/</g, "\\u003c")}</script>
<script>
${script}
(() => {
  const bar = document.querySelector('.bar');
  const onScroll = () => bar.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();
</script>
</body>
</html>
`;
}
