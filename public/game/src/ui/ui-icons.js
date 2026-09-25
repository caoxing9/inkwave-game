// INKWAVE UI — inline SVG icon set, input glyphs, logo and illustrations.
// Everything is a markup string (cheap to clone via innerHTML) using currentColor / CSS classes for team ink:
//   .iw-fa = accent/team A ink, .iw-fb = accent/team B ink (see ui.css).
import { esc, splatShape, blobPath } from './ui-util.js';

const K = '#15121c';        // outline ink
const DK = '#2b2735';       // dark plastic
const LT = '#e4e8ef';       // light metal/plastic
const O = `stroke="${K}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"`;

const svg = (body, vb = '0 0 64 64', cls = '') => `<svg class="iw-ico ${cls}" viewBox="${vb}" aria-hidden="true">${body}</svg>`;

// ------------------------------------------------------------------ weapons / subs / specials (two-tone, ink = currentColor)
export const WEAPON_ICONS = {
  shooter: svg(`<g ${O}>
      <path d="M17 37 L13.5 53.5 Q13 57 16.5 57 L22.5 57 Q25.5 57 26 54 L29 38 Z" fill="${DK}"/>
      <rect x="17.5" y="7.5" width="18" height="17" rx="7" fill="#f4f8ff"/>
      <path d="M8 26.5 Q8 22 12.5 22 L44 22 Q48.5 22 48.5 26.5 L48.5 35.5 Q48.5 40 44 40 L12.5 40 Q8 40 8 35.5 Z" fill="currentColor"/>
      <rect x="47" y="25.5" width="9" height="11" rx="2.5" fill="${LT}"/>
      <rect x="54.5" y="23" width="5.5" height="16" rx="2" fill="${DK}"/>
      <path d="M29.5 40.5 Q31 47 36.5 47" fill="none"/>
    </g>
    <rect x="20.5" y="14.5" width="12" height="8" rx="3.5" fill="currentColor"/>
    <path d="M13.5 27 L39 27" stroke="#fff" stroke-opacity=".6" stroke-width="3" stroke-linecap="round"/>
    <circle cx="22.5" cy="12" r="1.9" fill="#fff"/>`),
  roller: svg(`<path d="M31 33 L51 6" stroke="${K}" stroke-width="9" stroke-linecap="round"/>
    <path d="M31 33 L51 6" stroke="${LT}" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M44 15.5 L51 6" stroke="${K}" stroke-width="10" stroke-linecap="round"/>
    <path d="M44 15.5 L51 6" stroke="${DK}" stroke-width="4.2" stroke-linecap="round"/>
    <g ${O}>
      <path d="M18 38 L18 31 Q18 29 20 29 L42 29 Q44 29 44 31 L44 38" fill="none" stroke-width="3.4"/>
      <rect x="8" y="35" width="48" height="19" rx="8" fill="currentColor"/>
      <rect x="4" y="37" width="7" height="15" rx="2.5" fill="${DK}"/>
      <rect x="53" y="37" width="7" height="15" rx="2.5" fill="${DK}"/>
      <path d="M22 53.5 Q22 60 25 60 Q28 60 28 53.5" fill="currentColor"/>
      <path d="M40 53.5 Q40 57 42 57 Q44 57 44 53.5" fill="currentColor"/>
    </g>
    <path d="M14 40.5 L50 40.5" stroke="#fff" stroke-opacity=".55" stroke-width="3" stroke-linecap="round"/>`),
  charger: svg(`<g ${O}>
      <path d="M3.5 29 L15 26 L16.5 40 L7 46.5 Q3.5 47 3.5 43.5 Z" fill="${DK}"/>
      <path d="M22 37.5 L19 50.5 Q18.5 53.5 21.5 53.5 L26.5 53.5 L30 37.5 Z" fill="${DK}"/>
      <rect x="35" y="28" width="23" height="6.5" rx="2" fill="${LT}"/>
      <rect x="56" y="26" width="5.5" height="10.5" rx="1.8" fill="${DK}"/>
      <rect x="12.5" y="24.5" width="25" height="14" rx="4.5" fill="currentColor"/>
      <rect x="23" y="20.5" width="5" height="5" fill="${DK}"/>
      <rect x="15" y="12.5" width="22" height="9" rx="3.5" fill="${DK}"/>
      <rect x="40" y="25.5" width="3.6" height="11.5" rx="1.6" fill="currentColor"/>
      <rect x="46" y="25.5" width="3.6" height="11.5" rx="1.6" fill="currentColor"/>
    </g>
    <circle cx="34" cy="17" r="2.6" fill="currentColor"/>
    <path d="M17 29 L33 29" stroke="#fff" stroke-opacity=".55" stroke-width="3" stroke-linecap="round"/>`),
  blaster: svg(`<g ${O}>
      <path d="M17 41 L13.5 55 Q13 58.5 16.5 58.5 L22.5 58.5 L27 43 Z" fill="${DK}"/>
      <path d="M15 18 Q24.5 5.5 34 18" fill="none" stroke-width="4.2"/>
      <path d="M35 21.5 L53.5 19.5 Q60 19.5 60 26 L60 36 Q60 42.5 53.5 42.5 L35 40.5 Z" fill="${LT}"/>
      <ellipse cx="58" cy="31" rx="3.6" ry="10.5" fill="${DK}"/>
      <circle cx="24.5" cy="30.5" r="15.5" fill="currentColor"/>
      <rect x="36.5" y="20.5" width="5.5" height="21" rx="2.2" fill="currentColor"/>
    </g>
    <ellipse cx="19.5" cy="24.5" rx="5.2" ry="3.6" fill="#fff" fill-opacity=".6"/>`),
};

