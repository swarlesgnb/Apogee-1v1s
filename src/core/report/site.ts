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
      <p class="playlist">
        <span class="pl-label">${esc(label)}</span>
        ${
          code
            ? `<code class="pl-code">${esc(code)}</code><button type="button" class="btn btn-sm" data-copy="${esc(code)}">Copy</button>`
            : `<span class="pl-none">no share code yet</span>`
        }
      </p>`;
  };

  const ladder = (band: SeasonBand) =>
    `<ol class="ladder">${band.rankNames
      .map((name, i) => {
        const raw = band.rankColors[name] ?? palette["ink-dim"];
        const top = band.positional && i >= band.rankMaxes.length;
        return (
          `<li style="--c:${esc(raw)}"><span class="rung"></span>` +
          `<span class="rn" style="color:${esc(nameColor(raw))}">${esc(name)}</span>` +
          (top ? `<span class="rk-top">top ${band.positional!.topN}</span>` : "") +
          `</li>`
        );
      })
      .join("")}</ol>`;

  const row = (s: SeasonScenario, band: SeasonBand) => {
    const cells = band.rankNames.map((name, i) => {
      const c = esc(band.rankColors[name] ?? palette["ink-dim"]);
      return i < s.rankMaxes.length
        ? `<td class="num" style="--c:${c}">${fmt.format(s.rankMaxes[i])}</td>`
        : `<td class="num pos" style="--c:${c}">top ${band.positional?.topN ?? ""}</td>`;
    });
    const label = s.label ?? s.scenario;
    return (
      `<tr data-scenario="${esc(s.scenario)}">` +
      `<th scope="row"><span class="sc-label">${esc(label)}</span>` +
      (s.focus ? `<span class="sc-focus">${esc(s.focus)}</span>` : "") +
      `<span class="sc-name">${esc(s.scenario)}</span></th>` +
      cells.join("") +
      `<td class="yours"><input type="number" inputmode="decimal" min="0" step="any" ` +
      `placeholder="score" aria-label="Your score on ${esc(label)}"><output aria-live="polite"></output></td></tr>`
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
          <h3>${svg(mark.path, "icon", 1.5)}${esc(c.name)} <span class="cat-count">${scenarios.length} scenarios</span></h3>
          ${c.description ? `<p class="cat-desc">${esc(c.description)}</p>` : ""}
          ${ladder(band)}
          ${playlistLine(playlist, `${c.name} ${windows[w]} playlist:`)}
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
      : `<p class="note">${
          predicted === season.scenarios.length
            ? "All of these thresholds are provisional."
            : `${predicted} of these ${season.scenarios.length} thresholds are provisional.`
        } The scenarios are new, so there weren't enough real scores to set ranks from.
        Each one was predicted from the scenario file${
          calibrated
            ? `${calibrated === predicted ? " and then" : `, and ${calibrated} of them then`} adjusted
        using playtest runs and the same players' scores on KovaaK's leaderboards`
            : ""
        }. They'll be recut from real runs once there are enough, and ranks can move when
        that happens.</p>`;

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
        ${all ? playlistLine(all, `Every ${w} scenario in one playlist:`) : ""}
        ${season.categories.map((c) => category(c, i)).join("")}
      </div>`;
    })
    .join("");

  const lookup = liveLookup
    ? `
        <form class="lookup" id="lookup">
          <label for="lookup-name">KovaaK's username</label>
          <div class="field">
            <input id="lookup-name" name="username" autocomplete="off" spellcheck="false">
            <button type="submit" class="btn">Look up</button>
          </div>
          <p class="status" id="lookup-status" aria-live="polite"></p>
        </form>
        <p class="or">or</p>`
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

  const categoryCount = word(season.categories.length);

  // The first version was laid out like a product landing page: a two-tone headline,
  // small-caps labels over every section, a glowing card, numbered steps and a closing
  // call to action. It read like a template, and it put the tables, the one thing here
  // nobody else has, below a screen and a half of pitch. This is a rank sheet with a short
  // explanation on top.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Apogee - ranked 1v1 for KovaaK's</title>
