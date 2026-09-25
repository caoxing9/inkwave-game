// Non-colliding arena dressing: spawn launch pads + spawn barriers, team flags, harbour lamp posts, palms.
//
//   const decor = new Decor(scene, level);   decor.group · decor.setTeamColors([colA, colB]) · decor.update(dt)
//   decor.pulse(team, strength = 1)          // spawn-pad flare (respawns / super jumps home): ring wave + brighter barrier
//
// Everything static is merged per material (all lamps = 2 meshes, all palms = 2 meshes, all flag poles = 1 mesh, both
// flags' cloth = 1 instanced mesh), so the whole decor set costs ≈ 12 draw calls + its shadow casters. update() only
// writes uniforms (allocation-free).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { G } from '../core/ctx.js';

const TAU = Math.PI * 2;
const OUT = /* glsl */`
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;
const HASH = /* glsl */`
float dHash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float dNoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(dHash(i), dHash(i+vec2(1.0,0.0)), u.x), mix(dHash(i+vec2(0.0,1.0)), dHash(i+vec2(1.0,1.0)), u.x), u.y); }
`;

// ---------------------------------------------------------------------------------------------- shared helpers
// Paint a geometry with a flat vertex colour (for merging into one vertex-coloured mesh).
function tint(g, color, k = 1) {
  const c = new THREE.Color(color).multiplyScalar(k);
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}
const at = (g, x, y, z, rx = 0, ry = 0, rz = 0, s = 1) => g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(s, s, s)));
const lathe = (prof, seg = 16) => new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), seg);
function tube(pts, r, radial = 6) {
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
  return new THREE.TubeGeometry(curve, Math.max(4, pts.length * 4), r, radial, false);
}
function merge(list) {
  const clean = list.map((g) => { const x = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(x.attributes)) if (!['position', 'normal', 'color', 'uv'].includes(k)) x.deleteAttribute(k); return x; });
  return mergeGeometries(clean, false);
}
// Original squid emblem (white on transparent) — mantle with fins, round head, four tentacles, eye holes.
function emblemCanvas(size = 256, ring = true) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const x = cv.getContext('2d'), c = size / 2, s = size / 256;
  x.clearRect(0, 0, size, size);
  if (ring) { x.fillStyle = '#fff'; x.beginPath(); x.arc(c, c, 118 * s, 0, TAU); x.fill(); x.globalCompositeOperation = 'destination-out'; x.beginPath(); x.arc(c, c, 104 * s, 0, TAU); x.fill(); x.globalCompositeOperation = 'source-over'; }
  x.fillStyle = '#fff'; x.beginPath();
  const S = 78 * s, cy = c + 6 * s;
  x.moveTo(c, cy - S * 1.0);
  x.bezierCurveTo(c + 0.35 * S, cy - 0.7 * S, c + 0.45 * S, cy - 0.45 * S, c + 0.75 * S, cy - 0.25 * S);
  x.bezierCurveTo(c + 0.55 * S, cy - 0.1 * S, c + 0.5 * S, cy, c + 0.48 * S, cy + 0.2 * S);
  x.bezierCurveTo(c + 0.46 * S, cy + 0.45 * S, c + 0.3 * S, cy + 0.5 * S, c + 0.32 * S, cy + 0.8 * S);
  x.lineTo(c + 0.16 * S, cy + 0.62 * S); x.lineTo(c + 0.08 * S, cy + 0.85 * S); x.lineTo(c, cy + 0.62 * S);
  x.lineTo(c - 0.08 * S, cy + 0.85 * S); x.lineTo(c - 0.16 * S, cy + 0.62 * S); x.lineTo(c - 0.32 * S, cy + 0.8 * S);
  x.bezierCurveTo(c - 0.3 * S, cy + 0.5 * S, c - 0.46 * S, cy + 0.45 * S, c - 0.48 * S, cy + 0.2 * S);
  x.bezierCurveTo(c - 0.5 * S, cy, c - 0.55 * S, cy - 0.1 * S, c - 0.75 * S, cy - 0.25 * S);
  x.bezierCurveTo(c - 0.45 * S, cy - 0.45 * S, c - 0.35 * S, cy - 0.7 * S, c, cy - S);
  x.fill();
  x.globalCompositeOperation = 'destination-out';
  for (const sx of [-1, 1]) { x.beginPath(); x.ellipse(c + sx * 0.2 * S, cy + 0.05 * S, 0.13 * S, 0.17 * S, 0, 0, TAU); x.fill(); }
  x.globalCompositeOperation = 'source-over';
  for (const sx of [-1, 1]) { x.beginPath(); x.arc(c + sx * 0.2 * S + 0.03 * S, cy + 0.09 * S, 0.07 * S, 0, TAU); x.fill(); }
  return cv;
}

// ---------------------------------------------------------------------------------------------- spawn pad shaders
const PAD_FRAG = /* glsl */`
${HASH}
uniform vec3 uColor;
uniform float uTime;
uniform float uPulse;
uniform float uPulseT;
uniform sampler2D uEmblem;
varying vec2 vUv;
varying vec3 vW;
void main(){
  vec2 q = vUv * 2.0 - 1.0; float r = length(q); float a = atan(q.y, q.x + 1e-5);
  if (r > 1.0) discard;
  vec3 V = normalize(cameraPosition - vW);
  // glossy dark base with a soft sky reflection band and a moving sun glint
  vec3 base = mix(vec3(0.035, 0.04, 0.055), vec3(0.075, 0.085, 0.11), smoothstep(1.0, 0.0, r));
  float fres = pow(max(1.0 - clamp(V.y, 0.0, 1.0), 0.0), 3.0);
  base += vec3(0.16, 0.2, 0.26) * fres;
  // pooled ink in the centre: slow liquid swirl, wet highlight
  float n = dNoise(q * 3.2 + vec2(uTime * 0.25, -uTime * 0.18)) * 0.6 + dNoise(q * 7.0 - uTime * 0.3) * 0.4;
  float pool = smoothstep(0.58, 0.5, r + (n - 0.5) * 0.06);
  vec3 ink = uColor * (0.42 + 0.3 * n) + vec3(0.9) * pow(n, 7.0) * 1.4;
  base = mix(base, ink, pool);
  // emblem (white squid) in the pool
  vec2 eu = q / 0.46 * 0.5 + 0.5;
  float em = (eu.x > 0.0 && eu.x < 1.0 && eu.y > 0.0 && eu.y < 1.0) ? texture2D(uEmblem, eu).a : 0.0;
  base = mix(base, vec3(1.0) * (0.9 + 0.2 * uPulse), em * pool);
  // rings: bright outer rim, inner rim, dashed rotating track, radial ticks, chevrons pointing out
  float glow = 0.0;
  glow += smoothstep(0.022, 0.0, abs(r - 0.955)) * 1.3;
  glow += smoothstep(0.014, 0.0, abs(r - 0.6)) * 0.95;
  float dash = step(0.5, fract(a / 6.2831853 * 36.0 + uTime * 0.25));
  glow += smoothstep(0.018, 0.0, abs(r - 0.79)) * dash * 0.8;
  float tick = step(0.8, fract(a / 6.2831853 * 72.0)) * smoothstep(0.035, 0.0, abs(r - 0.88));
  glow += tick * 0.45;
  float sa = mod(a - uTime * 0.35, 6.2831853 / 6.0) - 3.14159265 / 6.0;
  vec2 pc = vec2(r - 0.7, sa * 0.7);
  float chev = smoothstep(0.02, 0.0, abs(pc.x - abs(pc.y) * 0.9)) * step(abs(pc.y), 0.07) * step(-0.06, pc.x);
  glow += chev * 0.9;
  // breathing idle + spawn pulse wave
  glow *= 0.85 + 0.15 * sin(uTime * 2.2);
  float wave = uPulse * smoothstep(0.09, 0.0, abs(r - uPulseT * 1.35)) * (1.0 - smoothstep(0.7, 1.35, uPulseT * 1.35));
  vec3 col = base + uColor * glow * 2.6 + (uColor * 2.2 + vec3(1.2)) * wave * 2.2;
  col += uColor * pool * uPulse * 0.8;
  // metal lip just inside the rim
  col = mix(col, vec3(0.5, 0.52, 0.56) * (0.6 + 0.6 * fres), smoothstep(0.975, 0.99, r));
  gl_FragColor = vec4(col, 1.0);
  ${OUT}
}`;
const BARRIER_FRAG = /* glsl */`
uniform vec3 uColor; uniform float uTime; uniform float uAlpha; uniform float uPulse;
varying vec2 vUv; varying vec3 vW; varying vec3 vN;
void main(){
  float h = vUv.y;
  // hex lattice on the cylinder
  vec2 p = vec2(vUv.x * 64.0, h * 9.0);
  p.x += step(1.0, mod(floor(p.y), 2.0)) * 0.5;
  vec2 f = fract(p) - 0.5;
  float hexEdge = smoothstep(0.43, 0.49, max(abs(f.x) * 1.15 + abs(f.y) * 0.6, abs(f.y) * 1.2));
  float scan = smoothstep(0.08, 0.0, abs(fract(h * 1.4 - uTime * 0.45) - 0.5) - 0.44);
  float fade = pow(max(1.0 - h, 0.0), 1.6);
  float base = smoothstep(0.0, 0.06, h);
  vec3 V = normalize(cameraPosition - vW);
  float rim = pow(max(1.0 - abs(dot(normalize(vN), V)), 0.0), 2.0);
  float a = (uAlpha + uPulse * 0.5) * fade * base * (0.25 + 0.75 * hexEdge + scan * 0.6) * (0.55 + 0.45 * rim);
  a += smoothstep(0.035, 0.0, h) * (0.5 + uAlpha);
  gl_FragColor = vec4(uColor * (1.5 + uPulse), a);
  ${OUT}
}`;
const WORLD_VERT = /* glsl */`
varying vec2 vUv; varying vec3 vW; varying vec3 vN;
void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = mat3(modelMatrix) * normal; gl_Position = projectionMatrix * viewMatrix * w; }`;

// ---------------------------------------------------------------------------------------------- flag cloth
const FLAG_W = 1.7, FLAG_H = 1.06;
const FLAG_PARS = /* glsl */`uniform float uTime;\n`;
const FLAG_DISP = /* glsl */`
  vec3 fip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  float fph = fip.x * 0.71 + fip.z * 0.43;
  float fk = clamp(position.x / ${FLAG_W.toFixed(2)}, 0.0, 1.0);
  float fa = position.x * 3.1 - uTime * 5.2 + fph;
  float fb = position.x * 5.7 + position.y * 3.9 - uTime * 7.9 + fph * 1.7;
  float fwav = (sin(fa) * 0.16 + sin(fb) * 0.045) * fk;
  float dwdx = (cos(fa) * 3.1 * 0.16 + cos(fb) * 5.7 * 0.045) * fk + (sin(fa) * 0.16 + sin(fb) * 0.045) / ${FLAG_W.toFixed(2)};
  float dwdy = cos(fb) * 3.9 * 0.045 * fk;
