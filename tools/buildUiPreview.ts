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

import { readFileSync, writeFileSync } from "node:fs";

const RENDERER_DIR = new URL("../src/app/renderer/", import.meta.url);
const OUT = new URL("./arena-ui-preview.html", import.meta.url);

const snapshot = readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8");
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

const html = `<title>Arena Client Preview</title>
${style}
${body}
<script id="arena-snapshot" type="application/json">${snapshot}</script>
<script>
  // Static host: hand the renderer its data instead of an Electron bridge.
  window.__ARENA_SNAPSHOT__ = JSON.parse(
    document.getElementById("arena-snapshot").textContent
  );
</script>
<script>
${rendererJs}
</script>
`;

writeFileSync(OUT, html, "utf8");

console.log(
  `wrote tools/arena-ui-preview.html  (${(html.length / 1024).toFixed(0)} KB, ` +
    `renderer ${(rendererJs.length / 1024).toFixed(0)} KB, ` +
    `snapshot ${(snapshot.length / 1024).toFixed(0)} KB)`,
);
