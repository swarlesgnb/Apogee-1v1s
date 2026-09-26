/**
 * The public page's script, bundled into it by tools/buildSite.ts.
 *
 * Two ways to fill the table with a visitor's own scores, and neither sends their data
 * anywhere:
 *
 *   STATS FOLDER   the same files the app reads, parsed by the app's own parser, in the
 *                  tab. Where the browser can hold a folder open (Chromium's
 *                  showDirectoryPicker) it is re-listed every few seconds, so a run
 *                  finished in KovaaK's lands in the table without touching the page.
 *                  Elsewhere a directory input reads it once.
 *   KOVAAK'S NAME  what evxl does: KovaaK's public API answers any origin, so the
 *                  browser asks it directly. `user/search` finds the account and
 *                  `user/scenario/total-play` lists every scenario it has played with
 *                  its best score, 100 to a page. Only offered once some scenario in
 *                  the season has a KovaaK's board: a local scenario never uploads, so
 *                  before that the answer would be empty for everybody.
 *
 * Display only. Nothing here is a rank the server has agreed to, and the page says a
 * score "lands" on a rank rather than that anybody holds it.
 */

import { parseFilename, parseStatsFile } from "../stats/parseStatsFile.ts";
import { rankIndex } from "../benchmarks/energy.ts";

interface SiteScenario {
  scenario: string;
  window: number;
  rankMaxes: number[];
  leaderboardId: number | null;
}

interface SiteData {
  windows: string[];
  scenarios: SiteScenario[];
  liveLookup: boolean;
}

interface Band {
  names: string[];
  colors: Record<string, string>;
  topN: number | null;
}

type Source = "typed" | "folder" | "kovaaks";

const API = "https://kovaaks.com/webapp-backend";
/** A folder re-list is a directory read and nothing else unless a new file appeared. */
const POLL_MS = 4000;
/** 40 pages is 4,000 scenarios, past anybody on KovaaK's own most-played lists. */
const MAX_PAGES = 40;
const USERNAME_KEY = "apogee.site.username";

const data = JSON.parse(document.getElementById("site-data")!.textContent!) as SiteData;
const byName = new Map(data.scenarios.map((s) => [s.scenario, s]));
const num = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<T>(sel));

function esc(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// ---- difficulty tabs ------------------------------------------------------------------

const tabs = $$<HTMLButtonElement>("[role=tab]");

function selectTab(tab: HTMLButtonElement, focus = false): void {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute("aria-controls")!)!.hidden = !on;
  }
  if (focus) tab.focus();
  moveMarker(tab);
}

function moveMarker(tab: HTMLButtonElement): void {
  const marker = $(".tab-marker");
  if (!marker) return;
  marker.style.width = `${tab.offsetWidth}px`;
  marker.style.transform = `translateX(${tab.offsetLeft}px)`;
}

for (const t of tabs) {
  t.addEventListener("click", () => {
    selectTab(t);
    history.replaceState(null, "", `#${t.dataset.slug}`);
  });
  t.addEventListener("keydown", (e: KeyboardEvent) => {
    const i = tabs.indexOf(t);
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length];
    selectTab(target, true);
    history.replaceState(null, "", `#${target.dataset.slug}`);
  });
}
selectTab(tabs.find((t) => `#${t.dataset.slug}` === location.hash) ?? tabs[0]);
window.addEventListener("resize", () => {
  const on = tabs.find((t) => t.getAttribute("aria-selected") === "true");
  if (on) moveMarker(on);
});
// The marker is measured, so it has to be measured again once the display face loads.
document.fonts?.ready.then(() => {
  const on = tabs.find((t) => t.getAttribute("aria-selected") === "true");
  if (on) moveMarker(on);
});

// ---- copy buttons ---------------------------------------------------------------------

for (const b of $$<HTMLButtonElement>("[data-copy]")) {
  b.addEventListener("click", async () => {
    const label = b.textContent;
    try {
      await navigator.clipboard.writeText(b.dataset.copy!);
      b.textContent = "Copied";
    } catch {
      b.textContent = "Press Ctrl+C";
    }
    setTimeout(() => (b.textContent = label), 1600);
  });
}

// ---- rows -----------------------------------------------------------------------------

const bands = new Map<HTMLElement, Band>();
for (const section of $$(".category")) bands.set(section, JSON.parse(section.dataset.band!) as Band);

const rows = new Map<string, HTMLTableRowElement>();
for (const row of $$<HTMLTableRowElement>("tr[data-scenario]")) rows.set(row.dataset.scenario!, row);

function chip(band: Band, name: string): string {
  return `<b style="color:${band.colors[name]}">${esc(name)}</b>`;
}

const SOURCE_LABEL: Record<Source, string> = {
  typed: "",
  folder: "stats folder",
  kovaaks: "KovaaK's",
};

