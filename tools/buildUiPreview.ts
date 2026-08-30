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

const RENDERER_DIR = new URL("../src/app/renderer/", import.meta.url);
const OUT = new URL("./apogee-ui-preview.html", import.meta.url);

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
const practice = (() => {
  const statsDir = [
    process.env.APOGEE_STATS_DIR,
    "C:/Program Files (x86)/Steam/steamapps/common/FPSAimTrainer/FPSAimTrainer/stats",
    "D:/steam/steamapps/common/FPSAimTrainer/FPSAimTrainer/stats",
    "E:/steam/steamapps/common/FPSAimTrainer/FPSAimTrainer/stats",
  ].find((p): p is string => Boolean(p) && existsSync(p!));
  if (!statsDir) return null;

  try {
    const season = loadSeason();
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

// The artifact host wraps page content in its own document skeleton, so strip the
// standalone document furniture and keep the body content plus the style block.
const styleMatch = /<style>[\s\S]*?<\/style>/.exec(indexHtml);
const bodyMatch = /<body>([\s\S]*?)<\/body>/.exec(indexHtml);

if (!styleMatch || !bodyMatch) {
  throw new Error("could not extract <style> and <body> from the renderer HTML");
}

const style = styleMatch[0];
const body = bodyMatch[1]
  // The preview supplies its own inline script instead of loading the file.
  .replace(/<script src="renderer\.js"><\/script>/, "");

const html = `<title>Apogee Client Preview</title>
${style}
${body}
<script id="apogee-snapshot" type="application/json">${snapshot}</script>
<script id="apogee-practice" type="application/json">${JSON.stringify(practice)}</script>
<script>
  // Static host: hand the renderer its data instead of an Electron bridge.
  window.__APOGEE_SNAPSHOT__ = JSON.parse(
    document.getElementById("apogee-snapshot").textContent
  );
  window.__APOGEE_PRACTICE__ = JSON.parse(
    document.getElementById("apogee-practice").textContent
  );
</script>
<script>
${rendererJs}
</script>
`;

writeFileSync(OUT, html, "utf8");

console.log(
  `wrote tools/apogee-ui-preview.html  (${(html.length / 1024).toFixed(0)} KB, ` +
    `renderer ${(rendererJs.length / 1024).toFixed(0)} KB, ` +
    `snapshot ${(snapshot.length / 1024).toFixed(0)} KB` +
    `${practice ? `, ${practice.scenarios.length} practice rows` : ", no practice list"})`,
);
