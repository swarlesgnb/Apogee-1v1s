/**
 * The share card in the app: main's record of a result, drawn by core/brand/shareCard.ts,
 * rasterised offscreen, then copied to the clipboard or saved.
 *
 * Main holds the record. The settle-match response is kept as it arrived and the ghost
 * result is read from ghostService's booking, so the renderer asks for "the match card,
 * portrait, to the clipboard" and never hands over a figure (shareInput.ts). The palette,
 * the insignia and the fonts come from the copies build:app ships in dist/app, read by the
 * same functions the brand kit uses on the source tree, so a card from the app and a
 * sample from `npm run brand:cards` are one drawing.
 *
 * Rasterising is tools/brand/rasterize.cjs's path, in a hidden window of its own: lay the
 * SVG out inline, wait for the embedded fonts, run FIT_TEXT_SCRIPT against the real
 * metrics, then draw it onto a canvas of exactly the card's size. Not capturePage(),
 * which Windows clamps to the screen, and which cut the 1920-tall story to the work area.
 * The page script is a copy of that tool's rather than an import because the tool is a
 * plain .cjs Electron entry; both are held to the same checks (validate:share here).
 */

import { app, BrowserWindow, clipboard, dialog, nativeImage } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { emblemFrom, readGhostTint, readTokens, sliceBadge, TOKEN_SHEETS, tokenCss, withFonts } from "../core/brand/clientSources.ts";
import { darkPalette, type BrandPalette } from "../core/brand/palette.ts";
import { FIT_TEXT_SCRIPT, headline, SHARE_CARD_SIZES, shareCardSvg, type CardLayout, type ShareCardInput } from "../core/brand/shareCard.ts";
import {
  ghostCardInput,
  matchCardInput,
  parseShareRequest,
  shareFileName,
  type CardContext,
  type GhostRecord,
  type MatchRecord,
  type SettledRecord,
} from "../core/brand/shareInput.ts";

export interface ShareDeps {
  /** dist/app/renderer: the stylesheets and renderer.js the palette and insignia are read from. */
  rendererDir: string;
  /** dist/app/fonts: the vendored card faces. */
  fontsDir: string;
  context: () => CardContext;
  /** The ghost result on screen, or null when there is none to share. */
  ghost: () => GhostRecord | null;
  window: () => BrowserWindow | null;
  /** Where Save puts a card. Replaced by validate:share, which cannot click a dialog. */
  saveAs?: (defaultPath: string) => Promise<string | null>;
  copy?: (png: Buffer) => void;
}

export type ShareResult =
  | { ok: true; png?: string; width: number; height: number; fileName: string; savedTo?: string; copied?: boolean }
  | { ok: false; error: string; cancelled?: boolean };

/** Everything the drawing needs from the shipped client files, read once. */
interface Kit {
  palette: BrandPalette;
  emblem: (tier: { id: string; name: string; color: string }, ink: string) => string;
  ghostTint: string | null;
  fontBase64: (file: string) => string;
}

const page = (svg: string) => `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent}
svg{display:block}
</style><body>${svg}</body>`;

/** Runs in the page: fit, serialise, draw to a canvas, return the PNG. See rasterize.cjs. */
const PAGE_SCRIPT = (width: number, height: number) => `(async () => {
  await Promise.all([...document.fonts].map((f) => f.load().catch(() => null)));
  await document.fonts.ready;
  const root = document.querySelector('body > svg');
  const problems = (0, eval)(${JSON.stringify(FIT_TEXT_SCRIPT)})(root);
  root.setAttribute('width', '${width}');
  root.setAttribute('height', '${height}');
  const missing = [...document.fonts].filter((f) => f.status !== 'loaded').map((f) => f.family + ' ' + f.weight);
  const texts = [...root.querySelectorAll('text')].map((t) => t.textContent);
  const svg = new XMLSerializer().serializeToString(root);
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  await img.decode();
  // An SVG image can lay its embedded fonts out a frame after decode.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const canvas = document.createElement('canvas');
  canvas.width = ${width};
  canvas.height = ${height};
  canvas.getContext('2d').drawImage(img, 0, 0, ${width}, ${height});
  return { problems, missing, texts, png: canvas.toDataURL('image/png') };
})()`;

export interface RenderedCard {
  png: Buffer;
  width: number;
  height: number;
  /** Every text node after fitting, for validate:share to read the figures back. */
  texts: string[];
  input: ShareCardInput;
  fileName: string;
}

