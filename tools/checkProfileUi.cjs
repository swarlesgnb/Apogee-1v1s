const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(root, '.cache', 'profile-ui-'));
app.setPath('userData', path.join(directory, 'profile'));
let session = {playerId:'11111111-1111-4111-8111-111111111111', steamId:'76561198000000001', displayName:'Player 000001'};
let saves = 0;
let window;
ipcMain.handle('apogee:getState', () => ({session, cloudHistory:{status:'ready',count:14705}}));
ipcMain.handle('apogee:updateName', (_event, name) => {
  saves++;
  if (name === 'Failure test') return {error:'Test offline error. Try again.'};
  session = {...session, displayName:name.trim()};
  window.webContents.send('apogee:session', session);
  return {session};
});
ipcMain.handle('apogee:restoreCloudHistory', () => ({count:14705,status:'ready'}));
app.whenReady().then(async () => {
  setTimeout(() => app.exit(1), 30000).unref();
  window = new BrowserWindow({width:1280,height:880,show:false,webPreferences:{preload:path.join(root,'dist/app/preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const html=fs.readFileSync(path.join(root,'dist/app/renderer/index.html'),'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')
    .replace('<head>', '<head><base href="'+pathToFileURL(path.join(root,'dist/app/renderer/')).href+'">');
  const file=path.join(directory,'index.html'); fs.writeFileSync(file,html);
  await window.loadFile(file);
  await window.webContents.executeJavaScript(fs.readFileSync(path.join(root,'dist/app/renderer/account-profile.js'),'utf8'));
  const js=code=>window.webContents.executeJavaScript(code);
  // getState resolves asynchronously; await another bridge call as a barrier.
  await js('window.apogee.getState()');
  assert.equal(await js('document.getElementById("btnEditName").hidden'),false);
  await js('document.getElementById("btnEditName").click()');
  assert.equal(await js('document.getElementById("profileDialog").open'),true);
  assert.equal(await js('document.getElementById("profileName").value'),'Player 000001');
  assert.equal(await js('document.activeElement.id'),'profileName');
  assert.equal(await js('document.getElementById("profileSave").disabled'),true);
  console.log('PASS editor opens with the current name, focuses the input, and disables unchanged saves');
  async function input(value) {await js(`document.getElementById('profileName').value=${JSON.stringify(value)};document.getElementById('profileName').dispatchEvent(new Event('input'))`);}
  await input('x');
  assert.equal(await js('document.getElementById("profileSave").disabled'),true);
  await input('Failure test');
  await js('document.getElementById("profileForm").requestSubmit()');
  await js('window.apogee.getState()');
  assert.equal(await js('document.getElementById("profileDialog").open'),true);
  assert.match(await js('document.getElementById("profileStatus").textContent'),/offline/);
  await input('Apogee Pilot');
  await js(`document.getElementById('profileStatus').textContent='';document.querySelector('#status details').open=true`);
  await js('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
  fs.writeFileSync(path.join(root,'.cache/profile-editor.png'),(await window.webContents.capturePage()).toPNG());
  await js('document.getElementById("profileForm").requestSubmit()');
  await js('window.apogee.getState()');
  assert.equal(session.displayName,'Apogee Pilot');
  assert.equal(await js('document.getElementById("profileDialog").open'),false);
  assert.equal(saves,2);
  console.log('PASS invalid names are blocked, server errors stay visible, and a corrected save succeeds');
  session=null; window.webContents.send('apogee:session',null);
  await js('window.apogee.getState()');
  assert.equal(await js('document.getElementById("btnEditName").hidden'),true);
  assert.equal(await js('document.getElementById("btnRestoreCloud").hidden'),true);
  console.log('PASS sign-out hides account-only controls');
  app.exit(0);
}).catch(error=>{console.error(error); app.exit(1);});