export const SUB_ICONS = {
  bomb: svg(`<g ${O}>
      <rect x="26.5" y="6" width="11" height="10" rx="3" fill="${DK}"/>
      <path d="M32 13 C38 13 53 39 53 46 C53 53 46 56.5 32 56.5 C18 56.5 11 53 11 46 C11 39 26 13 32 13 Z" fill="currentColor"/>
    </g>
    <circle cx="32" cy="43" r="4.6" fill="#fff" stroke="${K}" stroke-width="2.5"/>
    <path d="M25 29 Q21.5 35 19.5 42" stroke="#fff" stroke-opacity=".6" stroke-width="3.4" fill="none" stroke-linecap="round"/>`),
};

export const SPECIAL_ICONS = {
  slam: svg(`<g ${O}>
      <ellipse cx="32" cy="51" rx="25" ry="7" fill="none" stroke="currentColor" stroke-width="4.6"/>
      <ellipse cx="32" cy="51" rx="25" ry="7" fill="none" stroke-width="1.4"/>
      <path d="M32 45 L15 25.5 L24.5 25.5 L24.5 5 L39.5 5 L39.5 25.5 L49 25.5 Z" fill="currentColor"/>
      <circle cx="7" cy="36" r="3.4" fill="currentColor"/>
      <circle cx="57" cy="36" r="3.4" fill="currentColor"/>
      <circle cx="12" cy="27" r="2.2" fill="currentColor"/>
      <circle cx="52" cy="27" r="2.2" fill="currentColor"/>
    </g>
    <path d="M28.5 9 L28.5 26" stroke="#fff" stroke-opacity=".55" stroke-width="3" stroke-linecap="round"/>`),
  storm: svg(`<g ${O}>
      <path d="M20 42 L16 54" stroke="${K}" stroke-width="8"/><path d="M20 42 L16 54" stroke="currentColor" stroke-width="3.6"/>
      <path d="M32 42 L28 57" stroke="${K}" stroke-width="8"/><path d="M32 42 L28 57" stroke="currentColor" stroke-width="3.6"/>
      <path d="M44 42 L40 54" stroke="${K}" stroke-width="8"/><path d="M44 42 L40 54" stroke="currentColor" stroke-width="3.6"/>
      <path d="M15.5 38 Q5 38 6 28 Q7 19.5 16.5 20.5 Q18.5 8.5 31 8.5 Q43 8.5 46 19.5 Q58 18.5 58 29 Q58 38 48.5 38 Z" fill="currentColor"/>
      <path d="M33 21 L27 31 L33 31 L29 40" fill="none" stroke="#fff" stroke-width="3"/>
    </g>
    <path d="M14 26 Q15 22.5 19 23" stroke="#fff" stroke-opacity=".6" stroke-width="3" fill="none" stroke-linecap="round"/>`),
};

