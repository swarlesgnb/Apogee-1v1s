import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { list } from 'tar';

const output = resolve(process.argv[2] || 'release');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const inspect = async file => {
  const entries = new Map();
  await list({ file, onReadEntry: entry => {
    const chunks = [];
    if (entry.path === '.PKGINFO' || entry.path.endsWith('.desktop')) entry.on('data', data => chunks.push(data));
    entry.on('end', () => entries.set(entry.path, { mode: entry.mode, uid: entry.uid || 0, gid: entry.gid || 0,
      size: entry.size, type: entry.type, text: Buffer.concat(chunks).toString('utf8') }));
  } });
  assert(entries.size > 100, 'archive must contain the actual Electron distribution');
  for (const name of entries.keys()) assert(!name.startsWith('/') && !name.split('/').includes('..'), `unsafe path: ${name}`);
  return entries;
};
const arch = await inspect(join(output, `Apogee-${version}-linux-x64.pkg.tar.gz`));
assert.match(arch.get('.PKGINFO')?.text || '', /^pkgname = apogee$/m);
assert.match(arch.get('.PKGINFO').text, /^arch = x86_64$/m);
assert.match(arch.get('.PKGINFO').text, new RegExp(`^pkgver = ${version.replaceAll('.', '\\.')}\\-1$`, 'm'));
for (const dependency of ['gtk3', 'nss', 'alsa-lib', 'libxss', 'libxtst', 'xdg-utils', 'libxkbcommon', 'mesa', 'desktop-file-utils'])
  assert(arch.get('.PKGINFO').text.includes(`depend = ${dependency}\n`));
assert.equal(arch.get('opt/apogee/apogee')?.mode, 0o755);
assert.equal(arch.get('usr/bin/apogee')?.mode, 0o755);
const sandbox = arch.get('opt/apogee/chrome-sandbox');
assert.equal(sandbox?.mode, 0o4755); assert.equal(sandbox.uid, 0); assert.equal(sandbox.gid, 0);
assert(arch.get('opt/apogee/resources/app.asar')?.size > 1000000);
assert.match(arch.get('usr/share/applications/apogee.desktop')?.text || '', /^Exec=apogee %U$/m);
assert.match(arch.get('usr/share/applications/apogee.desktop').text, /^MimeType=x-scheme-handler\/apogee;$/m);
assert(arch.has('usr/share/icons/hicolor/256x256/apps/apogee.png'));
console.log(`PASS Arch package: ${arch.size} entries, metadata, dependencies, desktop launcher, root sandbox ownership and permissions`);
const portable = await inspect(join(output, `Apogee-${version}-linux-x64.tar.gz`));
const prefix = `Apogee-${version}-linux-x64/`;
assert.equal(portable.get(prefix + 'apogee')?.mode, 0o755);
assert.equal(portable.get(prefix + 'start-apogee.sh')?.mode, 0o755);
assert(portable.get(prefix + 'resources/app.asar')?.size > 1000000);
console.log(`PASS portable archive: ${portable.size} entries, executable Linux binary and launcher, complete application archive`);
console.log('Limits: archive checks do not execute Linux, pacman, FUSE, the display server, or Chromium sandbox.');
