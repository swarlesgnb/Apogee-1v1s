/**
 * The landing page's script (site/c/index.html, see landing.ts): read the query with the
 * app's own grammar, then describe the link and point "Open in Apogee" at its canonical
 * `apogee://` form. Everything is set through textContent and the href is built from the
 * parsed values, so a query cannot put anything on the page the grammar did not produce.
 */

import { deepLinkUrl, parseLandingQuery } from "./deepLinks.ts";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const parsed = parseLandingQuery(location.search.replace(/^\?/, ""));

if (parsed.ok) {
  const link = parsed.link;
  const points: string[] = [];
  if (link.kind === "duel") {
    $("kicker").textContent = "Open challenge";
    $("title").textContent = "Somebody played three. Your turn.";
    $("lede").textContent = "This is an open challenge from an Apogee player. Answer it with your own run of the same three scenarios in KovaaK's.";
    $("code").textContent = link.code;
    points.push(
      "Each side is scored against its own baseline, so you can score fewer points and still win, or more and still lose.",
      "Their score stays hidden until yours is in.",
      "Unrated: answering an open challenge never moves anybody's rating.",
    );
  } else if (link.kind === "ghost") {
    $("kicker").textContent = "Ghost link";
    $("title").textContent = "Race somebody's ghost";
    $("lede").textContent = "Three runs somebody played in Apogee, raced against your own baselines. Unrated.";
    $("code").textContent = link.code;
    points.push("Their runs play back as a ghost; your runs come from KovaaK's as you play them.", "Nothing is rated, and nothing is sent until you start.");
  } else {
    const band = link.band ? link.band[0].toUpperCase() + link.band.slice(1) : null;
    $("kicker").textContent = "Apogee Daily";
    $("title").textContent = link.number ? `Apogee Daily #${link.number}${band ? ` · ${band}` : ""}` : "Apogee Daily";
    $("lede").textContent = "Three scenarios a day, the same for everyone in a band. Play them in KovaaK's; Apogee reads the result from your stats folder.";
    $("code").textContent = link.number ? `#${link.number}${band ? ` ${band}` : ""}` : "Today";
    points.push(
      "One Clicking, one Tracking and one Switching scenario. Your first run on each counts.",
      "Each is scored against your own baseline: above, near or below.",
      "Works offline and signed out. Signed in, you see where you placed among the day's players.",
    );
  }
  const list = $("points");
  for (const text of points) {
    const li = document.createElement("li");
    li.textContent = text;
    list.append(li);
  }
  $("card").hidden = false;
  const open = $("open") as HTMLAnchorElement;
  open.href = deepLinkUrl(link);
  open.hidden = false;
  $("how").hidden = false;
} else if (location.search.length > 1) {
  $("kicker").textContent = "Not an Apogee link";
  $("lede").textContent = "This address does not hold a challenge Apogee made, so there is nothing to open. Here is what Apogee is instead: ranked 1v1 for KovaaK's, scored against your own baseline.";
}
