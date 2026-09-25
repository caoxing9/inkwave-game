// INKWAVE — procedural weapon models held by squidkids.
// Weapon space: grip centre at the origin, +Z = barrel forward, +Y = up, character's right = -X.
// Each weapon: body (vertex-coloured physical plastic with per-vertex surface class aMat — satin, gloss, rubber,
// metal, lens, LED, print), ink (team gloss), optional glow (charger coil) and drum (roller).
//
// Hands: the squidkid fist is modelled around a Ø 2.8 cm handle whose axis passes through HAND.hole (character-geo).
// A grip spec { pos, handZ, handY } says where that handle axis passes (pos), which way it runs toward the thumb
// (handZ) and which way the wrist lies (handY). Handles held by a hand are ≤ 1.5 cm in radius around that axis.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { superEllipsoid, lathe, smoothProfile, sweep, finalize, torus as torusG, HAND } from './character-geo.js';
import { WMAT } from './character-mats.js';

const V3 = THREE.Vector3;
const M = WMAT;
const C = {
  cream: '#f2ede1', white: '#eef0f3', bone: '#e4ddcc', dark: '#2a2e37', darker: '#1b1e25', gray: '#8f98a6', metal: '#c3c9d2',
  gunmetal: '#5b616c', rubber: '#26282e', lens: '#0b0f16', red: '#ff3b30', green: '#3dff7a', amber: '#ffb000', decal: '#f7f7f5', hazard: '#ffcf33',
};

class Parts {
  constructor() { this.list = []; }
  add(geo, color, mat = M.satin) {
    const g = geo.index ? geo : finalize(geo);
    const n = g.attributes.position.count; const col = new Float32Array(n * 3); const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', g.attributes.position.clone());
    out.setAttribute('normal', g.attributes.normal.clone());
    out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    out.setAttribute('aMat', new THREE.Float32BufferAttribute(new Float32Array(n).fill(mat), 1));
    out.setIndex(g.index.clone());
    this.list.push(out); return this;
  }
  build() { return this.list.length ? mergeGeometries(this.list, false) : null; }
}

// ---------------------------------------------------------------------------------------------- helpers
/** Lathe along +Z from [r, z] profile. */
function latheZ(profile, seg = 16) { const g = lathe(profile, seg); g.rotateX(Math.PI / 2); return g; }
function torus(R, r, rs = 6, ts = 16, arc = Math.PI * 2) { return torusG(R, r, rs, ts, arc); }
function at(g, x, y, z) { g.translate(x, y, z); return g; }
/** Rounded box (w, h, d = full sizes), squareness e (smaller = boxier). */
function rbox(w, h, d, e = 0.3, ws = 12, hs = 8, deform) { return superEllipsoid(w / 2, h / 2, d / 2, e, e, ws, hs, deform); }
/** Orient geometry authored along +Y so that +Y → dir, then place at p. */
function orient(g, dir, p) { g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), dir.clone().normalize())); return at(g, p.x, p.y, p.z); }
/** Small screw head (dome with a slot) facing n at p. */
function screw(P, p, n, r = 0.0032, col = C.metal) {
  const h = lathe([[0, 0], [r, 0], [r, 0.0006], [r * 0.72, 0.0014], [0, 0.0017]], 6);
  P.add(orient(h, n, p), col, M.metal);
}
/** Thin extruded decal from a 2D shape (in the XY plane), placed with basis (x, y) at p. */
function decal(shape, depth = 0.0006) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 5 });
  return finalize(g);
}
function placeXY(g, xAxis, yAxis, p) {
  const x = xAxis.clone().normalize(), y = yAxis.clone().addScaledVector(x, -yAxis.dot(x)).normalize(), z = new V3().crossVectors(x, y);
  g.applyMatrix4(new THREE.Matrix4().makeBasis(x, y, z).setPosition(p));
  return g;
}
/** Squid glyph (mantle arrow + head + eyes cut out) as a Shape of height ~1 (scale it). */
function squidShape(s = 1) {
  const sh = new THREE.Shape();
  sh.moveTo(0, 0.62 * s); sh.lineTo(0.42 * s, 0.1 * s); sh.quadraticCurveTo(0.38 * s, -0.08 * s, 0.26 * s, -0.12 * s);
  sh.lineTo(0.26 * s, -0.42 * s); sh.lineTo(0.14 * s, -0.42 * s); sh.lineTo(0.12 * s, -0.2 * s);
  sh.lineTo(0.05 * s, -0.2 * s); sh.lineTo(0.05 * s, -0.46 * s); sh.lineTo(-0.05 * s, -0.46 * s); sh.lineTo(-0.05 * s, -0.2 * s);
  sh.lineTo(-0.12 * s, -0.2 * s); sh.lineTo(-0.14 * s, -0.42 * s); sh.lineTo(-0.26 * s, -0.42 * s); sh.lineTo(-0.26 * s, -0.12 * s);
  sh.quadraticCurveTo(-0.38 * s, -0.08 * s, -0.42 * s, 0.1 * s); sh.lineTo(0, 0.62 * s);
  for (const ex of [0.12, -0.12]) { const e = new THREE.Path(); e.absellipse(ex * s, 0.02 * s, 0.055 * s, 0.07 * s, 0, Math.PI * 2, false); sh.holes.push(e); }
  return sh;
}
function chevronShape(w, h, n = 3, gap = 0.4) {
  const sh = []; const step = w / n;
  for (let i = 0; i < n; i++) {
    const s = new THREE.Shape(); const x0 = i * step, t = step * (1 - gap);
    s.moveTo(x0, 0); s.lineTo(x0 + t, 0); s.lineTo(x0 + t + h * 0.5, h * 0.5); s.lineTo(x0 + t, h); s.lineTo(x0, h); s.lineTo(x0 + h * 0.5, h * 0.5); s.lineTo(x0, 0);
    sh.push(s);
  }
  return sh;
}

