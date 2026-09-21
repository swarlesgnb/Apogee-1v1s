/** Check the actual desktop archive, including exclusions and copied source files. */
import { extractFile, listPackage, statFile } from '@electron/asar';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidate = process.argv[2] && resolve(process.argv[2]);
if (!candidate) throw new Error('Usage: node tools/validatePackage.mjs <candidate directory>');
const archive = join(candidate, 'win-unpacked/resources/app.asar');
const paths = listPackage(archive).map(path => path.replaceAll('\\', '/').replace(/^\//, ''));
const files = paths.filter(path => !statFile(archive, normalize(path)).files);
const readArchive = path => extractFile(archive, normalize(path));
const checks = [];
function check(label, passed) {
  checks.push({ label, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}`);
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const forbidden = /(^|\/)(\.env(?:\..*)?|node_modules|snapshot\.json|settings\.json|quests\.json|expedition-first-light-v\d+\.json)(\/|$)|\.map$|\.csv$/i;
check('Archive excludes environment files, player saves, snapshots, CSVs, source maps and node_modules', !files.some(path => forbidden.test(path)));
check('Archive contains only the application distribution and package metadata', files.every(path => path.startsWith('dist/') || path === 'package.json'));
const metadata = JSON.parse(readArchive('package.json'));
check('Application metadata points to the bundled main process', metadata.name === 'apogee' && metadata.main === 'dist/app/main.cjs');
const copies = [
  ['dist/app/preload.cjs', 'src/app/preload.cjs'],
  ...['index.html', 'expedition.js', 'expedition.css', 'arcade.css'].map(name => [`dist/app/renderer/${name}`, `src/app/renderer/${name}`]),
  ...['first-light-v1.json', 'first-light-v2.json'].map(name => [`dist/data/expeditions/${name}`, `data/expeditions/${name}`]),
];
for (const [shipped, source] of copies) {
  check(`${shipped} matches source`, hash(readArchive(shipped)) === hash(readFileSync(join(root, source))));
}
check('Bundled main process matches the validated build', hash(readArchive('dist/app/main.cjs')) === hash(readFileSync(join(root, 'dist/app/main.cjs'))));
const envFile = join(root, '.env');
const privateValues = existsSync(envFile) ? readFileSync(envFile, 'utf8').split(/\r?\n/).flatMap(line => {
  const entry = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
  if (!entry || !/SERVICE_ROLE|SECRET|PASSWORD|PRIVATE_KEY/.test(entry[1])) return [];
  const value = entry[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  return value.length >= 12 ? [value] : [];
}) : [];
// Keep secret values in memory only; failures identify the check, never its contents.
check('Known local private credentials are absent from packaged text', !files.some(path => {
  if (!/\.(?:cjs|js|json|html|css|txt)$/.test(path)) return false;
  const content = readArchive(path).toString('utf8');
  return privateValues.some(value => content.includes(value));
}));
const installer = join(candidate, `Apogee-${metadata.version}-setup.exe`);
check('Installer and unpacked executable exist', existsSync(installer) && existsSync(join(candidate, 'win-unpacked/Apogee.exe')));
const report = { checkedAt: new Date().toISOString(), version: metadata.version, checks,
  allPassed: checks.every(item => item.passed), installer,
  installerSha256: existsSync(installer) ? hash(readFileSync(installer)) : null,
  limits: ['Does not verify Authenticode, installation, native gameplay, or online services.'] };
writeFileSync(join(candidate, 'package-check.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Package ${metadata.version}: ${checks.filter(item => item.passed).length}/${checks.length} checks passed.`);
process.exitCode = report.allPassed ? 0 : 1;