<meta name="description" content="Ranked 1v1 for KovaaK's. Every ${esc(season.name)} scenario, the score each rank needs, and where your own scores land.">
<meta name="theme-color" content="${esc(palette.ground)}">
<meta property="og:title" content="Apogee - ranked 1v1 for KovaaK's">
<meta property="og:description" content="${esc(season.name)}: ${season.scenarios.length} scenarios across ${categoryCount} categories, and the score each rank needs on every one.">
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
    --r: 6px;
    --max: 1180px;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html { color-scheme: dark; scroll-padding-top: 64px; -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--ground); color: var(--ink); font: 15px/1.55 var(--font); -webkit-font-smoothing: antialiased; }
  a { color: var(--brand); text-underline-offset: 3px; }
  :focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
  .wrap { max-width: var(--max); margin: 0 auto; padding: 0 24px; }
  h1, h2, h3 { font-family: var(--display); font-weight: 500; letter-spacing: -.01em; }
  p { margin: 0 0 12px; }

  /* ---- top ---- */
  .top { border-bottom: 1px solid var(--rule); }
  .top .wrap { display: flex; align-items: center; gap: 20px; height: 56px; }
  .brand { display: flex; align-items: center; gap: 10px; margin-right: auto; color: var(--ink); text-decoration: none; font: 600 20px/1 var(--display); }
  .brand svg { width: 22px; height: 22px; color: var(--brand); }
  .top nav { display: flex; gap: 18px; font-size: 14px; }
  .top nav a { color: var(--ink-mid); text-decoration: none; }
  .top nav a:hover { color: var(--ink); }
  .top nav a.btn-go { color: var(--brand-ink); }

  .btn {
    display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 14px;
    font: 600 14px/1 var(--font); text-decoration: none; cursor: pointer; white-space: nowrap;
    border-radius: var(--r); border: 1px solid var(--rule-2); background: var(--control); color: var(--ink);
  }
  .btn:hover { background: var(--control-hi); }
  .btn-go { background: var(--brand); border-color: var(--brand); color: var(--brand-ink); }
  .btn-go:hover { background: var(--brand); filter: brightness(1.08); }
  .btn-sm { height: 28px; padding: 0 10px; font-size: 12.5px; }
  .btn .icon { width: 16px; height: 16px; }

  /* ---- intro ---- */
  .intro { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 440px); gap: 48px; padding: 44px 0 36px; border-bottom: 1px solid var(--rule); }
  .intro h1 { font-size: 40px; line-height: 1.1; margin: 0 0 16px; }
  .intro .what { font-size: 16.5px; color: var(--ink-mid); max-width: 38em; }
  .get { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin-top: 22px; color: var(--ink-dim); font-size: 13.5px; }

  .check { border: 1px solid var(--rule); border-radius: var(--r); background: var(--panel); padding: 20px 22px; align-self: start; }
  .check h2 { font-size: 20px; margin: 0 0 6px; }
  .check > p { color: var(--ink-mid); font-size: 14px; }
  .lookup label { display: block; font-size: 13px; color: var(--ink-dim); margin-bottom: 6px; }
  .field { display: flex; gap: 8px; }
  .field input {
    flex: 1; min-width: 0; height: 36px; padding: 0 12px; border-radius: var(--r);
    background: var(--sunk); border: 1px solid var(--rule-2); color: var(--ink); font: 14.5px var(--font);
  }
  .field input:focus { border-color: var(--brand-line); outline: none; }
  .or { margin: 12px 0; color: var(--ink-dim); font-size: 13px; }
  .folder-path { display: flex; align-items: center; gap: 8px; margin: 10px 0 0; }
  .folder-path code { flex: 1; min-width: 0; font: 11.5px/1.45 var(--mono); color: var(--ink-dim); overflow-wrap: anywhere; }
  .status { margin: 10px 0 0; font-size: 13.5px; color: var(--ink-mid); }
  .status:empty { display: none; }
  .status b { color: var(--ink); }
  .status.live::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 7px; border-radius: 50%; background: var(--up); vertical-align: 1px; }
  .to-ranks { display: inline-block; margin-top: 8px; font-size: 14px; font-weight: 600; }
  .to-ranks[hidden] { display: none; }
  .suggest { background: none; border: 0; padding: 0; color: var(--brand); font: inherit; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
  .fine { margin: 14px 0 0; font-size: 12.5px; color: var(--ink-dim); }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  /* ---- how ---- */
  .how { padding: 36px 0; border-bottom: 1px solid var(--rule); display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 24px 48px; }
  .how h2 { font-size: 22px; margin: 0; }
  .how ol { margin: 0; padding-left: 20px; max-width: 64em; color: var(--ink-mid); }
  .how li { padding-left: 6px; margin-bottom: 8px; }
  .how li::marker { color: var(--ink-dim); font-family: var(--mono); font-size: 13px; }

  /* ---- ranks ---- */
  .ranks { padding-top: 36px; }
  .ranks > h2 { font-size: 28px; margin: 0 0 8px; }
  .ranks > .lead { color: var(--ink-mid); max-width: 52em; }
  .note { max-width: 52em; color: var(--ink-mid); font-size: 14px; border-left: 3px solid var(--warn); padding: 2px 0 2px 14px; margin: 16px 0 24px; }
  .tabbar { position: sticky; top: 0; z-index: 10; background: var(--ground); margin: 0 -24px; padding: 0 24px; }
  [role=tablist] { position: relative; display: flex; gap: 2px; border-bottom: 1px solid var(--rule); overflow-x: auto; scrollbar-width: none; }
  [role=tablist]::-webkit-scrollbar { display: none; }
  [role=tab] { background: none; border: 0; color: var(--ink-dim); cursor: pointer; flex: none; font: 500 16px/1 var(--display); padding: 16px 14px 14px; }
  [role=tab]:hover { color: var(--ink-mid); }
  [role=tab][aria-selected=true] { color: var(--ink); }
  .tab-marker { position: absolute; left: 0; bottom: -1px; height: 2px; width: 0; background: var(--brand); transition: transform 200ms ease-out, width 200ms ease-out; }
  @media (prefers-reduced-motion: reduce) { .tab-marker { transition: none; } }
  .band { padding-top: 18px; }
  .band:focus { outline: none; }
  .jumps { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-bottom: 12px; font-size: 14px; }
  .jumps a { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-mid); text-decoration: none; }
  .jumps a:hover { color: var(--ink); }
  .jumps .icon { width: 16px; height: 16px; color: var(--ink-cat); }

  .playlist { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: 13.5px; color: var(--ink-dim); margin: 0 0 18px; }
  .pl-code { font: 13px var(--mono); color: var(--brand); }

  .category { border: 1px solid var(--rule); border-radius: var(--r); margin-bottom: 16px; background: var(--panel); scroll-margin-top: 64px; overflow: hidden; }
  .cat-head { padding: 18px 20px 4px; border-top: 3px solid var(--ink-cat); }
  .cat-head h3 { display: flex; align-items: center; gap: 10px; font-size: 21px; margin: 0 0 8px; }
  .cat-head h3 .icon { width: 22px; height: 22px; color: var(--ink-cat); flex: none; }
  .cat-count { font: 400 13px var(--font); color: var(--ink-dim); letter-spacing: 0; }
  .cat-desc { color: var(--ink-mid); max-width: 72ch; font-size: 14px; }
  .cat-head .playlist { margin-bottom: 14px; }

  .ladder { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 3px; list-style: none; margin: 14px 0 12px; padding: 0; }
  .ladder li { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .ladder .rung { height: 3px; background: var(--c); }
  .ladder .rn { font: 600 12.5px/1.2 var(--font); overflow-wrap: anywhere; }
  .ladder .rk-top { font-size: 11px; color: var(--ink-dim); margin-top: -3px; }

  .scroll { overflow-x: auto; border-top: 1px solid var(--rule); }
  .scroll:focus-visible { outline-offset: -2px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { padding: 11px 12px; text-align: left; border-bottom: 1px solid var(--rule); vertical-align: top; }
  thead th { font: 600 12.5px/1.2 var(--font); white-space: nowrap; background: var(--well); }
  thead th:first-child, .yours-h { color: var(--ink-dim); font-weight: 500; }
  tbody tr:last-child > * { border-bottom: 0; }
  tbody tr:hover { background: rgba(255,255,255,.02); }
  tbody th { font-weight: 400; min-width: 240px; padding-left: 20px; }
  .sc-label { display: block; font: 500 15.5px/1.3 var(--display); }
  .sc-focus { display: block; color: var(--ink-mid); font-size: 13px; margin-top: 2px; }
  .sc-name { display: block; color: var(--ink-dim); font: 11px var(--mono); margin-top: 4px; }
  td.num { text-align: right; font: 13.5px var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--ink-mid); padding-top: 13px; }
  thead th.num { text-align: right; }
  td.num.pos { color: var(--ink-dim); font-size: 12px; }
  td.num.met { color: var(--ink); box-shadow: inset 0 -2px 0 var(--c); }
  .yours { min-width: 200px; padding-right: 20px; }
  .yours input {
    width: 104px; height: 32px; padding: 0 9px; border-radius: var(--r);
    background: var(--sunk); border: 1px solid var(--rule-2); color: var(--ink); font: 13.5px var(--mono);
  }
  .yours input::placeholder { color: var(--ink-dim); opacity: .6; }
  .yours input:focus { outline: none; border-color: var(--brand-line); }
  .yours input::-webkit-inner-spin-button { display: none; }
  .yours output { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; font-size: 13px; color: var(--ink-mid); }
  .yours output:empty { display: none; }
  .yours output b { font-weight: 650; }
  .yours .unranked { color: var(--ink-dim); }
  .yours .src { font-size: 11.5px; color: var(--ink-dim); }
  .yours .src::before { content: "from "; }
  tr.fresh { animation: fresh 1400ms ease-out; }
  @keyframes fresh { from { background: rgba(229,237,176,.1); } to { background: transparent; } }

  footer { margin-top: 48px; border-top: 1px solid var(--rule); }
  footer .wrap { display: flex; flex-wrap: wrap; gap: 8px 22px; padding-top: 20px; padding-bottom: 36px; color: var(--ink-dim); font-size: 13px; }
  footer a { color: var(--ink-mid); text-decoration: none; }
  footer a:hover { color: var(--ink); }
  footer .aside { margin-left: auto; }

  @media (max-width: 900px) {
    .intro { grid-template-columns: 1fr; gap: 28px; padding-top: 32px; }
    .how { grid-template-columns: 1fr; gap: 12px; }
    footer .aside { margin-left: 0; flex-basis: 100%; }
  }
  @media (max-width: 720px) {
    .wrap { padding: 0 16px; }
    .tabbar { margin: 0 -16px; padding: 0 16px; }
    .top nav a:not(.btn) { display: none; }
    .intro h1 { font-size: 32px; }
    .check { padding: 18px 16px; }
    .cat-head { padding: 16px 16px 4px; }
    .ladder { grid-auto-flow: row; grid-template-columns: repeat(3, minmax(0, 1fr)); row-gap: 10px; }
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

<header class="top">
  <div class="wrap">
    <a class="brand" href="#">${svg(BRAND_MARK, "mark", 1.8)}Apogee</a>
    <nav aria-label="Page">
      <a href="#how">How it works</a>
      <a href="#ranks">Ranks</a>
      <a href="${esc(config.sourceUrl)}">Source</a>
      <a class="btn btn-go btn-sm" href="${esc(config.downloadUrl)}">Download</a>
    </nav>
  </div>
</header>

<main>
  <div class="wrap">
    <section class="intro">
      <div>
        <h1>Ranked 1v1 for KovaaK's</h1>
        <p class="what">You and an opponent near your rating play the same three scenarios.
        Each one goes to whoever beats their own usual score on it by the bigger margin,
        so it's about who plays above their level on the day. Scores are read from
        KovaaK's stats files, so nobody types anything in.</p>
        <p class="what">Below are all ${season.scenarios.length} ${esc(season.name)} scenarios and the
        score each rank needs on them. Bring your own scores and see where you land.</p>
        <div class="get">
          <a class="btn btn-go" href="${esc(config.downloadUrl)}">${svg("M12 3v12m0 0 5-5m-5 5-5-5M4 20h16", "icon", 1.8)}Download for Windows</a>
          <span>Free, and the <a href="${esc(config.sourceUrl)}">source is on GitHub</a>.</span>
        </div>
      </div>

      <aside class="check" id="find" aria-labelledby="find-title">
        <h2 id="find-title">Check your scores</h2>
        <p>Your best on each season scenario gets filled into the tables below.</p>
        ${lookup}
        <button type="button" class="btn${liveLookup ? "" : " btn-go"}" id="folder-open">
          ${svg("M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z", "icon", 1.7)}Open your stats folder
        </button>
        <input type="file" id="folder-input" webkitdirectory multiple class="visually-hidden" tabindex="-1" aria-hidden="true">
        <div class="folder-path">
          <code>${esc(DEFAULT_STATS_PATH)}</code>
          <button type="button" class="btn btn-sm" data-copy="${esc(DEFAULT_STATS_PATH)}">Copy</button>
        </div>
        <p class="status" id="folder-status" aria-live="polite"></p>
        <a class="to-ranks" id="to-ranks" href="#ranks" hidden>Go to the tables</a>
        <p class="fine">The folder is read in this tab and never uploaded. Chrome and Edge keep
        watching it, so a run shows up here a few seconds after you finish it.</p>
      </aside>
    </section>

    <section class="how" id="how" aria-labelledby="how-title">
      <h2 id="how-title">How a match works</h2>
      <ol>
        <li>Install the app and sign in through Steam. It uploads the runs already in your
        stats folder, and you can queue once ${minRunsToQueue} of them are in.</li>
        <li>Queue one of the ${categoryCount} categories, or all of them. You get matched with
        someone near your rating.</li>
        <li>The app puts the three scenarios in a KovaaK's playlist. Play them like you
        normally would.</li>
        <li>Each scenario is scored against your own baseline on it: the median of your last
        50 runs, or 90% of your best if that's higher. The bigger improvement takes the
        scenario. Ratings are worked out on the server, not in the app.</li>
      </ol>
    </section>

    <section class="ranks" id="ranks" aria-labelledby="ranks-title">
      <h2 id="ranks-title">${esc(season.name)} ranks</h2>
      <p class="lead">Each category is split into ${word(windows.length)} difficulty bands
      (${windows.map(esc).join(", ")}), and each band has its own ladder. Your rank on a
      scenario is the highest column your best score reaches.</p>
      ${provisional}
      <div class="tabbar"><div role="tablist" aria-label="Difficulty">${tabs}<span class="tab-marker" aria-hidden="true"></span></div></div>
      ${panels}
    </section>
  </div>
</main>

<footer>
  <div class="wrap">
    <a href="${esc(config.downloadUrl)}">Download</a>
    <a href="${esc(config.sourceUrl)}">Source</a>
    <a href="${esc(blob("FAIR-PLAY.md"))}">Fair play</a>
    <a href="${esc(blob("PRIVACY.md"))}">Privacy</a>
    <a href="${esc(blob("TERMS.md"))}">Terms</a>
    <span class="aside">Not affiliated with KovaaK's.</span>
  </div>
</footer>

<script type="application/json" id="site-data">${JSON.stringify(siteData).replace(/</g, "\\u003c")}</script>
<script>
${script}
</script>
</body>
</html>
`;
}
