/**
 * Build the shareable single-file UI preview.
 *
 * Inlines the renderer's own HTML, CSS and JS together with a real snapshot, so the
 * preview and the Electron client are the same UI rather than two that drift apart. If
 * a screen looks right here, it looks right in the app.
 *
 *   npx tsx src/core/report/exportSnapshot.ts
 *   npx tsx tools/buildUiPreview.ts
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { scanStatsFolder } from "../src/core/history/history.ts";
import { loadSeason } from "../src/core/season/season.ts";
import { practicePlaylists, practiceRows } from "../src/core/season/practice.ts";
import { sampleTournamentView } from "../src/core/tournament/sample.ts";
import { loadExpedition, rewardCatalog } from "../src/core/expedition/definition.ts";

const RENDERER_DIR = new URL("../src/app/renderer/", import.meta.url);
// APOGEE_PREVIEW_OUT lets a tool build its own copy (the video pipeline does) without
// rewriting the tracked preview, which would leave every render as a dirty working tree.
const OUT: string | URL = process.env.APOGEE_PREVIEW_OUT ?? new URL("./apogee-ui-preview.html", import.meta.url);

const snapshot = readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8");

/**
 * The Season screen's practice list, baked in beside the snapshot.
 *
 * Without it the preview shows that panel empty, which is the wrong thing to send someone
 * for feedback on the one screen the season is played from. Same helper the app calls, so
 * the preview cannot show a different personal best from the client.
 *
 * No stats folder is a fair state rather than a failure - the preview still builds, and
 * the panel says so itself.
 */
const previewSeason = loadSeason();
const practice = (() => {
  const statsDir = [
    process.env.APOGEE_STATS_DIR,
    "C:/Program Files (x86)/Steam/steamapps/common/FPSAimTrainer/FPSAimTrainer/stats",
    "D:/steam/steamapps/common/FPSAimTrainer/FPSAimTrainer/stats",
    "E:/steam/steamapps/common/FPSAimTrainer/FPSAimTrainer/stats",
  ].find((p): p is string => Boolean(p) && existsSync(p!));
  if (!statsDir) return null;

  try {
    const season = previewSeason;
    const { rows, families } = practiceRows(season, scanStatsFolder(statsDir));
    return {
      families,
      scenarios: rows,
      season: {
        name: season.name,
        status: season.status,
        windows: season.windows ?? [],
        windowSize: season.windowSize ?? 4,
        categories: season.categories.map((c) => ({
          name: c.name,
          rankNames: c.rankNames,
          rankColors: c.rankColors,
        })),
      },
      // The installer writes into a game folder, so the preview shows the list and not
      // the button: a shared HTML page has nowhere to write and nothing to write to.
      playlists: practicePlaylists(season).map((p) => ({
        name: p.name,
        category: p.category,
        window: p.window,
        scenarios: p.scenarios.length,
      })),
      playlistDir: null,
      installed: 0,
    };
  } catch {
    return null;
  }
})();
const indexHtml = readFileSync(new URL("index.html", RENDERER_DIR), "utf8");
const rendererJs = readFileSync(new URL("renderer.js", RENDERER_DIR), "utf8");
const cosmicJs = readFileSync(new URL("cosmic.js", RENDERER_DIR), "utf8");
const atlasFiles = [...Array.from({length:6}, (_,i) => `world-${i+1}`), "final", "ship"];
const atlasAssets = Object.fromEntries(atlasFiles.map(name => [name, "data:image/svg+xml;base64," + readFileSync(new URL(`assets/atlas/${name}.svg`, RENDERER_DIR)).toString("base64")]));
const cosmicAssets = atlasFiles.slice(0,7).map(name => atlasAssets[name]);
const cosmicCss = readFileSync(new URL("cosmic.css", RENDERER_DIR), "utf8").replace(/url\('assets\/atlas\/([a-z0-9-]+)\.svg'\)/g, (_, name) => `url('${atlasAssets[name]}')`);
const expeditionJs = readFileSync(new URL("expedition.js", RENDERER_DIR), "utf8");
const expeditionDefinition = loadExpedition();
const { journeys } = await import('../src/core/expedition/journey.ts');
const expeditionView = { definition: expeditionDefinition, state: null, rewards: rewardCatalog(expeditionDefinition), error: null, canPlay: false, sessionStartedAt: Date.now(), journeys };

// Only the style block and the body content are taken from index.html. The document
// around them is rebuilt below, because the preview swaps the Electron bridge for inline
// data scripts and the renderer's own <head> would load files that are not beside it.
const styleMatch = /<style>[\s\S]*?<\/style>/.exec(indexHtml);
const bodyMatch = /^<body\b[^>]*>([\s\S]*?)<\/body>/m.exec(indexHtml);

if (!styleMatch || !bodyMatch) {
  throw new Error("could not extract <style> and <body> from the renderer HTML");
}

