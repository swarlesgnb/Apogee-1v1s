/** Reproducible vector plates for the app chrome; the live expedition scene is separate. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const output = fileURLToPath(new URL('../src/app/renderer/assets/atlas/', import.meta.url));
mkdirSync(output, { recursive:true });
const colors = ['#94d5d1','#e7a17e','#a8cfb3','#bbadd5','#e6d19a','#dca2ac','#e5edb0'];
const circle = (r, extra='') => `<circle r="${r}" ${extra}/>`;
const ellipse = (x,y,extra='') => `<ellipse rx="${x}" ry="${y}" ${extra}/>`;
const paths = [
  `${circle(65)}${ellipse(25,65)}${ellipse(49,65)}${ellipse(65,22)}${ellipse(65,45)}<path d="M0-65V65M-65 0H65"/><g transform="rotate(-27)">${ellipse(91,24)}<path d="M-97 0h12m170 0h12"/></g><path d="M-64-62l7 11-7 11-7-11ZM71 39l6 10-6 10-6-10Z" fill="currentColor" fill-opacity=".2"/>`,
  `<path d="M-48-49-11-67 34-56 61-22 66 16 40 52-4 67-49 44-67 7Z" fill="currentColor" fill-opacity=".07"/><path d="M-48-49-20-12-67 7M-11-67-20-12 24-23 34-56M61-22 24-23 41 19 66 16M40 52 41 19-5 28-4 67M-49 44-5 28-20-12M24-23-5 28"/><g transform="rotate(-34)">${ellipse(95,72,'stroke-dasharray="4 10"')}</g><path d="M-88-29-80-34-74-26-80-19Z M76 49l10 2 4 10-9 6-9-10Z"/>`,
  `${circle(64)}<g clip-path="url(#disc)"><path d="M-80-39Q-42-57 0-38T80-39M-80-20Q-35-39 6-20T80-20M-80 1Q-42-17 0 1T80 1M-80 22Q-35 3 6 22T80 22M-80 43Q-42 25 0 43T80 43"/>${ellipse(29,70,'stroke-opacity=".45"')}</g><g transform="rotate(-22)">${ellipse(96,26)}${ellipse(106,31,'stroke-opacity=".4"')}</g>`,
  `${circle(57)}${ellipse(20,57,'transform="rotate(30)"')}<g transform="rotate(-32)"><path d="M-86 0a86 31 0 1 1 159 17M86 0a86 31 0 0 1-155 18"/></g><g transform="rotate(53)"><path d="M-77 0a77 34 0 1 1 143 16M77 0a77 34 0 0 1-144 17"/></g><path d="M-60-62l6 12-6 12-6-12ZM68 40l6 12-6 12-6-12ZM-8-57 9-28-12-5 13 23-4 57"/>`,
  `<path d="M0-77 45-33 39 43 0 79-39 43-45-33Z" fill="currentColor" fill-opacity=".07"/><path d="M0-77V79M-45-33 0-10 45-33M-39 43 0-10 39 43M-45-33 39 43M45-33-39 43"/><g transform="rotate(28)">${ellipse(89,42,'stroke-opacity=".45"')}</g><path d="M-76-56h13m-6-6v12M69 55h13m-6-6v12"/>`,
  `${circle(60)}${ellipse(29,60)}<g clip-path="url(#disc)"><path d="M-67-33H67M-67-12H67M-67 12H67M-67 33H67"/></g><g transform="rotate(-26)">${ellipse(99,19)}${ellipse(106,24,'stroke-opacity=".4"')}</g><circle cx="84" cy="-55" r="12"/><path d="M-84 58h11m-6-5v10"/>`,
  `<path d="M0-72 20-20 72 0 20 20 0 72-20 20-72 0-20-20Z" fill="currentColor" fill-opacity=".1"/><path d="M0-72V72M-72 0H72M-20-20 20 20M20-20-20 20"/>${circle(87,'stroke-dasharray="1 8"')}<path d="M-98-29v-33h33M98 29v33H65"/>`
];
function plate(index, ship=false) {
  const color = colors[index];
  const stars = [[374,43],[409,168],[454,211],[654,44],[683,177],[379,111],[618,207]].map(([x,y],i)=>`<rect x="${x}" y="${y}" width="${i%3===0?3:2}" height="${i%3===0?3:2}" fill="${color}" opacity=".35"/>`).join('');
  const graphic = ship ? `<g transform="translate(548 123) rotate(27)"><path d="M0-77 14-18 62 45 52 58 15 35 0 65-15 35-52 58-62 45-14-18Z" fill="#172830" stroke="#e5edb0" stroke-width="2"/><path d="M0-65 7-12 0 21-7-12ZM-42 34-16 13M42 34 16 13M0 26V47" stroke="#94d5d1"/><path d="M-13 52-10 78-6 51M6 51 10 78 13 52" stroke="#e7a17e"/><path d="M-10 87v15M10 87v24" stroke="#e7a17e" stroke-dasharray="3 6"/></g><g transform="translate(620 81)" opacity=".2">${circle(47)}${ellipse(68,17,'transform="rotate(-27)"')}</g>` : `<g transform="translate(548 120)" color="${color}" stroke="currentColor" stroke-width="1.6" opacity=".8">${circle(66,'fill="url(#scan)" stroke="none"')}${paths[index]}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="240" viewBox="0 0 720 240" fill="none"><defs><clipPath id="disc">${circle(64)}</clipPath><pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M0 .5H4" stroke="${color}" stroke-opacity=".08"/></pattern></defs><g stroke="${color}" stroke-width="1" opacity=".15"><path d="M412 23h31m-31 0v21M655 23h29v21M412 217h31m-31 0v-21M655 217h29v-21M423 120h14m222 0h14M548 23v13m0 168v13"/><path d="M351 188 389 188 409 168M656 74h31l15-15"/></g>${stars}${graphic}<g fill="${color}" opacity=".45"><path d="M425 222h13v3h-13zM442 222h6v3h-6zM452 222h3v3h-3z"/></g></svg>\n`;
}
for (let i=0;i<7;i++) writeFileSync(new URL(`../src/app/renderer/assets/atlas/${i===6?'final':`world-${i+1}`}.svg`,import.meta.url),plate(i));
writeFileSync(new URL('../src/app/renderer/assets/atlas/ship.svg',import.meta.url),plate(6,true));
console.log('Wrote eight original vector atlas plates.');