// ---------------------------------------------------------------------------------------------- hands
/** Grip-hole axis point relative to the hand bone (right hand = mirror of the modelled left hand). */
export const GRIP_HOLE_L = HAND.hole.clone();
export const GRIP_HOLE_R = new V3(-HAND.hole.x, HAND.hole.y, HAND.hole.z);
/** Twirl pivot: the right fist's grip axis (so spins happen around the handle the kid is holding). */
export const FIST_OFFSET = GRIP_HOLE_R.clone();

/** Pistol grip around the handle axis A through the origin: rubber-paneled, finger-grooved front strap,
 *  beavertail over the web of the hand, trigger + guard for the index finger, flared base plate. */
const GRIP_AXIS = new V3(0, 1, 0.25).normalize();
function pistolGrip(P, opt = {}) {
  const A = GRIP_AXIS;
  const tilt = Math.atan2(A.z, A.y);
  // core: slim oval handle, finger grooves on the front strap
  const core = superEllipsoid(0.0118, 0.056, 0.0152, 0.62, 0.7, 12, 12, (q) => {
    if (q.z > 0) { const f = 0.5 + 0.5 * Math.cos(((q.y + 0.0006) / 0.0122) * Math.PI * 2); q.z -= 0.0016 * f * (1 - Math.abs(q.x) / 0.0118) * (q.y < 0.03 ? 1 : 0); }
    if (q.y < -0.046) { q.x *= 1.08; q.z *= 1.06; }
  });
  core.rotateX(tilt); P.add(at(core, 0, -0.008, -0.002), C.darker, M.satin);
  // rubber side panels (knurled)
  for (const sx of [1, -1]) {
    const pn = superEllipsoid(0.003, 0.038, 0.0118, 0.5, 0.55, 5, 8);
    pn.rotateX(tilt); P.add(at(pn, sx * 0.0104, -0.012, -0.004), C.rubber, M.rubber);
  }
  // beavertail + back strap
  const bt = superEllipsoid(0.0118, 0.012, 0.016, 0.5, 0.6, 8, 5, (q) => { if (q.z < 0) q.y -= 0.006 * (q.z / 0.016) ** 2; });
  bt.rotateX(tilt - 0.35); P.add(at(bt, 0, 0.042, -0.018), C.darker, M.satin);
  // base plate (flared magazine foot)
  const base = superEllipsoid(0.0138, 0.0048, 0.0188, 0.45, 0.5, 10, 4);
  base.rotateX(tilt); P.add(at(base, 0, -0.062, -0.018), opt.baseCol || C.dark, M.gloss);
  // trigger guard (loop in front of the index finger) + trigger blade
  const g0 = new V3(0, 0.03, 0.012), g1 = new V3(0, 0.018, 0.043), g2 = new V3(0, 0.002, 0.05), g3 = new V3(0, -0.006, 0.028);
  const guard = sweep([g0, g1, g2, g3], { seg: 8, radial: 5, capSteps: 2, radius: () => 0.0032, flat: 1.9, outward: (Pp, o) => o.set(1, 0, 0) });
  P.add(guard.geo, C.dark, M.satin);
  const trig = superEllipsoid(0.0034, 0.0105, 0.0034, 0.7, 0.7, 6, 6, (q) => { q.z += 16 * q.y * q.y; });
  trig.rotateX(-0.25); P.add(at(trig, 0, 0.0215, 0.0305), C.metal, M.metal);
}
const GRIP_PISTOL = { pos: new V3(0, 0, 0), handZ: GRIP_AXIS.clone(), handY: new V3(0, 0.25, -1) };

