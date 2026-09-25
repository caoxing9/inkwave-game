// Showcase stage: a studio-lit overlay scene drawn on top of the live arena for the loadout screen (one squidkid on an
// ink-dipped pedestal) and the results screen (your team on a tiered ink podium with confetti + ink bursts, or a cool
// drizzle on defeat).
//
// Rendering: the stage is drawn into an MSAA HDR target and composited over the finished frame with three's own tone
// mapping + sRGB output (identical maths to drawing straight to the canvas, but antialiased). The target is the post
// composer's ping-pong buffer when it is compatible (those buffers are dead once composer.render() has output the frame,
// so borrowing costs no memory), else a private one. Framing is a full-screen projection with a lens shift
// (camera.setViewOffset) that puts the subject inside the UI's free area — measured from the live DOM, with stylesheet
// formula fallbacks — so nothing is ever cut by a viewport edge. Every effect is pooled/instanced; nothing allocates
// per frame. render() leaves the renderer exactly as it found it (target, clear colour/alpha, autoClear; viewport and
// scissor are untouched).
//
// API (driven by main.js): new Showcase(renderer, CharacterClass); showLoadout(weapon, color); showResults(team, won,
// color, styles); hide(); update(dt); render(); .mode ('loadout' | 'results' | null). Additive: dispose().
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { G, damp, lerp, rng } from '../core/ctx.js';

// ================================================================================================ helpers
const TAU = Math.PI * 2;
const c01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = c01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const eOut3 = (t) => { t = 1 - c01(t); return 1 - t * t * t; };
const eInOut = (t) => { t = c01(t); return t * t * t * (t * (t * 6 - 15) + 10); };
const backOut = (t, k = 1.70158) => { t = c01(t) - 1; return 1 + t * t * ((k + 1) * t + k); };
const smin = (a, b, k) => { const h = c01(0.5 + 0.5 * (b - a) / k); return lerp(b, a, h) - k * h * (1 - h); };
// damped oscillation after an impulse at t = 0 (0 → swings → settles to 0)
const wobble = (t, f = 17, z = 7) => (t < 0 ? 0 : Math.exp(-t * z) * Math.sin(t * f));
// fast attack / slower release pulse, peak ≈ 0.75
const punch = (t, a = 22, r = 4.2) => (t < 0 ? 0 : (1 - Math.exp(-t * a)) * Math.exp(-t * r));
const UPV = new THREE.Vector3(0, 1, 0);

// Loadout pedestal and results podium dimensions (metres; y = 0 is the pedestal/drum top before the ink coat).
const PED = { R: 0.64, bevel: 0.09, groove: { y: -0.235, h: 0.021, d: 0.022 }, flange: { y: -0.5, out: 0.075, b: 0.04 }, bottom: -3.0, ink: 0.014 };
const DRUM = { bevel: 0.09, groove: { y: -0.2, h: 0.019, d: 0.02 }, flange: { y: -0.44, out: 0.065, b: 0.035 }, bottom: -3.2, ink: 0.013 };
// results slots, styles order (0 = local player on the centre top tier)
const SLOTS = [
  { x: 0, z: 0, R: 0.7, top: 0.72, yaw: 0 },
  { x: -1.34, z: -0.14, R: 0.63, top: 0.46, yaw: 0.2 },
  { x: 1.34, z: -0.14, R: 0.63, top: 0.46, yaw: -0.2 },
  { x: 2.55, z: -0.36, R: 0.56, top: 0.22, yaw: -0.34 },
];
const CHAR_H = 1.62; // squidkid height incl. hair
const LOAD_FOCUS_Y = 0.76; // camera aims here on the loadout character (feet at 0)

// ================================================================================================ geometry
// Lathe outline strips of [r, y] → rows {r, y, nr, ny}: normals smooth inside a strip, hard between strips.
function stripRows(strips) {
  const rows = [];
  for (const st of strips) {
    for (let i = 0; i < st.length; i++) {
      const a = st[Math.max(0, i - 1)], b = st[Math.min(st.length - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1];
      const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      rows.push({ r: st[i][0], y: st[i][1], nr: -ty, ny: tx });
    }
  }
  return rows;
}
function arcPts(out, cx, cy, rad, a0, a1, n, skipFirst) {
  for (let i = skipFirst ? 1 : 0; i <= n; i++) { const a = a0 + (a1 - a0) * (i / n); out.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]); }
}

// Chunky drum outline: flat top → big rounded bevel → side with a rounded light groove → hard step out onto a bevelled
// flange → long skirt (runs off-screen / into the UI scrim, so the stage never shows a floating bottom edge).
function drumOutline(R, P) {
  const b = P.bevel, gv = P.groove, fl = P.flange;
  const top = [];
  for (let i = 0; i < 8; i++) top.push([(R - b) * (i / 8), 0]);
  arcPts(top, R - b, -b, b, Math.PI / 2, 0, 18);
  top.push([R, gv.y + gv.h + 0.022]);
  for (let i = 0; i <= 12; i++) { const f = (i / 12) * Math.PI; top.push([R - gv.d * Math.sin(f), gv.y + gv.h * Math.cos(f)]); }
  top.push([R, gv.y - gv.h - 0.022]);
  top.push([R, fl.y]);
  const ledge = [[R, fl.y], [R + fl.out - fl.b, fl.y]];
  arcPts(ledge, R + fl.out - fl.b, fl.y - fl.b, fl.b, Math.PI / 2, 0, 10, true);
  ledge.push([R + fl.out, fl.y - 0.25], [R + fl.out, P.bottom * 0.5], [R + fl.out, P.bottom]);
  return stripRows([top, ledge]);
}

// Lathe mesh with a vertical shade gradient (vertex colour) and a glow-spill attribute around the groove light.
function latheGeometry(rows, segs, groove) {
  const nR = rows.length, nV = nR * segs;
  const pos = new Float32Array(nV * 3), nor = new Float32Array(nV * 3), col = new Float32Array(nV * 3), glw = new Float32Array(nV);
  for (let i = 0; i < nR; i++) {
    const w = rows[i];
    // top stays full value, the skirt sinks into a deep shade; a touch lighter just under the bevel (bounce from the ink)
    const shade = lerp(0.2, 1, sstep(-1.7, -0.06, w.y)) * (1 + 0.1 * Math.exp(-(((w.y + 0.14) / 0.08) ** 2)));
    const gd = (w.y - groove.y) / 0.055;
    const glow = 0.26 * Math.exp(-gd * gd) + 0.05 * Math.exp(-(((w.y - groove.y) / 0.2) ** 2));
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * TAU, s = Math.sin(a), c = Math.cos(a), k = i * segs + j;
      pos[k * 3] = w.r * s; pos[k * 3 + 1] = w.y; pos[k * 3 + 2] = w.r * c;
      nor[k * 3] = w.nr * s; nor[k * 3 + 1] = w.ny; nor[k * 3 + 2] = w.nr * c;
      col[k * 3] = col[k * 3 + 1] = col[k * 3 + 2] = shade;
      glw[k] = glow;
    }
  }
  const idx = [];
  for (let i = 0; i < nR - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * segs + j, b = i * segs + ((j + 1) % segs), c = (i + 1) * segs + j, d = (i + 1) * segs + ((j + 1) % segs);
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aGlow', new THREE.BufferAttribute(glw, 1));
  g.setIndex(idx);
  return g;
}

// Drum body + the light tube sitting in its groove, merged (one draw call: the tube is black diffuse + full glow).
function drumGeometry(R, P, segs) {
  const body = latheGeometry(drumOutline(R, P), segs, P.groove);
  const tube = P.groove.h * 0.8;
  const ring = new THREE.TorusGeometry(R - P.groove.d + tube, tube, 10, segs).rotateX(Math.PI / 2);
  ring.translate(0, P.groove.y, 0);
  ring.deleteAttribute('uv');
  const n = ring.attributes.position.count;
  ring.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.03), 3));
  ring.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
  const g = mergeGeometries([body, ring]);
  body.dispose(); ring.dispose();
  return g;
}

// Ink coat profile (no groove/flange: drips bridge over the groove) with arclength s.
function inkProfile(R, b, depth) {
  const st = [];
  for (let i = 0; i < 12; i++) st.push([(R - b) * (i / 12), 0]);
  arcPts(st, R - b, -b, b, Math.PI / 2, 0, 22);
  const nRim = st.length - 1;
  for (let i = 1; i <= 36; i++) st.push([R, -b - depth * (i / 36)]);
  const rows = stripRows([st]);
  rows[0].s = 0;
  for (let i = 1; i < rows.length; i++) rows[i].s = rows[i - 1].s + Math.hypot(rows[i].r - rows[i - 1].r, rows[i].y - rows[i - 1].y);
  return { rows, sRim: rows[nRim].s, sTopEnd: R - b, sMax: rows[rows.length - 1].s, R };
}
function profAt(P, s, o) {
  const rows = P.rows;
  let lo = 0, hi = rows.length - 1;
  if (s <= 0) { lo = 0; hi = 1; s = 0; } else if (s >= rows[hi].s) { lo = hi - 1; s = rows[hi].s; }
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rows[m].s <= s) lo = m; else hi = m; }
  const a = rows[lo], b = rows[hi], f = c01((s - a.s) / (b.s - a.s || 1));
  o.r = lerp(a.r, b.r, f); o.y = lerp(a.y, b.y, f);
  const nr = lerp(a.nr, b.nr, f), ny = lerp(a.ny, b.ny, f), l = Math.hypot(nr, ny) || 1;
  o.nr = nr / l; o.ny = ny / l;
  return o;
}