export class ShareCards {
  private match: MatchRecord | null = null;
  private kit: Kit | null = null;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ShareDeps) {}

  /** Keep the settlement exactly as main received it. The next one replaces it. */
  recordSettled(settled: SettledRecord, sentDuel: boolean, at = Date.now()): void {
    this.match = { settled, sentDuel, at };
  }

  private loadKit(): Kit {
    if (this.kit) return this.kit;
    const read = (f: string) => readFileSync(join(this.deps.rendererDir, f), "utf8");
    const css = tokenCss(read("index.html"), TOKEN_SHEETS.map(read));
    let ghostTint: string | null = null;
    try {
      ghostTint = readGhostTint(read("ghost.css"));
    } catch {
      ghostTint = null;
    }
    const fonts = new Map<string, string>();
    this.kit = {
      palette: darkPalette(readTokens(css)),
      emblem: emblemFrom(sliceBadge(read("renderer.js"))),
      ghostTint,
      fontBase64: (file) => {
        if (!fonts.has(file)) fonts.set(file, readFileSync(join(this.deps.fontsDir, file)).toString("base64"));
        return fonts.get(file) as string;
      },
    };
    return this.kit;
  }

  /** The card for a source, or why there is none. Built from main's records only. */
  input(source: "match" | "ghost"): ShareCardInput | { refused: string } {
    if (source === "match") {
      if (!this.match) return { refused: "There is no settled match on screen to share." };
      return matchCardInput(this.match, this.deps.context());
    }
    const g = this.deps.ghost();
    if (!g) return { refused: "Finish a ghost match to share it." };
    return ghostCardInput(g, this.deps.context());
  }

  async render(input: ShareCardInput, layout: CardLayout): Promise<RenderedCard> {
    // One at a time: each render is its own window, and a burst of preview clicks should
    // queue rather than open five.
    const run = this.busy.then(() => this.renderNow(input, layout));
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async renderNow(input: ShareCardInput, layout: CardLayout): Promise<RenderedCard> {
    const kit = this.loadKit();
    const { width, height } = SHARE_CARD_SIZES[layout];
    const svg = withFonts(shareCardSvg(input, { layout, palette: kit.palette, emblem: kit.emblem, ghostTint: kit.ghostTint }), kit.fontBase64);

    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    // The page is a picture of a result with player names in it: nothing in it may leave.
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    try {
      await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(page(svg)));
      const r = (await win.webContents.executeJavaScript(PAGE_SCRIPT(width, height))) as {
        problems: string[];
        missing: string[];
        texts: string[];
        png: string;
      };
      // A card with a clipped name or a fallback face is worse than no card.
      if (r.missing.length) throw new Error(`the card's fonts did not load (${r.missing.join(", ")})`);
      if (r.problems.length) throw new Error(`the card could not fit its text (${r.problems.join("; ")})`);
      const png = Buffer.from(r.png.slice(r.png.indexOf(",") + 1), "base64");
      const w = png.readUInt32BE(16);
      const h = png.readUInt32BE(20);
      if (w !== width || h !== height) throw new Error(`the card came out ${w}x${h}, not ${width}x${height}`);
      return { png, width, height, texts: r.texts, input, fileName: shareFileName(input, headline(input)) };
    } finally {
      win.destroy();
    }
  }

  private async saveAs(defaultPath: string): Promise<string | null> {
    if (this.deps.saveAs) return this.deps.saveAs(defaultPath);
    const owner = this.deps.window();
    const options = {
      title: "Save share card",
      defaultPath,
      filters: [{ name: "PNG image", extensions: ["png"] }],
    };
    const r = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    return r.canceled || !r.filePath ? null : r.filePath;
  }

  async handle(raw: unknown): Promise<ShareResult> {
    const req = parseShareRequest(raw);
    if (typeof req === "string") return { ok: false, error: req };
    const input = this.input(req.source);
    if ("refused" in input) return { ok: false, error: input.refused };

    let card: RenderedCard;
    try {
      card = await this.render(input, req.layout);
    } catch (err) {
      return { ok: false, error: `The card could not be drawn: ${err instanceof Error ? err.message : String(err)}` };
    }
    const base = { ok: true as const, width: card.width, height: card.height, fileName: card.fileName };

    if (req.action === "preview") return { ...base, png: "data:image/png;base64," + card.png.toString("base64") };
    if (req.action === "copy") {
      if (this.deps.copy) this.deps.copy(card.png);
      else clipboard.writeImage(nativeImage.createFromBuffer(card.png));
      return { ...base, copied: true };
    }

    // Pictures/Apogee is made up front so the dialog opens in it; the player can still
    // put the file anywhere.
    const folder = join(app.getPath("pictures"), "Apogee");
    try {
      mkdirSync(folder, { recursive: true });
    } catch {
      // A Pictures folder that cannot be written to still leaves the dialog to choose another.
    }
    const target = await this.saveAs(join(folder, card.fileName));
    if (!target) return { ok: false, error: "Not saved.", cancelled: true };
    try {
      writeFileSync(target, card.png);
    } catch (err) {
      return { ok: false, error: `Could not save the card: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ...base, savedTo: target };
  }
}