// ---------------------------------------------------------------------------------------------- shooter
function buildShooter() {
  const P = new Parts(), I = new Parts();
  pistolGrip(P);
  // receiver: cream shell, dark lower frame, team-ink spine
  const recv = superEllipsoid(0.0265, 0.034, 0.1, 0.42, 0.56, 14, 10, (q) => {
    if (q.z > 0.045) q.y *= 1 - 0.3 * (q.z - 0.045) / 0.055;          // taper to the nose
    if (q.y > 0) q.x *= 1 - 0.12 * (q.y / 0.034);                       // tumblehome
  });
  P.add(at(recv, 0, 0.068, 0.028), C.cream, M.satin);
  const frame = superEllipsoid(0.0232, 0.012, 0.094, 0.4, 0.5, 12, 6);
  P.add(at(frame, 0, 0.041, 0.03), C.dark, M.satin);
  const spine = superEllipsoid(0.0165, 0.0065, 0.086, 0.5, 0.6, 12, 5);
  I.add(at(spine, 0, 0.1005, 0.02));
  // panel seams + screws on both flanks, squid decal + chevrons on the left flank
  for (const sx of [1, -1]) {
    const seam = superEllipsoid(0.0006, 0.0205, 0.0006, 1, 1, 4, 6); P.add(at(seam, sx * 0.0262, 0.069, 0.052), C.darker, M.print);
    const seam2 = superEllipsoid(0.0006, 0.0006, 0.054, 1, 1, 4, 6); P.add(at(seam2, sx * 0.0258, 0.056, 0.016), C.darker, M.print);
    for (const [y, z] of [[0.078, -0.052], [0.078, 0.036], [0.05, 0.094]]) screw(P, new V3(sx * 0.026, y, z), new V3(sx, 0, 0), 0.0028);
  }
  const sq = decal(squidShape(0.028)); placeXY(sq, new V3(0, 0, -1), new V3(0, 1, 0), new V3(0.0272, 0.074, -0.012)); P.add(sq, C.decal, M.print);
  for (const s of chevronShape(0.03, 0.009, 3, 0.45)) { const g = decal(s); placeXY(g, new V3(0, 0, 1), new V3(0, 1, 0), new V3(0.0268, 0.052, 0.036)); I.add(g); }
  // nozzle assembly: turned barrel, vented shroud, team ring, flared tip
  const barrel = latheZ(smoothProfile([[0.0, 0.1], [0.0138, 0.1], [0.0138, 0.118], [0.0156, 0.121], [0.0156, 0.162], [0.0138, 0.166], [0.0125, 0.17], [0.0125, 0.184]], 10).concat([[0.0152, 0.187], [0.019, 0.199], [0.0198, 0.207], [0.0186, 0.2118], [0.0128, 0.2122], [0.0098, 0.207], [0.0082, 0.196], [0.0, 0.194]]), 12);
  P.add(at(barrel, 0, 0.066, 0), C.gunmetal, M.metal);
  for (let k = 0; k < 3; k++) { const v = torus(0.0158, 0.0013, 3, 12); P.add(at(v, 0, 0.066, 0.127 + k * 0.012), C.darker, M.satin); }
  const nr = torus(0.0145, 0.0034, 4, 14); I.add(at(nr, 0, 0.066, 0.176));
  // ink canister on top: team ink visible between cage bars, caps + valve
  const can = latheZ(smoothProfile([[0.0, -0.052], [0.0178, -0.05], [0.0184, -0.04], [0.0184, 0.04], [0.0178, 0.05], [0.0, 0.052]], 7), 12);
  I.add(at(can, 0, 0.123, 0.018));
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const bar = superEllipsoid(0.0026, 0.0026, 0.044, 0.6, 0.6, 4, 4);
    P.add(at(bar, Math.cos(a) * 0.0196, 0.123 + Math.sin(a) * 0.0196, 0.018), C.dark, M.satin);
  }
  for (const [z, s] of [[-0.036, -1], [0.072, 1]]) {
    const cap = latheZ([[0, -0.009 * s], [0.0206, -0.009 * s], [0.0218, -0.004 * s], [0.0218, 0.006 * s], [0.018, 0.0095 * s], [0, 0.01 * s]], 12);
    P.add(at(cap, 0, 0.123, z), C.dark, M.gloss);
  }
  const valve = lathe([[0, 0], [0.0052, 0], [0.0052, 0.006], [0.0078, 0.0075], [0.0078, 0.011], [0, 0.0115]], 8);
  P.add(at(valve, 0, 0.143, -0.028), C.metal, M.metal);
  const mount = superEllipsoid(0.0118, 0.012, 0.05, 0.5, 0.6, 8, 5); P.add(at(mount, 0, 0.105, 0.018), C.dark, M.satin);
  // sights + status LED
  const rear = superEllipsoid(0.0105, 0.0065, 0.0052, 0.4, 0.4, 6, 4, (q) => { if (q.y > 0.002 && Math.abs(q.x) < 0.003) q.y = 0.002; });
  P.add(at(rear, 0, 0.148, -0.03), C.darker, M.satin);
  const front = superEllipsoid(0.0022, 0.0078, 0.004, 0.6, 0.6, 5, 4); P.add(at(front, 0, 0.1485, 0.068), C.darker, M.satin);
  const led = superEllipsoid(0.0032, 0.0032, 0.0016, 1, 1, 8, 4); P.add(orient(led, new V3(-1, 0, 0), new V3(-0.0268, 0.084, -0.046)), C.green, M.led);
  // rear cap + cocking knob
  const back = superEllipsoid(0.0232, 0.028, 0.0095, 0.45, 0.55, 10, 6); P.add(at(back, 0, 0.068, -0.075), C.dark, M.gloss);
  const knob = latheZ([[0, -0.0145], [0.0068, -0.0145], [0.0074, -0.01], [0.0074, 0.0], [0, 0.0]], 10); P.add(at(knob, 0, 0.068, -0.078), C.metal, M.metal);
  // support foregrip for the left hand (vertical, under the nose)
  const fg = superEllipsoid(0.0118, 0.028, 0.0132, 0.55, 0.65, 10, 8, (q) => { if (q.z > 0) { const f = 0.5 + 0.5 * Math.cos((q.y / 0.0125) * Math.PI * 2); q.z -= 0.0012 * f; } });
  fg.rotateX(-0.12); P.add(at(fg, 0, 0.016, 0.07), C.darker, M.satin);
  const fgr = superEllipsoid(0.0124, 0.0175, 0.0095, 0.5, 0.55, 8, 6); fgr.rotateX(-0.12); P.add(at(fgr, 0, 0.012, 0.069), C.rubber, M.rubber);
  const fgCap = superEllipsoid(0.0134, 0.0042, 0.0152, 0.5, 0.5, 10, 4); P.add(at(fgCap, 0, -0.0125, 0.074), C.dark, M.gloss);
  return {
    kind: 'shooter', body: P.build(), ink: I.build(),
    muzzle: new V3(0, 0.066, 0.212),
    gripR: GRIP_PISTOL,
    gripL: { pos: new V3(0, 0.02, 0.0705), handZ: new V3(0, 1, -0.12), handY: new V3(0.45, -0.05, -1) },
    twirl: new V3(0, 0.03, 0.03),
  };
}