// Glossy ink coat: covers the top, rolls over the bevel and runs down the side as drips with round, beaded tips.
// Built on the (u = arclength around, s = arclength down the profile) plane: the coat region is the smooth union of a
// wavy lip and one capsule per drip (signed distance), each column of the grid ends exactly on that outline, and the
// thickness rolls off to zero with a quarter-round profile near the outline (so every edge reads as a liquid bead).
function inkCoatGeometry(R, b, drips, o) {
  const P = inkProfile(R, b, o.depth || 0.45);
  const rnd = rng(o.seed || 1);
  const k1 = rnd() * TAU, k2 = rnd() * TAU, k3 = rnd() * TAU, k4 = rnd() * TAU;
  const circ = TAU * R;
  const T0 = o.T0, Dt = o.Dt || 0.016;
  for (const d of drips) d.u = d.th * R;
  const lip = (th) => Math.max(0.01, (o.lip || 0.03) + 0.011 * Math.sin(3 * th + k1) + 0.007 * Math.sin(7 * th + k2) + 0.004 * Math.sin(13 * th + k3));
  const sdf = (u, s) => {
    const th = u / R;
    let d = s - (P.sRim + lip(th));
    for (let i = 0; i < drips.length; i++) {
      const D = drips[i];
      let du = u - D.u; du -= Math.round(du / circ) * circ;
      if (Math.abs(du) > D.w + 0.06) continue;
      const hw = D.w * 0.5, s0 = P.sRim - 0.04, s1 = P.sRim + D.L - hw;
      const cs = s < s0 ? s0 : s > s1 ? s1 : s;
      d = smin(d, Math.hypot(du, s - cs) - hw, 0.018);
    }
    return d;
  };
  // columns: coarse all round, fine across every drip
  const th = [];
  const nC = Math.ceil(circ / o.du);
  for (let j = 0; j < nC; j++) th.push((j / nC) * TAU);
  for (const D of drips) {
    const half = (D.w * 0.5 + 0.04) / R, n = Math.ceil((2 * half * R) / o.duF);
    for (let k = 0; k <= n; k++) { let a = D.th - half + 2 * half * (k / n); a = ((a % TAU) + TAU) % TAU; th.push(a); }
  }
  th.sort((a, c) => a - c);
  const cols = [th[0]];
  const minGap = (o.duF * 0.45) / R;
  for (let i = 1; i < th.length; i++) if (th[i] - cols[cols.length - 1] > minGap) cols.push(th[i]);
  if (TAU - cols[cols.length - 1] + cols[0] < minGap) cols.pop();
  const NC = cols.length;
  // per-column outline depth (bisection on the sdf along s)
  const sEnd = new Float32Array(NC);
  for (let j = 0; j < NC; j++) {
    const u = cols[j] * R;
    let lo = P.sRim - 0.035, hi = Math.min(P.sMax, P.sRim + 0.5);
    for (let it = 0; it < 26; it++) { const m = (lo + hi) * 0.5; if (sdf(u, m) < 0) lo = m; else hi = m; }
    sEnd[j] = lo;
  }
  // rows: flat top, bevel (dense), then drip part scaled per column and packed toward the tip
  const rowsA = [];
  const nTop = 9, nBev = 14;
  for (let i = 0; i < nTop; i++) rowsA.push(P.sTopEnd * (i / nTop));
  for (let i = 0; i < nBev; i++) rowsA.push(P.sTopEnd + (P.sRim - P.sTopEnd) * (i / nBev));
  const NB = o.NB || 24, NA = rowsA.length, NRow = NA + NB + 1;
  const pos = new Float32Array(NC * NRow * 3);
  const pr = { r: 0, y: 0, nr: 0, ny: 0 };
  for (let j = 0; j < NC; j++) {
    const a = cols[j], sa = Math.sin(a), ca = Math.cos(a), u = a * R;
    for (let i = 0; i < NRow; i++) {
      let s;
      if (i < NA) s = rowsA[i];
      else { const f = (i - NA) / NB; s = P.sRim + (sEnd[j] - P.sRim) * (1 - Math.pow(1 - f, 1.55)); }
      const sd = sdf(u, s);
      const x = c01(-sd / Dt);
      let tk = T0 * (1 + 0.5 * c01((s - P.sRim - 0.03) / 0.2));
      for (let q = 0; q < drips.length; q++) {
        const D = drips[q];
        let du = u - D.u; du -= Math.round(du / circ) * circ;
        if (Math.abs(du) > D.w) continue;
        const hw = D.w * 0.5, sc = P.sRim + D.L - hw * 1.1;
        const e = ((s - sc) / (hw * 0.95)) ** 2 + (du / (hw * 0.8)) ** 2;
        tk += T0 * 0.6 * Math.exp(-e) * c01((D.L - 0.05) / 0.08);
      }
      tk *= 1 + 0.08 * Math.sin(a * 5 + s * 11 + k4) * Math.sin(a * 3 - s * 7 + k2);
      const t = tk * Math.sqrt(1 - (1 - x) * (1 - x)) + 0.0012;
      profAt(P, s, pr);
      const k = (j * NRow + i) * 3;
      const rr = pr.r + pr.nr * t;
      pos[k] = rr * sa; pos[k + 1] = pr.y + pr.ny * t; pos[k + 2] = rr * ca;
    }
  }
  const idx = [];
  for (let j = 0; j < NC; j++) {
    const jn = (j + 1) % NC;
    for (let i = 0; i < NRow - 1; i++) {
      const a = j * NRow + i, c = jn * NRow + i, b2 = j * NRow + i + 1, d = jn * NRow + i + 1;
      idx.push(a, b2, c, c, b2, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Drip layout: golden-angle spread with jitter; `front` limits them to the camera-facing half.
function makeDrips(seed, n, o) {
  const rnd = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    let th;
    if (o.front) th = (i / (n - 1) - 0.5) * o.front * 2 + (rnd() - 0.5) * (o.front / n);
    else th = i * 2.39996 + (rnd() - 0.5) * 0.25;
    const long = rnd() < o.longChance;
    out.push({ th: ((th % TAU) + TAU) % TAU, w: lerp(o.w0, o.w1, rnd()), L: long ? lerp(o.L1 * 0.8, o.L1, rnd()) : lerp(o.L0, o.L1 * 0.6, rnd()) });
  }
  return out;
}

// Flat ink splat decal (domed centre, wavy rim, satellite droplets). Radius ≈ 1, dome height ≈ 0.16.
function splatGeometry() {
  const rnd = rng(77);
  const parts = [];
  const dome = (cx, cz, R, amp, N, rings, h) => {
    const k = [rnd() * TAU, rnd() * TAU, rnd() * TAU];
    const rad = (a) => R * (1 + amp * (0.55 * Math.sin(5 * a + k[0]) + 0.3 * Math.sin(9 * a + k[1]) + 0.15 * Math.sin(14 * a + k[2])));
    const pos = [cx, h, cz];
    for (let r = 1; r <= rings; r++) {
      const f = r / rings;
      for (let i = 0; i < N; i++) { const a = (i / N) * TAU, rr = rad(a) * f; pos.push(cx + Math.sin(a) * rr, h * Math.pow(Math.max(0, 1 - f * f), 0.7) + 0.004, cz + Math.cos(a) * rr); }
    }
    const idx = [];
    for (let i = 0; i < N; i++) idx.push(0, 1 + i, 1 + ((i + 1) % N));
    for (let r = 1; r < rings; r++) {
      const o0 = 1 + (r - 1) * N, o1 = 1 + r * N;
      for (let i = 0; i < N; i++) { const i1 = (i + 1) % N; idx.push(o0 + i, o1 + i, o0 + i1, o0 + i1, o1 + i, o1 + i1); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    parts.push(g);
  };
  dome(0, 0, 1, 0.2, 44, 4, 0.16);
  for (let i = 0; i < 5; i++) { const a = rnd() * TAU, d = 1.25 + rnd() * 0.45; dome(Math.sin(a) * d, Math.cos(a) * d, 0.1 + rnd() * 0.12, 0.08, 12, 2, 0.06); }
  const g = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return g;
}

// Paper strip with a slight curl (reads as paper when it tumbles through the light).
function confettiGeometry() {
  const g = new THREE.PlaneGeometry(1, 1, 1, 4);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const y = p.getY(i); p.setZ(i, 0.22 * y * y - 0.05); }
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
}

// ================================================================================================ effects (pooled)
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3(), _d = new THREE.Vector3();
const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);
const Q_FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

// Ink blobs (splash droplets, arcing ink bombs, drizzle, floating bubbles) + landing splats + ripple rings.
class InkFX {
  constructor(root, mat, rand) {
    this.rand = rand;
    const N = (this.N = 150);
    this.mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), mat, N);
    this.P = new Float32Array(N * 3); this.V = new Float32Array(N * 3);
    this.R = new Float32Array(N); this.A = new Float32Array(N); this.L = new Float32Array(N); this.S = new Float32Array(N);
    this.K = new Uint8Array(N); // 0 free · 1 droplet · 2 bomb · 3 bubble · 4 drizzle
    const SN = (this.SN = 56);
    this.splats = new THREE.InstancedMesh(splatGeometry(), mat, SN);
    this.SP = new Float32Array(SN * 3); this.SS = new Float32Array(SN); this.SY = new Float32Array(SN);
    this.SA = new Float32Array(SN).fill(1e9); this.SL = new Float32Array(SN); this.sNext = 0;
    const RN = (this.RN = 10);
    this.rings = new THREE.InstancedMesh(new THREE.TorusGeometry(1, 0.034, 8, 96).rotateX(Math.PI / 2), mat, RN);
    this.RP = new Float32Array(RN * 3); this.R0 = new Float32Array(RN); this.R1 = new Float32Array(RN);
    this.RA = new Float32Array(RN).fill(1e9); this.RL = new Float32Array(RN); this.rNext = 0;
    for (const m of [this.mesh, this.splats, this.rings]) {
      m.frustumCulled = false; m.count = 0;
      for (let i = 0; i < m.instanceMatrix.count; i++) m.setMatrixAt(i, ZERO_M);
      root.add(m);
    }
    this.mesh.castShadow = true;
    this.splats.receiveShadow = true;
    this.mesh.renderOrder = 1;
  }
  _slot() { for (let i = 0; i < this.N; i++) if (!this.K[i]) return i; return -1; }
  drop(x, y, z, vx, vy, vz, r, kind = 1, life = 6) {
    const i = this._slot(); if (i < 0) return -1;
    const i3 = i * 3;
    this.P[i3] = x; this.P[i3 + 1] = y; this.P[i3 + 2] = z;
    this.V[i3] = vx; this.V[i3 + 1] = vy; this.V[i3 + 2] = vz;
    this.R[i] = r; this.A[i] = 0; this.L[i] = life; this.S[i] = this.rand() * TAU; this.K[i] = kind;
    return i;
  }
  bubble(x, y, z, r, rise, life) {
    const i = this.drop(x, y, z, x, rise, z, r, 3, life);
    return i;
  }
  splat(x, y, z, size, life) {
    const j = this.sNext; this.sNext = (j + 1) % this.SN;
    this.SP[j * 3] = x; this.SP[j * 3 + 1] = y + 0.0008 + (j % 7) * 0.00035; this.SP[j * 3 + 2] = z;
    this.SS[j] = size; this.SY[j] = this.rand() * TAU; this.SA[j] = 0; this.SL[j] = life;
  }
  ripple(x, y, z, r0, r1, life) {
    const j = this.rNext; this.rNext = (j + 1) % this.RN;
    this.RP[j * 3] = x; this.RP[j * 3 + 1] = y + 0.002; this.RP[j * 3 + 2] = z;
    this.R0[j] = r0; this.R1[j] = r1; this.RA[j] = 0; this.RL[j] = life;
  }
  // crown splash around a point on a deck (e.g. feet landing / a squidkid bursting out of the ink)
  crown(x, y, z, power, n, ring = 0.2) {
    const rnd = this.rand;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rnd() * 0.45;
      const rr = ring * (0.8 + rnd() * 0.6), out = (0.5 + rnd() * 0.9) * power, up = (1.7 + rnd() * 1.7) * power;
      this.drop(x + Math.sin(a) * rr, y + 0.01, z + Math.cos(a) * rr, Math.sin(a) * out, up, Math.cos(a) * out, 0.011 + rnd() * rnd() * 0.026, 1, 4);
    }
    this.ripple(x, y, z, ring * 0.8, ring + 0.55 * power, 0.6);
  }
  clear() {
    this.K.fill(0); this.SA.fill(1e9); this.RA.fill(1e9);
    for (const m of [this.mesh, this.splats, this.rings]) { for (let i = 0; i < m.instanceMatrix.count; i++) m.setMatrixAt(i, ZERO_M); m.count = 0; m.instanceMatrix.needsUpdate = true; }
  }
  _land(i, k, x, y, z) {
    const r = this.R[i], rnd = this.rand;
    if (k === 1) this.splat(x, y, z, r * 2.5, 1.4 + rnd() * 0.9);
    else if (k === 4) { this.splat(x, y, z, r * 2.1, 1.1 + rnd() * 0.5); this.ripple(x, y, z, 0.02, 0.2 + r * 3, 0.5); }
    else if (k === 2) {
      this.splat(x, y, z, r * 3.3, 3.4 + rnd());
      this.ripple(x, y, z, r, 0.55 + r * 4, 0.75);
      const n = 9;
      for (let q = 0; q < n; q++) {
        const a = (q / n) * TAU + rnd() * 0.6, sp = 0.9 + rnd() * 1.3;
        this.drop(x + Math.sin(a) * r, y + 0.02, z + Math.cos(a) * r, Math.sin(a) * sp, 1.3 + rnd() * 1.8, Math.cos(a) * sp, 0.012 + rnd() * 0.02, 1, 3);
      }
    }
  }
  update(dt, decks) {
    const P = this.P, V = this.V;
    let top = -1;
    for (let i = 0; i < this.N; i++) {
      const k = this.K[i];
      if (!k) continue;
      const i3 = i * 3;
      const age = (this.A[i] += dt);
      let x = P[i3], y = P[i3 + 1], z = P[i3 + 2];
      const r = this.R[i];
      if (k === 3) {
        // bubble: rises with a lazy wobble, swells and pops
        const L = this.L[i];
        if (age >= L) { this.K[i] = 0; this.mesh.setMatrixAt(i, ZERO_M); continue; }
        const S = this.S[i];
        y += V[i3 + 1] * dt * (0.75 + 0.25 * Math.sin(age * 1.9 + S));
        x = V[i3] + 0.035 * Math.sin(age * 1.7 + S) * Math.min(1, age);
        z = V[i3 + 2] + 0.035 * Math.cos(age * 1.3 + S * 1.3) * Math.min(1, age);
        const grow = eOut3(age / 0.5), pop = age > L - 0.14 ? 1 + 0.35 * ((age - (L - 0.14)) / 0.14) : 1;
        const vis = age > L - 0.03 ? 0 : 1;
        const wob = 1 + 0.12 * Math.sin(age * 8 + S);
        const sc = r * grow * pop * vis;
        _q.identity();
        _s.set(sc / Math.sqrt(wob), sc * wob, sc / Math.sqrt(wob));
      } else {
        const g = k === 2 ? 9.5 : k === 4 ? 9.8 : 10.5;
        V[i3 + 1] -= g * dt;
        if (k === 4 && V[i3 + 1] < -5.2) V[i3 + 1] = -5.2;
        const py = y;
        x += V[i3] * dt; y += V[i3 + 1] * dt; z += V[i3 + 2] * dt;
        let landed = false;
        for (let d = 0; d < decks.length; d++) {
          const D = decks[d];
          if (py >= D.y && y < D.y) {
            const dx = x - D.x, dz = z - D.z;
            if (dx * dx + dz * dz < D.r * D.r) { landed = true; this.K[i] = 0; this.mesh.setMatrixAt(i, ZERO_M); this._land(i, k, x, D.y, z); break; }
          }
        }
        if (landed) continue;
        if (y < -3.5 || age > this.L[i]) { this.K[i] = 0; this.mesh.setMatrixAt(i, ZERO_M); continue; }
        const vx = V[i3], vy = V[i3 + 1], vz = V[i3 + 2], sp = Math.hypot(vx, vy, vz);
        const st = 1 + Math.min(sp * 0.055, 0.9);
        if (sp > 0.05) _q.setFromUnitVectors(UPV, _d.set(vx / sp, vy / sp, vz / sp)); else _q.identity();
        const grow = k === 2 ? eOut3(age / 0.12) : 1;
        _s.set((r * grow) / Math.sqrt(st), r * grow * st, (r * grow) / Math.sqrt(st));
      }
      P[i3] = x; P[i3 + 1] = y; P[i3 + 2] = z;
      _m4.compose(_v.set(x, y, z), _q, _s);
      this.mesh.setMatrixAt(i, _m4);
      top = i;
    }
    this.mesh.count = top + 1;
    this.mesh.instanceMatrix.needsUpdate = true;
    // splats: pop in with overshoot, sink back into the surface
    let sTop = -1;
    for (let j = 0; j < this.SN; j++) {
      const L = this.SL[j];
      if (this.SA[j] >= L) continue;
      const a = (this.SA[j] += dt);
      if (a >= L) { this.splats.setMatrixAt(j, ZERO_M); continue; }
      const grow = backOut(a / 0.16, 2.2), shrink = 1 - eInOut((a - L * 0.5) / (L * 0.5));
      const s = this.SS[j] * grow * Math.max(0.001, shrink);
      _q.setFromAxisAngle(UPV, this.SY[j]);
      _s.set(s, s * (0.35 + 0.65 * shrink), s);
      _m4.compose(_v.set(this.SP[j * 3], this.SP[j * 3 + 1], this.SP[j * 3 + 2]), _q, _s);
      this.splats.setMatrixAt(j, _m4);
      sTop = j;
    }
    // ripple rings: expand and flatten out
    let rTop = -1;
    for (let j = 0; j < this.RN; j++) {
      const L = this.RL[j];
      if (this.RA[j] >= L) continue;
      const a = (this.RA[j] += dt);
      if (a >= L) { this.rings.setMatrixAt(j, ZERO_M); continue; }
      const f = a / L, rad = lerp(this.R0[j], this.R1[j], eOut3(f)), h = (1 - f) * (1 - f);
      _q.identity();
      _s.set(rad, Math.max(0.001, rad * 0.55 * h), rad);
      _m4.compose(_v.set(this.RP[j * 3], this.RP[j * 3 + 1], this.RP[j * 3 + 2]), _q, _s);
      this.rings.setMatrixAt(j, _m4);
      rTop = j;
    }
    // keep counts covering every live slot (dead slots in between hold zero matrices)
    this.splats.count = this._span(this.SA, this.SL, this.SN, sTop);
    this.rings.count = this._span(this.RA, this.RL, this.RN, rTop);
    this.splats.instanceMatrix.needsUpdate = true;
    this.rings.instanceMatrix.needsUpdate = true;
  }
  _span(A, L, n, top) { for (let j = n - 1; j > top; j--) if (A[j] < L[j]) return j + 1; return top + 1; }
}

