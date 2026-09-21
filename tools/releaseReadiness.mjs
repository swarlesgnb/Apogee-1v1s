/** Run every release check and retain every result, including failures. */
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
const validation = [...scripts.validate.matchAll(/npm run ([\w:-]+)/g)].map(match => match[1]);
const checks = [...new Set(['typecheck', ...validation, 'validate:expedition-ui', 'audit:look', 'smoke', 'beta'])];
const output = join(root, '.cache', 'release-readiness');
mkdirSync(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), finishedAt: null, checks: [], allPassed: false,
  limits: ['Synthetic UI checks do not prove real gameplay enjoyment or native game launching.',
    'Live Steam login, real matches and settlement need hands-on verification.',
    'This command does not build an installer, publish a release, or approve beta policy decisions.'] };
const reportPath = join(output, 'report.json');
for (const name of checks) {
  const logPath = join(output, name.replaceAll(':', '-') + '.log');
  const log = createWriteStream(logPath);
  const started = Date.now();
  const exitCode = await new Promise(resolve => {
    // Script names come only from package.json, never user text. cmd runs npm.cmd on Windows.
    const child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', `npm.cmd run ${name}`], { cwd: root, windowsHide: true })
      : spawn('npm', ['run', name], { cwd: root });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    child.on('error', err => { log.write(String(err)); });
    child.on('close', code => { log.end(() => resolve(code ?? 1)); });
  });
  report.checks.push({ name, exitCode, seconds: Math.round((Date.now() - started) / 1000), log: logPath });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`${exitCode === 0 ? 'PASS' : 'FAIL'} ${name} (${report.checks.at(-1).seconds}s)`);
}
report.finishedAt = new Date().toISOString();
report.allPassed = report.checks.every(check => check.exitCode === 0);
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.checks.filter(check => check.exitCode === 0).length}/${checks.length} checks passed. Report: ${reportPath}`);
console.log(report.allPassed ? 'Automated checks passed. Hands-on release gates remain.' : 'Release blocked: inspect the failed checks before publishing.');
process.exitCode = report.allPassed ? 0 : 1;
