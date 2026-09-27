/**
 * What is actually on the Workshop, against the season.
 *
 *   npm run workshop:status [-- --steam <steamid64>]
 *
 * Read-only. The survey itself, and why it reads the public listing rather than trusting
 * KovaaK's upload results, is in workshopSurvey.ts.
 */

import { loadSeason } from "../src/core/season/season.ts";
import { DEFAULT_STEAM, surveyWorkshop } from "./workshopSurvey.ts";

const args = process.argv.slice(2);
const steamArg = args.indexOf("--steam");
const steam = steamArg >= 0 ? args[steamArg + 1] : DEFAULT_STEAM;

const season = loadSeason();
const s = await surveyWorkshop(season, steam);

console.log(`${s.items.length} public Workshop items on ${steam}; ${season.scenarios.length} scenarios in ${season.name}\n`);
console.log(`up, right size: ${s.up.length}`);
if (s.wrongSize.length) {
  console.log(`\nwrong size (re-upload): ${s.wrongSize.length}`);
  for (const w of s.wrongSize) console.log(`  ${w.scenario.scenario}: ${w.item.publishedfileid} is ${w.item.file_size} bytes, the committed file ${w.expected}`);
}
if (s.duplicated.length) {
  console.log(`\nduplicated (keep one right-size item, delete the rest): ${s.duplicated.length}`);
  for (const d of s.duplicated) {
    const each = d.items.map((i) => `${i.publishedfileid} (${Number(i.file_size) === d.expected ? "right size" : `${i.file_size} bytes, expected ${d.expected}`})`);
    console.log(`  ${d.scenario.scenario}: ${each.join(", ")}`);
  }
}
if (s.blank.length) {
  console.log(`\nblank items (workshop:upload reuses these; otherwise delete them): ${s.blank.length}`);
  for (const d of s.blank) console.log(`  https://steamcommunity.com/sharedfiles/filedetails/?id=${d.publishedfileid}`);
}
if (s.strangers.length) console.log(`\nApogee titles the season no longer has (old names?): ${s.strangers.join(", ")}`);
console.log(`\nstill to upload: ${s.missing.length}`);
for (const band of season.windows ?? []) {
  const inBand = s.missing.filter((m) => m.scenario.endsWith(` ${band}`));
  if (inBand.length) console.log(`  ${band}: ${inBand.map((m) => m.scenario.replace(/^Apogee /, "").replace(` ${band}`, "")).join(", ")}`);
}