// Paper + foil confetti: cannon bursts and a falling rain; tumbles with flutter and settles on the podium tops.
class Confetti {
  constructor(scene, rand) {
    this.rand = rand;
    const geo = confettiGeometry();
    this.NP = 280; this.NF = 72;
    const N = (this.N = this.NP + this.NF);
    this.paper = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, roughness: 0.62, metalness: 0 }), this.NP);
    this.foil = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, roughness: 0.26, metalness: 0.9 }), this.NF);
    const white = new THREE.Color(1, 1, 1);
    for (const m of [this.paper, this.foil]) {
      m.frustumCulled = false; m.count = 0; m.renderOrder = 2;
      for (let i = 0; i < m.instanceMatrix.count; i++) { m.setMatrixAt(i, ZERO_M); m.setColorAt(i, white); }
      scene.add(m);
    }
    this.P = new Float32Array(N * 3); this.V = new Float32Array(N * 3); this.AX = new Float32Array(N * 3);
    this.ANG = new Float32Array(N); this.SPIN = new Float32Array(N); this.PH = new Float32Array(N); this.FQ = new Float32Array(N);
    this.SW = new Float32Array(N); this.SH = new Float32Array(N); this.AGE = new Float32Array(N); this.LIFE = new Float32Array(N);
    this.YAW = new Float32Array(N); this.REST = new Float32Array(N);
    this.ST = new Uint8Array(N); // 0 free · 1 flying · 2 settled
    this.acc = 0;
    this.palette = [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()];
    this.foils = [new THREE.Color(1.0, 0.72, 0.28), new THREE.Color(0.86, 0.88, 0.92), new THREE.Color()];
  }
  setColor(team) {
    const p = this.palette;
    p[0].copy(team); p[1].setRGB(0.92, 0.92, 0.95); p[2].setRGB(1.0, 0.66, 0.08); p[3].copy(team).lerp(p[1], 0.55);
    this.foils[2].copy(team).lerp(this.foils[1], 0.25);
  }
  _slot(foil) {
    const a = foil ? this.NP : 0, b = foil ? this.N : this.NP;
    for (let i = a; i < b; i++) if (!this.ST[i]) return i;
    return -1;
  }
  spawn(x, y, z, vx, vy, vz, foil) {
    const i = this._slot(foil); if (i < 0) return;
    const rnd = this.rand, i3 = i * 3;
    this.P[i3] = x; this.P[i3 + 1] = y; this.P[i3 + 2] = z;
    this.V[i3] = vx; this.V[i3 + 1] = vy; this.V[i3 + 2] = vz;
    _d.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    this.AX[i3] = _d.x; this.AX[i3 + 1] = _d.y; this.AX[i3 + 2] = _d.z;
    this.ANG[i] = rnd() * TAU; this.SPIN[i] = (5 + rnd() * 9) * (rnd() < 0.5 ? -1 : 1);
    this.PH[i] = rnd() * TAU; this.FQ[i] = 2.2 + rnd() * 2.6;
    const s = 0.8 + rnd() * 0.45;
    this.SW[i] = (foil ? 0.034 : 0.03) * s; this.SH[i] = (foil ? 0.034 : 0.064) * s;
    this.AGE[i] = 0; this.LIFE[i] = 11 + rnd() * 4; this.ST[i] = 1;
    this.YAW[i] = rnd() * TAU; this.REST[i] = 4 + rnd() * 5;
    if (foil) { this.foil.setColorAt(i - this.NP, this.foils[(rnd() * 3) | 0]); this.foil.instanceColor.needsUpdate = true; }
    else {
      const u = rnd();
      this.paper.setColorAt(i, this.palette[u < 0.46 ? 0 : u < 0.72 ? 1 : u < 0.86 ? 2 : 3]);
      this.paper.instanceColor.needsUpdate = true;
    }
  }
  burst(x, y, z, dx, dy, dz, n, speed, spread) {
    const rnd = this.rand;
    for (let i = 0; i < n; i++) {
      _v.set(dx + (rnd() - 0.5) * spread, dy + (rnd() - 0.5) * spread * 0.6, dz + (rnd() - 0.5) * spread).normalize();
      const sp = speed * (0.55 + rnd() * 0.6);
      this.spawn(x + (rnd() - 0.5) * 0.3, y + (rnd() - 0.5) * 0.3, z + (rnd() - 0.5) * 0.3, _v.x * sp, _v.y * sp, _v.z * sp, rnd() < 0.2);
    }
  }
  rain(dt, rate, x0, x1, z0, z1, y) {
    this.acc += dt * rate;
    const rnd = this.rand;
    while (this.acc >= 1) {
      this.acc -= 1;
      this.spawn(lerp(x0, x1, rnd()), y + rnd() * 0.6, lerp(z0, z1, rnd()), (rnd() - 0.5) * 0.4, -0.3 - rnd() * 0.5, (rnd() - 0.5) * 0.3, rnd() < 0.18);
    }
  }
  clear() {
    this.ST.fill(0); this.acc = 0;
    for (const m of [this.paper, this.foil]) { for (let i = 0; i < m.instanceMatrix.count; i++) m.setMatrixAt(i, ZERO_M); m.count = 0; m.instanceMatrix.needsUpdate = true; }
  }
  update(dt, decks) {
    const P = this.P, V = this.V;
    let topP = -1, topF = -1;
    const kd = Math.exp(-2.9 * dt);
    for (let i = 0; i < this.N; i++) {
      const st = this.ST[i];
      if (!st) continue;
      const foil = i >= this.NP, mesh = foil ? this.foil : this.paper, mi = foil ? i - this.NP : i;
      const i3 = i * 3;
      const age = (this.AGE[i] += dt);
      let x = P[i3], y = P[i3 + 1], z = P[i3 + 2];
      let life = 1;
      if (st === 1) {
        V[i3 + 1] -= 4.1 * dt;
        V[i3] *= kd; V[i3 + 1] *= kd; V[i3 + 2] *= kd;
        const fl = Math.min(1, age * 1.5);
        const py = y;
        x += (V[i3] + fl * 0.5 * Math.sin(age * this.FQ[i] + this.PH[i])) * dt;
        y += V[i3 + 1] * dt;
        z += (V[i3 + 2] + fl * 0.3 * Math.cos(age * this.FQ[i] * 0.73 + this.PH[i])) * dt;
        this.ANG[i] += this.SPIN[i] * dt;
        for (let d = 0; d < decks.length; d++) {
          const D = decks[d];
          if (py >= D.y && y < D.y) {
            const dx = x - D.x, dz = z - D.z;
            if (dx * dx + dz * dz < D.r * D.r) { this.ST[i] = 2; y = D.y + 0.003 + (i % 5) * 0.0006; this.AGE[i] = 0; break; }
          }
        }
        if (y < -3.2 || age > this.LIFE[i]) { this.ST[i] = 0; mesh.setMatrixAt(mi, ZERO_M); continue; }
        _q.setFromAxisAngle(_d.set(this.AX[i3], this.AX[i3 + 1], this.AX[i3 + 2]), this.ANG[i]);
      } else {
        const rest = this.REST[i];
        if (age > rest) { this.ST[i] = 0; mesh.setMatrixAt(mi, ZERO_M); continue; }
        life = 1 - sstep(rest - 0.6, rest, age);
        _q.setFromAxisAngle(UPV, this.YAW[i]).multiply(Q_FLAT);
      }
      P[i3] = x; P[i3 + 1] = y; P[i3 + 2] = z;
      _s.set(this.SW[i] * life, this.SH[i] * life, this.SW[i] * life);
      _m4.compose(_v.set(x, y, z), _q, _s);
      mesh.setMatrixAt(mi, _m4);
      if (foil) topF = mi; else topP = mi;
    }
    this.paper.count = topP + 1; this.foil.count = topF + 1;
    this.paper.instanceMatrix.needsUpdate = true; this.foil.instanceMatrix.needsUpdate = true;
  }
}

