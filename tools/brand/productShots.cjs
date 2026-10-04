/**
 * Product shots for the marketing kit: the real renderer, photographed.
 *
 *   npm run brand:shots     (builds the preview first, then runs this)
 *
 * Not a mock-up. The page is tools/buildUiPreview.ts's output: renderer.js, cosmic.js and
 * the rest of the client on the committed data/snapshot.json, the same page the video
 * films. Three screens are photographed at 1440x900 into assets/brand/marketing/shots/:
 *
 *   queue.png    Play arena: the category picker and the ladder card
 *   ranks.png    the Apogee ladder with the player's tier
 *   result.png   Last match: the snapshot's example match, labelled as such by the app
 *
 * Two things differ from a Windows desktop, and both are said in docs/fleet/brand.md:
 * the preview's own "Design preview" banners and scrollbars are hidden (the video hides
 * the same ones), and Bahnschrift, a Windows font that cannot be redistributed, is set in
 * Barlow, the open face the brand kit already uses in its place. Every request off the
 * machine is cancelled; there are no credentials in the preview.
 */

const { app, BrowserWindow } = require("electron");
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");

const root = resolve(__dirname, "..", "..");
const preview = resolve(root, process.argv.at(-2));
const out = resolve(root, process.argv.at(-1));
mkdirSync(out, { recursive: true });
app.setPath("userData", mkdtempSync(join(tmpdir(), "apogee-shots-")));
app.commandLine.appendSwitch("force-device-scale-factor", "1");

const font = (file) => `url(data:font/woff2;base64,${readFileSync(join(root, "assets", "brand", "fonts", file)).toString("base64")}) format('woff2')`;
const CSS = [
  ...[400, 500, 600].map((w) => `@font-face{font-family:'Bahnschrift';font-weight:${w};src:${font(`barlow-latin-${w}-normal.woff2`)}}`),
  ...[400, 600].map((w) => `@font-face{font-family:'Cascadia Mono';font-weight:${w};src:${font(`cascadia-mono-latin-${w}-normal.woff2`)}}`),
  "#previewNote,#tnPreviewNote,#footnote,#tnLive{display:none!important}",
  "*{scrollbar-width:none!important}*::-webkit-scrollbar{display:none!important}",
].join("\n");

const SHOTS = [
  { name: "queue", screen: "queue" },
  { name: "ranks", screen: "ranks" },
  { name: "result", screen: "result" },
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const blocked = [];
  win.webContents.session.webRequest.onBeforeRequest((d, cb) => {
    const off = /^(https?|wss?):/.test(d.url);
    if (off) blocked.push(d.url);
    cb({ cancel: off });
  });
  await win.loadFile(preview);
  await win.webContents.insertCSS(CSS);
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
  await wait(1200);
  for (const s of SHOTS) {
    const ok = await win.webContents.executeJavaScript(`(() => { const t = document.querySelector('.tab[data-screen="${s.screen}"]'); if (!t) return false; t.click(); return true; })()`);
    if (!ok) throw new Error(`no tab for ${s.screen}: the preview changed`);
    await wait(900);
    // Offscreen pages do not advance CSS animations; every entrance is placed at its end.
    await win.webContents.executeJavaScript("document.getAnimations().forEach((a) => { try { a.finish() } catch {} }); window.scrollTo(0, 0); document.querySelectorAll('.scroll').forEach((e) => e.scrollTop = 0); true");
    await wait(300);
    win.webContents.invalidate();
    await wait(150);
    const png = (await win.webContents.capturePage()).toPNG();
    writeFileSync(join(out, `${s.name}.png`), png);
    console.log(`  ${s.name}.png`);
  }
  if (blocked.length) console.log(`  cancelled ${blocked.length} network request(s)`);
  app.quit();
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
