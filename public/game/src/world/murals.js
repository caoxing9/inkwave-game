// Procedural wall murals / signage, drawn into one canvas atlas (4 rows of tileable 2048x256 strips) that the
// level shader samples underneath the ink layer.
import * as THREE from 'three';

const W = 2048, RH = 256, ROWS = 4;
const NAVY = '#27304d', CORAL = '#ec7a6b', TEAL = '#3fa8a2', MUSTARD = '#eec35c', CREAM = '#fbf5e8', SKY = '#7cc6e6';

export async function createMuralTexture() {
  try { await document.fonts.load('120px "Titan One"'); } catch { /* fallback font */ }
  const c = document.createElement('canvas');
  c.width = W; c.height = RH * ROWS;
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, RH * ROWS);
  const font = (px) => `${px}px "Titan One", "Arial Black", sans-serif`;
  drawBanner(g, 0, font);
  drawChevrons(g, RH, font);
  drawShop(g, RH * 2, font);
  drawShipping(g, RH * 3, font);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.wrapS = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

function blob(g, x, y, r, seed, color) {
  g.fillStyle = color;
  g.beginPath();
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const rr = r * (1 + 0.12 * Math.sin(a * 3 + seed) + 0.08 * Math.sin(a * 7 + seed * 2));
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.fill();
}

function squid(g, x, y, s, color, eye = CREAM) {
  // a little squid icon (mantle + fins + tentacles + eyes)
  g.save(); g.translate(x, y); g.scale(s, s);
  g.fillStyle = color;
  g.beginPath(); g.moveTo(0, -60); g.bezierCurveTo(34, -40, 34, 10, 26, 22); g.lineTo(-26, 22); g.bezierCurveTo(-34, 10, -34, -40, 0, -60); g.fill();
  g.beginPath(); g.moveTo(-18, -44); g.lineTo(-46, -30); g.lineTo(-22, -22); g.fill();
  g.beginPath(); g.moveTo(18, -44); g.lineTo(46, -30); g.lineTo(22, -22); g.fill();
  for (let i = 0; i < 5; i++) { g.beginPath(); g.ellipse(-20 + i * 10, 34, 5, 14, (i - 2) * 0.15, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = eye; g.beginPath(); g.ellipse(-10, 2, 7, 9, 0, 0, Math.PI * 2); g.ellipse(10, 2, 7, 9, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = NAVY; g.beginPath(); g.arc(-9, 4, 3.5, 0, Math.PI * 2); g.arc(11, 4, 3.5, 0, Math.PI * 2); g.fill();
  g.restore();
}

// Row 0: big "INKWAVE" banner for the back walls
function drawBanner(g, y0, font) {
  g.save(); g.translate(0, y0);
  // stripe band
  g.fillStyle = NAVY; g.fillRect(0, 150, W, 70);
  g.fillStyle = MUSTARD; g.fillRect(0, 150, W, 10);
  g.fillStyle = CORAL; g.fillRect(0, 214, W, 8);
  for (let k = 0; k < 2; k++) {
    const ox = k * 1024;
    blob(g, ox + 170, 120, 88, 1 + k, TEAL);
    squid(g, ox + 170, 128, 1.25, CREAM, NAVY);
    g.font = font(150);
    g.textBaseline = 'alphabetic';
    g.lineJoin = 'round';
    g.lineWidth = 22; g.strokeStyle = CREAM; g.strokeText('INKWAVE', ox + 300, 186);
    g.fillStyle = NAVY; g.fillText('INKWAVE', ox + 300, 186);
    g.fillStyle = CORAL; g.fillText('INKWAVE', ox + 294, 180);
    g.font = font(34); g.fillStyle = CREAM; g.fillText('TURF RIOT  •  TIDEWATER PLAZA', ox + 320, 205 + 2);
    // splat accents
    blob(g, ox + 960, 70, 26, 5 + k, MUSTARD);
    blob(g, ox + 925, 110, 12, 7 + k, MUSTARD);
  }
  g.restore();
}

// Row 1: bold chevron arrows + hazard stripes for dividing walls
function drawChevrons(g, y0, font) {
  g.save(); g.translate(0, y0);
  g.fillStyle = TEAL; g.fillRect(0, 60, W, 140);
  g.fillStyle = CREAM;
  for (let x = 0; x < W; x += 128) {
    g.beginPath(); g.moveTo(x + 20, 80); g.lineTo(x + 70, 80); g.lineTo(x + 110, 130); g.lineTo(x + 70, 180); g.lineTo(x + 20, 180); g.lineTo(x + 60, 130); g.closePath(); g.fill();
  }
  g.fillStyle = NAVY; g.fillRect(0, 60, W, 8); g.fillRect(0, 192, W, 8);
  g.restore();
}

// Row 2: kiosk shop sign
function drawShop(g, y0, font) {
  g.save(); g.translate(0, y0);
  for (let k = 0; k < 2; k++) {
    const ox = k * 1024;
    g.fillStyle = CORAL; roundRect(g, ox + 40, 30, 944, 150, 40); g.fill();
    g.fillStyle = CREAM; roundRect(g, ox + 54, 44, 916, 122, 30); g.fill();
    g.font = font(92); g.fillStyle = NAVY; g.textBaseline = 'middle';
    g.fillText('TIDE SNACKS', ox + 250, 108);
    // ice-cream squid icon
    g.fillStyle = MUSTARD; g.beginPath(); g.moveTo(ox + 140, 150); g.lineTo(ox + 110, 90); g.lineTo(ox + 170, 90); g.closePath(); g.fill();
    squid(g, ox + 140, 86, 0.7, CORAL, CREAM);
    // awning scallops
    for (let x = 0; x < 1024; x += 64) { g.fillStyle = (x / 64) % 2 ? CREAM : CORAL; g.beginPath(); g.arc(ox + x + 32, 212, 30, 0, Math.PI); g.fill(); }
  }
  g.restore();
}

// Row 3: shipping line logo for containers
function drawShipping(g, y0, font) {
  g.save(); g.translate(0, y0);
  for (let k = 0; k < 2; k++) {
    const ox = k * 1024;
    g.font = font(110); g.textBaseline = 'middle';
    g.fillStyle = 'rgba(251,245,232,0.92)';
    g.fillText('KRAKEN', ox + 140, 110);
    g.font = font(44); g.fillText('LINES  ~  SEA FREIGHT', ox + 150, 190);
    // tentacle wave
    g.strokeStyle = 'rgba(251,245,232,0.92)'; g.lineWidth = 16; g.lineCap = 'round';
    g.beginPath(); g.moveTo(ox + 40, 140); g.bezierCurveTo(ox + 70, 60, ox + 120, 200, ox + 110, 70); g.stroke();
    g.beginPath(); g.arc(ox + 105, 64, 12, 0, Math.PI * 2); g.stroke();
  }
  g.restore();
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
