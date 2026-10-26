import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
mkdirSync('.cache/rift-ui', { recursive: true });
// The fixture generator locates its authored scenario data relative to its original source.
await build({ entryPoints:['tools/riftUiHost.ts'], outfile:'.cache/rift-ui/main.cjs', bundle:true, platform:'node', format:'cjs', external:['electron'],
  define:{'import.meta.url':JSON.stringify(pathToFileURL(resolve('tools/fixtures/syntheticStats.ts')).href)}, logLevel:'warning' });
writeFileSync('.cache/rift-ui/preload.cjs', `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('riftTest',{
rift:()=>ipcRenderer.invoke('apogee:rift'),riftAction:a=>ipcRenderer.invoke('apogee:riftAction',a),
chooseFolder:()=>ipcRenderer.invoke('test:folder'),onRift:fn=>ipcRenderer.on('apogee:rift',(_,v)=>fn(v))});`);
