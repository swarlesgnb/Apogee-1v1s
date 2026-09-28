/**
 * Upload the season's scenarios to the Workshop, the ones not already there.
 *
 *   npm run workshop:previews                      once, or after a family changes
 *   npm run workshop:upload                        the plan: what it would do, nothing sent
 *   npm run workshop:upload -- --upload            do it
 *   npm run workshop:upload -- --upload --only "Apogee Glide Novice"
 *   npm run workshop:upload -- --upload --limit 5
 *
 * Needs Steam running, signed in as the uploader, with KovaaK's closed: this initialises
 * the Steam API as app 824270 and calls the same ISteamUGC CreateItem/SubmitItemUpdate
 * KovaaK's own uploader calls. steamcmd's workshop_build_item was the other way and was
 * rejected because it cannot set tags, and KovaaK's files its uploads under "Scenario".
 *
 * An item is what KovaaK's makes, read off the live items and a subscribed copy: a folder
 * holding the one .sce, titled with the scenario's name, tagged Scenario, Public. The
 * description is generated from the family's focus; the 37 items already up keep their
 * hand-written ones, because nothing that is up is touched.
 *
 * Re-running is the recovery for everything, so it has to be safe:
 * - What is up comes from workshopSurvey.ts, the public listing, not from Steam's reply.
 * - The listing lags a fresh upload by minutes, so .cache/workshop-uploads.json also
 *   records every item this created and whether its update came back. A scenario with an
 *   item there is updated in place, never created twice; one marked done is skipped.
 * - A blank item (CreateItem landed, the update did not) is reused rather than left.
 * - Wrong-size items are updated in place, content only, keeping their text and preview.
 * - Duplicates are reported and left: which one to delete is a person's call.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import steamworks from "steamworks.js";

import { loadSeason, type SeasonScenario } from "../src/core/season/season.ts";
import { DEFAULT_STEAM, KOVAAKS_APP, LEDGER, readLedger, scenarioFile, surveyWorkshop } from "./workshopSurvey.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PREVIEWS = join(root, ".cache", "workshop-previews");
/** Steam gives no deadline of its own; a 40 KB file that has not landed in this long will not. */
const UPDATE_TIMEOUT_MS = 5 * 60_000;
/** ISteamUGC's visibility enum; a const enum in the typings, so it has no runtime value. */
const PUBLIC = 0;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const doUpload = flag("--upload");
const only = value("--only");
const limit = Number(value("--limit") ?? Infinity);
const steam = value("--steam") ?? DEFAULT_STEAM;

