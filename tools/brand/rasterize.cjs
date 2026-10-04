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
  const report = ${!!job.report} ? await measure(root, W, H) : null;
  return { problems, missing, svg, png: canvas.toDataURL('image/png'), report };
})()`;

/**
 * Runs in the page for a job with \`report\` set: every <text> after fitting, where it
 * landed in output pixels, its ink, and the least legible pixel of what is drawn behind
 * it. The background is the same SVG drawn again with its text removed, so a wash, a
 * panel or a photograph under a word is measured as it is, not assumed. The worst pixel
 * is taken at the 3rd percentile so a lone square star cannot fail a line, and the ratio
 * itself is left to tools/brand/checks.ts, which uses src/core/report/contrast.ts.
 */
const MEASURE_SCRIPT = `async function measure(root, W, H) {
  const rr = root.getBoundingClientRect();
  const sx = W / rr.width, sy = H / rr.height;
  const hex = (c) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(c);
    if (!m) return c;
    return '#' + m[1].split(',').slice(0, 3).map((v) => Math.round(+v).toString(16).padStart(2, '0')).join('');
  };
  const lum = (r, g, b) => {
    const ch = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  };
  const texts = [...root.querySelectorAll('text')].map((t) => {
    const b = t.getBoundingClientRect();
    const cs = getComputedStyle(t);
    let opacity = 1;
    for (let n = t; n && n !== root.parentNode; n = n.parentNode) {
      if (n.getAttribute) opacity *= Number(getComputedStyle(n).opacity || 1);
    }
    return {
      s: t.textContent,
      x: (b.left - rr.left) * sx, y: (b.top - rr.top) * sy, w: b.width * sx, h: b.height * sy,
      size: parseFloat(cs.fontSize) * sy, weight: Number(cs.fontWeight) || 400,
      fill: hex(cs.fill), opacity: opacity * Number(cs.fillOpacity || 1),
    };
  });
  const bare = root.cloneNode(true);
  bare.querySelectorAll('text').forEach((t) => t.remove());
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(bare)], { type: 'image/svg+xml' }));
  await img.decode();
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  // What a transparent asset is drawn on is not known, so it is measured on nothing: the
  // check is then about the asset's own surfaces, and a lockup with no ground is skipped.
  g.drawImage(img, 0, 0, W, H);
  const data = g.getImageData(0, 0, W, H).data;
  for (const t of texts) {
    const f = /^#[0-9a-f]{6}$/i.test(t.fill) ? [1, 3, 5].map((i) => parseInt(t.fill.slice(i, i + 2), 16)) : null;
    if (!f) continue;
    const samples = [];
    const x0 = Math.max(0, Math.floor(t.x)), x1 = Math.min(W - 1, Math.ceil(t.x + t.w));
    const y0 = Math.max(0, Math.floor(t.y)), y1 = Math.min(H - 1, Math.ceil(t.y + t.h));
    const step = Math.max(1, Math.round(Math.min(t.w, t.h) / 12));
    for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) {
      const i = (y * W + x) * 4;
      if (data[i + 3] < 250) continue;
      const a = t.opacity;
      const e = [0, 1, 2].map((k) => f[k] * a + data[i + k] * (1 - a));
      const le = lum(e[0], e[1], e[2]), lb = lum(data[i], data[i + 1], data[i + 2]);
      samples.push({ r: (Math.max(le, lb) + 0.05) / (Math.min(le, lb) + 0.05), px: [data[i], data[i + 1], data[i + 2]] });
    }
    if (!samples.length) continue;
    samples.sort((p, q) => p.r - q.r);
    const worst = samples[Math.floor(samples.length * 0.03)];
    t.bg = '#' + worst.px.map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  return texts;
}`;

app.whenReady().then(async () => {
  const dir = mkdtempSync(join(tmpdir(), "apogee-brand-page-"));
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { offscreen: true } });
  const failures = [];
  const reports = [];
  for (const [i, job] of jobs.entries()) {
    const label = job.pngOut.replace(/.*[\\/](assets|\.cache)[\\/]/, "$1/").replace(/\\/g, "/");
    const file = join(dir, `page-${i}.html`);
    writeFileSync(file, page(job.svg));
    await win.loadFile(file);
    if (job.report) await win.webContents.executeJavaScript(MEASURE_SCRIPT.replace("async function measure", "window.measure = async function") + ";true");
    const r = await win.webContents.executeJavaScript(PAGE_SCRIPT(job));
    reports.push(r.report);
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
      // A picture embedded for the render (a product shot) can be kept beside the SVG and
      // referenced by path instead, so the source is not a second copy of the image.
      let out = r.svg;
      for (const [from, to] of job.rewrite ?? []) out = out.split(from).join(to);
      writeFileSync(job.svgOut, out + "\n");
    }
  }
  win.destroy();
  if (reports.some(Boolean)) writeFileSync(process.argv.at(-1).replace(/\.json$/, ".report.json"), JSON.stringify(reports));
  console.log(`  rasterised ${jobs.length} image(s)`);
  if (failures.length) {
    console.error(failures.map((f) => `  FAIL ${f}`).join("\n"));
    process.exitCode = 1;
  }
  app.quit();
});
