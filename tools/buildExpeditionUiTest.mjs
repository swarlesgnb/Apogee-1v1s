import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('.cache/expedition-ui', { recursive: true });
await build({ entryPoints: ['tools/expeditionUiHost.ts'], outfile: '.cache/expedition-ui/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'warning' });
writeFileSync('.cache/expedition-ui/preload.cjs', `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('expeditionTest',{
expedition:()=>ipcRenderer.invoke('test:view'),
expeditionAction:a=>ipcRenderer.invoke('test:action',a),
chooseFolder:()=>ipcRenderer.invoke('test:folder'),
onExpedition:fn=>ipcRenderer.on('test:update',(_,v)=>fn(v))
});`);
