/**
 * Build the trailer, the teaser and the README GIF from the shot list.
 *
 *   npm run video                         everything, into media/
 *   npm run video -- --cut teaser         one cut
 *   npm run video -- --with mechanic-headline,share-card
 *                                         include scenes the shot list has switched off
 *   npm run video -- --skip-record        re-assemble from the clips already filmed
 *   npm run video -- --no-music           picture only
 *
 * Stages, in order:
 *   1. the preview, rebuilt from the current renderer into .cache/video/preview.html, so
 *      what is filmed is whatever the branch looks like now;
 *   2. each cut filmed scene by scene (record.cjs, in Electron, offscreen, no network);
 *   3. clips joined with the shot list's transitions over a synthesised bed (music.mjs),
 *      encoded once at final quality;
 *   4. the GIF, cut from the trailer and shrunk until it is under the README's limit;
 *   5. every output probed, and a frame every two seconds written to
 *      .cache/video/review/ for a person to look at before anything is posted.
 *
 * Fails, rather than shipping, if a clip came back mostly repeated frames, a caption or
 * title overflowed, a stage direction threw, or the page tried to reach the network.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderMusic } from "./music.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cache = join(root, ".cache", "video");
const media = join(root, "media");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes("--" + name);
const opt = (name) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const shots = JSON.parse(readFileSync(join(root, "tools", "video", "shots.json"), "utf8"));
const cuts = opt("cut") ? [opt("cut")] : Object.keys(shots.cuts);
const withScenes = opt("with") ?? "";

function run(cmd, args, what) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"], shell: process.platform === "win32" && cmd === "npx" });
  if (r.status !== 0) throw new Error(`${what} failed (${cmd} exited ${r.status})`);
}
function capture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

mkdirSync(cache, { recursive: true });
mkdirSync(media, { recursive: true });
const failures = [];

/* ------------------------------------------------------------ 1. preview */

const preview = join(cache, "preview.html");
if (!flag("skip-record")) {
  console.log("preview");
  // Same two steps as `npm run ui`, minus exportSnapshot: the committed snapshot is the
  // data the video is allowed to show, and re-exporting would film whatever stats folder
  // is on the machine doing the render.
  run("node", ["tools/buildCosmic.mjs"], "cosmic build");
  process.env.APOGEE_PREVIEW_OUT = preview;
  run("npx", ["tsx", "tools/buildUiPreview.ts"], "preview build");
}

/* ----------------------------------------------------------- 2. filming */

const electron = join(root, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
for (const name of cuts) {
  const dir = join(cache, name);
  if (!flag("skip-record")) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`filming ${name}`);
    const args = [join(root, "tools", "video", "record.cjs"), "--cut", name, "--preview", preview, "--out", dir];
    if (withScenes) args.push("--with", withScenes);
    const r = spawnSync(electron, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"], shell: process.platform === "win32" });
    if (r.status !== 0) throw new Error(`filming ${name} failed`);
  }
}

/* ---------------------------------------------------------- 3. assembly */

const probe = (file) => JSON.parse(capture("ffprobe", ["-v", "error", "-show_entries", "format=duration,size:stream=codec_name,width,height,nb_frames,r_frame_rate,pix_fmt", "-of", "json", file]));
const timelines = {};