// ---------------------------------------------------------------------------------------------- roller
function buildRoller() {
  const P = new Parts(), I = new Parts();
  const L = 0.84; // grip -> drum axis
  // shaft: brushed tube, ferrules, two knurled rubber grips (top = right hand, mid = left hand)
  P.add(latheZ([[0, -0.072], [0.0098, -0.072], [0.0098, 0.715], [0, 0.715]], 10), C.metal, M.metal);
  const topGrip = latheZ(smoothProfile([[0, -0.094], [0.0112, -0.094], [0.0148, -0.086], [0.0142, -0.07], [0.0136, -0.03], [0.0138, 0.02], [0.0142, 0.052], [0.0158, 0.06], [0.0118, 0.066]], 10), 12);
  P.add(topGrip, C.rubber, M.rubber);
  const cap = latheZ([[0, -0.1], [0.0118, -0.0985], [0.0142, -0.094], [0, -0.094]], 12); P.add(cap, C.dark, M.gloss);
  I.add(at(torus(0.0142, 0.0028, 5, 14), 0, 0, 0.066));
  const midGrip = latheZ(smoothProfile([[0.0098, 0.13], [0.0136, 0.136], [0.0142, 0.15], [0.0138, 0.2], [0.0142, 0.235], [0.0136, 0.25], [0.0098, 0.256]], 8), 10);
  P.add(midGrip, C.rubber, M.rubber);
  for (const z of [0.128, 0.258]) I.add(at(torus(0.0118, 0.0022, 4, 12), 0, 0, z));
  // hazard band + squid decal wrapped on the shaft
  for (let k = 0; k < 5; k++) { const band = latheZ([[0.0101, 0], [0.0101, 0.008]], 8); P.add(at(band, 0, 0, 0.34 + k * 0.016), k % 2 ? C.dark : C.hazard, M.print); }
  // yoke: cast hub, twin swept arms, bearing bosses with bolt circles, ink reservoir with a window
  const hub = superEllipsoid(0.026, 0.024, 0.036, 0.5, 0.6, 12, 8); P.add(at(hub, 0, 0, 0.716), C.dark, M.satin);
  const collar = latheZ([[0.0098, 0.69], [0.0162, 0.692], [0.0168, 0.702], [0.0098, 0.704]], 12); P.add(collar, C.metal, M.metal);
  for (const sx of [1, -1]) {
    const arm = sweep([new V3(0, 0, 0.712), new V3(0.13 * sx, -0.004, 0.734), new V3(0.285 * sx, -0.012, 0.768), new V3(0.328 * sx, -0.02, 0.808), new V3(0.334 * sx, -0.022, L)], {
      seg: 12, radial: 7, capSteps: 2, radius: (t) => 0.0122 - 0.002 * t, flat: 0.62, outward: (Pp, o) => o.set(0, 1, 0),
    });
    P.add(arm.geo, C.gunmetal, M.metal);
    const boss = latheZ([[0, -0.014], [0.0262, -0.014], [0.0282, -0.01], [0.0284, 0.008], [0.025, 0.013], [0, 0.013]], 12);
    boss.rotateY(Math.PI / 2); P.add(at(boss, 0.322 * sx, -0.022, L), C.dark, M.gloss);
    for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI * 2; screw(P, new V3(0.3355 * sx, -0.022 + Math.cos(a) * 0.017, L + Math.sin(a) * 0.017), new V3(sx, 0, 0), 0.0024); }
  }
  const res = superEllipsoid(0.056, 0.026, 0.036, 0.55, 0.6, 12, 7); I.add(at(res, 0, 0.03, 0.738));
  const resFrame = superEllipsoid(0.06, 0.009, 0.04, 0.4, 0.5, 14, 4); P.add(at(resFrame, 0, 0.052, 0.738), C.dark, M.gloss);
  const resBase = superEllipsoid(0.06, 0.008, 0.04, 0.4, 0.5, 14, 4); P.add(at(resBase, 0, 0.008, 0.738), C.dark, M.satin);
  for (const sx of [1, -1]) for (const sz of [1, -1]) { const post = superEllipsoid(0.004, 0.02, 0.004, 0.7, 0.7, 5, 5); P.add(at(post, sx * 0.05, 0.03, 0.738 + sz * 0.028), C.dark, M.satin); }
  const vcap = lathe([[0, 0], [0.009, 0], [0.0098, 0.004], [0.0082, 0.0085], [0, 0.009]], 10); P.add(at(vcap, 0.028, 0.06, 0.738), C.metal, M.metal);
  const led = superEllipsoid(0.0036, 0.0022, 0.0036, 1, 1, 8, 4); P.add(at(led, -0.03, 0.062, 0.738), C.amber, M.led);
  const sq = decal(squidShape(0.032)); placeXY(sq, new V3(1, 0, 0), new V3(0, 0.3, -1), new V3(0, 0.0605, 0.738)); P.add(sq, C.decal, M.print);
  // drum (separate spinning mesh): axis along X, centred at origin; lumpy wet ink with raised tread ribs
  const drumProf = smoothProfile([[0.0, -0.3], [0.07, -0.3], [0.09, -0.296], [0.099, -0.283], [0.1015, -0.25], [0.1015, 0.25], [0.099, 0.283], [0.09, 0.296], [0.07, 0.3], [0.0, 0.3]], 16);
  const drum = lathe(drumProf, 26, (v) => {
    const a = Math.atan2(v.z, v.x); const rr = Math.hypot(v.x, v.z);
    if (rr > 0.085) {
      let k = 1 + 0.03 * Math.sin(a * 7 + v.y * 21) * Math.sin(a * 3 - v.y * 13);
      k += 0.018 * Math.max(0, Math.cos(v.y * 42)) * (Math.abs(v.y) < 0.26 ? 1 : 0);   // tread ribs
      v.x *= k; v.z *= k;
    }
  });
  drum.rotateZ(Math.PI / 2);
  const caps = new Parts();
  for (const sx of [1, -1]) {
    const c = latheZ([[0, -0.007], [0.074, -0.007], [0.081, -0.002], [0.081, 0.003], [0.064, 0.008], [0.03, 0.009], [0.018, 0.013], [0, 0.013]], 16);
    c.rotateY(sx * Math.PI / 2); caps.add(at(c, 0.302 * sx, 0, 0), C.dark, M.gloss);
    for (let k = 0; k < 4; k++) { const a = (k / 4) * Math.PI * 2 + 0.4; const b = lathe([[0, 0], [0.0042, 0], [0.0042, 0.002], [0, 0.0028]], 5); caps.add(orient(b, new V3(sx, 0, 0), new V3(0.3085 * sx + 0.002 * sx, Math.cos(a) * 0.05, Math.sin(a) * 0.05)), C.metal, M.metal); }
    const hubC = latheZ([[0, 0], [0.016, 0], [0.018, 0.006], [0.012, 0.012], [0, 0.013]], 10); hubC.rotateY(sx * Math.PI / 2); caps.add(at(hubC, 0.309 * sx, 0, 0), C.metal, M.metal);
  }
  return {
    kind: 'roller', body: P.build(), ink: I.build(), drum, drumCaps: caps.build(), drumAt: new V3(0, -0.022, L), drumR: 0.1,
    muzzle: new V3(0, -0.022, L),
    gripR: { pos: new V3(0, 0, -0.022), handZ: new V3(0, 0, 1), handY: new V3(-0.3, 1, 0) },
    gripL: { pos: new V3(0, 0, 0.19), handZ: new V3(0, 0, 1), handY: new V3(0.5, 1, 0) },
    twirl: new V3(0, 0, 0),
  };
}

