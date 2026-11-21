import { anomaly, VESSELS } from '../core/rift/engine.ts';
import type { RiftRecord } from '../core/rift/store.ts';

export const FLIGHT_CARD_SIZE = { width: 1200, height: 675 };
const esc = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!);

export function flightCardSvg(r: RiftRecord): string {
  const accent = r.outcome === 'lost' ? '#ff9780' : r.outcome === 'won' ? '#a4fba5' : '#81d9ff';
  const hull = r.firstContact ? 'First Light' : VESSELS.find(v => v.id === r.vessel)?.name || 'Unknown vessel';
  const outcome = r.ending ?? ({ lost: 'Voyage lost', won: 'Escaped the Rift', extracted: 'Extracted safely' }[r.outcome] || 'Voyage ended');
  const text = (x: number, y: number, size: number, value: string, width: number, fill = '#f5f4ff', mono = false) =>
    `<text x="${x}" y="${y}" font-family="'Apogee ${mono ? 'Mono' : 'Display'}', sans-serif" font-weight="600" font-size="${size}" data-fit="${width}" fill="${fill}">${esc(value)}</text>`;
  const rail = r.anomalies.map((id, i) => {
    const x = 56 + (i % 3) * 365, y = 477 + Math.floor(i / 3) * 58;
    return `<rect x="${x}" y="${y}" width="350" height="48" rx="8" fill="#1c2439"/>` +
      text(x + 12, y + 33, 22, String(i + 1).padStart(2, '0'), 37, accent, true) +
      text(x + 57, y + 34, 29, anomaly(id)?.name ?? id, 281);
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675" role="img">
    <title>${esc(hull + ' · ' + outcome)}</title><defs><radialGradient id="sky" cx=".84" cy=".22" r=".92"><stop stop-color="#303653"/><stop offset="1" stop-color="#0a0d19"/></radialGradient></defs>
    <rect width="1200" height="675" fill="url(#sky)"/><g fill="none" stroke="${accent}" opacity=".16" transform="rotate(-18 964 155)"><ellipse cx="964" cy="155" rx="210" ry="95"/><ellipse cx="964" cy="155" rx="255" ry="117"/><circle cx="964" cy="155" r="78"/></g>
    ${text(56, 59, 24, r.firstContact ? 'APOGEE  /  FIRST CONTACT' : 'APOGEE  /  INTO THE RIFT', 825, accent, true)}
    ${text(56, 151, 75, hull, 760)}${text(58, 211, 43, outcome, 1060, accent)}
    <path d="M56 246h1088M56 407h1088" stroke="#47506a"/>
    ${text(56, 294, 23, 'BEST HIT', 400, '#c3c9dd', true)}${text(56, 377, 77, r.bestHit.toLocaleString('en-US'), 635)}
    ${text(746, 296, 25, r.band.toUpperCase(), 380, accent, true)}${text(746, 366, 54, 'System ' + r.system, 380)}
    ${text(56, 453, 23, 'ANOMALIES IN FIRING ORDER', 900, '#c3c9dd', true)}
    ${rail || text(56, 515, 30, 'No anomalies aboard', 900)}
  </svg>`;
}