function paint(row: HTMLTableRowElement, score: number | null, source: Source): void {
  const s = byName.get(row.dataset.scenario!)!;
  const band = bands.get(row.closest<HTMLElement>(".category")!)!;
  const out = $("output", row)!;
  const cells = $$("td.num", row);

  if (score === null) {
    out.innerHTML = "";
    row.classList.remove("has-score");
    for (const c of cells) c.classList.remove("met");
    return;
  }

  // The same rule the app grades with: the highest threshold met, and the first one
  // missed ends the search.
  const idx = rankIndex(score, s.rankMaxes);
  cells.forEach((c, i) => c.classList.toggle("met", i <= idx));

  let html = idx >= 0 ? chip(band, band.names[idx]) : `<span class="unranked">Unranked</span>`;
  if (idx + 1 < s.rankMaxes.length) {
    html += `<span class="gap">${num.format(s.rankMaxes[idx + 1] - score)} to ${chip(band, band.names[idx + 1])}</span>`;
  } else if (band.topN) {
    html += `<span class="gap">${chip(band, band.names[s.rankMaxes.length])} is the top ${band.topN} on the board</span>`;
  }
  if (source !== "typed") html += `<span class="src">${SOURCE_LABEL[source]}</span>`;
  out.innerHTML = html;
  row.classList.add("has-score");

  if (source !== "typed") {
    const input = $<HTMLInputElement>("input", row)!;
    if (document.activeElement !== input) input.value = String(score);
  }
}

function flash(row: HTMLTableRowElement): void {
  if (reduceMotion.matches) return;
  row.classList.remove("fresh");
  void row.offsetWidth;
  row.classList.add("fresh");
}

for (const row of rows.values()) {
  const input = $<HTMLInputElement>("input", row)!;
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    paint(row, Number.isFinite(v) ? v : null, "typed");
  });
}

/** Paint a whole set of bests and move to the band holding most of them. */
function apply(best: Map<string, number>, source: Source, changed?: Set<string>): void {
  const perWindow = new Array(data.windows.length).fill(0);
  for (const [name, score] of best) {
    const row = rows.get(name);
    if (!row) continue;
    paint(row, score, source);
    perWindow[byName.get(name)!.window]++;
    if (changed?.has(name)) flash(row);
  }
  if (!changed) {
    const top = perWindow.indexOf(Math.max(...perWindow));
    if (perWindow[top] > 0) selectTab(tabs[top]);
    const link = $("#to-ranks");
    if (link) link.hidden = best.size === 0;
  }
}

function summary(found: number): string {
  const total = data.scenarios.length;
  return found === 0
    ? `None of the ${total} season scenarios have a run yet.`
    : `Runs found on ${found} of ${total} season scenarios.`;
}

// ---- stats folder ---------------------------------------------------------------------

const folderStatus = $("#folder-status");
const folderBest = new Map<string, number>();
const folderSeen = new Set<string>();

function setFolderStatus(text: string, live = false): void {
  if (!folderStatus) return;
  folderStatus.textContent = text;
  folderStatus.classList.toggle("live", live);
}

/** Read one file into the running bests. Returns the scenario it improved, if any. */
async function ingest(name: string, file: File): Promise<string | null> {
  const info = parseFilename(name);
  if (!info || !byName.has(info.scenario)) return null;
  const parsed = parseStatsFile(name, await file.text());
  if (!parsed.ok || !byName.has(parsed.run.scenario)) return null;
  const { scenario, score } = parsed.run;
  if ((folderBest.get(scenario) ?? -Infinity) >= score) return null;
  folderBest.set(scenario, score);
  return scenario;
}

type DirHandle = {
  name: string;
  values(): AsyncIterable<{ kind: "file" | "directory"; name: string; getFile(): Promise<File> }>;
  getDirectoryHandle(name: string): Promise<DirHandle>;
};

/** A player who picks FPSAimTrainer, or the folder above it, still gets their stats. */
async function statsDir(dir: DirHandle): Promise<DirHandle> {
  for await (const entry of dir.values()) {
    if (entry.kind === "file" && parseFilename(entry.name)) return dir;
  }
  for (const path of [["stats"], ["FPSAimTrainer", "stats"]]) {
    try {
      let d = dir;
      for (const part of path) d = await d.getDirectoryHandle(part);
      return d;
    } catch {
      /* not this layout */
    }
  }
  return dir;
}

async function scan(dir: DirHandle): Promise<Set<string>> {
  const changed = new Set<string>();
  for await (const entry of dir.values()) {
    if (entry.kind !== "file" || folderSeen.has(entry.name)) continue;
    folderSeen.add(entry.name);
    const hit = await ingest(entry.name, await entry.getFile());
    if (hit) changed.add(hit);
  }
  return changed;
}

let polling: number | null = null;