// ------------------------------------------------------------------ squid (team icons, avatar)
export const SQUID = svg(`<g ${O} stroke-width="3.4">
    <path d="M22 44 Q19 53 13 58 Q20 61 26 50 Z" fill="currentColor"/>
    <path d="M29 46 Q28.5 55 25 61 Q32.5 61 33 48 Z" fill="currentColor"/>
    <path d="M35 46 Q35.5 55 39 61 Q31.5 61 31 48 Z" fill="currentColor"/>
    <path d="M42 44 Q45 53 51 58 Q44 61 38 50 Z" fill="currentColor"/>
    <path d="M32 3 C36.5 3 50.5 17.5 55.5 24.5 C57.5 27.8 55.5 31 51.5 30.2 L46 29.4 L46 39.5 C46 46.5 41.5 49 32 49 C22.5 49 18 46.5 18 39.5 L18 29.4 L12.5 30.2 C8.5 31 6.5 27.8 8.5 24.5 C13.5 17.5 27.5 3 32 3 Z" fill="currentColor"/>
  </g>
  <path d="M25 13 Q29 8.5 32 8" stroke="#fff" stroke-opacity=".55" stroke-width="3" fill="none" stroke-linecap="round"/>
  <g class="iw-squid-eyes">
    <ellipse cx="26" cy="36" rx="4.6" ry="5.6" fill="#fff" stroke="${K}" stroke-width="2.4"/>
    <ellipse cx="38" cy="36" rx="4.6" ry="5.6" fill="#fff" stroke="${K}" stroke-width="2.4"/>
    <ellipse cx="27" cy="37" rx="2.2" ry="3" fill="${K}"/>
    <ellipse cx="37" cy="37" rx="2.2" ry="3" fill="${K}"/>
  </g>`, '0 0 64 64', 'iw-squid');

