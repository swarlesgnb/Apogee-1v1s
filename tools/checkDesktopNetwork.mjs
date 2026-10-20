/** Local transport regression checks; --live also checks the configured auth service. */
import { build } from 'esbuild';
import electron from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, '.cache'), { recursive: true });
const work = mkdtempSync(join(root, '.cache', 'desktop-network-'));
const cert = join(work, 'cert.pem');
const key = join(work, 'key.pem');
const gitOpenSsl = 'C:/Program Files/Git/usr/bin/openssl.exe';
const openssl = process.platform === 'win32' && existsSync(gitOpenSsl) ? gitOpenSsl : 'openssl';
const generated = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
  '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], {windowsHide: true});
if (generated.status !== 0) throw Error('OpenSSL is required to generate the untrusted localhost test certificate.');
const bundle = join(work, 'check.cjs');
await build({entryPoints: [join(root, 'tools/checkDesktopNetwork.ts')], outfile: bundle,
  bundle: true, platform: 'node', format: 'cjs', external: ['electron']});
const env = {...process.env};
if (process.argv.includes('--live')) {
  const settings = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)
    .map(line => line.match(/^(APOGEE_SUPABASE_URL|APOGEE_SUPABASE_ANON_KEY)\s*=\s*(.*)$/))
    .filter(Boolean).map(m => [m[1], m[2].trim()]));
  if (!settings.APOGEE_SUPABASE_URL || !settings.APOGEE_SUPABASE_ANON_KEY) throw Error('--live requires public Supabase configuration in .env');
  env.APOGEE_NETWORK_CHECK_URL = settings.APOGEE_SUPABASE_URL;
  env.APOGEE_NETWORK_CHECK_ANON = settings.APOGEE_SUPABASE_ANON_KEY;
}
const child = spawn(electron, [bundle, cert, key], {cwd: root, env, stdio: 'inherit', windowsHide: true});
child.on('error', error => {console.error(error.message); process.exitCode = 1;});
child.on('close', code => {process.exitCode = code ?? 1;});
