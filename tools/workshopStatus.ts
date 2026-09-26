/**
 * What is actually on the Workshop, against the season.
 *
 *   npm run workshop:status [-- --steam <steamid64>]
 *
 * KovaaK's reports on its own uploads are not to be trusted: an upload is Steam's
 * CreateItem and then SubmitItemUpdate, so a failed update leaves a blank item (no title,
 * no file), and a lost connection reports "failed" for an update that landed. This reads
 * the uploader's public Workshop items instead and says, per season scenario: up and the
 * same size as the committed file, the wrong size, duplicated, or missing; and lists the
 * blank items to delete.
 *
 * Size, not hash: the Workshop only serves a file to a subscriber. Galaga Novice was
 * checked to the byte once subscribed (5d38e514...), and a size match on a generated file
 * this large is not a coincidence, but it is not a hash.
 *
 * Read-only, and public data only: the profile's Workshop listing and
 * ISteamRemoteStorage/GetPublishedFileDetails, neither of which needs a key. Private items
 * do not appear, so set every upload to Public.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../src/core/dataDir.ts";
import { loadSeason } from "../src/core/season/season.ts";

const KOVAAKS_APP = 824270;
/** The uploader of the first Season 1 items. */
const DEFAULT_STEAM = "76561198710540626";

const args = process.argv.slice(2);
const steamArg = args.indexOf("--steam");
const steam = steamArg >= 0 ? args[steamArg + 1] : DEFAULT_STEAM;

interface Details {
  publishedfileid: string;
  result: number;
  title?: string;
  file_size?: string | number;
  time_created?: number;
  visibility?: number;
}

async function profileItemIds(): Promise<string[]> {
  const ids = new Set<string>();
  for (let page = 1; page <= 40; page++) {
    const url = `https://steamcommunity.com/profiles/${steam}/myworkshopfiles/?appid=${KOVAAKS_APP}&p=${page}&numperpage=30`;
    const html = await (await fetch(url)).text();
    const found = [...html.matchAll(/filedetails\/\?id=(\d+)/g)].map((m) => m[1]);
    const before = ids.size;
    for (const id of found) ids.add(id);
    if (ids.size === before) break;
  }
  return [...ids];
}

async function details(ids: string[]): Promise<Details[]> {
  const out: Details[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const body = new URLSearchParams({ itemcount: String(chunk.length) });
    chunk.forEach((id, j) => body.set(`publishedfileids[${j}]`, id));
    const res = await fetch("https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/", { method: "POST", body });
    const json = (await res.json()) as { response: { publishedfiledetails: Details[] } };
    out.push(...json.response.publishedfiledetails);
  }
  return out;
}

const season = loadSeason();
const items = await details(await profileItemIds());

const byTitle = new Map<string, Details[]>();
const blank: Details[] = [];
for (const d of items) {
  const title = (d.title ?? "").trim();
  if (!title) blank.push(d);
  else byTitle.set(title, [...(byTitle.get(title) ?? []), d]);
}

const up: string[] = [];
const wrongSize: string[] = [];
const duplicated: string[] = [];
const missing: string[] = [];
for (const s of season.scenarios) {
  const file = join(dataFile("season-1", "scenarios"), `${s.scenario}.sce`);
  const size = existsSync(file) ? statSync(file).size : -1;
  const found = byTitle.get(s.scenario) ?? [];
  if (found.length === 0) missing.push(s.scenario);
  else {
    const good = found.filter((d) => Number(d.file_size) === size);
    if (found.length > 1) {
      duplicated.push(`${s.scenario}: ${found.map((d) => `${d.publishedfileid} (${Number(d.file_size) === size ? "right size" : `${d.file_size} bytes, expected ${size}`})`).join(", ")}`);
    } else if (good.length === 1) up.push(s.scenario);
    else wrongSize.push(`${s.scenario}: ${found[0].publishedfileid} is ${found[0].file_size} bytes, the committed file ${size}`);
  }
}
const seasonNames = new Set(season.scenarios.map((s) => s.scenario));
const strangers = [...byTitle.keys()].filter((t) => t.startsWith("Apogee ") && !seasonNames.has(t));

console.log(`${items.length} public Workshop items on ${steam}; ${season.scenarios.length} scenarios in ${season.name}\n`);
console.log(`up, right size: ${up.length}`);
if (wrongSize.length) console.log(`\nwrong size (re-upload): ${wrongSize.length}\n  ${wrongSize.join("\n  ")}`);
if (duplicated.length) console.log(`\nduplicated (keep one right-size item, delete the rest): ${duplicated.length}\n  ${duplicated.join("\n  ")}`);
if (blank.length) {
  console.log(`\nblank items to delete: ${blank.length}`);
  for (const d of blank) console.log(`  https://steamcommunity.com/sharedfiles/filedetails/?id=${d.publishedfileid}`);
}
if (strangers.length) console.log(`\nApogee titles the season no longer has (old names?): ${strangers.join(", ")}`);
console.log(`\nstill to upload: ${missing.length}`);
for (const band of season.windows ?? []) {
  const inBand = missing.filter((m) => m.endsWith(` ${band}`));
  if (inBand.length) console.log(`  ${band}: ${inBand.map((m) => m.replace(/^Apogee /, "").replace(` ${band}`, "")).join(", ")}`);
}