// ------------------------------------------------------------------ line glyphs (single colour, currentColor)
const G = `fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"`;
function gearPath() {
  const pts = []; const n = 8;
  for (let i = 0; i < n * 4; i++) {
    const a = (i / (n * 4)) * Math.PI * 2 - Math.PI / 2;
    const r = (i % 4 === 0 || i % 4 === 1) ? 27 : 20;
    pts.push(`${(32 + Math.cos(a) * r).toFixed(1)} ${(32 + Math.sin(a) * r).toFixed(1)}`);
  }
  return 'M' + pts.join('L') + 'Z';
}
export const GLYPHS = {
  play: svg(`<path d="M21 12 L51 32 L21 52 Z" fill="currentColor" stroke="currentColor" stroke-width="7" stroke-linejoin="round"/>`),
  gear: svg(`<path d="${gearPath()}" fill="currentColor" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><circle cx="32" cy="32" r="8.5" fill="var(--k, #15121c)"/>`),
  question: svg(`<circle cx="32" cy="32" r="26" fill="currentColor"/><path d="M24 25 Q24 16 32.5 16 Q41 16 41 24 Q41 29.5 35 32 Q32.5 33.3 32.5 37.5" fill="none" stroke="var(--k, #15121c)" stroke-width="6" stroke-linecap="round"/><circle cx="32.5" cy="47" r="3.8" fill="var(--k, #15121c)"/>`),
  star: svg(`<path d="M32 5 L39.5 23 L58.5 24.5 L44 37 L48.5 56 L32 46 L15.5 56 L20 37 L5.5 24.5 L24.5 23 Z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>`),
  back: svg(`<path d="M38 14 L20 32 L38 50" ${G} stroke-width="8"/>`),
  next: svg(`<path d="M26 14 L44 32 L26 50" ${G} stroke-width="8"/>`),
  check: svg(`<path d="M14 33 L27 46 L51 18" ${G} stroke-width="8"/>`),
  close: svg(`<path d="M18 18 L46 46 M46 18 L18 46" ${G} stroke-width="8"/>`),
  crown: svg(`<path d="M8 22 L20 34 L32 12 L44 34 L56 22 L51 50 L13 50 Z" fill="currentColor" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/>`),
  clock: svg(`<circle cx="32" cy="33" r="23" ${G}/><path d="M32 20 L32 34 L41 40" ${G}/>`),
  pencil: svg(`<path d="M14 50 L17 38 L42 13 L51 22 L26 47 Z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M36 19 L45 28" stroke="var(--k, #15121c)" stroke-width="3.5"/>`),
  map: svg(`<path d="M8 16 L24 10 L40 16 L56 10 L56 48 L40 54 L24 48 L8 54 Z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M24 10 L24 48 M40 16 L40 54" stroke="var(--k, #15121c)" stroke-width="3.5"/>`),
  bot: svg(`<rect x="12" y="18" width="40" height="32" rx="10" fill="currentColor"/><path d="M32 18 L32 9" ${G} stroke-width="4.5"/><circle cx="32" cy="8" r="4" fill="currentColor"/><circle cx="24" cy="34" r="4.5" fill="var(--k, #15121c)"/><circle cx="40" cy="34" r="4.5" fill="var(--k, #15121c)"/>`),
  gamepad: svg(`<path d="M18 17 L46 17 Q58 17 60 34 Q62 50 54 50 Q49 50 44 42 L20 42 Q15 50 10 50 Q2 50 4 34 Q6 17 18 17 Z" fill="currentColor"/><path d="M19 25 L19 35 M14 30 L24 30" stroke="var(--k, #15121c)" stroke-width="4" stroke-linecap="round"/><circle cx="44" cy="27" r="3.2" fill="var(--k, #15121c)"/><circle cx="50" cy="33" r="3.2" fill="var(--k, #15121c)"/>`),
  keyboard: svg(`<rect x="4" y="16" width="56" height="34" rx="7" fill="currentColor"/><g fill="var(--k, #15121c)"><rect x="11" y="23" width="6" height="6" rx="1.5"/><rect x="20" y="23" width="6" height="6" rx="1.5"/><rect x="29" y="23" width="6" height="6" rx="1.5"/><rect x="38" y="23" width="6" height="6" rx="1.5"/><rect x="47" y="23" width="6" height="6" rx="1.5"/><rect x="11" y="32" width="6" height="6" rx="1.5"/><rect x="47" y="32" width="6" height="6" rx="1.5"/><rect x="20" y="40" width="24" height="5" rx="2"/></g>`),
  monitor: svg(`<rect x="6" y="10" width="52" height="34" rx="6" fill="currentColor"/><path d="M24 54 L40 54 M32 44 L32 54" ${G} stroke-width="5"/><path d="M14 36 L24 24 L31 31 L38 22 L50 36" fill="none" stroke="var(--k, #15121c)" stroke-width="4" stroke-linejoin="round"/>`),
  speaker: svg(`<path d="M8 24 L20 24 L34 12 L34 52 L20 40 L8 40 Z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M42 23 Q48 32 42 41 M48 16 Q59 32 48 48" ${G} stroke-width="5"/>`),
  flag: svg(`<path d="M14 58 L14 8" ${G} stroke-width="6"/><path d="M14 10 Q24 4 34 10 Q44 16 54 10 L54 34 Q44 40 34 34 Q24 28 14 34 Z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>`),
  reset: svg(`<path d="M50 30 A18 18 0 1 1 42 17" ${G} stroke-width="6.5"/><path d="M40 7 L45 19 L33 22" ${G} stroke-width="6.5"/>`),
  sun: svg(`<circle cx="32" cy="32" r="12" fill="currentColor"/><g ${G} stroke-width="5">${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => { const a = i * Math.PI / 4; return `<path d="M${(32 + Math.cos(a) * 19).toFixed(1)} ${(32 + Math.sin(a) * 19).toFixed(1)} L${(32 + Math.cos(a) * 26).toFixed(1)} ${(32 + Math.sin(a) * 26).toFixed(1)}"/>`; }).join('')}</g>`),
  moon: svg(`<path d="M40 8 A24 24 0 1 0 56 40 A19 19 0 0 1 40 8 Z" fill="currentColor"/>`),
  users: svg(`<circle cx="22" cy="22" r="9" fill="currentColor"/><circle cx="43" cy="22" r="9" fill="currentColor"/><path d="M6 52 Q6 36 22 36 Q38 36 38 52 Z M30 52 Q30 36 43 36 Q58 36 58 52 Z" fill="currentColor"/>`),
  drop: svg(`<path d="M32 6 C32 6 50 28 50 40 C50 51 42 58 32 58 C22 58 14 51 14 40 C14 28 32 6 32 6 Z" fill="currentColor"/>`),
  swords: svg(`<path d="M12 10 L40 38 M52 10 L24 38" ${G} stroke-width="6"/><path d="M34 44 L44 34 M20 34 L30 44 M42 42 L54 54 M22 42 L10 54" ${G} stroke-width="6"/>`),
};