`;
function flagMaterial(emblemTex, uTime) {
  const m = new THREE.MeshStandardMaterial({ map: emblemTex, roughness: 0.78, metalness: 0, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = FLAG_PARS + sh.vertexShader
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        ${FLAG_DISP}
        objectNormal = normalize(vec3(-dwdx, -dwdy, 1.0));`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed.z += fwav;
        transformed.y -= fk * fk * 0.06 + fk * 0.03 * (0.5 + 0.5 * sin(uTime * 2.3 + fph));
        transformed.x -= fk * abs(fwav) * 0.12;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <map_fragment>', '')
      .replace('#include <color_fragment>', `
        vec4 fTx = texture2D(map, vMapUv);
        #if defined( USE_COLOR )
          diffuseColor.rgb *= vColor.rgb;
        #endif
        // hoist sleeve + fly-end hem stripes and the white emblem
        float sleeve = smoothstep(0.075, 0.065, vMapUv.x);
        float hem = smoothstep(0.955, 0.965, vMapUv.x);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93), max(fTx.a, sleeve));
        diffuseColor.rgb *= 1.0 - hem * 0.35;`);
  };
  return m;
}
function flagDepthMaterial(uTime) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = FLAG_PARS + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      ${FLAG_DISP}
      transformed.z += fwav;`);
  };
  return m;
}

// ---------------------------------------------------------------------------------------------- palm fronds (wind sway)
function frondMaterial(uTime) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = 'uniform float uTime;\nattribute float sway;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      float sph = position.x * 0.37 + position.z * 0.29;
      transformed.x += sin(uTime * 1.6 + sph) * 0.07 * sway;
      transformed.z += cos(uTime * 1.25 + sph * 1.3) * 0.06 * sway;
      transformed.y += sin(uTime * 2.1 + sph * 2.0) * 0.045 * sway * sway;`);
  };
  return m;
}