// ---------------------------------------------------------------------------------------------- charger
function buildCharger() {
  const P = new Parts(), I = new Parts(), G = new Parts();
  pistolGrip(P);
  // receiver: long white body with a team-ink spine and dark rails
  const rec = superEllipsoid(0.0255, 0.038, 0.13, 0.4, 0.56, 14, 10, (q) => { if (q.z > 0.07) q.y *= 1 - 0.3 * (q.z - 0.07) / 0.06; if (q.y > 0) q.x *= 1 - 0.1 * q.y / 0.038; });
  P.add(at(rec, 0, 0.062, 0.035), C.white, M.satin);
  const recLow = superEllipsoid(0.0225, 0.011, 0.12, 0.4, 0.5, 12, 5); P.add(at(recLow, 0, 0.034, 0.04), C.dark, M.satin);
  const spine = superEllipsoid(0.0155, 0.0058, 0.11, 0.5, 0.6, 12, 5); I.add(at(spine, 0, 0.0975, 0.03));
  for (const sx of [1, -1]) {
    for (const [y, z] of [[0.07, -0.065], [0.07, 0.03], [0.07, 0.125]]) screw(P, new V3(sx * 0.0252, y, z), new V3(sx, 0, 0), 0.0026);
    const seam = superEllipsoid(0.0006, 0.0006, 0.095, 1, 1, 4, 6); P.add(at(seam, sx * 0.0248, 0.05, 0.035), C.darker, M.print);
  }
  const sq = decal(squidShape(0.026)); placeXY(sq, new V3(0, 0, -1), new V3(0, 1, 0), new V3(0.026, 0.066, -0.02)); P.add(sq, C.decal, M.print);
  // skeletal stock + rubber butt pad + cheek rest
  const stockTop = superEllipsoid(0.0115, 0.009, 0.088, 0.5, 0.6, 8, 5); stockTop.rotateX(0.04); P.add(at(stockTop, 0, 0.066, -0.17), C.dark, M.satin);
  const stockLow = sweep([new V3(0, 0.03, -0.09), new V3(0, 0.012, -0.16), new V3(0, 0.004, -0.228), new V3(0, 0.012, -0.252)], { seg: 8, radial: 6, capSteps: 2, radius: () => 0.0072, flat: 1.6, outward: (Pp, o) => o.set(1, 0, 0) });
  P.add(stockLow.geo, C.dark, M.satin);
  const cheek = superEllipsoid(0.0128, 0.006, 0.04, 0.5, 0.6, 8, 4); P.add(at(cheek, 0, 0.078, -0.16), C.rubber, M.rubber);
  const pad = superEllipsoid(0.0138, 0.042, 0.0078, 0.45, 0.55, 8, 8); pad.rotateX(0.08); P.add(at(pad, 0, 0.038, -0.262), C.rubber, M.rubber);
  // long barrel: fluted sleeve, charge coil (glow), muzzle brake with ports
  const barrel = latheZ(smoothProfile([[0, 0.14], [0.0122, 0.14], [0.0122, 0.61], [0.0128, 0.622]], 6).concat([[0.0178, 0.626], [0.0182, 0.672], [0.0165, 0.684], [0.0096, 0.684], [0.0, 0.68]]), 10);
  P.add(at(barrel, 0, 0.058, 0), C.gunmetal, M.metal);
  for (let k = 0; k < 2; k++) { const port = superEllipsoid(0.0186, 0.0026, 0.004, 0.6, 0.6, 8, 4); P.add(at(port, 0, 0.058, 0.642 + k * 0.016), C.darker, M.satin); }
  const guard = superEllipsoid(0.0232, 0.026, 0.1, 0.42, 0.56, 12, 8, (q) => { if (q.y < 0) q.x *= 0.92; });
  P.add(at(guard, 0, 0.046, 0.23), C.white, M.satin);
  for (let k = 0; k < 3; k++) { const vent = superEllipsoid(0.0236, 0.0028, 0.012, 0.6, 0.6, 8, 4); P.add(at(vent, 0, 0.056, 0.196 + k * 0.026), C.darker, M.satin); }
  for (let i = 0; i < 4; i++) { const c = torus(0.0232, 0.0056, 5, 14); G.add(at(c, 0, 0.058, 0.365 + i * 0.047), '#ffffff'); }
  const coilCore = latheZ([[0.0168, 0.343], [0.0178, 0.35], [0.0178, 0.522], [0.0168, 0.53]], 12); P.add(at(coilCore, 0, 0.058, 0), C.darker, M.metal);
  for (const z of [0.34, 0.534]) { const r = latheZ([[0.0122, z - 0.006], [0.028, z - 0.005], [0.029, z], [0.028, z + 0.005], [0.0122, z + 0.006]], 12); P.add(at(r, 0, 0.058, 0), C.dark, M.gloss); }
  // underslung handguard for the left hand (horizontal grip)
  const hg = latheZ(smoothProfile([[0.0, 0.176], [0.0112, 0.178], [0.0132, 0.186], [0.0134, 0.236], [0.0128, 0.252], [0.0, 0.256]], 8), 12);
  P.add(at(hg, 0, 0.004, 0), C.rubber, M.rubber);
  const hgMount = superEllipsoid(0.008, 0.012, 0.03, 0.5, 0.6, 6, 5); P.add(at(hgMount, 0, 0.018, 0.216), C.dark, M.satin);
  // scope: tube, turrets, lens + sunshade, mounts
  const scope = latheZ(smoothProfile([[0, -0.052], [0.0182, -0.051], [0.0196, -0.038], [0.0162, -0.022], [0.0162, 0.104], [0.021, 0.124], [0.0225, 0.158], [0.0205, 0.162], [0.0, 0.16]], 9), 14);
  P.add(at(scope, 0, 0.122, 0), C.dark, M.satin);
  const lens = superEllipsoid(0.0192, 0.0192, 0.003, 1, 1, 12, 4); P.add(at(lens, 0, 0.122, 0.1605), C.lens, M.lens);
  const lensB = superEllipsoid(0.0158, 0.0158, 0.0024, 1, 1, 10, 4); P.add(at(lensB, 0, 0.122, -0.0525), C.lens, M.lens);
  I.add(at(torus(0.0212, 0.0022, 3, 14), 0, 0.122, 0.157));
  for (const [dir, p] of [[new V3(0, 1, 0), new V3(0, 0.1375, 0.04)], [new V3(1, 0, 0), new V3(0.0155, 0.122, 0.04)]]) {
    const t = lathe([[0, 0], [0.0074, 0], [0.0076, 0.006], [0.0066, 0.0085], [0, 0.009]], 10); P.add(orient(t, dir, p), C.metal, M.metal);
  }
  for (const z of [-0.005, 0.085]) { const m = superEllipsoid(0.0092, 0.0162, 0.0105, 0.5, 0.6, 6, 5); P.add(at(m, 0, 0.102, z), C.dark, M.satin); }
  // visible ink cartridge under the receiver (windowed)
  const can = superEllipsoid(0.0158, 0.0158, 0.036, 1, 1, 10, 7); I.add(at(can, 0, 0.012, 0.118));
  for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI * 2 + 0.5; const bar = superEllipsoid(0.0024, 0.0024, 0.032, 0.6, 0.6, 4, 4); P.add(at(bar, Math.cos(a) * 0.0172, 0.012 + Math.sin(a) * 0.0172, 0.118), C.dark, M.satin); }
  for (const z of [0.082, 0.154]) { const c = latheZ([[0, z - 0.004], [0.0182, z - 0.004], [0.0186, z + 0.004], [0, z + 0.004]], 12); P.add(at(c, 0, 0.012, 0), C.dark, M.gloss); }
  return {
    kind: 'charger', body: P.build(), ink: I.build(), glow: G.build(),
    muzzle: new V3(0, 0.058, 0.686),
    gripR: GRIP_PISTOL,
    gripL: { pos: new V3(0, 0.004, 0.214), handZ: new V3(0, 0, 1), handY: new V3(0.75, -0.62, -0.1) },
    twirl: new V3(0, 0.03, 0.03),
  };
}