/** Kill-feed / stat glyphs */
export const SPLAT_ICON = (() => {
  const s = splatShape(32, 32, 17, { seed: 11, arms: 8, drops: 4, armLen: 0.5 });
  return svg(`<path d="${s.core}" fill="currentColor" stroke="${K}" stroke-width="3" stroke-linejoin="round"/>${s.drops.map((d) => `<circle cx="${d.x}" cy="${d.y}" r="${Math.max(2.2, d.r)}" fill="currentColor" stroke="${K}" stroke-width="2"/>`).join('')}`);
})();
export const DEATH_ICON = svg(`<g ${O} stroke-width="3.4">
    <path d="M32 6 C36.5 6 50 19 54.5 25.5 C56.5 28.5 54.5 31.5 50.5 30.7 L46 30 L46 40 C46 47 41.5 50 32 50 C22.5 50 18 47 18 40 L18 30 L13.5 30.7 C9.5 31.5 7.5 28.5 9.5 25.5 C14 19 27.5 6 32 6 Z" fill="currentColor"/>
  </g>
  <path d="M21.5 31.5 L29 39 M29 31.5 L21.5 39 M35 31.5 L42.5 39 M42.5 31.5 L35 39" stroke="${K}" stroke-width="3.6" stroke-linecap="round"/>`);

// ------------------------------------------------------------------ input glyphs
const PAD_FACE = { A: '#3fc46e', B: '#ff4f5a', X: '#3c8cff', Y: '#ffc31d' };
/** Keycap. `k` is the label ('W', 'SHIFT', 'SPACE', ...). */
export function keycap(k) {
  const s = String(k);
  const wide = s.length > 2 ? ' iw-key--wide' : '';
  return `<kbd class="iw-key${wide}">${esc(s === ' ' ? 'SPACE' : s)}</kbd>`;
}
/** Mouse glyph: which = 'L' | 'R' | 'M' (move) | 'W' (wheel) */
export function mouseGlyph(which = 'L') {
  const l = which === 'L' ? 'var(--a, #ff8a14)' : '#fff';
  const r = which === 'R' ? 'var(--a, #ff8a14)' : '#fff';
  const arrows = which === 'M' ? `<g stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M3 32 L-3 32 M0 29 L-3 32 L0 35"/><path d="M45 32 L51 32 M48 29 L51 32 L48 35"/></g>` : '';
  return `<span class="iw-mouse"><svg viewBox="-6 0 60 64" aria-hidden="true">${arrows}
    <path d="M24 6 Q40 6 40 24 L40 42 Q40 58 24 58 Q8 58 8 42 L8 24 Q8 6 24 6 Z" fill="#fff" stroke="${K}" stroke-width="3"/>
    <path d="M24 6 Q9.5 6 8.3 24 L24 24 Z" style="fill:${l}" stroke="${K}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M24 6 Q38.5 6 39.7 24 L24 24 Z" style="fill:${r}" stroke="${K}" stroke-width="3" stroke-linejoin="round"/>
    <rect x="21.5" y="11" width="5" height="9" rx="2.5" fill="${K}"/></svg></span>`;
}
/** Gamepad glyph: 'A' 'B' 'X' 'Y' 'LB' 'RB' 'LT' 'RT' 'LS' 'RS' 'View' 'Start' 'DPad' */
export function padGlyph(b) {
  if (PAD_FACE[b]) return `<span class="iw-pad iw-pad--face" style="--pc:${PAD_FACE[b]}">${b}</span>`;
  if (b === 'LB' || b === 'RB') return `<span class="iw-pad iw-pad--bumper">${b}</span>`;
  if (b === 'LT' || b === 'RT') return `<span class="iw-pad iw-pad--trigger">${b}</span>`;
  if (b === 'LS' || b === 'RS') return `<span class="iw-pad iw-pad--stick">${b[0]}</span>`;
  if (b === 'View') return `<span class="iw-pad iw-pad--sys"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="10" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="2.2"/><rect x="9" y="10" width="10" height="8" rx="1.5" fill="currentColor"/></svg></span>`;
  if (b === 'Start') return `<span class="iw-pad iw-pad--sys"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7 H19 M5 12 H19 M5 17 H19" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg></span>`;
  if (b === 'DPad') return `<span class="iw-pad iw-pad--sys"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3 H15 V9 H21 V15 H15 V21 H9 V15 H3 V9 H9 Z" fill="currentColor"/></svg></span>`;
  return `<span class="iw-pad iw-pad--bumper">${esc(b)}</span>`;
}
/** Renders "Hold [SHIFT] to swim" → text with keycaps. `{A}` renders a gamepad glyph. */
export function richText(str) {
  return esc(str)
    .replace(/\[([^\]]{1,10})\]/g, (_, k) => (k === 'LMB' ? mouseGlyph('L') : k === 'RMB' ? mouseGlyph('R') : keycap(k)))
    .replace(/\{([A-Za-z]{1,5})\}/g, (_, k) => padGlyph(k));
}

