import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { list } from 'tar';
import { createHash } from 'node:crypto';
import { load } from 'js-yaml';

const output = resolve(process.argv[2] || 'release');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const expectedAppHash = createHash('sha256').update(readFileSync(join(output, 'linux-unpacked/resources/app.asar'))).digest('hex');
const inspect = async file => {
  const entries = new Map();
  await list({ file, onReadEntry: entry => {
    const chunks = [];
    const hash = entry.path.endsWith('/resources/app.asar') ? createHash('sha256') : null;
    if (hash) entry.on('data', data => hash.update(data));
    if (entry.path === '.PKGINFO' || entry.path.endsWith('.desktop')) entry.on('data', data => chunks.push(data));
    entry.on('end', () => entries.set(entry.path, { mode: entry.mode, uid: entry.uid, gid: entry.gid,
      size: entry.size, type: entry.type, sha256: hash?.digest('hex'), text: Buffer.concat(chunks).toString('utf8') }));
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
assert.equal(arch.get('opt/apogee/resources/app.asar')?.sha256, expectedAppHash);
assert.match(arch.get('usr/share/applications/apogee.desktop')?.text || '', /^Exec=apogee %U$/m);
assert.match(arch.get('usr/share/applications/apogee.desktop').text, /^MimeType=x-scheme-handler\/apogee;$/m);
assert(arch.has('usr/share/icons/hicolor/256x256/apps/apogee.png'));
console.log(`PASS Arch package: ${arch.size} entries, metadata, dependencies, desktop launcher, root sandbox ownership and permissions`);
const portable = await inspect(join(output, `Apogee-${version}-linux-x64.tar.gz`));
const prefix = `Apogee-${version}-linux-x64/`;
assert.equal(portable.get(prefix + 'apogee')?.mode, 0o755);
assert.equal(portable.get(prefix + 'start-apogee.sh')?.mode, 0o755);
assert.equal(portable.get(prefix + 'resources/app.asar')?.sha256, expectedAppHash);
console.log(`PASS portable archive: ${portable.size} entries, executable Linux binary and launcher, complete application archive`);
if (process.argv.includes('--appimage')) {
  const name = `Apogee-${version}-linux-x86_64.AppImage`;
  const feed = load(readFileSync(join(output, 'latest-linux.yml'), 'utf8'));
  const image = readFileSync(join(output, name));
  assert(image.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])));
  assert.equal(image.readUInt16LE(18), 62);
  assert(image.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 2])), 'AppImage type 2 header');
  assert.equal(feed.version, version);
  assert.equal(feed.path, name);
  const entry = feed.files.find(file => file.url === name);
  assert.equal(entry?.size, image.length);
  const sha512 = createHash('sha512').update(image).digest('base64');
  assert.equal(entry.sha512, sha512);
  assert.equal(feed.sha512, sha512);
  console.log(`PASS AppImage: x86-64 runtime, v${version} update feed, exact download name, size and SHA-512`);
}
console.log('Limits: archive checks do not execute Linux, pacman, FUSE, the display server, or Chromium sandbox.');
