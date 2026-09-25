// Ink paint system.
//  * GPU: every paintable face owns a rectangle in one big atlas render target (R = team 0 ink, G = team 1 ink,
//    B = tone). Splats are drawn as quads straight into the atlas in face space (texture-space painting), so ink wraps
//    across floors/walls/corners exactly like a spherical splash would.
//  * CPU: a parallel coarse grid (0.25 m cells) per face answers gameplay queries — "is this spot my ink?" — and
//    tracks turf coverage for scoring. Both sides evaluate the same blob-edge function so they agree.
import * as THREE from 'three';

const TAU = Math.PI * 2;
const MAX_QUADS = 6000;
const FRESH_N = 16;
const _rel = new THREE.Vector3();

// Main-blob outline: organic lobes + two narrow "fingers" thrown out by the impact. The GPU splat shader evaluates the
// identical function (wob), so the gameplay grid and the rendered ink agree on the edge.
export function blobWobble(ang, seed) {
  return 1 + 0.12 * Math.sin(3 * ang + seed * 6.2831) + 0.08 * Math.sin(5 * ang + seed * 17.0) +
    0.05 * Math.sin(7 * ang + seed * 41.0) + 0.03 * Math.sin(11 * ang + seed * 73.0) + 0.018 * Math.sin(17 * ang + seed * 29.0) +
    0.17 * Math.pow(Math.max(Math.cos(ang - seed * 37.7), 0), 28) + 0.12 * Math.pow(Math.max(Math.cos(ang - seed * 53.3 - 2.1), 0), 36);
}
const WOB_MAX = 1.5;   // upper bound of blobWobble (reach of the CPU cell loop)