// ------------------------------------------------------------------ logo
/** Big display logo: letters + ink splat + animated drips. size: 'xl' | 'md' | 'sm' */
export function logoMarkup(title = 'INKWAVE', subtitle = 'Turf Riot', size = 'xl') {
  const letters = [...title].map((ch, i) => `<span class="iw-logo__l" style="--i:${i}" data-l="${esc(ch)}">${esc(ch)}</span>`).join('');
  const s = splatShape(300, 110, 88, { seed: 23, arms: 11, drops: 9, armLen: 0.55 });
  // drips hanging off the splat, grow + drop
  const drips = [[190, 150, 1.0], [262, 162, 1.35], [335, 158, 0.8], [402, 150, 1.15]].map(([x, y, k], i) =>
    `<g class="iw-drip" style="--d:${i}"><path class="iw-fa" d="M${x - 7} ${y} L${x + 7} ${y} L${x + 5} ${y + 28 * k} Q${x} ${y + 38 * k} ${x - 5} ${y + 28 * k} Z"/>
     <circle class="iw-fa iw-drip__drop" cx="${x}" cy="${y + 36 * k}" r="5.5"/></g>`).join('');
  return `<div class="iw-logo iw-logo--${size}">
    <svg class="iw-logo__splat" viewBox="0 0 600 240" aria-hidden="true">
      <g transform="translate(300 110) scale(1.7 1.02) translate(-300 -110)">
        <path class="iw-fb" transform="translate(-30 12) rotate(-10 300 110)" d="${s.core}"/>
        <path class="iw-fa" d="${s.core}"/>
      </g>
      ${s.drops.map((d) => `<circle class="iw-fa" cx="${(300 + (d.x - 300) * 1.7).toFixed(1)}" cy="${d.y}" r="${d.r}"/>`).join('')}
      ${drips}
    </svg>
    <div class="iw-logo__word">${letters}</div>
    ${subtitle ? `<div class="iw-logo__sub"><span>${esc(subtitle)}</span></div>` : ''}
  </div>`;
}