// ---------------------------------------------------------------------------------------------- blaster
function buildBlaster() {
  const P = new Parts(), I = new Parts();
  pistolGrip(P, { baseCol: C.dark });
  // pressurised ink bulb in a cream cage
  const bulb = superEllipsoid(0.066, 0.063, 0.084, 0.85, 0.9, 18, 12); I.add(at(bulb, 0, 0.092, 0.072));
  for (const z of [0.022, 0.072, 0.122]) { const r = torus(z === 0.072 ? 0.0655 : 0.058, 0.0068, 5, 20); P.add(at(r, 0, 0.092, z), C.cream, M.gloss); }
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const rib = sweep([new V3(Math.cos(a) * 0.05, 0.092 + Math.sin(a) * 0.05, -0.006), new V3(Math.cos(a) * 0.069, 0.092 + Math.sin(a) * 0.069, 0.072), new V3(Math.cos(a) * 0.052, 0.092 + Math.sin(a) * 0.052, 0.148)], {
      seg: 8, radial: 4, capSteps: 2, radius: () => 0.0042, flat: 0.7, outward: (Pp, o) => o.set(Pp.x, Pp.y - 0.092, 0).normalize(),
    });
    P.add(rib.geo, C.cream, M.gloss);
  }
  const back = superEllipsoid(0.056, 0.056, 0.024, 0.6, 0.9, 14, 7); P.add(at(back, 0, 0.092, -0.016), C.cream, M.satin);
  const gauge = latheZ([[0, -0.006], [0.0128, -0.006], [0.0132, 0.0], [0.011, 0.002], [0, 0.002]], 14); P.add(at(gauge, 0, 0.092, -0.042), C.metal, M.metal);
  const face = superEllipsoid(0.0105, 0.0105, 0.001, 1, 1, 12, 4); P.add(at(face, 0, 0.092, -0.0445), C.white, M.gloss);
  const needle = superEllipsoid(0.0006, 0.0072, 0.0006, 0.8, 0.8, 4, 4); needle.rotateZ(-0.7); P.add(at(needle, 0.0025, 0.0948, -0.0456), C.red, M.gloss);
  // bell muzzle: flared cream horn, dark throat, team lip
  const bell = latheZ(smoothProfile([[0.035, 0.13], [0.041, 0.16], [0.043, 0.2], [0.05, 0.24], [0.064, 0.29], [0.078, 0.325]], 9).concat([[0.082, 0.335], [0.078, 0.345], [0.066, 0.34], [0.05, 0.31], [0.034, 0.28], [0.0, 0.27]]), 18);
  P.add(at(bell, 0, 0.092, 0), C.cream, M.gloss);
  I.add(at(torus(0.078, 0.0068, 5, 18), 0, 0.092, 0.337));
  const inner = latheZ([[0.0, 0.275], [0.03, 0.28], [0.05, 0.305], [0.068, 0.335], [0.0, 0.335]], 16); P.add(at(inner, 0, 0.092, 0.001), C.darker, M.satin);
  for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; const fin = superEllipsoid(0.0024, 0.0125, 0.034, 0.6, 0.6, 4, 5, (q) => { q.y += 0.25 * q.z; }); fin.rotateZ(a); P.add(at(fin, Math.cos(a + Math.PI / 2) * -0.05, 0.092 + Math.sin(a + Math.PI / 2) * -0.05, 0.215), C.bone, M.satin); }
  // top carry rail + sight, side vents, decals
  const rail = superEllipsoid(0.0078, 0.0085, 0.06, 0.5, 0.6, 8, 5); P.add(at(rail, 0, 0.165, 0.05), C.dark, M.satin);
  const sight = superEllipsoid(0.0045, 0.0085, 0.006, 0.5, 0.5, 6, 4); P.add(at(sight, 0, 0.177, 0.088), C.darker, M.satin);
  for (const sx of [1, -1]) {
    for (let k = 0; k < 3; k++) { const v = superEllipsoid(0.002, 0.0026, 0.012, 0.6, 0.6, 4, 4); P.add(at(v, sx * 0.0548, 0.107 - k * 0.012, -0.012), C.darker, M.satin); }
    screw(P, new V3(sx * 0.0562, 0.075, -0.01), new V3(sx, 0, 0), 0.003);
  }
  const sq = decal(squidShape(0.03)); placeXY(sq, new V3(0, 0, -1), new V3(0, 1, 0), new V3(0.0485, 0.098, -0.02)); P.add(sq, C.decal, M.print);
  // pump foregrip for the left hand + slide tube
  const tube = latheZ([[0, 0.04], [0.0092, 0.04], [0.0092, 0.19], [0, 0.19]], 10); P.add(at(tube, 0, 0.012, 0), C.metal, M.metal);
  const pump = latheZ(smoothProfile([[0.0, 0.118], [0.0118, 0.12], [0.0138, 0.128], [0.0138, 0.176], [0.0126, 0.186], [0.0, 0.188]], 8), 12);
  P.add(at(pump, 0, 0.012, 0), C.rubber, M.rubber);
  for (let k = 0; k < 4; k++) P.add(at(torus(0.0139, 0.0012, 3, 12), 0, 0.012, 0.134 + k * 0.012), C.darker, M.satin);
  const link = superEllipsoid(0.007, 0.022, 0.012, 0.5, 0.6, 6, 6); P.add(at(link, 0, 0.034, 0.152), C.dark, M.satin);
  return {
    kind: 'blaster', body: P.build(), ink: I.build(),
    muzzle: new V3(0, 0.092, 0.345),
    gripR: GRIP_PISTOL,
    gripL: { pos: new V3(0, 0.012, 0.152), handZ: new V3(0, 0, 1), handY: new V3(0.8, -0.55, -0.1) },
    twirl: new V3(0, 0.03, 0.03),
  };
}