const PAINT_VS = /* glsl */`
attribute vec2 aPos;
attribute vec3 aLocal;
attribute vec4 aSplat;
attribute vec3 aStretch;
attribute vec2 aGrow;
varying vec3 vLocal;
varying vec4 vSplat;
varying vec3 vStretch;
varying vec2 vGrow;
void main() {
  vLocal = aLocal; vSplat = aSplat; vStretch = aStretch; vGrow = aGrow;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Atlas encoding: R/G = team weights ("over" composited: the newest splat wins, only their ratio matters), B = per-splat
// tone, A = ink coverage as a smooth ~3-texel profile, MAX-blended (union of splats; redrawing a spreading splat every
// frame is idempotent). The level shader reads A through a cubic B-spline for a thick, rounded ink height field.
const PAINT_FS = /* glsl */`
precision highp float;
varying vec3 vLocal;
varying vec4 vSplat;
varying vec3 vStretch;
varying vec2 vGrow;
float hsh(float n) { return fract(sin(n) * 43758.5453123); }
float wob(float a, float s) {
  return 1.0 + 0.12 * sin(3.0 * a + s * 6.2831) + 0.08 * sin(5.0 * a + s * 17.0) + 0.05 * sin(7.0 * a + s * 41.0)
    + 0.03 * sin(11.0 * a + s * 73.0) + 0.018 * sin(17.0 * a + s * 29.0)
    + 0.17 * pow(max(cos(a - s * 37.7), 0.0), 28.0) + 0.12 * pow(max(cos(a - s * 53.3 - 2.1), 0.0), 36.0);
}
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
void main() {
  float R = vSplat.x, team = vSplat.y, seed = vSplat.z, isWall = vSplat.w;
  float dn = vLocal.z;
  float r2 = R * R - dn * dn;
  if (r2 <= 0.0) discard;
  float r = sqrt(r2);
  float fall = clamp(r / max(R, 1e-3), 0.0, 1.0);        // 1 on the face the blob hit, smaller on faces it grazes
  vec2 p0 = vLocal.xy;                                   // metres from the splat centre in face space
  vec2 dir = vStretch.xy; float sa = vStretch.z;
  vec2 p = p0;
  if (sa > 0.0) {                                        // shots: smeared forward along the travel direction
    float a = dot(p, dir); vec2 perp = p - a * dir;
    float s = a > 0.0 ? 1.0 + sa : 1.0 + 0.25 * sa;
    p = perp + dir * (a / s);
  }
  float sd = length(p) - r * wob(atan(p.y, p.x), seed);   // main blob — same edge as the CPU gameplay grid
  // satellite droplets (thrown forward for shots, all round for blasts), streaked along their flight line
  float dirAng = sa > 0.0 ? atan(dir.y, dir.x) : 0.0;
  float spread = mix(6.2831, 2.4, clamp(sa * 1.2, 0.0, 1.0));
  for (int k = 0; k < 8; k++) {
    float fk = float(k);
    float h1 = hsh(seed * 13.1 + fk * 7.7), h2 = hsh(seed * 5.3 + fk * 3.1), h3 = hsh(seed * 9.9 + fk * 1.7);
    float a2 = sa > 0.0 ? dirAng + (h1 - 0.5) * spread : h1 * 6.2831;
    vec2 u = vec2(cos(a2), sin(a2));
    float dist = r * (1.08 + 0.8 * h2 * h2);
    float rad = r * (0.028 + 0.085 * h3) * fall * (1.0 - 0.4 * h2);
    vec2 q = p - u * dist;
    float el = 1.0 + (0.5 + 1.6 * sa) * h2;             // further = faster = longer streak
    q -= u * dot(q, u) * (1.0 - 1.0 / el);
    sd = smin(sd, length(q) - rad, rad * 0.8);
  }
  // drips running down walls: meandering stream + bulbous teardrop tip, still running while vGrow.x < 1
  if (isWall > 0.5 && fall > 0.3) {
    float dT = vGrow.x;
    for (int k = 0; k < 5; k++) {
      float fk = float(k);
      float h1 = hsh(seed * 3.7 + fk * 11.3), h2 = hsh(seed * 8.1 + fk * 2.9), h3 = hsh(seed * 4.3 + fk * 5.9);
      if (k > 1 && h3 < 0.3) continue;
      float x = (h1 * 2.0 - 1.0) * r * 0.7;
      float c = sqrt(max(1.0 - (x / r) * (x / r), 0.0));
      float yTop = -c * r * 0.75;
      float len = c * r * 0.25 + r * (0.2 + 1.45 * h2 * h2) * fall * dT;
      float w = r * (0.05 + 0.045 * h3);
      vec2 q = p0 - vec2(x, yTop);
      float ty = clamp(-q.y / max(len, 1e-4), 0.0, 1.0);
      q.x += sin(q.y / r * 11.0 + seed * 20.0 + fk * 2.3) * w * 0.3 * ty;
      float stream = max(abs(q.x) - w * (1.0 - 0.35 * ty), max(q.y, -len - q.y));
      vec2 tq = (q - vec2(0.0, -len + w * 0.35)) * vec2(1.0, 0.82);
      float bulb = length(tq) - w * (1.3 + 0.35 * h2) * (0.55 + 0.45 * dT);
      sd = smin(sd, smin(stream, bulb, w * 0.9), w * 1.3);
    }
  }
  float fw = max(fwidth(sd), 1e-5);
  float a = 1.0 - smoothstep(-1.5 * fw, 1.5 * fw, sd);
  if (a <= 0.002) discard;
  gl_FragColor = vec4(team < 0.5 ? 1.0 : 0.0, team < 0.5 ? 0.0 : 1.0, hsh(seed * 1.73), a);
}`;

export class PaintSystem {
  constructor(renderer, level, { atlasSize = 4096, maxDensity = 30, cell = 0.25 } = {}) {
    this.renderer = renderer;
    this.level = level;
    this.size = atlasSize;
    this.cell = cell;
    this.pad = 8;            // ≥ 2^maxInkLod texels so mip levels never bleed between faces
    this._layout(maxDensity);
    this._initGrid();
    this._initGPU();
    this._q = [];
    this.growing = [];            // splats still spreading on screen (the gameplay grid is already updated)
    this.version = 0;          // bumps whenever the CPU grid changes (minimap polling)
    // recent splats for the level shader's fresh-ink sheen: xyz + radius, and the paint clock when they landed
    this.clock = 0;
    this.fresh = Array.from({ length: FRESH_N }, () => new THREE.Vector4(0, -999, 0, 0));
    this.freshT = new Float32Array(FRESH_N).fill(-99);
    this._freshI = 0;
  }

  // ------------------------------------------------------------ atlas layout (shelf packing)
  _layout(maxDensity) {
    const faces = this.level.faces.filter((f) => f.paintable);
    this.paintFaces = faces;
    const S = this.size;
    let ppm = maxDensity;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (this._tryPack(faces, ppm, S)) break;
      ppm *= 0.92;
    }
    this.ppm = ppm;
  }
  _tryPack(faces, ppm, S) {
    const pad = this.pad;
    const rects = faces.map((f) => ({ f, w: Math.ceil(f.su * ppm) + pad * 2, h: Math.ceil(f.sv * ppm) + pad * 2 }));
    // rotate nothing; sort by height
    rects.sort((a, b) => b.h - a.h);
    let x = 0, y = 0, rowH = 0;
    for (const r of rects) {
      if (r.w > S) return false;
      if (x + r.w > S) { x = 0; y += rowH; rowH = 0; }
      if (y + r.h > S) return false;
      r.x = x; r.y = y;
      x += r.w; rowH = Math.max(rowH, r.h);
    }
    for (const r of rects) r.f.atlas = { x: r.x, y: r.y, w: r.w, h: r.h, ppm, pad };
    this.usedHeight = y + rowH;
    return true;
  }

  // ------------------------------------------------------------ CPU grid
  _initGrid() {
    let total = 0;
    const lvl = this.level;
    const p = new THREE.Vector3();
    for (const f of this.paintFaces) {
      f.nu = Math.max(1, Math.round(f.su / this.cell));
      f.nv = Math.max(1, Math.round(f.sv / this.cell));
      f.cu = f.su / f.nu; f.cv = f.sv / f.nv;
      f.grid = total;
      total += f.nu * f.nv;
    }
    this.grid = new Uint8Array(total);      // 0 none, 1 team0, 2 team1
    this.dead = new Uint8Array(total);      // cells buried inside other geometry
    this.turfTotal = 0;
    this.turfArea = 0;
    this.counts = [0, 0];                   // live turf cells per team
    for (const f of this.paintFaces) {
      for (let j = 0; j < f.nv; j++) for (let i = 0; i < f.nu; i++) {
        p.copy(f.origin).addScaledVector(f.u, (i + 0.5) * f.cu).addScaledVector(f.v, (j + 0.5) * f.cv).addScaledVector(f.n, 0.06);
        const k = f.grid + j * f.nu + i;
        if (lvl.pointInside(p, 0, f.block)) this.dead[k] = 1;
        else if (f.turf) { this.turfTotal++; this.turfArea += f.cu * f.cv; }
      }
    }
  }

  // ------------------------------------------------------------ GPU
  _initGPU() {
    const S = this.size;
    this.rt = new THREE.WebGLRenderTarget(S, S, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      generateMipmaps: true, depthBuffer: false, stencilBuffer: false,
    });
    this.texture = this.rt.texture;
    this.texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const g = new THREE.BufferGeometry();
    this.aPos = new Float32Array(MAX_QUADS * 4 * 2);
    this.aLocal = new Float32Array(MAX_QUADS * 4 * 3);
    this.aSplat = new Float32Array(MAX_QUADS * 4 * 4);
    this.aStretch = new Float32Array(MAX_QUADS * 4 * 3);
    this.aGrow = new Float32Array(MAX_QUADS * 4 * 2);
    const idx = new Uint32Array(MAX_QUADS * 6);
    for (let i = 0; i < MAX_QUADS; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    const mk = (arr, n) => { const a = new THREE.BufferAttribute(arr, n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    g.setAttribute('aPos', mk(this.aPos, 2));
    g.setAttribute('aLocal', mk(this.aLocal, 3));
    g.setAttribute('aSplat', mk(this.aSplat, 4));
    g.setAttribute('aStretch', mk(this.aStretch, 3));
    g.setAttribute('aGrow', mk(this.aGrow, 2));
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_QUADS * 4 * 3), 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: PAINT_VS, fragmentShader: PAINT_FS,
      transparent: true, depthTest: false, depthWrite: false,
      // RGB: newest splat wins ("over"); A: max → union coverage that stays idempotent while a splat spreads
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendEquationAlpha: THREE.MaxEquation,
      blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quads = 0;
    this.clear();
  }

  clear() {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.setRenderTarget(prev);
    r.setClearColor(cc, ca);
    this.grid.fill(0);
    this.counts[0] = this.counts[1] = 0;
    this.quads = 0;
    if (this.growing) this.growing.length = 0;
    if (this.freshT) this.freshT.fill(-99);
    this.version++;
  }

  // ------------------------------------------------------------ splat
  // center: Vector3, radius (m), team 0|1, opts: { stretch: Vector3 dir, stretchAmt, seed }
  // Returns the area (m²) newly claimed by `team` (for turf points / special gauge).
  splat(center, radius, team, opts = {}) {
    const seed = opts.seed ?? Math.random();
    const reach = radius * 3.2;
    const ids = this.level.queryBlocks(center.x - reach, center.z - reach, center.x + reach, center.z + reach, this._qb || (this._qb = []));
    let claimed = 0;
    const st = opts.stretch, sAmt = st ? (opts.stretchAmt ?? 1) : 0;
    const entries = [];
    let wall = false;
    for (const bid of ids) {
      const b = this.level.blocks[bid];
      // quick reject by AABB distance
      if (center.x < b.aabbMin.x - reach || center.x > b.aabbMax.x + reach ||
          center.y < b.aabbMin.y - reach || center.y > b.aabbMax.y + reach ||
          center.z < b.aabbMin.z - reach || center.z > b.aabbMax.z + reach) continue;
      for (let fi = 0; fi < 6; fi++) {
        const fid = b.faces[fi];
        if (fid < 0) continue;
        const f = this.level.faces[fid];
        if (!f.atlas) continue;
        _rel.copy(center).sub(f.origin);
        const dn = _rel.dot(f.n);
        if (dn > radius || dn < -0.12) continue;
        const lu = _rel.dot(f.u), lv = _rel.dot(f.v);
        const rr = Math.sqrt(Math.max(0, radius * radius - dn * dn));
        const ext = rr * (2.05 + 1.4 * sAmt);
        if (lu < -ext || lu > f.su + ext || lv < -ext - (f.wall ? rr * 1.9 : 0) || lv > f.sv + ext) continue;
        // stretch direction projected into face space
        let sdu = 0, sdv = 0, sa = 0;
        if (st) {
          sdu = st.dot(f.u); sdv = st.dot(f.v);
          const l = Math.hypot(sdu, sdv);
          if (l > 0.2) { sdu /= l; sdv /= l; sa = sAmt * l; } else { sdu = sdv = 0; }
        }
        claimed += this._cpuSplat(f, lu, lv, rr, team, seed, sdu, sdv, sa);
        entries.push(f, lu, lv, dn, sdu, sdv, sa);
        if (f.wall && rr > radius * 0.3) wall = true;
      }
    }
    if (entries.length) {
      // an older splat of the other team still spreading underneath this one finishes instantly, so the newer ink
      // always ends up on top (matching the gameplay grid)
      for (let i = this.growing.length - 1; i >= 0; i--) {
        const g = this.growing[i];
        if (g.team === team) continue;
        const dx = g.cx - center.x, dy = g.cy - center.y, dz = g.cz - center.z;
        const rs = (g.R * (g.dripDur ? 3.0 : 2.1) + radius * 2.1);
        if (dx * dx + dy * dy + dz * dz < rs * rs) { this._emitGrowth(g, 1, 1); this.growing.splice(i, 1); }
      }
      if (opts.instant) this._emitGrowth({ entries, R: radius, team, seed }, 1, 1);
      else {
        // the blob spreads in ~0.07–0.27 s; drips keep running down walls for up to ~1 s
        const dur = 0.07 + Math.min(0.2, radius * 0.075);
        this.growing.push({ entries, R: radius, team, seed, age: 0, dur, dripDur: wall ? 0.45 + Math.min(0.55, radius * 0.5) : 0, cx: center.x, cy: center.y, cz: center.z });
      }
      if (radius >= 0.25) {
        const k = this._freshI; this._freshI = (k + 1) % FRESH_N;
        this.fresh[k].set(center.x, center.y, center.z, radius * 1.35);
        this.freshT[k] = this.clock;
      }
    }
    return claimed;
  }

  // Draw one growth step of a splat: ink spreads from ~30 % to full radius with a liquid ease-out; drips run on with
  // their own progress td (the atlas alpha is max-blended, so redrawing every frame is idempotent).
  _emitGrowth(g, t, td = 1) {
    const k = 1 - Math.pow(1 - t, 3);
    const R = g.R * (0.3 + 0.7 * k);
    const dT = td >= 1 ? 1 : 1 - Math.pow(1 - td, 2);
    const E = g.entries;
    for (let i = 0; i < E.length; i += 7) {
      const f = E[i], lu = E[i + 1], lv = E[i + 2], dn = E[i + 3], sdu = E[i + 4], sdv = E[i + 5], sa = E[i + 6];
      if (dn >= R) continue;
      const rr = Math.sqrt(R * R - dn * dn);
      this._pushQuad(f, lu, lv, dn, R, rr, rr * (2.05 + 1.4 * sa), g.team, g.seed, sdu, sdv, sa, dT);
    }
  }

  _cpuSplat(f, lu, lv, r, team, seed, sdu, sdv, sa) {
    if (r <= 0.02) return 0;
    const val = team + 1;
    const ext = r * (1 + sa) * WOB_MAX;
    const i0 = Math.max(0, Math.floor((lu - ext) / f.cu)), i1 = Math.min(f.nu - 1, Math.floor((lu + ext) / f.cu));
    const j0 = Math.max(0, Math.floor((lv - ext) / f.cv)), j1 = Math.min(f.nv - 1, Math.floor((lv + ext) / f.cv));
    if (i1 < i0 || j1 < j0) return 0;
    let claimed = 0;
    const cellA = f.cu * f.cv;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        let px = (i + 0.5) * f.cu - lu, py = (j + 0.5) * f.cv - lv;
        if (sa > 0) {
          const a = px * sdu + py * sdv;
          const qx = px - a * sdu, qy = py - a * sdv;
          const s = a > 0 ? 1 + sa : 1 + 0.25 * sa;
          px = qx + sdu * (a / s); py = qy + sdv * (a / s);
        }
        const d = Math.hypot(px, py);
        if (d > r * WOB_MAX) continue;
        if (d / (r * blobWobble(Math.atan2(py, px), seed)) > 0.97) continue;
        const k = f.grid + j * f.nu + i;
        const prev = this.grid[k];
        if (prev === val) continue;
        this.grid[k] = val;
        claimed += cellA;
        if (f.turf && !this.dead[k]) {
          if (prev) this.counts[prev - 1]--;
          this.counts[team]++;
        }
      }
    }
    if (claimed > 0) this.version++;
    return claimed;
  }

  _pushQuad(f, lu, lv, dn, R, rr, ext, team, seed, sdu, sdv, sa, dT = 1) {
    if (this.quads >= MAX_QUADS) this._drawQuads();
    const a = f.atlas, S = this.size;
    const padM = (a.pad - 0.5) / a.ppm;
    let u0 = Math.max(-padM, lu - ext), u1 = Math.min(f.su + padM, lu + ext);
    let v0 = Math.max(-padM, lv - ext - (f.wall ? rr * 1.9 : 0)), v1 = Math.min(f.sv + padM, lv + ext);
    if (u1 <= u0 || v1 <= v0) return;
    const q = this.quads++;
    const corners = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    for (let c = 0; c < 4; c++) {
      const cu = corners[c][0], cv = corners[c][1];
      const vi = q * 4 + c;
      const px = a.x + a.pad + cu * a.ppm, py = a.y + a.pad + cv * a.ppm;
      this.aPos[vi * 2] = (px / S) * 2 - 1;
      this.aPos[vi * 2 + 1] = (py / S) * 2 - 1;
      this.aLocal[vi * 3] = cu - lu; this.aLocal[vi * 3 + 1] = cv - lv; this.aLocal[vi * 3 + 2] = dn;
      this.aSplat[vi * 4] = R; this.aSplat[vi * 4 + 1] = team; this.aSplat[vi * 4 + 2] = seed; this.aSplat[vi * 4 + 3] = f.wall ? 1 : 0;
      this.aStretch[vi * 3] = sdu; this.aStretch[vi * 3 + 1] = sdv; this.aStretch[vi * 3 + 2] = sa;
      this.aGrow[vi * 2] = dT; this.aGrow[vi * 2 + 1] = 0;
    }
  }

  // Draw all queued splat quads into the atlas. Call once per frame before rendering the scene.
  // Advance spreading splats and draw everything queued this frame into the atlas. Call once per frame.
  flush(dt = 1 / 60) {
    this.clock += dt;
    for (let i = 0; i < this.growing.length; i++) {
      const g = this.growing[i];
      g.age += dt;
      const t = Math.min(1, g.age / g.dur);
      const td = g.dripDur ? Math.min(1, g.age / g.dripDur) : 1;
      this._emitGrowth(g, t, td);
      if (t >= 1 && td >= 1) { this.growing[i] = this.growing[this.growing.length - 1]; this.growing.pop(); i--; }
    }
    this._drawQuads();
  }

  _drawQuads() {
    if (!this.quads) return;
    const g = this.geo, n = this.quads * 4;
    for (const name of ['aPos', 'aLocal', 'aSplat', 'aStretch', 'aGrow']) {
      const at = g.attributes[name];
      at.clearUpdateRanges(); at.addUpdateRange(0, n * at.itemSize); at.needsUpdate = true;
    }
    g.setDrawRange(0, this.quads * 6);
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const ac = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(this.rt);
    r.render(this.scene, this.cam);
    r.setRenderTarget(prev);
    r.autoClear = ac;
    this.quads = 0;
  }

  // ------------------------------------------------------------ queries
  // Team at face-local (u,v): 0 none, 1 = team0, 2 = team1
  sample(faceId, u, v) {
    if (faceId < 0) return 0;
    const f = this.level.faces[faceId];
    if (!f.atlas) return 0;
    const i = Math.min(f.nu - 1, Math.max(0, Math.floor(u / f.cu)));
    const j = Math.min(f.nv - 1, Math.max(0, Math.floor(v / f.cv)));
    return this.grid[f.grid + j * f.nu + i];
  }

  // Team at a world point lying on face faceId.
  sampleWorld(faceId, p) {
    if (faceId < 0) return 0;
    const f = this.level.faces[faceId];
    _rel.copy(p).sub(f.origin);
    return this.sample(faceId, _rel.dot(f.u), _rel.dot(f.v));
  }

  // Turf coverage fractions [team0, team1] of all live turf cells.
  coverage() {
    return [this.counts[0] / this.turfTotal, this.counts[1] / this.turfTotal];
  }

  // Fractions of turf cells within radius of (x, z) near height y: { own, enemy, empty } relative to `team`.
  regionStats(x, y, z, radius, team, out = { own: 0, enemy: 0, empty: 0, n: 0 }) {
    out.own = out.enemy = out.empty = out.n = 0;
    const ids = this.level.queryBlocks(x - radius, z - radius, x + radius, z + radius, this._qr || (this._qr = []));
    const own = team + 1;
    for (const bid of ids) {
      const b = this.level.blocks[bid];
      for (let fi = 0; fi < 6; fi++) {
        const fid = b.faces[fi];
        if (fid < 0) continue;
        const f = this.level.faces[fid];
        if (!f.turf || !f.atlas) continue;
        if (Math.abs(f.origin.y - y) > 2.5) continue;
        _rel.set(x, y, z).sub(f.origin);
        const lu = _rel.dot(f.u), lv = _rel.dot(f.v);
        const i0 = Math.max(0, Math.floor((lu - radius) / f.cu)), i1 = Math.min(f.nu - 1, Math.floor((lu + radius) / f.cu));
        const j0 = Math.max(0, Math.floor((lv - radius) / f.cv)), j1 = Math.min(f.nv - 1, Math.floor((lv + radius) / f.cv));
        for (let j = j0; j <= j1; j += 2) for (let i = i0; i <= i1; i += 2) {
          const du = (i + 0.5) * f.cu - lu, dv = (j + 0.5) * f.cv - lv;
          if (du * du + dv * dv > radius * radius) continue;
          const k = f.grid + j * f.nu + i;
          if (this.dead[k]) continue;
          const g = this.grid[k];
          out.n++;
          if (g === own) out.own++; else if (g) out.enemy++; else out.empty++;
        }
      }
    }
    if (out.n) { out.own /= out.n; out.enemy /= out.n; out.empty /= out.n; }
    return out;
  }

  dispose() { this.rt.dispose(); this.geo.dispose(); this.mat.dispose(); }
}