const ledger = readLedger();
const saveLedger = () => {
  mkdirSync(join(root, ".cache"), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n");
};

const season = loadSeason();
const band = (s: SeasonScenario) => season.windows?.[s.window ?? 0] ?? "";
const preview = (s: SeasonScenario) => join(PREVIEWS, `${s.family}.png`);
const description = (s: SeasonScenario) => `${s.focus}\r\n\r\nApogee ${season.name}, ${s.category}, ${band(s)}.`;

// --- the plan ---------------------------------------------------------------------

const survey = await surveyWorkshop(season, steam);
const spareBlanks = survey.blank.map((b) => b.publishedfileid).filter((id) => !Object.values(ledger).some((e) => e.itemId === id));

interface Job {
  scenario: SeasonScenario;
  /** Existing item to update; absent means CreateItem first. */
  itemId?: string;
  why: string;
  /** Content only: the item is up with its own text and preview, just the wrong file. */
  contentOnly: boolean;
}
const jobs: Job[] = [];
for (const s of survey.missing) {
  const known = ledger[s.scenario];
  if (known?.done) continue; // uploaded by an earlier run, not in the listing yet
  if (known) jobs.push({ scenario: s, itemId: known.itemId, why: `retry item ${known.itemId} from an earlier run`, contentOnly: false });
  else if (spareBlanks.length) {
    const id = spareBlanks.shift()!;
    jobs.push({ scenario: s, itemId: id, why: `reuse blank item ${id}`, contentOnly: false });
  } else jobs.push({ scenario: s, why: "new item", contentOnly: false });
}
for (const w of survey.wrongSize) {
  jobs.push({ scenario: w.scenario, itemId: w.item.publishedfileid, why: `${w.item.file_size} bytes up, ${w.expected} committed`, contentOnly: true });
}

let todo = only ? jobs.filter((j) => j.scenario.scenario === only) : jobs;
if (only && todo.length === 0) {
  console.error(`"${only}" has nothing to do: it is up, pending in the listing, or not a season scenario`);
  process.exit(1);
}
todo = todo.slice(0, limit);

const pending = survey.missing.filter((s) => ledger[s.scenario]?.done).length;
console.log(`${survey.up.length} up; ${pending} uploaded earlier and not in the public listing yet; ${jobs.length} to do`);
if (survey.duplicated.length) {
  console.log(`${survey.duplicated.length} duplicated, left alone (see npm run workshop:status): ${survey.duplicated.map((d) => d.scenario.scenario).join(", ")}`);
}

const problems: string[] = [];
for (const j of todo) {
  if (!existsSync(scenarioFile(j.scenario.scenario))) problems.push(`${j.scenario.scenario}: no .sce at ${scenarioFile(j.scenario.scenario)}`);
  if (!j.contentOnly && !existsSync(preview(j.scenario))) problems.push(`${j.scenario.scenario}: no preview; run npm run workshop:previews`);
  if (!j.contentOnly && !j.scenario.focus) problems.push(`${j.scenario.scenario}: no focus line to describe it with`);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

if (!doUpload) {
  for (const j of todo) console.log(`  ${j.scenario.scenario}  (${j.why})`);
  if (todo[0]) console.log(`\nfirst description:\n  ${description(todo[0].scenario).replace(/\r\n/g, "\n  ")}`);
  console.log(`\nnothing sent. Add --upload to publish${todo.length > 1 ? `; --only "${todo[0].scenario.scenario}" to try one first` : ""}.`);
  process.exit(0);
}

// --- the upload -------------------------------------------------------------------

let client: ReturnType<typeof steamworks.init>;
try {
  client = steamworks.init(KOVAAKS_APP);
} catch (e) {
  console.error(`could not start the Steam API as app ${KOVAAKS_APP}: is Steam running and signed in? (${(e as Error).message})`);
  process.exit(1);
}
const me = client.localplayer.getSteamId().steamId64.toString();
if (me !== steam) {
  // The survey read another profile's items, so the plan is for the wrong account.
  console.error(`Steam is signed in as ${me}, but the plan was made from ${steam}'s items; sign in as ${steam} or pass --steam ${me}`);
  process.exit(1);
}

const stage = mkdtempSync(join(tmpdir(), "apogee-workshop-"));
const withTimeout = <T>(p: Promise<T>, what: string) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: no answer from Steam in ${UPDATE_TIMEOUT_MS / 60_000} min`)), UPDATE_TIMEOUT_MS))]);

let agreement = false;
const failed: string[] = [];
let sent = 0;
for (const [i, j] of todo.entries()) {
  const name = j.scenario.scenario;
  const tag = `[${i + 1}/${todo.length}] ${name}`;
  try {
    // KovaaK's reads the folder, not a file: one folder per item, holding only its .sce.
    const folder = join(stage, String(i));
    mkdirSync(folder);
    copyFileSync(scenarioFile(name), join(folder, `${name}.sce`));

    let itemId = j.itemId;
    if (!itemId) {
      const created = await withTimeout(client.workshop.createItem(KOVAAKS_APP), "CreateItem");
      itemId = created.itemId.toString();
      agreement ||= created.needsToAcceptAgreement;
    }
    // Written before the update, so a crash or timeout from here leaves an id to retry
    // rather than an orphan the next run would duplicate.
    ledger[name] = { itemId, done: false, at: new Date().toISOString() };
    saveLedger();

    const details = j.contentOnly
      ? { contentPath: folder, changeNote: "Scenario file updated." }
      : {
          title: name,
          description: description(j.scenario),
          contentPath: folder,
          previewPath: preview(j.scenario),
          tags: ["Scenario"],
          visibility: PUBLIC,
          changeNote: `Apogee ${season.name}.`,
        };
    const result = await withTimeout(client.workshop.updateItem(BigInt(itemId), details, KOVAAKS_APP), "SubmitItemUpdate");
    agreement ||= result.needsToAcceptAgreement;
    ledger[name] = { itemId, done: true, at: new Date().toISOString() };
    saveLedger();
    sent++;
    console.log(`${tag}  https://steamcommunity.com/sharedfiles/filedetails/?id=${itemId}`);
  } catch (e) {
    failed.push(name);
    console.error(`${tag}  FAILED: ${(e as Error).message ?? e}`);
  }
}

console.log(`\n${sent} sent, ${failed.length} failed.`);
if (failed.length) console.log(`Run it again: failed items are retried in place, not created twice.`);
if (agreement) {
  console.log(
    `Steam says the Workshop legal agreement has not been accepted on this account; until it is, these items stay hidden. ` +
      `Accept it at https://steamcommunity.com/sharedfiles/workshoplegalagreement`,
  );
}
console.log(`The public listing takes a few minutes to catch up; then npm run workshop:status says what really landed.`);
process.exit(failed.length ? 1 : 0);