export class Decor {
  constructor(scene, level) {
    this.scene = scene; this.level = level;
    this.group = new THREE.Group();
    this.group.name = 'decor';
    scene.add(this.group);
    this.pads = []; this.flags = []; this.barriers = [];
    this.time = 0;
    this.uTime = { value: 0 };
    this.emblem = new THREE.CanvasTexture(emblemCanvas(256, true));
    this.emblem.colorSpace = THREE.SRGBColorSpace; this.emblem.anisotropy = 4;
    this._buildPads();
    this._buildLamps();
    this._buildPalms();
    this._buildFlags();
  }

  // ------------------------------------------------------------------ spawn pads
  _buildPads() {
    const L = this.level;
    // bevelled glossy base ring with a metal lip, recessed face and 24 lip bolts (one merged geometry, vertex colours)
    const parts = [];
    parts.push(tint(lathe([[1.93, 0.072], [1.97, 0.074], [2.01, 0.1], [2.1, 0.104], [2.17, 0.078], [2.2, 0.04], [2.22, 0.0]], 72), 0x2b2f3a));
    parts.push(tint(at(new THREE.TorusGeometry(2.055, 0.016, 6, 96), 0, 0.104, 0, Math.PI / 2), 0x9aa3ad));
    for (let i = 0; i < 24; i++) { const a = (i / 24) * TAU; parts.push(tint(at(new THREE.CylinderGeometry(0.022, 0.026, 0.02, 8), Math.cos(a) * 2.12, 0.1, Math.sin(a) * 2.12), 0xb8c0c8)); }
    for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU + 0.2; parts.push(tint(at(new THREE.BoxGeometry(0.26, 0.014, 0.03), Math.cos(a) * 2.135, 0.093, Math.sin(a) * 2.135, 0, -a - Math.PI / 2), 0x14161b)); }
    const baseGeo = merge(parts);
    const baseMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.55 });
    this._padBase = { geo: baseGeo, mat: baseMat };
    for (let t = 0; t < 2; t++) {
      const p = L.spawnPads[t];
      const g = new THREE.Group();
      g.position.copy(p);
      const base = new THREE.Mesh(baseGeo, baseMat);
      base.receiveShadow = true; base.name = 'spawnPad:base';
      g.add(base);
      const padMat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color() }, uTime: { value: 0 }, uPulse: { value: 0 }, uPulseT: { value: 1 }, uEmblem: { value: this.emblem } },
        vertexShader: WORLD_VERT, fragmentShader: PAD_FRAG,
      });
      const face = new THREE.Mesh(new THREE.CircleGeometry(1.95, 96).rotateX(-Math.PI / 2), padMat);
      face.position.y = 0.076; face.name = 'spawnPad:face';
      g.add(face);
      const barMat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
        uniforms: { uColor: { value: new THREE.Color() }, uTime: { value: 0 }, uAlpha: { value: 0.12 }, uPulse: { value: 0 } },
        vertexShader: WORLD_VERT, fragmentShader: BARRIER_FRAG,
      });
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(L.spawnBarrier, L.spawnBarrier, 2.6, 96, 1, true), barMat);
      bar.position.y = 1.3; bar.name = 'spawnPad:barrier';
      g.add(bar);
      this.group.add(g);
      this.pads.push({ g, padMat, barMat, team: t, pulse: 0, pulseT: 1 });
    }
  }

  // Flare a team's spawn pad (respawn / super jump home). strength 0..1+.
  pulse(team, strength = 1) {
    const p = this.pads[team];
    if (!p) return;
    p.pulse = Math.min(1.5, Math.max(p.pulse, strength));
    p.pulseT = 0;
  }

  // ------------------------------------------------------------------ lamps (all merged: body + glass)
  _buildLamps() {
    const L = this.level.layout;
    const pts = [...L.decor.lamps, ...L.decor.lamps.map(([x, z]) => [-x, -z])];
    const body = [], glass = [];
    const IRON = 0x2f3947, GOLD = 0xd9b45a, CREAM = 0xf1ece0;
    for (const [x, z] of pts) {
      const y = Math.max(0, this.level.groundHeight(x, z));
      const dir = x > 0 ? -1 : 1;     // arm reaches toward the arena centre
      const put = (g, c, k) => { g.translate(x, y, z); body.push(tint(g, c, k)); };
      put(lathe([[0, 0], [0.27, 0], [0.28, 0.04], [0.24, 0.1], [0.24, 0.16], [0.2, 0.2], [0.19, 0.42], [0.21, 0.46], [0.15, 0.52], [0.12, 0.62], [0.1, 0.7], [0, 0.7]], 20), IRON);
      // fluted shaft: slender lathe with a slight taper
      put(lathe([[0.1, 0.7], [0.085, 0.9], [0.075, 3.6], [0.068, 5.05], [0, 5.05]], 14), IRON);
      for (const yy of [0.9, 2.6, 4.55]) put(at(new THREE.TorusGeometry(0.088, 0.018, 6, 20), 0, yy, 0, Math.PI / 2), GOLD);
      // swan-neck arm with a scroll brace
      put(tube([[0, 4.9, 0], [0.18 * dir, 5.18, 0], [0.55 * dir, 5.22, 0], [0.9 * dir, 5.08, 0]], 0.032, 7), IRON);
      put(tube([[0.02 * dir, 4.45, 0], [0.22 * dir, 4.62, 0], [0.4 * dir, 4.95, 0], [0.5 * dir, 5.18, 0]], 0.016, 5), IRON);
      put(at(new THREE.SphereGeometry(0.06, 10, 8), 0, 5.12, 0), GOLD);
      // lantern: hood, cage bars, finial, bottom cup
      const hx = 0.92 * dir;
      put(at(lathe([[0, 0.3], [0.08, 0.29], [0.26, 0.12], [0.3, 0.08], [0.29, 0.06], [0.1, 0.06], [0, 0.06]], 20), hx, 4.92, 0), IRON);
      put(at(new THREE.SphereGeometry(0.05, 10, 8), hx, 5.26, 0), GOLD);
      put(at(lathe([[0, -0.26], [0.07, -0.25], [0.13, -0.2], [0.15, -0.16], [0, -0.16]], 16), hx, 4.92, 0), IRON);
      for (let k = 0; k < 4; k++) { const a = (k / 4) * TAU + 0.4; put(at(new THREE.CylinderGeometry(0.011, 0.011, 0.26, 5), hx + Math.cos(a) * 0.16, 4.89, Math.sin(a) * 0.16), IRON); }
      const gl = lathe([[0.001, -0.18], [0.1, -0.16], [0.17, -0.05], [0.18, 0.02], [0.13, 0.07], [0.001, 0.08]], 18);
      gl.translate(x + hx, y + 4.93, z);
      glass.push(tint(gl, CREAM));
      const bulb = new THREE.SphereGeometry(0.075, 12, 8); bulb.translate(x + hx, y + 4.9, z);
      glass.push(tint(bulb, 0xfff1cf, 1.0));
    }
    if (!pts.length) return;
    const bodyMesh = new THREE.Mesh(merge(body), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.55 }));
    bodyMesh.castShadow = true; bodyMesh.receiveShadow = true; bodyMesh.name = 'lamps:body';
    this.bulbMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.18, metalness: 0, emissive: 0xffd9a0, emissiveIntensity: 0.9, transparent: true, opacity: 0.92 });
    const glassMesh = new THREE.Mesh(merge(glass), this.bulbMat);
    glassMesh.name = 'lamps:glass';
    this.group.add(bodyMesh, glassMesh);
  }

  // ------------------------------------------------------------------ palms (trunks + coconuts merged, fronds merged with sway)
  _buildPalms() {
    const L = this.level.layout;
    const pts = [...L.decor.palms, ...L.decor.palms.map(([x, z]) => [-x, -z])];
    if (!pts.length) return;
    const trunks = [], fronds = [];
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    for (const [x, z] of pts) {
      const y = Math.max(0, this.level.groundHeight(x, z));
      const lean = rnd() * TAU, lx = Math.cos(lean), lz = Math.sin(lean);
      const H = 4.7 + rnd() * 0.5, bend = 1.0 + rnd() * 0.4;
      const curve = new THREE.CubicBezierCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(lx * bend * 0.1, H * 0.4, lz * bend * 0.1), new THREE.Vector3(lx * bend * 0.55, H * 0.75, lz * bend * 0.55), new THREE.Vector3(lx * bend, H, lz * bend));
      // ringed trunk: radius tapers, each ring gets a darker lip → banded look
      const segs = 44, radial = 12;
      const tg = new THREE.TubeGeometry(curve, segs, 1, radial, false);
      const P = tg.attributes.position, N = tg.attributes.normal, cols = new Float32Array(P.count * 3);
      const c0 = new THREE.Color(0x9a7650), c1 = new THREE.Color(0x7d5c3d), tmp = new THREE.Color();
      for (let i = 0; i < P.count; i++) {
        const seg = Math.floor(i / (radial + 1)), t = seg / segs;
        const cp = curve.getPoint(t);
        const band = (seg % 3 === 0) ? 1.12 : 1.0;
        const r = (0.2 - 0.075 * t + (t < 0.06 ? (0.06 - t) * 2.2 : 0)) * band;
        P.setXYZ(i, cp.x + N.getX(i) * r, cp.y + N.getY(i) * r, cp.z + N.getZ(i) * r);
        tmp.copy(seg % 3 === 0 ? c1 : c0).multiplyScalar(0.85 + 0.25 * t);
        cols[i * 3] = tmp.r; cols[i * 3 + 1] = tmp.g; cols[i * 3 + 2] = tmp.b;
      }
      tg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      tg.computeVertexNormals();
      tg.translate(x, y, z);
      trunks.push(tg);
      const top = curve.getPoint(1).add(new THREE.Vector3(x, y, z));
      // crown boss + coconuts
      trunks.push(tint(at(new THREE.SphereGeometry(0.2, 12, 8), top.x, top.y + 0.02, top.z), 0x6f5236));
      for (let k = 0; k < 4; k++) { const a = (k / 4) * TAU + rnd(); trunks.push(tint(at(new THREE.SphereGeometry(0.11, 10, 8), top.x + Math.cos(a) * 0.15, top.y - 0.14, top.z + Math.sin(a) * 0.15), 0x5b4a2c)); }
      // fronds: arching rib with ~36 narrow drooping leaflets each (V-folded), dark at the base → light at the tips
      const nf = 12;
      const pos = [], col = [], sway = [], idx = [];
      const vtx = (px, py, pz, c, s) => { pos.push(px, py, pz); col.push(c.r, c.g, c.b); sway.push(s); return pos.length / 3 - 1; };
      const dark = new THREE.Color(0x356f35), light = new THREE.Color(0x86c55e), dry = new THREE.Color(0x9fa04a), cc = new THREE.Color(), ct = new THREE.Color();
      for (let f = 0; f < nf; f++) {
        const lower = f % 3 === 2;
        const az = (f / nf) * TAU + rnd() * 0.35, len = (lower ? 2.0 : 2.3) + rnd() * 0.5, lift = lower ? 0.05 : f % 2 ? 0.55 : 0.35;
        const dx = Math.cos(az), dz = Math.sin(az), sx = -dz, sz = dx;
        const S = 18, rib = [];
        for (let s = 0; s <= S; s++) {
          const t = s / S;
          rib.push([top.x + dx * len * t, top.y + 0.05 + lift * t - (lower ? 1.7 : 1.35) * t * t, top.z + dz * len * t, t]);
        }
        // rib: thin two-sided strip
        let pa = -1, pb = -1;
        for (const [px, py, pz, t] of rib) {
          cc.copy(dark).lerp(light, t * 0.5);
          const w = 0.03 * (1 - t * 0.7);
          const a = vtx(px + sx * w, py + 0.01, pz + sz * w, cc, t), b = vtx(px - sx * w, py + 0.01, pz - sz * w, cc, t);
          if (pa >= 0) idx.push(pa, a, b, pa, b, pb);
          pa = a; pb = b;
        }
        // leaflets
        for (let s = 2; s < S; s++) {
          const [px, py, pz, t] = rib[s];
          const [qx, qy, qz] = rib[s + 1];
          const tx = qx - px, ty = qy - py, tz = qz - pz, tl = Math.hypot(tx, ty, tz) || 1;
          const L = (0.28 + 0.62 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.08)), 0.7)) * (0.9 + rnd() * 0.2);
          cc.copy(lower ? dry : dark).lerp(light, 0.25 + t * 0.35);
          ct.copy(light).lerp(lower ? dry : light, 0.3).multiplyScalar(0.95 + rnd() * 0.12);
          for (const side of [-1, 1]) {
            const ox = sx * side, oz = sz * side;
            const droop = (0.45 + t * 0.35) * L;
            const tipx = px + ox * L * 0.82 + (tx / tl) * L * 0.35, tipy = py - droop, tipz = pz + oz * L * 0.82 + (tz / tl) * L * 0.35;
            const b0 = vtx(px - (tx / tl) * 0.035, py, pz - (tz / tl) * 0.035, cc, t);
            const b1 = vtx(px + (tx / tl) * 0.035, py, pz + (tz / tl) * 0.035, cc, t);
            const mid = vtx(px * 0.45 + tipx * 0.55, py * 0.45 + tipy * 0.55 + 0.04, pz * 0.45 + tipz * 0.55, cc, Math.min(1, t + 0.05));
            const tip = vtx(tipx, tipy, tipz, ct, Math.min(1, t + 0.15));
            idx.push(b0, b1, mid, b0, mid, tip, b1, tip, mid);
          }
        }
      }
      const fg = new THREE.BufferGeometry();
      fg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      fg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      fg.setAttribute('sway', new THREE.Float32BufferAttribute(sway, 1));
      fg.setIndex(idx);
      fg.computeVertexNormals();
      fronds.push(fg);
    }
    const trunkMesh = new THREE.Mesh(merge(trunks), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 }));
    trunkMesh.castShadow = true; trunkMesh.receiveShadow = true; trunkMesh.name = 'palms:trunk';
    const frondGeo = mergeGeometries(fronds, false);
    const frondMesh = new THREE.Mesh(frondGeo, frondMaterial(this.uTime));
    frondMesh.castShadow = true; frondMesh.receiveShadow = true; frondMesh.name = 'palms:fronds';
    this.group.add(trunkMesh, frondMesh);
  }

  // ------------------------------------------------------------------ team flags (poles merged, cloth instanced)
  _buildFlags() {
    const L = this.level.layout;
    const pts = [...L.decor.flags.map((p) => ({ p, team: 0 })), ...L.decor.flags.map(([x, y, z]) => ({ p: [-x, y, -z], team: 1 }))];
    if (!pts.length) return;
    const poles = [];
    const POLE = 0xe3e0d8, GOLD = 0xd9b45a, DARK = 0x3a3f48;
    for (const { p } of pts) {
      const [x, y, z] = p;
      const add = (g, c) => { g.translate(x, y, z); poles.push(tint(g, c)); };
      add(lathe([[0, 0], [0.2, 0], [0.21, 0.03], [0.17, 0.07], [0.07, 0.1], [0, 0.1]], 16), DARK);
      add(lathe([[0.065, 0.1], [0.058, 0.4], [0.045, 4.35], [0, 4.36]], 12), POLE);
      add(at(new THREE.SphereGeometry(0.085, 14, 10), 0, 4.43, 0), GOLD);
      add(at(new THREE.CylinderGeometry(0.03, 0.05, 0.08, 10), 0, 4.34, 0), GOLD);
      add(at(new THREE.BoxGeometry(0.04, 0.16, 0.05), -0.07, 1.2, 0), DARK);
      add(at(new THREE.CylinderGeometry(0.012, 0.012, 0.18, 6), -0.1, 1.2, 0, 0, 0, Math.PI / 2), DARK);
      add(tube([[-0.07, 4.3, 0.01], [-0.075, 2.8, 0.03], [-0.1, 1.28, 0.02]], 0.007, 4), 0xf0ead8);
      add(tube([[0.04, 4.3, 0], [-0.03, 4.3, 0.02], [-0.07, 4.26, 0.01]], 0.007, 4), 0xf0ead8);
    }
    const poleMesh = new THREE.Mesh(merge(poles), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.55 }));
    poleMesh.castShadow = true; poleMesh.receiveShadow = true; poleMesh.name = 'flags:poles';
    this.group.add(poleMesh);
    // cloth: hoisted at the pole top, flies toward +X (local)
    const geo = new THREE.PlaneGeometry(FLAG_W, FLAG_H, 26, 14);
    geo.translate(FLAG_W / 2 + 0.05, -FLAG_H / 2, 0);
    // emblem UVs: the canvas is square → centre it on the cloth with its aspect preserved
    const uv = geo.attributes.uv, Pp = geo.attributes.position;
    for (let i = 0; i < uv.count; i++) {
      const u = (Pp.getX(i) - 0.05) / FLAG_W, v = (Pp.getY(i) + FLAG_H) / FLAG_H;
      uv.setXY(i, u, v);
    }
    this.flagTex = new THREE.CanvasTexture((() => {
      const cv = document.createElement('canvas'); cv.width = 512; cv.height = 320;
      const x = cv.getContext('2d'); x.clearRect(0, 0, 512, 320);
      x.drawImage(emblemCanvas(256, true), 256 - 120, 160 - 120, 240, 240);
      // two thin wave stripes under the emblem
      x.strokeStyle = '#fff'; x.lineWidth = 7; x.lineCap = 'round';
      for (const yy of [276, 298]) { x.beginPath(); for (let i = 0; i <= 24; i++) { const px = 120 + (i / 24) * 272; x.lineTo(px, yy + Math.sin(i * 0.9) * 6); } x.stroke(); }
      return cv;
    })());
    this.flagTex.colorSpace = THREE.SRGBColorSpace; this.flagTex.anisotropy = 4;
    const mat = flagMaterial(this.flagTex, this.uTime);
    const mesh = new THREE.InstancedMesh(geo, mat, pts.length);
    const m = new THREE.Matrix4();
    pts.forEach(({ p }, i) => { m.makeTranslation(p[0], p[1] + 4.28, p[2]); mesh.setMatrixAt(i, m); mesh.setColorAt(i, new THREE.Color(1, 1, 1)); });
    mesh.customDepthMaterial = flagDepthMaterial(this.uTime);
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false; mesh.name = 'flags:cloth';
    this.group.add(mesh);
    this.flagMesh = mesh;
    this.flags = pts.map(({ team }, i) => ({ team, index: i }));
  }

  setTeamColors(colors) {
    for (const p of this.pads) { p.padMat.uniforms.uColor.value.copy(colors[p.team]); p.barMat.uniforms.uColor.value.copy(colors[p.team]); }
    if (this.flagMesh) {
      for (const f of this.flags) this.flagMesh.setColorAt(f.index, colors[f.team]);
      this.flagMesh.instanceColor.needsUpdate = true;
    }
  }

  update(dt) {
    this.time += dt;
    this.uTime.value = this.time;
    for (const p of this.pads) {
      p.pulseT = Math.min(3, p.pulseT + dt);
      p.pulse = Math.max(0, p.pulse - dt * 0.9);
      const u = p.padMat.uniforms, b = p.barMat.uniforms;
      u.uTime.value = this.time; u.uPulse.value = p.pulse; u.uPulseT.value = p.pulseT;
      b.uTime.value = this.time; b.uPulse.value = p.pulse;
      // barrier brightens when an enemy approaches it
      let near = 0;
      for (const a of G.actors) {
        if (a.team === p.team || !a.alive) continue;
        const d = Math.hypot(a.pos.x - p.g.position.x, a.pos.z - p.g.position.z);
        near = Math.max(near, 1 - Math.min(1, Math.max(0, (d - this.level.spawnBarrier) / 4)));
      }
      b.uAlpha.value = 0.12 + near * 0.55;
    }
  }
}
