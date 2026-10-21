import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
if (!process.argv[2] && !process.env.CI) throw Error('Use an explicit temporary folder outside CI.');
const folder = process.argv[2] ? resolve(process.argv[2])
  : join(homedir(), '.local/share/Steam/steamapps/common/FPSAimTrainer/FPSAimTrainer/stats');
mkdirSync(folder, { recursive: true });
const season = JSON.parse(readFileSync('data/seasons/season-1.json', 'utf8'));
for (const [index, slot] of season.scenarios.entries()) {
  if (!slot.scenario) continue;
  writeFileSync(join(folder, `${slot.scenario} - Challenge - 2026.10.20-12.${String(Math.floor(index / 60)).padStart(2, '0')}.${String(index % 60).padStart(2, '0')} Stats.csv`),
    `Kill #,Timestamp,Time Elapsed,TTK\n\nScenario:,${slot.scenario}\nScore:,${slot.rankMaxes?.[0] || 100}\nKills:,10\nDeaths:,0\nHit Count:,10\nShot Count:,20\nChallenge Start:,2026.10.20-12.00.00\n`);
}
console.log(`Created synthetic Linux smoke history at ${folder}. No real player history is used.`);