// ------------------------------------------------------------------ map thumbnails
/** Stylised top-down illustration of an arena. theme: 'day' | 'sunset' */
export function mapThumb(map, seed = 3) {
  const sunset = map && map.theme === 'sunset';
  const id = 'm' + Math.floor(Math.random() * 1e9).toString(36);
  const sea = sunset ? ['#ffb36b', '#e0607e', '#5b3b9a'] : ['#7fe3f5', '#2fb1e6', '#1e76cf'];
  const deck = sunset ? '#f1cfae' : '#f6efe0';
  const deckEdge = sunset ? '#b98468' : '#c9b99c';
  const block = sunset ? '#e4b894' : '#e9dfcb';
  const blockTop = sunset ? '#f6dcc2' : '#fffaf0';
  const sa = splatShape(0, 0, 1, { seed: seed * 3 + 1, arms: 8, drops: 0 });
  const sb = splatShape(0, 0, 1, { seed: seed * 5 + 2, arms: 9, drops: 0 });
  const splat = (cls, shape, x, y, r, rot) => `<path class="${cls}" transform="translate(${x} ${y}) rotate(${rot}) scale(${r})" d="${shape.core}"/>`;
  const waves = Array.from({ length: 7 }, (_, i) => {
    const y = 14 + i * 29; const x = (i % 2) * 22;
    return `<path d="M${x - 10} ${y} q10 -6 20 0 t20 0 M${x + 250} ${y + 8} q10 -6 20 0 t20 0" stroke="#fff" stroke-opacity="${sunset ? 0.35 : 0.5}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
  }).join('');
  const lights = sunset ? Array.from({ length: 14 }, (_, i) => `<circle cx="${52 + i * 16.5}" cy="${34 + Math.sin(i * 0.9) * 2}" r="2.6" fill="#fff4b0"/><circle cx="${52 + i * 16.5}" cy="${34 + Math.sin(i * 0.9) * 2}" r="6" fill="#ffe27a" opacity=".35"/>`).join('') : '';
  const sun = sunset
    ? `<circle cx="276" cy="18" r="30" fill="#ffe08a" opacity=".55"/><circle cx="276" cy="18" r="17" fill="#fff1b8"/>`
    : `<circle cx="292" cy="10" r="26" fill="#fff" opacity=".35"/>`;
  return `<svg class="iw-mapthumb" viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs><linearGradient id="${id}s" x1="0" y1="0" x2=".3" y2="1"><stop offset="0" stop-color="${sea[0]}"/><stop offset=".55" stop-color="${sea[1]}"/><stop offset="1" stop-color="${sea[2]}"/></linearGradient>
    <clipPath id="${id}c"><rect x="44" y="30" width="232" height="146" rx="16"/></clipPath></defs>
    <rect width="320" height="200" fill="url(#${id}s)"/>${waves}${sun}
    <rect x="48" y="40" width="232" height="146" rx="16" fill="#000" opacity=".18"/>
    <rect x="44" y="30" width="232" height="146" rx="16" fill="${deckEdge}"/>
    <rect x="44" y="30" width="232" height="140" rx="16" fill="${deck}"/>
    <g clip-path="url(#${id}c)">
      <path d="M44 72 H276 M44 128 H276 M102 30 V176 M160 30 V176 M218 30 V176" stroke="${deckEdge}" stroke-opacity=".35" stroke-width="2"/>
      ${splat('iw-fa', sa, 78, 100, 30, 10)}${splat('iw-fa', sb, 118, 62, 17, 40)}${splat('iw-fa', sa, 128, 140, 14, 70)}${splat('iw-fa', sb, 60, 150, 12, 5)}
      ${splat('iw-fb', sb, 244, 102, 29, 25)}${splat('iw-fb', sa, 206, 140, 17, 60)}${splat('iw-fb', sb, 196, 58, 13, 12)}${splat('iw-fb', sa, 262, 54, 11, 80)}
      <g>
        <rect x="140" y="86" width="40" height="30" rx="7" fill="${block}"/><rect x="140" y="82" width="40" height="28" rx="7" fill="${blockTop}"/>
        <rect x="96" y="40" width="30" height="20" rx="6" fill="${block}"/><rect x="96" y="37" width="30" height="18" rx="6" fill="${blockTop}"/>
        <rect x="194" y="150" width="30" height="18" rx="6" fill="${block}"/><rect x="194" y="147" width="30" height="16" rx="6" fill="${blockTop}"/>
        <rect x="100" y="146" width="22" height="22" rx="6" fill="${block}"/><rect x="100" y="143" width="22" height="20" rx="6" fill="${blockTop}"/>
        <rect x="200" y="40" width="22" height="22" rx="6" fill="${block}"/><rect x="200" y="37" width="22" height="20" rx="6" fill="${blockTop}"/>
        <path class="iw-fa" d="M140 99 q8 -4 14 0 v11 h-14 z" opacity=".9"/>
      </g>
    </g>
    <circle cx="58" cy="103" r="11" class="iw-fa" stroke="#fff" stroke-width="4"/>
    <circle cx="262" cy="103" r="11" class="iw-fb" stroke="#fff" stroke-width="4"/>
    ${lights}
  </svg>`;
}

// ------------------------------------------------------------------ how-to illustrations (120 x 80)
export const RULE_ART = {
  turf: `<svg viewBox="0 0 120 80" aria-hidden="true">
    <path d="M10 60 L60 34 L110 60 L60 78 Z" fill="#f4ecdc" stroke="${K}" stroke-width="2.5" stroke-linejoin="round"/>
    <path class="iw-fa" d="${blobPath(46, 58, 16, { seed: 4, sy: 0.55, points: 10, wobble: 0.22 })}"/>
    <path class="iw-fa" d="${blobPath(64, 47, 9, { seed: 9, sy: 0.55, points: 8, wobble: 0.25 })}"/>
    <path class="iw-fb" d="${blobPath(84, 58, 8, { seed: 5, sy: 0.55, points: 8, wobble: 0.25 })}"/>
    <g transform="translate(18 8)"><rect width="84" height="13" rx="6.5" fill="${K}"/><rect x="3" y="3" width="52" height="7" rx="3.5" class="iw-fa"/><rect x="55" y="3" width="26" height="7" rx="3.5" class="iw-fb"/></g>
    <path d="M60 22 L60 30" stroke="#fff" stroke-width="2.5" stroke-dasharray="2 3"/>
  </svg>`,
  swim: `<svg viewBox="0 0 120 80" aria-hidden="true">
    <path class="iw-fa" d="${blobPath(60, 58, 44, { seed: 12, sy: 0.3, points: 12, wobble: 0.12 })}"/>
    <g transform="translate(40 26) scale(.62)" style="color:var(--a)">${SQUID.replace('class="iw-ico iw-squid"', 'x="0" y="0" width="64" height="64"')}</g>
    <path d="M18 42 L32 42 M12 50 L30 50 M20 58 L34 58" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>
    <g transform="translate(88 14)"><rect width="16" height="34" rx="8" fill="#fff" stroke="${K}" stroke-width="2.5"/><rect x="3" y="12" width="10" height="19" rx="5" class="iw-fa"/><path d="M8 -2 L8 8 M4 3 L8 -2 L12 3" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>
  </svg>`,
  enemy: `<svg viewBox="0 0 120 80" aria-hidden="true">
    <path class="iw-fb" d="${blobPath(58, 60, 44, { seed: 31, sy: 0.3, points: 11, wobble: 0.14 })}"/>
    <g transform="translate(36 22) scale(.62)" style="color:var(--a)">${SQUID.replace('class="iw-ico iw-squid"', 'x="0" y="0" width="64" height="64"')}</g>
    <path d="M78 16 q4 6 0 9 q-4 -3 0 -9z" fill="#9fe3ff" stroke="${K}" stroke-width="1.8"/>
    <g transform="translate(86 34)"><rect width="26" height="16" rx="8" fill="${K}"/><text x="13" y="12" text-anchor="middle" font-family="Rubik, sans-serif" font-weight="900" font-size="10" fill="#ff5a6a">HP</text></g>
    <path d="M92 58 L100 58 M96 54 L96 62" stroke="#fff" stroke-width="0" />
    <path d="M18 28 l6 6 m0 -6 l-6 6" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
  </svg>`,
  climb: `<svg viewBox="0 0 120 80" aria-hidden="true">
    <path d="M58 6 L102 6 L102 76 L58 76 Z" fill="#e8dcc6" stroke="${K}" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M58 6 L50 12 L50 80 L58 76 Z" fill="#cdbd9f" stroke="${K}" stroke-width="2.5" stroke-linejoin="round"/>
    <path class="iw-fa" d="M68 76 L68 20 Q68 12 76 12 Q86 12 86 22 L86 76 Z"/>
    <path class="iw-fa" d="M66 34 q-6 2 -5 8 q4 -2 5 -8z M88 50 q6 2 5 8 q-4 -2 -5 -8z"/>
    <g transform="translate(62 30) scale(.4)" style="color:var(--a-light, #fff)">${SQUID.replace('class="iw-ico iw-squid"', 'x="0" y="0" width="64" height="64"')}</g>
    <path d="M36 62 L36 22 M28 30 L36 20 L44 30" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M36 62 L36 22 M28 30 L36 20 L44 30" stroke="${K}" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity=".4"/>
  </svg>`,
};

// ------------------------------------------------------------------ helpers
export const weaponIcon = (idOrKind) => WEAPON_ICONS[idOrKind] || WEAPON_ICONS.shooter;
export const specialIcon = (id) => SPECIAL_ICONS[id] || SPECIAL_ICONS.slam;
