/**
 * Draw one Workshop preview per family, for workshop:upload.
 *
 *   npm run workshop:previews        writes .cache/workshop-previews/<family>.png
 *
 * KovaaK's own uploader never takes a screenshot: every item uploaded through it so far
 * carries the same stock dartboard, so a player browsing the Workshop could not tell an
 * Apogee scenario from anything else. One card per family rather than per scenario,
 * because the four bands of a family are the same drill at four sizes and the title
 * already says which band it is.
 *
 * Colours and fonts are the app's, read out of the stylesheets the way buildIcon.mjs reads
 * them (last value in stylesheet order), and the mark is the rail's path, so the card on
 * the Workshop is recognisably the client that ranks it. Rendered by Electron offscreen
 * because it already lays out the app's type; there is no image dependency.
 *
 * 600x600: Steam crops browse thumbnails to a square, and a flat card this size is well
 * under the Workshop's 1 MB preview limit, which this checks.
 */

const { app, BrowserWindow } = require("electron");
const { mkdirSync, readFileSync, writeFileSync, mkdtempSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");

const root = resolve(__dirname, "..");
const out = join(root, ".cache", "workshop-previews");
const read = (p) => readFileSync(join(root, p), "utf8");

const html = read("src/app/renderer/index.html");
const css = html.slice(0, html.indexOf("</style>")) + "\n" + ["arena", "arcade", "cosmic"].map((f) => read(`src/app/renderer/${f}.css`)).join("\n");
function token(name, pattern = "#[0-9a-fA-F]{6}") {
  const m = [...css.matchAll(new RegExp("--" + name + ":\\s*(" + pattern + ")\\s*;", "g"))].at(-1);
  if (!m) throw new Error(`--${name} has no value in the stylesheets`);
  return m[1];
}
const T = {
  ground: token("ground"),
  panel: token("panel"),
  brand: token("brand"),
  ink: token("ink"),
  dim: token("ink-dim"),
  rule: token("rule-2"),
  font: token("font", "[^;]+"),
  mono: token("mono", "[^;]+"),
};
/** Same path buildIcon.mjs checks against every copy of the mark in the app. */
const MARK = "m3 20 9-17 9 17M3 20l9-6 9 6M8 11h8M12 3l0 11";

const { families } = JSON.parse(read("data/season-1/families.json"));
const season = JSON.parse(read("data/seasons/season-1.json"));
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function card(f) {
  // Long names ("Shooting Stars", "Constellation") must stay on one line at 600px.
  const size = f.family.length > 11 ? 64 : f.family.length > 8 ? 78 : 92;
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:600px;height:600px;overflow:hidden}
    body{background:${T.ground};color:${T.ink};font-family:${T.font};box-sizing:border-box;padding:48px;
      display:flex;flex-direction:column;justify-content:space-between;
      background-image:radial-gradient(circle at 85% 12%, ${T.panel} 0, transparent 60%)}
    .top{display:flex;align-items:center;gap:14px;font-family:${T.mono};font-size:18px;letter-spacing:.14em;color:${T.dim};text-transform:uppercase}
    .top svg{width:40px;height:40px}
    .cat{font-family:${T.mono};font-size:20px;letter-spacing:.12em;text-transform:uppercase;color:${T.brand};margin-bottom:14px}
    h1{margin:0;font-size:${size}px;line-height:1;font-weight:700;letter-spacing:-.02em;white-space:nowrap}
    p{margin:26px 0 0;padding-top:22px;border-top:2px solid ${T.rule};font-size:24px;line-height:1.35;color:${T.dim}}
  </style><body>
    <div class="top"><svg viewBox="0 0 24 24" fill="none" stroke="${T.brand}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${MARK}"/></svg>Apogee · ${esc(season.name)}</div>
    <div><div class="cat">${esc(f.category)}</div><h1>${esc(f.family)}</h1><p>${esc(f.focus)}</p></div>
  </body>`;
}

app.setPath("userData", mkdtempSync(join(tmpdir(), "apogee-previews-")));
app.whenReady().then(async () => {
  mkdirSync(out, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 600, height: 600, useContentSize: true, webPreferences: { offscreen: true } });
  const failures = [];
  for (const f of families) {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(card(f)));
    await new Promise((r) => setTimeout(r, 150));
    const overflow = await win.webContents.executeJavaScript(
      `(()=>{const h=document.querySelector('h1');return h.scrollWidth>h.clientWidth+1||document.body.scrollHeight>600})()`,
    );
    if (overflow) failures.push(`${f.family}: text runs off the card`);
    const png = (await win.webContents.capturePage()).resize({ width: 600, height: 600 }).toPNG();
    if (png.length > 1_000_000) failures.push(`${f.family}: ${png.length} bytes, over the Workshop's 1 MB limit`);
    writeFileSync(join(out, `${f.family}.png`), png);
  }
  console.log(`${families.length} previews in ${out}`);
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  }
  app.quit();
});
