/**
 * Film one cut of the shot list into per-scene clips.
 *
 *   electron tools/video/record.cjs --cut trailer --preview <html> --out <dir> [--with id,id] [--only id]
 *
 * Normally run by tools/video/make.mjs, which builds the preview first and assembles the
 * clips afterwards. Writes <out>/<NN>-<scene>.mp4 and <out>/manifest.json.
 *
 * Filmed in real time from the offscreen window's paint stream rather than by stepping a
 * virtual clock. The app's motion is CSS transitions, WebGL and requestAnimationFrame
 * spread over a dozen files; a virtual clock would have to own all three, and the first
 * thing to drift would be the part of the app being shown off. The price is that a slow
 * machine drops frames, so every clip reports how many distinct frames it actually got,
 * and make.mjs refuses a clip that is mostly repeats.
 *
 * Offscreen windows only paint when something changes, so the sampler repeats the latest
 * paint to hold 30fps; a still frame is the same image for as long as it is still.
 *
 * No network. The preview is a static file with its data inlined, and every http(s) and
 * ws(s) request is cancelled and counted, so nothing filmed can reach Supabase or anywhere
 * else, and a stray request shows up in the manifest instead of in someone's logs.
 */

const { app, BrowserWindow, session } = require("electron");
const { spawn } = require("node:child_process");
const { mkdirSync, readFileSync, writeFileSync, mkdtempSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");

const root = resolve(__dirname, "..", "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf("--" + name);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const cutName = arg("cut", "trailer");
const previewPath = resolve(arg("preview", join(root, ".cache", "video", "preview.html")));
const outDir = resolve(arg("out", join(root, ".cache", "video", cutName)));
const enable = new Set((arg("with", "") || "").split(",").filter(Boolean));
const only = arg("only", null);

const shots = JSON.parse(readFileSync(join(__dirname, "shots.json"), "utf8"));
const cut = shots.cuts[cutName];
if (!cut) throw new Error(`no cut named ${cutName} in shots.json`);
const FPS = shots.fps || 30;
const W = cut.width, H = cut.height;

// Pixel-exact frames: a 125%-scaled Windows desktop would otherwise hand back 2400x1350
// paints for a 1920x1080 window. Zoom is applied per cut through the page instead.
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("high-dpi-support", "1");
app.setPath("userData", mkdtempSync(join(tmpdir(), "apogee-video-")));

const read = (p) => readFileSync(join(root, p), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The cosmic theme's tokens, last value in stylesheet order, as workshopPreviews.cjs reads them. */
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

/**
 * The preview with the stage directions in its head and the demo match in its snapshot.
 *
 * The snapshot's own example match is whatever exportSnapshot drew for the owner's last
 * data - a defeat on two rounds of 0.0%, the day this was written - which is honest in a
 * preview and says nothing in a trailer. The demo match replaces only that field; every
 * other number on screen is the snapshot's.
 */
function stagedPreview() {
  let html = readFileSync(previewPath, "utf8");
  const open = '<script id="apogee-snapshot" type="application/json">';
  const a = html.indexOf(open);
  const b = html.indexOf("</script>", a);
  if (a < 0 || b < 0) throw new Error("preview has no inlined snapshot; rebuild it with tools/buildUiPreview.ts");
  if (!html.includes(GHOST_MARKER)) throw new Error("preview has no ghost.js; rebuild it with tools/buildUiPreview.ts");
  const snapshot = JSON.parse(html.slice(a + open.length, b));
  if (shots.demo?.match) snapshot.match = shots.demo.match;
  html = html.slice(0, a + open.length) + JSON.stringify(snapshot) + html.slice(b);
  const stage = readFileSync(join(__dirname, "stage.js"), "utf8");
  // Function replacers throughout: the payloads carry base64 and minified script, and a
  // "$&" in either would be read as a replacement pattern by the string form.
  html = html.replace("<head>", () => "<head><style>" + brandFonts() + "</style><script>" + stage + "</script>");
  return html.replace(GHOST_MARKER, () => ghostBridge() + GHOST_MARKER);
}

/**
 * Ghost Mode reads its screens from window.apogee, which the preview host does not
 * provide: main draws the match, and there is no main here. The bridge answers with the
 * frozen screens in tools/video/ghost.json (drawn by the real core, see ghostDemo.ts),
 * the way tools/ghostUi.cjs feeds its fixture. Race and Start answer with the screen the
 * app's GhostService would send back; the runs landing are pushed by stage.js on cue.
 * It goes in just before ghost.js, which reads the bridge the moment it loads.
 */
const GHOST_MARKER = "<script>/* Ghost Mode:";
function ghostBridge() {
  const screens = JSON.parse(readFileSync(join(__dirname, "ghost.json"), "utf8"));
  return `<script>(()=>{const S=${JSON.stringify(screens)};let cur=S.choose;const hs=[];` +
    `const answer={draw:"ready",start:"started",rematch:"ready",dismiss:"choose"};` +
    `window.__ghostPush=(name)=>{if(!S[name])throw new Error("no ghost screen "+name);cur=S[name];hs.forEach((h)=>h(cur));};` +
    `window.apogee=Object.assign(window.apogee||{},{ghost:async()=>cur,` +
    `ghostAction:async(a)=>{if(answer[a.type])cur=S[answer[a.type]];return {view:cur};},` +
    `onGhost:(h)=>hs.push(h),onMatchSettled:()=>{}});})();</script>`;
}

/**
 * The brand kit's faces as @font-face rules with the fonts inlined, under the family names
 * the kit's own SVGs use, so a card, a caption and an inlined lockup all resolve to the
 * same files. Inlined rather than linked because the staged pages are written into
 * .cache/, and a relative url() from there would depend on where .cache/ is.
 */
function brandFonts() {
  const face = (family, weight, file) =>
    `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;src:url(data:font/woff2;base64,${readFileSync(join(root, "assets", "brand", "fonts", file)).toString("base64")}) format('woff2')}`;
  return [
    ...[400, 500, 600].map((w) => face("Apogee Display", w, `barlow-latin-${w}-normal.woff2`)),
    ...[400, 600].map((w) => face("Apogee Mono", w, `cascadia-mono-latin-${w}-normal.woff2`)),
  ].join("\n");
}

const dataUri = (p) => `data:${p.endsWith(".svg") ? "image/svg+xml" : "image/png"};base64,${readFileSync(join(root, p)).toString("base64")}`;

function cardPage(card) {
  const lockups = { horizontal: "assets/brand/logo/horizontal-dark.svg", stacked: "assets/brand/logo/stacked-dark.svg" };
  const images = Object.fromEntries((card.images || []).map((im) => [im.src, dataUri(im.src)]));
  return readFileSync(join(__dirname, "card.html"), "utf8")
    .replace("/*FONTS*/", () => brandFonts())
    .replace("/*TOKENS*/", () => themeTokens())
    .replace("/*CARD*/", () => JSON.stringify(card))
    .replace("/*LOCKUPS*/", () => JSON.stringify(card.lockup ? { [card.lockup]: read(lockups[card.lockup]) } : {}))
    .replace("/*IMAGES*/", () => JSON.stringify(images));
}

/* ------------------------------------------------------------------ camera */

function startEncoder(file) {
  // Intermediate only: fast, near-lossless, re-encoded once by make.mjs at final quality.
  const ff = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-pix_fmt", "yuv420p", file,
  ], { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  ff.stderr.on("data", (d) => (err += d));
  const done = new Promise((res, rej) => ff.on("close", (code) => (code === 0 ? res() : rej(new Error(`ffmpeg ${code}: ${err}`)))));
  return { ff, done };
}

/**
 * Roll for `seconds`, firing `steps` on schedule, and write exactly seconds*FPS frames.
 */
async function roll(win, file, seconds, steps, onStart) {
  const frames = Math.round(seconds * FPS);
  let latest = null;
  let latestId = 0;
  const onPaint = (_e, _dirty, image) => { latest = image; latestId++; };
  win.webContents.on("paint", onPaint);
  win.webContents.invalidate();
  for (let i = 0; i < 50 && !latest; i++) await sleep(20);
  if (!latest) throw new Error("the window never painted");
  const size = latest.getSize();
  if (size.width !== W || size.height !== H) throw new Error(`paint is ${size.width}x${size.height}, expected ${W}x${H}`);

  const { ff, done } = startEncoder(file);
  let bitmap = null, bitmapId = -1, distinct = 0, backlog = 0;
  const errors = [];
  const t0 = performance.now();
  if (onStart) onStart();
  const timers = steps.map((s) => setTimeout(() => {
    win.webContents.executeJavaScript(`window.__stage.run(${JSON.stringify(s)}).then(()=>null,e=>String(e&&e.stack||e))`, true)
      .then((e) => e && errors.push(`${s.do} @${s.at}s: ${e}`));
  }, s.at * 1000));

  for (let n = 0; n < frames; n++) {
    const due = t0 + (n * 1000) / FPS;
    while (performance.now() < due) await sleep(Math.max(1, Math.min(8, due - performance.now())));
    if (latestId !== bitmapId) {
      bitmap = latest.toBitmap();
      bitmapId = latestId;
      distinct++;
    }
    if (!ff.stdin.write(bitmap)) backlog++;
  }
  timers.forEach(clearTimeout);
  win.webContents.off("paint", onPaint);
  ff.stdin.end();
  await done;
  return { frames, distinct, backlog, errors, wall: (performance.now() - t0) / 1000 };
}

/* ------------------------------------------------------------------- scenes */

async function main() {
  mkdirSync(outDir, { recursive: true });
  const blocked = [];
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (d, cb) => {
    blocked.push(d.url);
    cb({ cancel: true });
  });

  const win = new BrowserWindow({
    show: false, width: W, height: H, useContentSize: true, enableLargerThanScreen: true, frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  // A 1080x1920 window is taller than most screens, and Windows clamps it to the work area
  // unless told otherwise: the first portrait test came back 1080x1032.
  win.setContentSize(W, H);
  win.webContents.setAudioMuted(true);
  win.webContents.setFrameRate(60);
  const consoleErrors = [];
  win.webContents.on("console-message", (e) => {
    const { level, message } = e;
    if (level === "error" && !/Electron Security Warning/.test(message)) { consoleErrors.push(message); console.error("\n  renderer: " + message); }
  });

  const staged = join(outDir, "staged-preview.html");
  writeFileSync(staged, stagedPreview());

  const scenes = cut.scenes.filter((s) => (s.enabled !== false || enable.has(s.id)) && (!only || s.id === only));
  const manifest = { cut: cutName, width: W, height: H, fps: FPS, out: cut.out, transition: cut.transition, clips: [], blocked, consoleErrors };
  let previousKind = null;

  for (const [i, scene] of scenes.entries()) {
    const file = join(outDir, `${String(i + 1).padStart(2, "0")}-${scene.id}.mp4`);
    const report = { id: scene.id, file, seconds: scene.seconds, transition: scene.transition || null, placeholder: scene.placeholder || null };
    process.stdout.write(`  ${cutName} · ${scene.id} (${scene.seconds}s)… `);

    if (scene.kind === "card") {
      const page = join(outDir, `card-${scene.id}.html`);
      writeFileSync(page, cardPage(scene.card));
      await win.loadFile(page);
      win.webContents.setZoomFactor(1);
      await sleep(250);
      report.fit = await win.webContents.executeJavaScript("window.__fit", true);
      Object.assign(report, await roll(win, file, scene.seconds, [], () => win.webContents.executeJavaScript("window.__card.start()", true)));
    } else {
      if (!(scene.continue && previousKind === "app")) {
        await win.loadFile(staged);
        // A scene may set its own zoom: the ghost board is three lanes tall and has to
        // clear the caption band, which the cut's zoom may not leave room for.
        win.webContents.setZoomFactor(scene.zoom || cut.zoom || 1);
        // Boot, first render and the entrance animations of the landing screen, off camera.
        await sleep(1600);
        for (const s of scene.setup || []) {
          const e = await win.webContents.executeJavaScript(`window.__stage.run(${JSON.stringify(s)}).then(()=>null,e=>String(e))`, true);
          if (e) throw new Error(`${scene.id} setup ${s.do}: ${e}`);
        }
        await sleep(900);
      }
      Object.assign(report, await roll(win, file, scene.seconds, scene.steps || []));
    }
    report.overflow = await win.webContents.executeJavaScript(
      `document.documentElement.scrollWidth > innerWidth + 1 || [...document.querySelectorAll('.vs-caption .vs-text, h1 .line')].some(el => el.getBoundingClientRect().right > innerWidth + 1)`, true);
    previousKind = scene.kind;
    manifest.clips.push(report);
    console.log(`${report.distinct}/${report.frames} distinct frames${report.errors.length ? " · " + report.errors.join("; ") : ""}${report.overflow ? " · OVERFLOW" : ""}`);
  }

  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (blocked.length) console.log(`  blocked ${blocked.length} network request(s): ${[...new Set(blocked)].slice(0, 5).join(", ")}`);
}

app.whenReady().then(main).then(() => app.exit(0), (err) => {
  console.error(err);
  app.exit(1);
});