async function openFolder(): Promise<void> {
  const picker = (window as unknown as { showDirectoryPicker?: (o: object) => Promise<DirHandle> })
    .showDirectoryPicker;
  if (!picker) {
    $<HTMLInputElement>("#folder-input")!.click();
    return;
  }
  let dir: DirHandle;
  try {
    dir = await statsDir(await picker({ id: "kovaaks-stats", mode: "read" }));
  } catch {
    return; // the picker was dismissed
  }
  folderBest.clear();
  folderSeen.clear();
  setFolderStatus("Reading…");
  await scan(dir);
  apply(folderBest, "folder");
  if (folderSeen.size === 0) {
    setFolderStatus("No stats files in that folder. It is the one called stats, inside FPSAimTrainer.");
    return;
  }
  setFolderStatus(`${summary(folderBest.size)} Watching for new runs.`, true);

  if (polling !== null) clearInterval(polling);
  polling = window.setInterval(async () => {
    if (document.hidden) return;
    try {
      const changed = await scan(dir);
      if (changed.size) {
        apply(folderBest, "folder", changed);
        setFolderStatus(`${summary(folderBest.size)} Watching for new runs.`, true);
      }
    } catch {
      if (polling !== null) clearInterval(polling);
      setFolderStatus("Lost access to the folder. Open it again to keep watching.");
    }
  }, POLL_MS);
}

$("#folder-open")?.addEventListener("click", openFolder);
$<HTMLInputElement>("#folder-input")?.addEventListener("change", async (e) => {
  const files = Array.from((e.target as HTMLInputElement).files ?? []);
  folderBest.clear();
  setFolderStatus("Reading…");
  let stats = 0;
  for (const f of files) {
    if (parseFilename(f.name)) stats++;
    await ingest(f.name, f);
  }
  apply(folderBest, "folder");
  setFolderStatus(
    stats === 0
      ? "No stats files in that folder. It is the one called stats, inside FPSAimTrainer."
      : `${summary(folderBest.size)} Open it again after playing to update.`,
  );
});

// ---- KovaaK's username ----------------------------------------------------------------

interface Account {
  username: string;
  steamAccountName?: string;
}
interface PlayRow {
  leaderboardId: string | number;
  scenarioName: string;
  score: number;
}

const lookupForm = $<HTMLFormElement>("#lookup");
const lookupStatus = $("#lookup-status");

function setLookupStatus(html: string): void {
  if (lookupStatus) lookupStatus.innerHTML = html;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API}/${path}`);
  if (!res.ok) throw new Error(`KovaaK's answered ${res.status}`);
  return (await res.json()) as T;
}

async function lookup(name: string): Promise<void> {
  const query = name.trim();
  if (!query) return;
  setLookupStatus("Finding the account…");
  let accounts: Account[];
  try {
    accounts = await getJson<Account[]>(`user/search?username=${encodeURIComponent(query)}`);
  } catch {
    setLookupStatus("KovaaK's did not answer. Try again in a moment.");
    return;
  }
  const exact = accounts.find((a) => a.username?.toLowerCase() === query.toLowerCase());
  if (!exact) {
    if (accounts.length === 0) {
      setLookupStatus(`No KovaaK's account is called ${esc(query)}.`);
      return;
    }
    setLookupStatus(
      `No exact match. Did you mean ` +
        accounts
          .slice(0, 5)
          .map((a) => `<button type="button" class="suggest" data-name="${esc(a.username)}">${esc(a.username)}</button>`)
          .join(" ") +
        `?`,
    );
    for (const b of $$<HTMLButtonElement>(".suggest", lookupStatus!)) {
      b.addEventListener("click", () => {
        $<HTMLInputElement>("#lookup-name")!.value = b.dataset.name!;
        void lookup(b.dataset.name!);
      });
    }
    return;
  }

  try {
    localStorage.setItem(USERNAME_KEY, exact.username);
  } catch {
    /* private window: the name just is not remembered */
  }

  const byBoard = new Map<string, string>();
  for (const s of data.scenarios) if (s.leaderboardId) byBoard.set(String(s.leaderboardId), s.scenario);

  const best = new Map<string, number>();
  let total = 0;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await getJson<{ total: number; data: PlayRow[] }>(
        `user/scenario/total-play?username=${encodeURIComponent(exact.username)}&page=${page}&max=100`,
      );
      total = body.total;
      for (const r of body.data) {
        // By board where the season knows it, which survives a rename; by name otherwise.
        const name = byBoard.get(String(r.leaderboardId)) ?? (byName.has(r.scenarioName) ? r.scenarioName : null);
        if (name && (best.get(name) ?? -Infinity) < r.score) best.set(name, r.score);
      }
      if ((page + 1) * 100 >= total) break;
      setLookupStatus(`Reading ${esc(exact.username)}'s scenarios, ${num.format(Math.min((page + 1) * 100, total))} of ${num.format(total)}…`);
    }
  } catch {
    setLookupStatus("KovaaK's stopped answering partway through. Try again in a moment.");
    return;
  }

  apply(best, "kovaaks");
  setLookupStatus(`<b>${esc(exact.username)}</b>. ${summary(best.size)}`);
}

if (lookupForm && data.liveLookup) {
  lookupForm.addEventListener("submit", (e) => {
    e.preventDefault();
    void lookup($<HTMLInputElement>("#lookup-name")!.value);
  });
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(USERNAME_KEY);
  } catch {
    /* storage unavailable */
  }
  if (saved) {
    $<HTMLInputElement>("#lookup-name")!.value = saved;
    void lookup(saved);
  }
}
