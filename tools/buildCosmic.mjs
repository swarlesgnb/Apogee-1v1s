import {readFileSync,writeFileSync} from 'node:fs';
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
await build({entryPoints:[join(root,'src/app/renderer/cosmic-source.mjs')],outfile:join(root,'src/app/renderer/cosmic.js'),bundle:true,format:'iife',platform:'browser',target:'chrome138',minify:true,legalComments:'eof',logLevel:'warning'});

// GLSL template strings retain upstream trailing spaces; strip them for reproducible clean diffs.
const output=join(root,'src/app/renderer/cosmic.js');
writeFileSync(output,readFileSync(output,'utf8').replace(/[ \t]+$/gm,''));
