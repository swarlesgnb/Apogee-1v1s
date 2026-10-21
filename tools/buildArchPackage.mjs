import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { create } from 'tar';

const output = resolve(process.argv[2] || 'release');
const source = join(output, 'linux-unpacked');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
if (!existsSync(join(source, 'apogee'))) throw Error('Build the Linux distribution first.');
const root = mkdtempSync(join(output, '.arch-package-'));
const appDir = join(root, 'opt', 'apogee');
cpSync(source, appDir, { recursive: true });
const bin = join(root, 'usr/bin'), desktop = join(root, 'usr/share/applications');
const icons = join(root, 'usr/share/icons/hicolor/256x256/apps');
for (const path of [bin, desktop, icons]) mkdirSync(path, { recursive: true });
writeFileSync(join(bin, 'apogee'), '#!/bin/sh\nexec /opt/apogee/apogee "$@"\n');
writeFileSync(join(desktop, 'apogee.desktop'), [
  '[Desktop Entry]', 'Type=Application', 'Name=Apogee', "Comment=KovaaK's training and ranked companion",
  'Exec=apogee %U', 'Icon=apogee', 'Terminal=false', 'Categories=Game;', 'StartupWMClass=apogee',
  'MimeType=x-scheme-handler/apogee;', '',
].join('\n'));
cpSync('build/icons/icon-256.png', join(icons, 'apogee.png'));
let size = 0;
const walk = dir => { for (const file of readdirSync(dir, { withFileTypes: true })) {
  const path = join(dir, file.name); if (file.isDirectory()) walk(path); else size += statSync(path).size;
} };
walk(root);
writeFileSync(join(root, '.PKGINFO'), [
  'pkgname = apogee', `pkgver = ${version}-1`, "pkgdesc = KovaaK's training and ranked companion",
  'url = https://github.com/swarlesgnb/Apogee-1v1s', `builddate = ${Math.floor(Date.now() / 1000)}`,
  'packager = Rylee', `size = ${size}`, 'arch = x86_64', 'license = AGPL-3.0-or-later',
  ...['gtk3', 'nss', 'alsa-lib', 'libxss', 'libxtst', 'xdg-utils', 'libxkbcommon', 'mesa', 'desktop-file-utils'].map(name => `depend = ${name}`),
  'optdepend = gnome-keyring: remember Steam sign-in securely', '',
].join('\n'));
const file = join(output, `Apogee-${version}-linux-x64.pkg.tar.gz`);
await create({ cwd: root, file, gzip: true, portable: true, onWriteEntry: entry => {
  // Building on Windows must still produce real Unix permissions and root ownership.
  const name = entry.path.replaceAll('\\', '/');
  entry.stat.uid = 0; entry.stat.gid = 0;
  entry.stat.mode = entry.type === 'Directory' || name === 'usr/bin/apogee' || name === 'opt/apogee/apogee'
    || name.endsWith('.sh') || name.endsWith('.so') || name.endsWith('chrome_crashpad_handler') ? 0o755 : 0o644;
  if (name === 'opt/apogee/chrome-sandbox') entry.stat.mode = 0o4755;
} }, ['.PKGINFO', 'opt', 'usr']);
console.log(`Built native Arch package: ${file}`);
const portable = join(output, `Apogee-${version}-linux-x64.tar.gz`);
await create({ cwd: source, file: portable, gzip: true, portable: true,
  prefix: `Apogee-${version}-linux-x64`, onWriteEntry: entry => {
    const name = entry.path.replaceAll('\\', '/');
    entry.stat.mode = entry.type === 'Directory' || ['apogee', 'chrome-sandbox', 'chrome_crashpad_handler', 'start-apogee.sh'].includes(name)
      || name.endsWith('.so') ? 0o755 : 0o644;
  } }, readdirSync(source));
console.log(`Built FUSE-free portable archive: ${portable}`);
