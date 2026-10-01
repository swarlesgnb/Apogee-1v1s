/**
 * SVG to PNG for the brand kit, in an offscreen Electron window.
 *
 *   electron tools/brand/rasterize.cjs <jobs.json>
 *
 * Not run by hand: tools/brand/kit.ts writes the job list and spawns this. Each job is an
 * SVG with its fonts embedded. It is laid out inline in a page, the fonts are waited for,
 * the fit script the SVG carries (<script type="text/fit">, FIT_TEXT_SCRIPT for cards)
 * shrinks text to its budget, and a trim job has its viewBox pulled in to the drawing.
 * The fitted SVG is then drawn onto a canvas of exactly the job's pixel size and read
 * back as PNG.
 *
 * A canvas rather than capturePage() because Windows clamps a window to the screen, even
 * an offscreen one, and a 1920-tall story came back cut to the work area. A canvas has no
 * such limit, keeps the alpha channel for transparent lockups, and is what the client
 * would use to make the same card, so this path is the one worth proving.
 *
 * It fails - non-zero exit, and the offending text named - when text still leaves the
 * canvas, a font did not load, or the PNG comes back the wrong size, because a card with a
 * clipped name is worse than no card and nobody reviews sixty PNGs by eye on every run.
 */

const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync, mkdirSync, mkdtempSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { tmpdir } = require("node:os");

const jobs = JSON.parse(readFileSync(process.argv.at(-1), "utf8"));

app.setPath("userData", mkdtempSync(join(tmpdir(), "apogee-brand-")));
app.commandLine.appendSwitch("force-device-scale-factor", "1");

const page = (svg) => `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent}
svg{display:block}
</style><body>${svg}</body>`;

/** Runs in the page: fit, trim, serialise, draw to a canvas, return the PNG. */
const PAGE_SCRIPT = (job) => `(async () => {
  await Promise.all([...document.fonts].map((f) => f.load().catch(() => null)));
  await document.fonts.ready;
  const root = document.querySelector('body > svg');
  const fitSrc = root.querySelector('script[type="text/fit"]');
  let problems = [];
  if (fitSrc) { problems = (0, eval)(fitSrc.textContent)(root); fitSrc.remove(); }
  const W = ${job.width};
  let H = ${job.height};
  if (${job.trim != null}) {
    const b = root.getBBox();
    const pad = ${job.trim ?? 0};
    const vb = [b.x - pad, b.y - pad, b.width + pad * 2, b.height + pad * 2].map((n) => +n.toFixed(2));
    root.setAttribute('viewBox', vb.join(' '));
    H = Math.round(W * vb[3] / vb[2]);
  }
  root.setAttribute('width', String(W));
  root.setAttribute('height', String(H));
  const missing = [...document.fonts].filter((f) => f.status !== 'loaded').map((f) => f.family + ' ' + f.weight);
  const svg = new XMLSerializer().serializeToString(root);

  const img = new Image();
  img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  await img.decode();
  // An SVG image can lay its embedded fonts out a frame after decode. The fonts are data
  // URIs, so there is nothing to wait on but that frame.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.getContext('2d').drawImage(img, 0, 0, W, H);
  return { problems, missing, svg, png: canvas.toDataURL('image/png') };
})()`;

app.whenReady().then(async () => {
  const dir = mkdtempSync(join(tmpdir(), "apogee-brand-page-"));
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { offscreen: true } });
  const failures = [];
  for (const [i, job] of jobs.entries()) {
    const label = job.pngOut.replace(/.*[\\/](assets|\.cache)[\\/]/, "$1/").replace(/\\/g, "/");
    const file = join(dir, `page-${i}.html`);
    writeFileSync(file, page(job.svg));
    await win.loadFile(file);
    const r = await win.webContents.executeJavaScript(PAGE_SCRIPT(job));
    for (const p of r.problems) failures.push(`${label}: ${p}`);
    for (const f of r.missing) failures.push(`${label}: font ${f} did not load`);
    const png = Buffer.from(r.png.slice(r.png.indexOf(",") + 1), "base64");
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    if (w !== job.width || (job.trim == null && h !== job.height)) {
      failures.push(`${label}: came out ${w}x${h}, wanted ${job.width}x${job.height}`);
    }
    mkdirSync(dirname(job.pngOut), { recursive: true });
    writeFileSync(job.pngOut, png);
    if (job.svgOut) {
      mkdirSync(dirname(job.svgOut), { recursive: true });
      writeFileSync(job.svgOut, r.svg + "\n");
    }
  }
  win.destroy();
  console.log(`  rasterised ${jobs.length} image(s)`);
  if (failures.length) {
    console.error(failures.map((f) => `  FAIL ${f}`).join("\n"));
    process.exitCode = 1;
  }
  app.quit();
});
