/**
 * A music bed, synthesised rather than sourced.
 *
 *   node tools/video/music.mjs <seconds> <out.wav>
 *
 * The repo ships no audio (the app's sounds are synthesised in the renderer), and the
 * trailer is going on a public page, so nothing licensed can go under it. A pad, a soft
 * arpeggio and a low pulse is enough to give cuts a floor to land on, and it is the same
 * bytes on every run: no randomness here is unseeded, so a re-render changes the picture
 * only.
 *
 * 120 BPM, so a bar is two seconds and scene lengths in the shot list can be read in bars.
 */

import { writeFileSync } from "node:fs";

export function renderMusic(seconds, { rate = 48000, intro = 4.6 } = {}) {
  const n = Math.ceil(seconds * rate);
  const L = new Float32Array(n), R = new Float32Array(n);
  const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
  // Am9, Fmaj7, Cmaj7/E, G6: minor-leaning and unresolved, which suits "ranked" more than
  // anything cheerful, and never lands hard enough to fight a caption.
  const chords = [
    [45, 57, 60, 64, 67, 71],
    [41, 57, 60, 64, 65, 69],
    [40, 55, 59, 60, 64, 67],
    [43, 55, 59, 62, 64, 67],
  ];
  const bar = 2, chordLen = 2 * bar;

  // Pad: detuned partials under a slow swell per chord, crossfaded so changes never click.
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const c = Math.floor(t / chordLen);
    const into = t - c * chordLen;
    let l = 0, r = 0;
    for (const [which, gain] of [[c, Math.min(1, into / 1.2)], [c - 1, Math.max(0, 1 - into / 1.2)]]) {
      if (which < 0 || gain <= 0) continue;
      const notes = chords[which % chords.length];
      notes.forEach((m, k) => {
        const f = hz(m + 12 * (k === 0 ? 0 : 0));
        const w = k === 0 ? 0.55 : 0.22;
        const a = Math.sin(2 * Math.PI * f * 1.0015 * t + k), b = Math.sin(2 * Math.PI * f * 0.9985 * t + k * 2);
        const s = (a + b + 0.3 * Math.sin(2 * Math.PI * f * 2 * t)) * w * gain;
        l += s * (0.6 + 0.4 * Math.sin(k)); r += s * (0.6 - 0.4 * Math.sin(k));
      });
    }
    L[i] = l * 0.05; R[i] = r * 0.05;
  }

  // Arpeggio: eighth notes through the chord's upper tones, entering after the hook card.
  const eighth = 0.25;
  for (let e = Math.ceil(intro / eighth); e * eighth < seconds; e++) {
    const t0 = e * eighth;
    const notes = chords[Math.floor(t0 / chordLen) % chords.length].slice(1);
    const pattern = [0, 2, 4, 1, 3, 4, 2, 1];
    const f = hz(notes[pattern[e % 8] % notes.length] + 12);
    const pan = 0.5 + 0.35 * Math.sin(e * 0.9);
    const len = Math.floor(0.6 * rate), start = Math.floor(t0 * rate);
    for (let j = 0; j < len && start + j < n; j++) {
      const t = j / rate;
      const env = Math.min(1, t / 0.004) * Math.exp(-t * 7);
      const s = (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t)) * env * 0.045;
      L[start + j] += s * (1 - pan); R[start + j] += s * pan;
    }
  }

  // Pulse: a soft low thump on beats one and three, no hi-hats; it is a bed, not a track.
  for (let b = Math.ceil(intro / 0.5); b * 0.5 < seconds; b += 2) {
    const start = Math.floor(b * 0.5 * rate);
    for (let j = 0; j < 0.4 * rate && start + j < n; j++) {
      const t = j / rate;
      const f = 42 + 50 * Math.exp(-t * 30);
      const s = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 9) * 0.22;
      L[start + j] += s; R[start + j] += s;
    }
  }

  // Room: a few feedback delays at unrelated lengths, enough to glue the layers.
  for (const [ms, fb] of [[113, 0.32], [167, 0.28], [229, 0.24]]) {
    const d = Math.floor((ms / 1000) * rate);
    for (let i = d; i < n; i++) { L[i] += R[i - d] * fb * 0.5; R[i] += L[i - d] * fb * 0.5; }
  }

  // Fade in and out, then normalise to -3 dBFS peak.
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const g = Math.min(1, t / 1.5) * Math.min(1, (seconds - t) / 2.5);
    L[i] *= g; R[i] *= g;
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  const norm = peak > 0 ? 0.708 / peak : 1;
  const pcm = Buffer.alloc(44 + n * 4);
  pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + n * 4, 4); pcm.write("WAVEfmt ", 8);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(2, 22);
  pcm.writeUInt32LE(rate, 24); pcm.writeUInt32LE(rate * 4, 28); pcm.writeUInt16LE(4, 32); pcm.writeUInt16LE(16, 34);
  pcm.write("data", 36); pcm.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * norm)) * 32767), 44 + i * 4);
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * norm)) * 32767), 46 + i * 4);
  }
  return pcm;
}

if (process.argv[1] && process.argv[1].endsWith("music.mjs")) {
  const [seconds, out] = process.argv.slice(2);
  writeFileSync(out, renderMusic(Number(seconds)));
}
