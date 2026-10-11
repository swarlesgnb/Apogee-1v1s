/**
 * The video pipeline's card.html with a mechanic's `glyph`, rendered and photographed: the
 * check validate:brand runs so a scene from tools/video/mechanics.json is known to draw
 * before anyone films it.
 *
 *   electron tools/brand/cardSmoke.cjs <jobs.json>
 *
 * Each job is { card, width, height, out }. The page is built the way record.cjs builds a
 * card page (fonts and tokens inlined, the emblem from assets/brand/mechanics), seeked to
 * 3 s, and captured. Fails if the page throws, if the title had to be shrunk to fit
 * (card.html's window.__fit below 1), or if the glyph is missing from the top row.
 */

const { app, BrowserWindow } = require("electron");
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { tmpdir } = require("node:os");

const root = resolve(__dirname, "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const jobs = JSON.parse(readFileSync(process.argv.at(-1), "utf8"));
app.setPath("userData", mkdtempSync(join(tmpdir(), "apogee-card-")));
app.commandLine.appendSwitch("force-device-scale-factor", "1");

// As record.cjs: the brand faces inlined, the theme tokens read from the stylesheets.
function brandFonts() {
  const face = (family, weight, file) =>
    `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;src:url(data:font/woff2;base64,${readFileSync(join(root, "assets", "brand", "fonts", file)).toString("base64")}) format('woff2')}`;
  return [
    ...[400, 500, 600].map((w) => face("Apogee Display", w, `barlow-latin-${w}-normal.woff2`)),
    ...[400, 600].map((w) => face("Apogee Mono", w, `cascadia-mono-latin-${w}-normal.woff2`)),
  ].join("\n");
}
function themeTokens() {
  const html = read("src/app/renderer/index.html");
  const css = html.slice(0, html.indexOf("</style>")) + "\n" + ["arena", "arcade", "cosmic"].map((f) => read(`src/app/renderer/${f}.css`)).join("\n");
  const token = (name) => {
    const m = [...css.matchAll(new RegExp("--" + name + ":\\s*([^;]+);", "g"))].at(-1);
    if (!m) throw new Error(`--${name} has no value in the stylesheets`);
    return `--${name}:${m[1].trim()};`;
  };
  return ["ground", "panel", "brand", "ink", "ink-mid", "ink-dim", "font", "mono", "display"].map(token).join("");
}
function cardPage(card) {
  return read("tools/video/card.html")
    .replace("/*FONTS*/", () => brandFonts())
    .replace("/*TOKENS*/", () => themeTokens())
    .replace("/*CARD*/", () => JSON.stringify(card))
    .replace("/*LOCKUPS*/", () => "{}")
    .replace("/*IMAGES*/", () => "{}")
    .replace("/*GLYPHS*/", () => JSON.stringify(card.glyph ? { [card.glyph]: read(`assets/brand/mechanics/emblems/dark/${card.glyph}.svg`) } : {}));
}

// One window per card, closed after: without this, closing the first quits the app.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const dir = mkdtempSync(join(tmpdir(), "apogee-card-page-"));
  const failures = [];
  for (const [i, job] of jobs.entries()) {
    const win = new BrowserWindow({ show: false, width: job.width, height: job.height, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } });
    const errors = [];
    win.webContents.on("console-message", (e) => { if (e.level === "error") errors.push(e.message); });
    const file = join(dir, `card-${i}.html`);
    writeFileSync(file, cardPage(job.card));
    await win.loadFile(file);
    await win.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
    const r = await win.webContents.executeJavaScript(`(() => { window.__card.seek(3); return { fit: window.__fit, glyph: !!document.querySelector('.top > svg.glyph'), w: innerWidth, h: innerHeight }; })()`);
    await new Promise((res) => setTimeout(res, 250));
    win.webContents.invalidate();
    await new Promise((res) => setTimeout(res, 150));
    const png = (await win.webContents.capturePage()).toPNG();
    mkdirSync(dirname(job.out), { recursive: true });
    writeFileSync(job.out, png);
    const name = `${job.card.glyph} ${job.width}x${job.height}`;
    if (errors.length) failures.push(`${name}: ${errors.join("; ")}`);
    if (r.fit < 1) failures.push(`${name}: the title was shrunk to ${(r.fit * 100).toFixed(0)}% to fit`);
    if (!r.glyph) failures.push(`${name}: the glyph is not in the top row`);
    win.destroy();
  }
  console.log(`  card.html: ${jobs.length} mechanic card(s) drawn`);
  if (failures.length) {
    console.error(failures.map((f) => `  FAIL ${f}`).join("\n"));
    process.exitCode = 1;
  }
  app.quit();
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
