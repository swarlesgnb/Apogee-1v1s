const { app, BrowserWindow } = require('electron');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'apogee-background-test-')));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 1000,
    webPreferences: { offscreen: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(resolve('tools/apogee-ui-preview.html'));
  const result = await win.webContents.executeJavaScript(`(() => {
    let focused = false, paints = 0;
    document.hasFocus = () => focused;
    const actualRender = render;
    render = function(data) { paints++; return actualRender(data); };
    const newest = { ...lastSnapshot, backgroundTest: 100 };
    const start = performance.now();
    for (let i = 0; i < 100; i++) receiveSnapshot({ ...newest, backgroundTest: i });
    const backgroundMs = performance.now() - start;
    if (paints !== 0 || current.backgroundTest !== 99) throw new Error('Background state/paint mismatch');
    focused = true;
    window.dispatchEvent(new Event('focus'));
    if (paints !== 1 || lastSnapshot.backgroundTest !== 99) throw new Error('Did not paint the newest snapshot once');
    window.dispatchEvent(new Event('focus'));
    if (paints !== 1) throw new Error('Duplicate focus repainted');
    if (document.getElementById('app').hidden) throw new Error('App remains hidden');
    return { backgroundUpdates: 100, backgroundMs, paintsOnReturn: paints,
      renderedNodes: document.querySelectorAll('*').length };
  })()`);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('OK: actual Chromium renderer: ' + JSON.stringify(result));
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