const _cache = new Map();
const BUILDERS = { shooter: buildShooter, roller: buildRoller, charger: buildCharger, blaster: buildBlaster };
export const WEAPON_KINDS = Object.keys(BUILDERS);

/** Hand bone frame (wrist origin) expressed in weapon space, from a grip spec and that hand's grip-hole offset. */
function handInWeapon(grip, hole) {
  const Y = grip.handY.clone().normalize();
  const Z = grip.handZ.clone().addScaledVector(Y, -grip.handZ.dot(Y)).normalize();
  const X = new V3().crossVectors(Y, Z).normalize();
  const m = new THREE.Matrix4().makeBasis(X, Y, Z);
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  const pos = grip.pos.clone().sub(hole.clone().applyQuaternion(q));
  return { pos, quat: q };
}

// ---------------------------------------------------------------------------------------------- sub: splat bomb prop
/** Hand-held splat bomb (held by its knurled cap in the LEFT fist while the sub is aimed).
 *  Bomb space: cap handle axis along +Y through the origin; ink bulb hangs below. */
function buildBomb() {
  const P = new Parts(), I = new Parts();
  P.add(lathe(smoothProfile([[0, -0.014], [0.0118, -0.014], [0.0128, -0.008], [0.0128, 0.009], [0.0104, 0.0145], [0, 0.0155]], 8), 14), C.rubber, M.rubber);
  P.add(lathe([[0, 0.015], [0.0048, 0.015], [0.0048, 0.021], [0.0062, 0.0225], [0, 0.024]], 8), C.metal, M.metal);
  P.add(lathe(smoothProfile([[0, -0.03], [0.022, -0.029], [0.0215, -0.019], [0.0142, -0.0145], [0, -0.014]], 6), 16), C.dark, M.gloss);
  const bulb = lathe(smoothProfile([[0, -0.118], [0.03, -0.114], [0.047, -0.098], [0.052, -0.074], [0.046, -0.05], [0.031, -0.034], [0.0185, -0.027], [0, -0.026]], 14), 20);
  I.add(bulb);
  P.add(at(torus(0.0515, 0.0042, 5, 20), 0, 0, 0).rotateX(Math.PI / 2).translate(0, -0.074, 0), C.cream, M.gloss);
  for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI * 2; const fin = superEllipsoid(0.0035, 0.018, 0.012, 0.6, 0.6, 4, 5); fin.rotateY(a); P.add(at(fin, Math.sin(a) * 0.043, -0.052, Math.cos(a) * 0.043), C.cream, M.gloss); }
  const led = superEllipsoid(0.0028, 0.0028, 0.0028, 1, 1, 8, 5); P.add(at(led, 0, -0.022, 0.0205), C.red, M.led);
  const sq = decal(squidShape(0.026)); placeXY(sq, new V3(1, 0, 0), new V3(0, 1, 0), new V3(0, -0.075, 0.0548)); P.add(sq, C.decal, M.print);
  return { kind: 'bomb', body: P.build(), ink: I.build(), grip: { pos: new V3(0, 0, 0), handZ: new V3(0, 1, 0), handY: new V3(0.3, 0.1, -1) } };
}
const _subCache = new Map();
/** Sub-weapon prop for the LEFT hand: { body, ink, handL:{pos,quat} (hand in prop space), inHandL:{pos,quat} (prop in hand space) }.
 *  Attach like a weapon: prop group under handL at inHandL (plastic body + team ink material). */
export function getSubDef(kind = 'bomb') {
  if (!_subCache.has(kind)) {
    const d = buildBomb();
    d.handL = handInWeapon(d.grip, GRIP_HOLE_L);
    const inv = new THREE.Matrix4().compose(d.handL.pos, d.handL.quat, new V3(1, 1, 1)).invert();
    d.inHandL = { pos: new V3(), quat: new THREE.Quaternion() };
    inv.decompose(d.inHandL.pos, d.inHandL.quat, new V3());
    _subCache.set(kind, d);
  }
  return _subCache.get(kind);
}

export function getWeaponDef(kind) {
  if (!_cache.has(kind)) {
    const d = (BUILDERS[kind] || buildShooter)();
    d.handR = handInWeapon(d.gripR, GRIP_HOLE_R);
    d.handL = handInWeapon(d.gripL, GRIP_HOLE_L);
    // weapon relative to right hand bone
    const inv = new THREE.Matrix4().compose(d.handR.pos, d.handR.quat, new V3(1, 1, 1)).invert();
    d.inHand = { pos: new V3(), quat: new THREE.Quaternion() };
    inv.decompose(d.inHand.pos, d.inHand.quat, new V3());
    _cache.set(kind, d);
  }
  return _cache.get(kind);
}
