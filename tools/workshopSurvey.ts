/**
 * What is on the Workshop, against the season: shared by workshop:status, which prints
 * it, and workshop:upload, which plans from it.
 *
 * KovaaK's reports on its own uploads are not to be trusted: an upload is Steam's
 * CreateItem and then SubmitItemUpdate, so a failed update leaves a blank item (no title,
 * no file), and a lost connection reports "failed" for an update that landed. This reads
 * the uploader's public Workshop items instead and says, per season scenario: up and the
 * same size as the committed file, the wrong size, duplicated, or missing; and lists the
 * blank items.
 *
 * Size, not hash: the Workshop only serves a file to a subscriber. Galaga Novice was
 * checked to the byte once subscribed (5d38e514...), and a size match on a generated file
 * this large is not a coincidence, but it is not a hash.
 *
 * Public data only: the profile's Workshop listing and
 * ISteamRemoteStorage/GetPublishedFileDetails, neither of which needs a key. Private items
 * do not appear, so every upload is set to Public.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { dataFile } from "../src/core/dataDir.ts";
import type { Season, SeasonScenario } from "../src/core/season/season.ts";

export const KOVAAKS_APP = 824270;
/** The uploader of the first Season 1 items. */
export const DEFAULT_STEAM = "76561198710540626";

export interface Details {
  publishedfileid: string;
  result: number;
  creator?: string;
  title?: string;
  file_size?: string | number;
  time_created?: number;
  visibility?: number;
}

export interface Survey {
  items: Details[];
  up: SeasonScenario[];
  /** One item under the title, at a size other than the committed file's. */
  wrongSize: { scenario: SeasonScenario; item: Details; expected: number }[];
  /** More than one item under the title; which to keep is a person's call. */
  duplicated: { scenario: SeasonScenario; items: Details[]; expected: number }[];
  missing: SeasonScenario[];
  /** Items with no title: a CreateItem whose update never landed. */
  blank: Details[];
  /** Apogee titles the season no longer has, most likely old names. */
  strangers: string[];
}

/**
 * Every item workshop:upload created, and whether Steam confirmed its update. Written by
 * the uploader; read here because the profile listing is not complete (see below).
 */
export const LEDGER = join(fileURLToPath(new URL(".", import.meta.url)), "..", ".cache", "workshop-uploads.json");
export type Ledger = Record<string, { itemId: string; done: boolean; at: string }>;
export function readLedger(): Ledger {
  return existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : {};
}

export function scenarioFile(scenario: string): string {
  return join(dataFile("season-1", "scenarios"), `${scenario}.sce`);
}

async function profileItemIds(steam: string): Promise<string[]> {
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

export async function surveyWorkshop(season: Season, steam: string): Promise<Survey> {
  // The profile listing is an index, and it lags: after the first bulk upload it showed
  // 158 of 164 items, the missing six Public, the right size and returned by
  // GetPublishedFileDetails by id. So the ids the uploader recorded are asked for too.
  const ids = new Set(await profileItemIds(steam));
  for (const e of Object.values(readLedger())) ids.add(e.itemId);
  // An id from the ledger can be another account's if --steam changed, or deleted since.
  const items = (await details([...ids])).filter((d) => d.result === 1 && d.creator === steam);

  const byTitle = new Map<string, Details[]>();
  const blank: Details[] = [];
  for (const d of items) {
    const title = (d.title ?? "").trim();
    if (!title) blank.push(d);
    else byTitle.set(title, [...(byTitle.get(title) ?? []), d]);
  }

  const survey: Survey = { items, up: [], wrongSize: [], duplicated: [], missing: [], blank, strangers: [] };
  for (const s of season.scenarios) {
    const file = scenarioFile(s.scenario);
    const expected = existsSync(file) ? statSync(file).size : -1;
    const found = byTitle.get(s.scenario) ?? [];
    if (found.length === 0) survey.missing.push(s);
    else if (found.length > 1) survey.duplicated.push({ scenario: s, items: found, expected });
    else if (Number(found[0].file_size) === expected) survey.up.push(s);
    else survey.wrongSize.push({ scenario: s, item: found[0], expected });
  }
  const seasonNames = new Set(season.scenarios.map((s) => s.scenario));
  survey.strangers = [...byTitle.keys()].filter((t) => t.startsWith("Apogee ") && !seasonNames.has(t));
  return survey;
}