const arenaCss = readFileSync(new URL("arena.css", RENDERER_DIR), "utf8");
const tournamentCss = readFileSync(new URL("tournament.css", RENDERER_DIR), "utf8");
const arcadeCss = readFileSync(new URL("arcade.css", RENDERER_DIR), "utf8");
const style = styleMatch[0] + "\n<style>" + arenaCss + "</style>\n<style>" + tournamentCss + "</style>\n<style>" + arcadeCss + "</style>\n<style>" + readFileSync(new URL("expedition.css", RENDERER_DIR), "utf8") + "</style>";

// An example tournament, built by the real engine and view with invented players, so the
// screen has something honest to draw with no server behind it. Labelled on the page.
const tournamentSample = {
  registration: sampleTournamentView({ stage: "registration", viewerHosts: true }),
  groups: sampleTournamentView({ stage: "groups" }),
  playoffs: sampleTournamentView({ stage: "playoffs" }),
  completed: sampleTournamentView({ stage: "completed" }),
};
const body = bodyMatch[1]
  // The preview supplies its own inline script instead of loading the file.
  .replace(/<script src="(?:renderer|cosmic|expedition|presentation|mixtape-engine|mixtape|ghost|share|crowns|race|queue-board)\.js"><\/script>/g, "");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Apogee Client Preview</title>
${style}
<style>${cosmicCss}</style>
<style>${readFileSync(new URL("presentation.css", RENDERER_DIR), "utf8")}</style>
<style>${readFileSync(new URL("mixtape.css", RENDERER_DIR), "utf8")}</style>
<style>${readFileSync(new URL("ghost.css", RENDERER_DIR), "utf8")}</style>
<style>${readFileSync(new URL("share.css", RENDERER_DIR), "utf8")}</style>
<style>${readFileSync(new URL("crowns.css", RENDERER_DIR), "utf8")}</style>
<style>${readFileSync(new URL("queue-board.css", RENDERER_DIR), "utf8")}</style>
</head><body data-screen="queue">
${body}
<script id="apogee-snapshot" type="application/json">${snapshot}</script>
<script id="apogee-season" type="application/json">${JSON.stringify(previewSeason)}</script>
<script id="apogee-practice" type="application/json">${JSON.stringify(practice)}</script>
<script id="apogee-tournament" type="application/json">${JSON.stringify(tournamentSample).replace(/</g, "\\u003c")}</script>
<script id="apogee-expedition" type="application/json">${JSON.stringify(expeditionView).replace(/</g, "\\u003c")}</script>
<script>
  window.__APOGEE_EXPEDITION__ = JSON.parse(document.getElementById('apogee-expedition').textContent);
  // Static host: hand the renderer its data instead of an Electron bridge.
  window.__APOGEE_SNAPSHOT__ = JSON.parse(
    document.getElementById("apogee-snapshot").textContent
  );
  window.__APOGEE_SEASON__ = JSON.parse(
    document.getElementById("apogee-season").textContent
  );
  window.__APOGEE_PRACTICE__ = JSON.parse(
    document.getElementById("apogee-practice").textContent
  );
  window.__APOGEE_TOURNAMENT__ = JSON.parse(
    document.getElementById("apogee-tournament").textContent
  );
</script>
<script>
${rendererJs}
</script>
<script>window.__COSMIC_ASSETS__ = ${JSON.stringify(cosmicAssets)};</script>
<script>${cosmicJs}</script>
<script>${expeditionJs}</script>
<script>${readFileSync(new URL("presentation.js", RENDERER_DIR), "utf8")}</script>
<script>${readFileSync(new URL("mixtape-engine.js", RENDERER_DIR), "utf8")}</script>
<script>${readFileSync(new URL("mixtape.js", RENDERER_DIR), "utf8")}</script>
<script>${readFileSync(new URL("ghost.js", RENDERER_DIR), "utf8")}</script>
<script>${readFileSync(new URL("share.js", RENDERER_DIR), "utf8")}</script>
<script>${readFileSync(new URL("crowns.js", RENDERER_DIR), "utf8")}</script>
<script>${readFileSync(new URL("race.js", RENDERER_DIR), "utf8")}</script>
<script>${readFileSync(new URL("queue-board.js", RENDERER_DIR), "utf8")}</script>
</body></html>
`;

writeFileSync(OUT, html, "utf8");

console.log(
  `wrote ${process.env.APOGEE_PREVIEW_OUT ?? "tools/apogee-ui-preview.html"}  (${(html.length / 1024).toFixed(0)} KB, ` +
    `renderer ${(rendererJs.length / 1024).toFixed(0)} KB, ` +
    `snapshot ${(snapshot.length / 1024).toFixed(0)} KB` +
    `${practice ? `, ${practice.scenarios.length} practice rows` : ", no practice list"})`,
);