// Twinkling star glints (camera-facing, bright core + 4 rays).
class Sparkles {
  constructor(root, mat, rand) {
    this.rand = rand;
    const N = (this.N = 36);
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, N);
    this.mesh.frustumCulled = false; this.mesh.count = 0; this.mesh.renderOrder = 20;
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < N; i++) { this.mesh.setMatrixAt(i, ZERO_M); this.mesh.setColorAt(i, white); }
    root.add(this.mesh);
    this.P = new Float32Array(N * 3); this.A = new Float32Array(N).fill(1e9); this.L = new Float32Array(N); this.S = new Float32Array(N);
    this.next = 0; this.acc = 0;
  }
  spawn(x, y, z, size, color, life) {
    const i = this.next; this.next = (i + 1) % this.N;
    this.P[i * 3] = x; this.P[i * 3 + 1] = y; this.P[i * 3 + 2] = z;
    this.A[i] = 0; this.L[i] = life; this.S[i] = size;
    this.mesh.setColorAt(i, color); this.mesh.instanceColor.needsUpdate = true;
  }
  clear() { this.A.fill(1e9); this.acc = 0; for (let i = 0; i < this.N; i++) this.mesh.setMatrixAt(i, ZERO_M); this.mesh.count = 0; this.mesh.instanceMatrix.needsUpdate = true; }
  update(dt) {
    let top = -1;
    for (let i = 0; i < this.N; i++) {
      if (this.A[i] >= this.L[i]) continue;
      const a = (this.A[i] += dt), L = this.L[i];
      if (a >= L) { this.mesh.setMatrixAt(i, ZERO_M); continue; }
      const f = a / L, env = Math.pow(Math.sin(Math.PI * f), 1.6) * (0.82 + 0.18 * Math.sin(a * 31 + i));
      const s = this.S[i] * env;
      _m4.makeScale(s, s, s).setPosition(this.P[i * 3], this.P[i * 3 + 1] + a * 0.05, this.P[i * 3 + 2]);
      this.mesh.setMatrixAt(i, _m4);
      top = i;
    }
    let n = top + 1;
    for (let i = this.N - 1; i >= n; i--) if (this.A[i] < this.L[i]) { n = i + 1; break; }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ================================================================================================ materials
function makeBodyMaterial(glowUniform) {
  const m = new THREE.MeshPhysicalMaterial({ color: 0x38306a, roughness: 0.36, metalness: 0, clearcoat: 0.85, clearcoatRoughness: 0.16, vertexColors: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uGlow = glowUniform;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uGlow;\nvarying float vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uGlow * vGlow;');
  };
  m.customProgramCacheKey = () => 'iw-showcase-drum';
  return m;
}

const INSTANCE_ALPHA_VS = /* glsl */`
  varying vec2 vUv; varying float vA;
  void main() {
    vUv = uv; vA = 1.0;
    #ifdef USE_INSTANCING_COLOR
      vA = instanceColor.r;
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }`;

function makeContactMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0.018, 0.012, 0.04) } },
    vertexShader: INSTANCE_ALPHA_VS,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; varying vec2 vUv; varying float vA;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float a = 1.0 - smoothstep(0.0, 1.0, r);
        a = a * a * (0.45 + 0.55 * a) * vA;
        gl_FragColor = vec4(uColor, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6,
  });
}

function makeSparkMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */`
      varying vec2 vUv; varying vec3 vCol;
      void main() {
        vUv = uv; vCol = vec3(1.0);
        #ifdef USE_INSTANCING_COLOR
          vCol = instanceColor;
        #endif
        vec4 mv = modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0);
        mv.xy += position.xy * length(instanceMatrix[0].xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec2 vUv; varying vec3 vCol;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        float core = exp(-r * r * 26.0);
        float rays = exp(-abs(p.y) * 30.0) * pow(max(0.0, 1.0 - abs(p.x)), 2.0) + exp(-abs(p.x) * 30.0) * pow(max(0.0, 1.0 - abs(p.y)), 2.0);
        float halo = exp(-r * r * 5.0) * 0.18;
        float a = clamp(core * 1.3 + rays * 0.9 + halo, 0.0, 1.0);
        if (a < 0.004) discard;
        gl_FragColor = vec4(vCol * (1.2 + 3.0 * core), a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false,
  });
}

// Composite: un-premultiply the MSAA-resolved HDR stage, tone map + sRGB encode exactly like a direct canvas draw
// (three injects toneMapping()/linearToOutputTexel for the default framebuffer), then premultiplied-over the frame.
function makeCompositeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { tMap: { value: null }, uOpacity: { value: 1 }, uSat: { value: 1.06 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */`
      uniform sampler2D tMap; uniform float uOpacity; uniform float uSat; varying vec2 vUv;
      void main() {
        vec4 t = texture2D(tMap, vUv);
        float a = clamp(t.a, 0.0, 1.0) * uOpacity;
        if (a < 0.002) discard;
        vec3 c = max(t.rgb, 0.0) / max(t.a, 1e-4);
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = max(mix(vec3(l), c, uSat), 0.0);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        gl_FragColor.rgb = clamp(gl_FragColor.rgb + (n - 0.5) / 255.0, 0.0, 1.0);
        gl_FragColor = vec4(gl_FragColor.rgb * a, a);
      }`,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    depthTest: false, depthWrite: false, transparent: true,
  });
}

// Light rigs per scene mood. Directions are relative to the stage focus; the camera sits on +Z.
const MOODS = {
  loadout: { key: 2.75, keyCol: 0xfff0de, rimA: 3.4, rimB: 1.9, fill: 0.5, hemi: 0.8, sky: 0xdce8ff, ground: 0x2c2442, env: 0.6, glow: 2.2 },
  win: { key: 2.9, keyCol: 0xfff1dc, rimA: 3.6, rimB: 2.0, fill: 0.55, hemi: 0.85, sky: 0xdfe9ff, ground: 0x2e2644, env: 0.62, glow: 2.3 },
  lose: { key: 1.85, keyCol: 0xd9e2ff, rimA: 1.7, rimB: 2.5, fill: 0.36, hemi: 0.62, sky: 0xbfd0f4, ground: 0x1d1a30, env: 0.46, glow: 1.2 },
};

// ================================================================================================ Showcase
export class Showcase {
  constructor(renderer, CharacterClass) {
    this.r = renderer;
    this.CharacterClass = CharacterClass;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(26, 1, 0.05, 90);
    this.mode = null;
    this.chars = [];
    this.color = new THREE.Color(0xff8a14);
    this.won = true;
    this.t = 0; this.fadeIn = 0; this._out = 0; this._lastMode = null;
    this.spin = 0; this.spinVel = 0; this.sinceDrag = 99; this.drag = null;
    this.weapon = null; this.hopT = -99; this.hopWeapon = null; this.pop = null;
    this.ui = { panelR: -1, titleR: -1, titleB: -1, bandB: -1, s: null, W: 0, H: 0, next: 0, stamp: -1 };
    this.decks = [];
    this.rand = rng(0x5ca1ab);
    this._tgt = new THREE.Vector3(); this._clr = new THREE.Color(); this._dbs = new THREE.Vector2(); this._c = new THREE.Color();
    this._rt = null;
    this.emit = { spark: 0, bubble: 0 };

    this.fxRoot = new THREE.Group();
    this.scene.add(this.fxRoot);
    this._buildLights();
    this.glowU = { value: new THREE.Color() };
    this.inkMat = new THREE.MeshPhysicalMaterial({ color: this.color.clone(), roughness: 0.17, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.045, sheen: 0.3, sheenRoughness: 0.32, sheenColor: new THREE.Color(1, 1, 1) });
    this.bodyMat = makeBodyMaterial(this.glowU);
    this.fx = new InkFX(this.fxRoot, this.inkMat, this.rand);
    this.confetti = new Confetti(this.scene, this.rand);
    this.sparks = new Sparkles(this.fxRoot, makeSparkMaterial(), this.rand);
    // soft contact shadows under the feet (one instanced draw)
    this.contact = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), makeContactMaterial(), 8);
    this.contact.frustumCulled = false; this.contact.count = 0; this.contact.renderOrder = 1;
    for (let i = 0; i < 8; i++) { this.contact.setMatrixAt(i, ZERO_M); this.contact.setColorAt(i, this._c.setRGB(0, 0, 0)); }
    this.scene.add(this.contact);
    // composite pass
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.compMat = makeCompositeMaterial();
    this.compQuad = new THREE.Mesh(tri, this.compMat); this.compQuad.frustumCulled = false;
    this.compScene = new THREE.Scene(); this.compScene.add(this.compQuad);
    this.compCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.stageL = null; this.stageR = null; // built lazily (first show)
    this._bindDrag();
    addEventListener('resize', () => { this.ui.next = 0; });
  }

  // ---------------------------------------------------------------------------------------------- setup
  _buildLights() {
    const s = this.scene;
    const key = (this.key = new THREE.DirectionalLight(0xfff0de, 2.7));
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0003; key.shadow.normalBias = 0.012; key.shadow.radius = 3;
    this.rimA = new THREE.DirectionalLight(0xffffff, 3);
    this.rimB = new THREE.DirectionalLight(0xd4e8ff, 1.8);
    this.fill = new THREE.DirectionalLight(0xe3ecff, 0.5);
    this.hemi = new THREE.HemisphereLight(0xdce8ff, 0x2c2442, 0.8);
    for (const l of [key, this.rimA, this.rimB, this.fill]) s.add(l, l.target);
    s.add(this.hemi);
  }

  _aimLights(focus, spread, mood) {
    const M = MOODS[mood];
    const f = focus;
    this.key.position.set(f.x - 3.4 * spread, f.y + 5.4 * spread, f.z + 4.6 * spread); this.key.target.position.copy(f);
    this.rimA.position.set(f.x + 3.8, f.y + 2.8, f.z - 4.4); this.rimA.target.position.copy(f);
    this.rimB.position.set(f.x - 4.4, f.y + 2.0, f.z - 3.6); this.rimB.target.position.copy(f);
    this.fill.position.set(f.x + 4.6, f.y + 0.6, f.z + 3.8); this.fill.target.position.copy(f);
    const sc = this.key.shadow.camera, e = 1.25 * spread;
    sc.left = -e; sc.right = e; sc.top = e; sc.bottom = -e; sc.near = 0.5; sc.far = 16 * spread; sc.updateProjectionMatrix();
    this.key.intensity = M.key; this.key.color.set(M.keyCol);
    this.rimB.intensity = M.rimB; this.fill.intensity = M.fill;
    this.hemi.intensity = M.hemi; this.hemi.color.set(M.sky); this.hemi.groundColor.set(M.ground);
    this.mood = M;
    this._tintLights();
  }

  // team-coloured rim + groove glow follow the ink colour
  _tintLights() {
    const M = this.mood || MOODS.loadout;
    const c = this._c.copy(this.color);
    const mx = Math.max(c.r, c.g, c.b, 1e-4);
    c.multiplyScalar(1 / mx).lerp(new THREE.Color(1, 1, 1), 0.18);
    this.rimA.color.copy(c); this.rimA.intensity = M.rimA;
    this.glowU.value.copy(this.color).multiplyScalar(1 / mx).lerp(this._c.setRGB(1, 1, 1), 0.3).multiplyScalar(M.glow);
  }

  _setColor(color) {
    this.color.copy(color);
    this.inkMat.color.copy(color);
    this.inkMat.sheenColor.copy(color).lerp(this._c.setRGB(1, 1, 1), 0.55);
    this.confetti.setColor(color);
    this._tintLights();
  }

  _buildLoadoutStage() {
    const group = new THREE.Group();
    const body = new THREE.Mesh(drumGeometry(PED.R, PED, 144), this.bodyMat);
    body.receiveShadow = true;
    const drips = makeDrips(11, 14, { w0: 0.036, w1: 0.07, L0: 0.05, L1: 0.3, longChance: 0.3 });
    const ink = new THREE.Mesh(inkCoatGeometry(PED.R, PED.bevel, drips, { T0: PED.ink, du: 0.02, duF: 0.0034, NB: 26, seed: 5, depth: 0.42 }), this.inkMat);
    ink.receiveShadow = true;
    group.add(body, ink);
    group.visible = false;
    this.scene.add(group);
    return { group, parts: [body, ink] };
  }

  _buildResultsStage() {
    const group = new THREE.Group();
    const drums = SLOTS.map((S, i) => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(drumGeometry(S.R, DRUM, 112), this.bodyMat);
      body.receiveShadow = true;
      const drips = makeDrips(31 + i * 7, 8, { front: 1.35, w0: 0.034, w1: 0.064, L0: 0.05, L1: 0.26, longChance: 0.35 });
      const ink = new THREE.Mesh(inkCoatGeometry(S.R, DRUM.bevel, drips, { T0: DRUM.ink, du: 0.024, duF: 0.0042, NB: 22, seed: 9 + i, depth: 0.36 }), this.inkMat);
      ink.receiveShadow = true;
      g.add(body, ink);
      g.position.set(S.x, S.top, S.z);
      group.add(g);
      return g;
    });
    group.visible = false;
    this.scene.add(group);
    return { group, drums };
  }

  _bindDrag() {
    const el = document.getElementById('app');
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'loadout') return;
      const edge = this.ui.s ? this.ui.s.panelR : innerWidth * 0.52;
      if (e.clientX > edge) { this.drag = { x: e.clientX, t: performance.now() }; this.spinVel = 0; }
    });
    addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) return;
      const now = performance.now(), dx = e.clientX - d.x, dts = Math.max(0.008, (now - d.t) / 1000);
      this.spin += dx * 0.011;
      this.spinVel = lerp(this.spinVel, (dx * 0.011) / dts, 0.5);
      d.x = e.clientX; d.t = now;
      this.sinceDrag = 0;
    });
    addEventListener('pointerup', () => { this.drag = null; });
  }

  // ---------------------------------------------------------------------------------------------- lifecycle
  _clear() {
    for (const c of this.chars) { this.scene.remove(c.root); c.dispose?.(); }
    this.chars = [];
    this.fx.clear(); this.confetti.clear(); this.sparks.clear();
    for (let i = 0; i < 8; i++) this.contact.setMatrixAt(i, ZERO_M);
    this.contact.count = 0; this.contact.instanceMatrix.needsUpdate = true;
    if (this.stageL) this.stageL.group.visible = false;
    if (this.stageR) this.stageR.group.visible = false;
    if (this.pop) { this.pop.scale.setScalar(1); this.pop = null; }
    this.decks.length = 0;
    this._out = 0;
  }

  _anim() {
    return { time: 0, speed: 0, localMove: { x: 0, z: 0 }, grounded: true, vy: 0, aimPitch: 0, firing: false, charge: 0, rolling: false, form: 'kid', wallNormal: new THREE.Vector3(0, 0, 1), ink: 1, lowInk: false, special: 0, invuln: false };
  }

  showLoadout(weapon, color) {
    const fresh = this.mode !== 'loadout' || !this.chars.length;
    if (fresh) {
      const resume = this._out > 0 && this._lastMode === 'loadout' && this.chars.length;
      if (resume) {
        this._out = 0;
      } else {
        this._clear();
        if (!this.stageL) this.stageL = this._buildLoadoutStage();
        const c = new this.CharacterClass({ color: color.clone(), weapon, style: { hair: 0, skin: 1 }, name: 'preview', isLocal: false });
        c._a = this._anim(); c._a.grounded = false;
        c._y = -1.6; c.root.position.set(0, -1.6, 0);
        this.scene.add(c.root);
        this.chars.push(c);
        this.t = 0; this.fadeIn = 0;
        this.spin = 0; this.spinVel = 0; this.sinceDrag = 99;
        this.hopT = -99; this.hopWeapon = null;
        this.phase = 'emerge'; this.landT = -99; this.emerged = false;
        this.weapon = weapon;
        this.stageL.group.visible = true;
        this.ui.next = 0;
      }
      this.mode = 'loadout';
      this._lastMode = 'loadout';
      this._aimLights(this._tgt.set(0, 0.8, 0), 1, 'loadout');
    }
    this._setColor(color);
    const c = this.chars[0];
    c.setColor(color);
    if (weapon !== this.weapon && !fresh) {
      // weapon change: hop + twirl, the new weapon materialises mid-air, splash on landing, camera punch
      this.weapon = weapon;
      this.hopWeapon = weapon;
      this.hopT = this.t;
      if (this.phase !== 'emerge') this.phase = 'hop';
    } else if (fresh) {
      c.setWeapon(weapon);
    }
  }

  showResults(team, won, color, styles) {
    this._clear();
    if (!this.stageR) this.stageR = this._buildResultsStage();
    this.mode = 'results';
    this._lastMode = 'results';
    this.won = !!won;
    this.t = 0; this.fadeIn = 0;
    this._setColor(color);
    this.stageR.group.visible = true;
    const n = Math.min(styles.length, SLOTS.length);
    this.slots = SLOTS.slice(0, Math.max(1, n));
    this.stageR.drums.forEach((d, i) => { d.visible = i < this.slots.length; d.position.y = -9; });
    for (let i = 0; i < n; i++) {
      const st = styles[i], S = SLOTS[i];
      const c = new this.CharacterClass({ color: color.clone(), weapon: st.weapon, style: st.style, name: st.name, isLocal: false });
      c._a = this._anim();
      c._slot = S;
      c._land = this.won ? 0.46 + i * 0.13 + (i === 3 ? 0.05 : 0) : -1;
      c._landed = !this.won;
      c.root.rotation.y = S.yaw;
      c.root.visible = !this.won;
      if (!this.won) {
        c.setDance('defeat');
        for (let k = 0; k < i * 7 + 3; k++) c.update(0.1, c._a); // desync the slump cycles
      }
      this.scene.add(c.root);
      this.chars.push(c);
    }
    this.events = { cannon: 0, bombs: 0 };
    this._aimLights(this._tgt.set(0.55, 1.25, 0), 2.6, this.won ? 'win' : 'lose');
    this.ui.next = 0;
  }

  hide() {
    if (!this.mode) return;
    this._lastMode = this.mode;
    this.mode = null;
    this._out = 0.2; // quick fade-out, then _clear()
  }

  dispose() {
    this.mode = null; this._clear();
    for (const st of [this.stageL, this.stageR]) {
      if (!st) continue;
      st.group.traverse((o) => o.geometry?.dispose());
      this.scene.remove(st.group);
    }
    this.stageL = this.stageR = null;
    this._rt?.dispose(); this._rt = null;
  }

  // ---------------------------------------------------------------------------------------------- update
  update(dt) {
    dt = Math.min(dt || 0, 0.1);
    let mode = this.mode;
    if (!mode && this._out > 0) {
      this._out -= dt;
      if (this._out <= 0) { this._clear(); return; }
      mode = this._lastMode;
    }
    if (!mode || !this.chars.length) return;
    this.t += dt;
    this.fadeIn = Math.min(1, this.fadeIn + dt / 0.25);
    if (mode === 'loadout') this._updateLoadout(dt);
    else this._updateResults(dt);
    this.fx.update(dt, this.decks);
    this.confetti.update(dt, this.decks);
    this.sparks.update(dt);
    this.contact.instanceMatrix.needsUpdate = true;
    if (this.contact.instanceColor) this.contact.instanceColor.needsUpdate = true;
  }

  _contactAt(i, x, y, z, size, alpha) {
    _m4.makeScale(size, 1, size).setPosition(x, y, z);
    this.contact.setMatrixAt(i, _m4);
    this.contact.setColorAt(i, this._c.setRGB(alpha, 0, 0));
    if (this.contact.count < i + 1) this.contact.count = i + 1;
  }

  _updateLoadout(dt) {
    const t = this.t, c = this.chars[0], st = this.stageL, rnd = this.rand;
    const a = c._a;
    a.time = G.time;
    // pedestal rises in
    const stageY = -0.95 * (1 - backOut(t / 0.6, 1.25));
    st.group.position.y = stageY;
    const deckY = stageY + PED.ink;
    // turntable: user drag + momentum; otherwise a slow sway that drifts home
    if (!this.drag) {
      this.spin += this.spinVel * dt;
      this.spinVel *= Math.exp(-3.4 * dt);
      this.sinceDrag += dt;
      if (this.sinceDrag > 2.4 && Math.abs(this.spinVel) < 0.35) this.spin = damp(this.spin, Math.round(this.spin / TAU) * TAU, 1.1, dt);
    }
    const sway = 0.17 * Math.sin((t - 1.6) * 0.5) * sstep(1.6, 4, t);
    const yawStage = this.spin + sway;
    st.group.rotation.y = yawStage;
    this.fxRoot.rotation.y = yawStage;
    this.fxRoot.position.y = stageY;
    this.decks.length = 1;
    const dk = this.decks[0] || (this.decks[0] = { x: 0, z: 0, r: 0, y: 0 });
    dk.x = 0; dk.z = 0; dk.r = PED.R - 0.035; dk.y = PED.ink;

    // character choreography
    let y = 0, sy = 1, twirl = 0, air = false, vy = 0;
    if (this.phase === 'emerge') {
      // bursts out of the ink: ballistic from inside the pedestal, stretched on the way up, squash on landing
      const t0 = 0.12, y0 = -1.45, tp = 0.4, peak = 0.3;
      const g = (2 * (peak - y0)) / (tp * tp), v0 = g * tp;
      const te = t - t0;
      if (te < 0) { y = y0; air = true; }
      else {
        y = y0 + v0 * te - 0.5 * g * te * te;
        vy = v0 - g * te;
        air = true;
        if (!this.emerged && y > 0) { this.emerged = true; this.fx.crown(0, PED.ink, 0, 1.25, 26, 0.24); c.trigger('jump'); }
        if (te > tp && y <= 0) {
          y = 0; air = false; this.phase = 'pose'; this.landT = t;
          c.trigger('land', 7); c.setDance('lobby_pose');
          this.fx.crown(0, PED.ink, 0, 0.7, 16, 0.3);
        }
        sy = 1 + 0.16 * c01(vy / 7);
      }
      twirl = -0.6 * (1 - eOut3(c01(te / 0.55)));
    } else if (this.phase === 'hop') {
      const tw = t - this.hopT, ant = 0.075, T = 0.46, H = 0.3;
      if (tw < ant) { sy = 1 - 0.1 * Math.sin((Math.PI * 0.5 * tw) / ant); }
      else if (tw < ant + T) {
        const x = (tw - ant) / T;
        y = 4 * H * x * (1 - x); vy = (4 * H * (1 - 2 * x)) / T; air = true;
        twirl = TAU * eInOut(x);
        sy = 1 + 0.12 * c01(vy / 3) - 0.04 * c01(-vy / 3);
        if (this.hopWeapon && x > 0.12) {
          if (this.pop) this.pop.scale.setScalar(1);
          c.setWeapon(this.hopWeapon);
          this.pop = c.weapon?.pivot || null;
          if (this.pop) { this.pop.scale.setScalar(0.001); this.popT = t; }
          this.hopWeapon = null;
          c.setDance(null); c.trigger('jump');
        }
      } else {
        this.phase = 'pose'; this.landT = t;
        c.trigger('land', 6); c.setDance('lobby_pose');
        this.fx.crown(0, PED.ink, 0, 1.0, 22, 0.26);
      }
    }
    if (this.phase === 'pose') {
      const tl = t - this.landT;
      sy = 1 - 0.13 * wobble(tl, 15, 6.5);
    }
    if (this.pop) {
      const k = backOut((t - this.popT) / 0.34, 2.4);
      this.pop.scale.setScalar(Math.max(0.001, k));
      if (t - this.popT > 0.34) { this.pop.scale.setScalar(1); this.pop = null; }
    }
    a.grounded = !air; a.vy = vy;
    const sxz = 1 / Math.sqrt(sy);
    c.root.position.set(0, stageY + PED.ink * 0.5 + y, 0);
    c.root.scale.set(sxz, sy, sxz);
    c.root.rotation.y = -0.45 + yawStage + twirl;
    c.update(dt, a);
    // contact shadow
    const hgt = Math.max(0, y);
    this._contactAt(0, 0, deckY + 0.004, 0, 0.78 * (1 + hgt * 0.8), y < -0.05 ? 0 : 0.8 * (1 - c01(hgt / 1.1) * 0.75));

    // idle life: a few ink bubbles drifting up off the pedestal, glints around the kid
    if (t > 1.2) {
      this.emit.bubble += dt * 0.85;
      while (this.emit.bubble >= 1) {
        this.emit.bubble -= 1;
        const ang = rnd() * TAU, rr = 0.36 + rnd() * 0.34;
        this.fx.bubble(Math.sin(ang) * rr, PED.ink + 0.01, Math.cos(ang) * rr, 0.009 + rnd() * 0.016, 0.16 + rnd() * 0.16, 3 + rnd() * 3);
      }
      this.emit.spark += dt * 2.0;
      while (this.emit.spark >= 1) {
        this.emit.spark -= 1;
        const ang = rnd() * TAU, rr = 0.38 + rnd() * 0.5;
        const col = rnd() < 0.3 ? this._c.copy(this.color).lerp(_c1.setRGB(1, 1, 1), 0.45) : this._c.setRGB(1, 0.97, 0.9);
        this.sparks.spawn(Math.sin(ang) * rr, 0.25 + rnd() * 1.55, Math.cos(ang) * rr, 0.05 + rnd() * 0.07, col, 0.7 + rnd() * 0.7);
      }
    }
  }

  _updateResults(dt) {
    const t = this.t, rnd = this.rand, won = this.won;
    const slots = this.slots;
    // drums rise from under the UI band, centre first
    this.decks.length = slots.length;
    for (let i = 0; i < slots.length; i++) {
      const S = slots[i], d = this.stageR.drums[i];
      const k = backOut((t - 0.04 * i) / 0.72, 1.15);
      d.position.set(S.x, S.top - 2.4 * (1 - k), S.z);
      const dk = this.decks[i] || (this.decks[i] = { x: 0, z: 0, r: 0, y: 0 });
      dk.x = S.x; dk.z = S.z; dk.r = S.R - 0.04; dk.y = d.position.y + DRUM.ink;
    }
    // squidkids: winners drop in one by one and splash down; losers ride the drums up, already slumped
    for (let i = 0; i < this.chars.length; i++) {
      const c = this.chars[i], S = c._slot, a = c._a, dk = this.decks[i];
      a.time = G.time;
      let y = dk.y - DRUM.ink * 0.5, sy = 1, air = false, vy = 0;
      if (won) {
        const T = 0.5, H = 3.1, g = (2 * H) / (T * T);
        const tf = t - (c._land - T);
        if (tf < 0) { c.root.visible = false; }
        else if (tf < T) {
          c.root.visible = true; air = true;
          y += H - 0.5 * g * tf * tf; vy = -g * tf;
          sy = 1 + 0.1 * c01(-vy / 12);
        } else {
          c.root.visible = true;
          if (!c._landed) {
            c._landed = true;
            c.trigger('land', 9); c.setDance('victory');
            this.fx.crown(S.x, dk.y, S.z, i === 0 ? 1.15 : 0.95, i === 0 ? 24 : 16, 0.24);
          }
          sy = 1 - 0.15 * wobble(t - c._land, 14, 6);
        }
      }
      a.grounded = !air; a.vy = vy;
      const sxz = 1 / Math.sqrt(sy);
      c.root.position.set(S.x, y, S.z);
      c.root.scale.set(sxz, sy, sxz);
      c.update(dt, a);
      const hgt = Math.max(0, y - dk.y);
      this._contactAt(i, S.x, dk.y + 0.004, S.z, 0.74 * (1 + hgt * 0.35), c.root.visible ? 0.78 * (1 - c01(hgt / 2.5) * 0.85) : 0);
    }
    if (won) {
      // confetti cannons from both wings + a rain that tapers to a gentle trickle
      const ev = this.events;
      if (ev.cannon === 0 && t > 0.98) { ev.cannon = 1; this.confetti.burst(-3.3, 0.1, 0.8, 0.42, 1, -0.12, 95, 8.8, 0.7); this.confetti.burst(4.3, 0.1, 0.8, -0.42, 1, -0.12, 95, 8.8, 0.7); }
      if (ev.cannon === 1 && t > 1.3) { ev.cannon = 2; this.confetti.burst(-3.0, 0.2, 0.6, 0.3, 1, -0.1, 45, 7.2, 0.8); this.confetti.burst(4.0, 0.2, 0.6, -0.3, 1, -0.1, 45, 7.2, 0.8); }
      if (t > 0.9) this.confetti.rain(dt, lerp(30, 5, sstep(1.5, 7, t)), -2.9, 4.0, -1.1, 1.0, 3.9);
      // glossy ink bombs arc in from off-stage and splat on the drums
      const plan = [[1.05, 0, -1], [1.3, 2, 1], [1.62, 1, -1], [2.0, 3, 1], [3.6, 0, 1], [5.2, 2, -1], [6.9, 1, 1]];
      while (ev.bombs < plan.length && t > plan[ev.bombs][0]) {
        const [, di, side] = plan[ev.bombs++];
        if (di >= slots.length) continue;
        const S = slots[di], ang = rnd() * TAU, rr = S.R * (0.5 + rnd() * 0.3);
        const tx = S.x + Math.sin(ang) * rr, tz = S.z + Math.cos(ang) * rr * 0.6 - 0.1, ty = this.decks[di].y;
        const sx = tx + side * (2.4 + rnd()), sy2 = ty - 1.2, sz = tz - 2.2, T = 0.78, g = 9.5;
        this.fx.drop(sx, sy2, sz, (tx - sx) / T, (ty - sy2) / T + 0.5 * g * T, (tz - sz) / T, 0.05 + rnd() * 0.025, 2, 3);
      }
      // gold/white glints over the team
      this.emit.spark += dt * (t < 3 ? 7 : 3.5);
      while (this.emit.spark >= 1) {
        this.emit.spark -= 1;
        const col = rnd() < 0.5 ? this._c.setRGB(1, 0.84, 0.45) : rnd() < 0.5 ? this._c.setRGB(1, 1, 1) : this._c.copy(this.color).lerp(_c1.setRGB(1, 1, 1), 0.5);
        const i = (rnd() * slots.length) | 0, S = slots[i];
        this.sparks.spawn(S.x + (rnd() - 0.5) * 1.3, S.top + 0.3 + rnd() * 2.0, S.z + (rnd() - 0.5) * 0.8, 0.07 + rnd() * 0.08, col, 0.6 + rnd() * 0.7);
      }
    } else if (t > 1.0) {
      // defeat: a light, slow ink drizzle pattering on the podium
      this.emit.spark += dt * 2.4;
      while (this.emit.spark >= 1) {
        this.emit.spark -= 1;
        this.fx.drop(-2.4 + rnd() * 5.6, 3.6 + rnd() * 0.8, -0.8 + rnd() * 1.4, 0, -2.5, 0, 0.013 + rnd() * 0.012, 4, 3);
      }
    }
    // bubbles off the drum tops (both moods)
    if (t > 1.5) {
      this.emit.bubble += dt * (won ? 1.1 : 0.7);
      while (this.emit.bubble >= 1) {
        this.emit.bubble -= 1;
        const i = (rnd() * slots.length) | 0, S = slots[i], ang = rnd() * TAU, rr = S.R * (0.45 + rnd() * 0.45);
        this.fx.bubble(S.x + Math.sin(ang) * rr, this.decks[i].y + 0.01, S.z + Math.cos(ang) * rr, 0.01 + rnd() * 0.016, 0.16 + rnd() * 0.18, 2.5 + rnd() * 3);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------- framing
  // Free screen areas come from the live DOM (layout boxes, transform-free) with stylesheet-formula fallbacks.
  _measureUI(W, H) {
    const U = this.ui;
    const u = Math.min(W * 0.01, H * 0.017778);
    if (U.W !== W || U.H !== H) { U.W = W; U.H = H; U.next = 0; }
    if (!U.s) U.s = { panelR: 0, titleR: 0, titleB: 0, bandB: 0 };
    if (this.t >= U.next) {
      U.next = this.t < 0.4 ? this.t + 0.1 : this.t < 1.5 ? this.t + 0.35 : this.t < 9 ? this.t + 0.2 : 1e9;
      U.panelR = 3.6 * u + Math.min(52 * u, 0.54 * W);
      U.titleR = 3.8 * u + 33.2 * u; U.titleB = 12.3 * u; U.bandB = 0.42 * H;
      const box = (sel) => {
        const list = document.querySelectorAll(sel);
        const el = list[list.length - 1];
        if (!el || !el.offsetParent) return null;
        let x = 0, y = 0;
        for (let e = el; e; e = e.offsetParent) { x += e.offsetLeft; y += e.offsetTop; }
        return { l: x, t: y, r: x + el.offsetWidth, b: y + el.offsetHeight };
      };
      if (this.mode === 'loadout' || this._lastMode === 'loadout') {
        const b = box('.iw-loadout:not(.is-leaving) .iw-loadout__body');
        if (b && b.r > W * 0.2 && b.r < W * 0.8) U.panelR = b.r;
      } else {
        const tt = box('.iw-results:not(.is-leaving) .iw-res__title'), hd = box('.iw-results:not(.is-leaving) .iw-res__head'), bd = box('.iw-results:not(.is-leaving) .iw-res__body');
        if (tt && tt.r < W * 0.75) U.titleR = tt.r;
        const tag = box('.iw-results:not(.is-leaving) .iw-res__metarow');
        if (hd && hd.b < H * 0.5) U.titleB = Math.min(hd.b, tag ? tag.b + 8 : hd.b);
        if (bd && bd.t > H * 0.25) U.bandB = bd.t;
        // podium moment: the scoreboard is still below the fold → frame the team big
        if (document.querySelector('.iw-results.is-intro:not(.is-leaving)')) U.bandB = H * 0.86;
      }
      if (U.stamp < 0) { U.s.panelR = U.panelR; U.s.titleR = U.titleR; U.s.titleB = U.titleB; U.s.bandB = U.bandB; }
      U.stamp = this.t;
    }
    // ease toward new measurements so a late layout never snaps the camera
    const k = 1 - Math.exp(-8 * (this._fdt || 0.016));
    U.s.panelR += (U.panelR - U.s.panelR) * k; U.s.titleR += (U.titleR - U.s.titleR) * k;
    U.s.titleB += (U.titleB - U.s.titleB) * k; U.s.bandB += (U.bandB - U.s.bandB) * k;
    return U.s;
  }

  // Orbit the focus point, aim at it, then lens-shift so the focus lands on screen pixel (sx, sy).
  _place(focus, yaw, pitch, dist, fov, sx, sy, W, H, roll = 0) {
    const cam = this.camera, cp = Math.cos(pitch);
    cam.fov = fov;
    cam.position.set(focus.x + dist * Math.sin(yaw) * cp, focus.y - dist * Math.sin(pitch), focus.z + dist * Math.cos(yaw) * cp);
    cam.up.set(0, 1, 0);
    cam.lookAt(focus);
    if (roll) cam.rotateZ(roll);
    cam.near = Math.max(0.05, dist - 12); cam.far = dist + 14;
    cam.setViewOffset(W, H, W * 0.5 - sx, H * 0.5 - sy, W, H);
    cam.updateMatrixWorld();
  }

  _cameraLoadout(W, H) {
    const U = this._measureUI(W, H), t = this.t;
    const fov = 25, tanH = Math.tan((fov * Math.PI) / 360);
    const freeL = U.panelR + W * 0.012, freeR = W * 0.985, freeW = Math.max(W * 0.18, freeR - freeL);
    const kV = (0.6 * H) / CHAR_H, kW = (0.84 * freeW) / (2 * (PED.R + PED.flange.out));
    const k = Math.min(kV, kW);
    let dist = H / (2 * k * tanH);
    const sx = (freeL + freeR) * 0.5, sy = 0.735 * H - LOAD_FOCUS_Y * k;
    const e = eOut3(t / 1.45);
    let yaw = 0.36 * (1 - e) + 0.03 * Math.sin(t * 0.41) * e;
    let pitch = -0.1 - 0.05 * (1 - e) + 0.012 * Math.sin(t * 0.29 + 1.3) * e;
    dist *= 1 + 0.3 * (1 - e) + 0.012 * Math.sin(t * 0.23 + 2.1) * e;
    let roll = 0;
    const tw = t - this.hopT;
    if (tw >= 0 && tw < 1.6) { const p = punch(tw); dist *= 1 - 0.075 * p; yaw -= 0.035 * p; roll = 0.012 * wobble(tw, 11, 5); }
    this._place(this._tgt.set(0, LOAD_FOCUS_Y, 0), yaw, pitch, dist, fov, sx, sy, W, H, roll);
  }

  _cameraResults(W, H) {
    const U = this._measureUI(W, H), t = this.t, won = this.won;
    const fov = 22, tanH = Math.tan((fov * Math.PI) / 360);
    const S0 = this.slots[0];
    const yFeet = S0.top, yHead = S0.top + CHAR_H + 0.28;
    const topPx = H * 0.05;
    const feetPx = Math.min(H * 0.66, Math.max(H * 0.34, U.bandB - H * 0.11));
    let k = (feetPx - topPx) / (yHead - yFeet);
    // horizontal: stay clear of the title block and inside the right edge
    let xL = 0, xR = 0, yTopL = yHead;
    for (const S of this.slots) {
      if (S.x - 0.42 < xL) { xL = S.x - 0.42; yTopL = S.top + CHAR_H + 0.28; }
      xR = Math.max(xR, S.x + S.R + 0.12);
    }
    let sx0 = W * 0.5;
    for (let it = 0; it < 8; it++) {
      sx0 = W * 0.5;
      const headL = feetPx - (yTopL - yFeet) * k;
      const left = sx0 + xL * k;
      if (headL < U.titleB + H * 0.01 && left < U.titleR + W * 0.012) sx0 += U.titleR + W * 0.012 - left;
      if (sx0 + xR * k > W * 0.975) { k *= 0.95; continue; }
      break;
    }
    const fy = yFeet + 0.55;
    const sy = feetPx - (fy - yFeet) * k;
    let dist = H / (2 * k * tanH);
    const e = eOut3(t / 2.5);
    const pitch0 = won ? -0.075 : -0.15;
    let yaw = -0.3 * (1 - e) + 0.02 * Math.sin(t * 0.33) * e;
    let pitch = pitch0 + 0.08 * (1 - e) + 0.007 * Math.sin(t * 0.21 + 1) * e;
    dist *= (1 + 0.32 * (1 - e)) * (1 - 0.045 * eInOut((t - 2.5) / 13));
    this._place(this._tgt.set(0, fy, 0), yaw, pitch, dist, fov, sx0, sy, W, H);
  }

  // ---------------------------------------------------------------------------------------------- render
  // MSAA HDR target: the composer's spare ping-pong buffer when it matches the canvas, else a private one.
  _target() {
    const r = this.r;
    r.getDrawingBufferSize(this._dbs);
    const w = this._dbs.x, h = this._dbs.y;
    const comp = G.post?.composer;
    const b = comp && comp.writeBuffer;
    if (b && b.isWebGLRenderTarget && b.depthBuffer && b.texture.type !== THREE.UnsignedByteType && Math.abs(b.width - w) <= 1 && Math.abs(b.height - h) <= 1) {
      if (this._rt) { this._rt.dispose(); this._rt = null; }
      return b;
    }
    if (!this._rt) this._rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: (G.post?.q?.msaa ?? 4) > 0 ? 4 : 0 });
    else if (this._rt.width !== w || this._rt.height !== h) this._rt.setSize(w, h);
    return this._rt;
  }

  render() {
    const mode = this.mode || (this._out > 0 ? this._lastMode : null);
    if (!mode || !this.chars.length) return;
    const r = this.r, W = innerWidth, H = innerHeight;
    this._fdt = 1 / 60;
    if (mode === 'loadout') this._cameraLoadout(W, H); else this._cameraResults(W, H);
    this.scene.environment = G.env?.envMap || null;
    this.scene.environmentIntensity = (this.mood || MOODS.loadout).env;
    const opacity = this.mode ? eOut3(this.fadeIn) : c01(this._out / 0.2);
    const prevRT = r.getRenderTarget(), prevAuto = r.autoClear, prevAlpha = r.getClearAlpha();
    r.getClearColor(this._clr);
    r.autoClear = false;
    const target = this._target();
    r.setRenderTarget(target);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prevRT);
    this.compMat.uniforms.tMap.value = target.texture;
    this.compMat.uniforms.uOpacity.value = opacity;
    r.render(this.compScene, this.compCam);
    this.compMat.uniforms.tMap.value = null;
    r.setClearColor(this._clr, prevAlpha);
    r.autoClear = prevAuto;
  }
}
const _c1 = new THREE.Color();
