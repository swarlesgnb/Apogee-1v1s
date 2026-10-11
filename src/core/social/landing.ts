/**
 * site/c/index.html: where an https challenge link lands.
 *
 * Discord, X and Reddit make an https link clickable and an `apogee://` one not, so every
 * post carries `https://…/c/?duel=CODE` (or `?ghost=`, `?daily=14&band=…`) and this static
 * page turns it into an "Open in Apogee" button, with the download beside it for somebody
 * who does not have the app yet. `npm run build:site` writes it next to the site's front
 * page; nothing about it needs a server.
 *
 * The query is read in the browser by `parseLandingQuery`, the same grammar the app holds
 * links to (bundled from src/core/social/deepLinks.ts by build:site), and the page is built
 * from the parsed values only: the button's href is `deepLinkUrl(link)`, never the query,
 * and every string reaches the page through textContent. A query the grammar refuses gets
 * the page's general explanation and no button. The page loads nothing from anywhere and
 * its CSP says so.
 */

export interface LandingConfig {
  downloadUrl: string;
  sourceUrl: string;
  /** The site's front page, relative to /c/. */
  homeHref: string;
  palette: Record<string, string>;
  /** The bundled landing script (landingClient.ts), inlined. */
  script: string;
  /** The rail's mark path, so the lockup is the app's own. */
  markPath: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export function renderLanding(config: LandingConfig): string {
  const p = config.palette;
  const v = (k: string, fallback: string) => esc(p[k] ?? fallback);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>An Apogee challenge</title>
<meta name="description" content="Ranked 1v1 for KovaaK's. Open this link in Apogee to answer the challenge, or download Apogee first.">
<meta property="og:title" content="An Apogee challenge">
<meta property="og:description" content="Ranked 1v1 for KovaaK's. Open the link in Apogee to answer it.">
<meta property="og:type" content="website">
<style>
:root { --ground:${v("ground", "#090c12")}; --panel:${v("panel", "#121822")}; --well:${v("well", "#0c111a")}; --ink:${v("ink", "#f2f0e8")};
  --ink-dim:${v("ink-dim", "#a4b2c4")}; --brand:${v("brand", "#e5edb0")}; --brand-ink:${v("brand-ink", "#151c15")}; --rule:${v("rule", "#2c3746")}; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--ground); color: var(--ink); font: 16px/1.55 "Segoe UI", system-ui, sans-serif; }
body::before { content: ""; position: fixed; inset: 0; background: radial-gradient(1200px 700px at 90% -10%, #32445266, transparent 60%); pointer-events: none; }
main { position: relative; max-width: 680px; margin: 0 auto; padding: 48px 24px 64px; display: grid; gap: 22px; }
.lockup { display: flex; align-items: center; gap: 10px; color: var(--ink); text-decoration: none; font: 500 24px "Bahnschrift", "Segoe UI", sans-serif; letter-spacing: -.02em; }
.lockup svg { width: 28px; height: 28px; fill: none; stroke: var(--brand); stroke-width: 1.65; stroke-linecap: round; stroke-linejoin: round; }
.kicker { color: var(--brand); font: 12px ui-monospace, "Cascadia Mono", Consolas, monospace; letter-spacing: .16em; text-transform: uppercase; margin: 0; }
h1 { margin: 0; font: 600 clamp(34px, 7vw, 52px)/1.02 "Bahnschrift", "Segoe UI", sans-serif; letter-spacing: -.035em; }
p { margin: 0; color: var(--ink-dim); }
.card { display: grid; gap: 14px; padding: 22px; border-radius: 14px; background: var(--panel); border: 1px solid var(--rule); }
.code { font: 600 22px ui-monospace, "Cascadia Mono", Consolas, monospace; letter-spacing: .12em; color: var(--brand); }
.actions { display: flex; flex-wrap: wrap; gap: 10px; }
.btn { display: inline-flex; align-items: center; justify-content: center; min-height: 46px; padding: 0 20px; border-radius: 9px; border: 1px solid var(--rule); background: var(--well); color: var(--ink); text-decoration: none; font-weight: 600; }
.btn.go { background: var(--brand); border-color: var(--brand); color: var(--brand-ink); }
[hidden] { display: none !important; }
.fine { font-size: 13px; }
.fine a { color: var(--ink); }
ul { margin: 0; padding-left: 20px; color: var(--ink-dim); display: grid; gap: 6px; }
</style>
</head>
<body>
<main>
  <a class="lockup" href="${esc(config.homeHref)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${esc(config.markPath)}"/></svg>apogee</a>
  <p class="kicker" id="kicker">Challenge link</p>
  <h1 id="title">Ranked 1v1 for KovaaK's</h1>
  <p id="lede">Apogee matches you against someone near your level on three scenarios, played in KovaaK's as normal. Each side is measured against its own baseline, so the question is who played sharper than usual.</p>
  <section class="card" id="card" hidden>
    <div class="code" id="code"></div>
    <ul id="points"></ul>
  </section>
  <div class="actions">
    <a class="btn go" id="open" hidden>Open in Apogee</a>
    <a class="btn" id="download" href="${esc(config.downloadUrl)}">Download Apogee for Windows</a>
  </div>
  <p class="fine" id="how" hidden>Open in Apogee needs the app installed. The app shows what the link is for and nothing happens until you confirm it there. If the button does nothing, open Apogee, choose Links &amp; Discord at the top, and paste this page's address.</p>
  <p class="fine"><a href="${esc(config.homeHref)}">What Apogee is</a> · <a href="${esc(config.sourceUrl)}">Source</a></p>
</main>
<script>${config.script}</script>
</body>
</html>
`;
}