for (const name of cuts) {
  const dir = join(cache, name);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const fps = manifest.fps;

  for (const c of manifest.clips) {
    // A still screen legitimately repeats frames, so the bar is low: under 12% distinct
    // means the machine stalled, not that the shot was calm. Every app shot here moves.
    if (c.distinct / c.frames < 0.12) failures.push(`${name}/${c.id}: only ${c.distinct} of ${c.frames} frames distinct`);
    if (c.errors?.length) failures.push(`${name}/${c.id}: ${c.errors.join("; ")}`);
    if (c.overflow) failures.push(`${name}/${c.id}: text runs off the frame`);
    if (c.fit && c.fit < 1) console.warn(`  ${name}/${c.id}: title shrunk to ${(c.fit * 100).toFixed(0)}% to fit`);
  }
  if (manifest.blocked.length) failures.push(`${name}: the page tried the network: ${[...new Set(manifest.blocked)].join(", ")}`);

  // Offsets from the frame counts actually filmed, so an xfade never lands on a boundary
  // that rounding moved.
  const inputs = [], filters = [];
  const starts = {};
  let label = "[c0]", length = 0;
  manifest.clips.forEach((c, k) => {
    inputs.push("-i", c.file);
    filters.push(`[${k}:v]settb=AVTB,fps=${fps},format=yuv420p[c${k}]`);
    const d = c.frames / fps;
    if (k === 0) { starts[c.id] = 0; length = d; return; }
    const t = c.transition || manifest.transition;
    if (t.type === "cut") {
      starts[c.id] = length;
      filters.push(`${label}[c${k}]concat=n=2:v=1:a=0,settb=AVTB,fps=${fps}[j${k}]`);
      length += d;
    } else {
      const td = t.seconds ?? manifest.transition.seconds;
      starts[c.id] = length - td;
      filters.push(`${label}[c${k}]xfade=transition=${t.type}:duration=${td}:offset=${(length - td).toFixed(4)}[j${k}]`);
      length += d - td;
    }
    label = `[j${k}]`;
  });
  filters.push(`${label}fade=t=in:st=0:d=0.35,fade=t=out:st=${(length - 0.6).toFixed(3)}:d=0.6[v]`);
  timelines[name] = { starts, length };

  const out = join(media, manifest.out);
  const audio = [];
  if (!flag("no-music")) {
    const wav = join(dir, "music.wav");
    writeFileSync(wav, renderMusic(length, { intro: manifest.clips[0].frames / fps }));
    audio.push("-i", wav);
  }
  const portrait = manifest.height > manifest.width;
  console.log(`assembling ${manifest.out} (${length.toFixed(2)}s)`);
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", ...inputs, ...audio,
    "-filter_complex", filters.join(";"),
    "-map", "[v]", ...(audio.length ? ["-map", `${manifest.clips.length}:a`, "-c:a", "aac", "-b:a", "192k", "-shortest"] : []),
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-profile:v", "high", "-level", portrait ? "4.2" : "4.1",
    "-maxrate", "14M", "-bufsize", "28M", "-pix_fmt", "yuv420p", "-r", String(fps),
    // Nothing about the machine or the toolchain in the file: the title is the product.
    "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-metadata", "title=Apogee",
    "-movflags", "+faststart", out,
  ], `encoding ${manifest.out}`);
}

/* ---------------------------------------------------------------- 4. GIF */

const gif = shots.gif;
if (gif && timelines[gif.from]) {
  const src = join(media, shots.cuts[gif.from].out);
  const out = join(media, "apogee-readme.gif");
  const start = timelines[gif.from].starts[gif.scene] ?? 0;
  // Width first, then frame rate: a GIF that is too big is usually too wide, and a README
  // shows it at column width anyway.
  for (const [width, fps] of [[gif.width, gif.fps], [720, gif.fps], [640, 12], [560, 10]]) {
    run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-ss", start.toFixed(3), "-t", String(gif.seconds), "-i", src,
      "-vf", `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
      "-loop", "0", out,
    ], "GIF");
    const size = statSync(out).size;
    console.log(`GIF ${width}px @${fps}fps: ${(size / 1e6).toFixed(2)} MB`);
    if (size <= gif.maxBytes) break;
  }
  if (statSync(out).size > gif.maxBytes) failures.push(`GIF is over ${gif.maxBytes} bytes at every size tried`);
}

/* ---------------------------------------------------- 5. probe and review */

console.log("\nprobe");
for (const file of [...cuts.map((c) => shots.cuts[c].out), "apogee-readme.gif"].map((f) => join(media, f)).filter(existsSync)) {
  const p = probe(file);
  const v = p.streams.find((s) => s.width);
  const a = p.streams.find((s) => !s.width);
  const frames = Number(v.nb_frames) || 0;
  console.log(`  ${file.slice(root.length + 1)}  ${v.codec_name} ${v.width}x${v.height} ${v.pix_fmt ?? ""} ${v.r_frame_rate}  ${Number(p.format.duration).toFixed(2)}s  ${frames || "?"} frames  ${(p.format.size / 1e6).toFixed(2)} MB${a ? "  " + a.codec_name : ""}`);
  if (!file.endsWith(".gif") && frames <= 0) failures.push(`${file}: no frames`);
  const cut = Object.values(shots.cuts).find((c) => file.endsWith(c.out));
  // Posting limits, not taste: X and most feeds cap a native clip's autoplay at 60 s, and
  // a story slot is 15 s, so a cut over its limit gets trimmed by the platform instead.
  if (cut?.maxSeconds && Number(p.format.duration) > cut.maxSeconds + 0.05) failures.push(`${file}: ${Number(p.format.duration).toFixed(2)}s is over ${cut.maxSeconds}s`);
  // Every two seconds, GIF included: at three, a card shorter than that (the ghost clip's
  // close is 2.2 s) could fall between two review frames and never be looked at.
  const review = join(cache, "review", file.split(/[\\/]/).pop().replace(/\.\w+$/, ""));
  rmSync(review, { recursive: true, force: true });
  mkdirSync(review, { recursive: true });
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vf", "fps=1/2", join(review, "t%02d.png")], "review frames");
}
console.log(`\nreview frames in ${join(cache, "review").slice(root.length + 1)}`);

if (failures.length) {
  console.error("\n" + failures.map((f) => "FAIL " + f).join("\n"));
  process.exit(1);
}
