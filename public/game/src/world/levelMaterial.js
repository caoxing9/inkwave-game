// Level surface material: MeshPhysicalMaterial + injected procedural surface patterns and the wet ink layer.
import * as THREE from 'three';
import { TEXLIB_GLSL } from './texlib.js';
import { G } from '../core/ctx.js';

export function createLevelMaterial(paintTexture, atlasSize, muralTexture = null, opts = {}) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.82, metalness: 0.0,
    clearcoat: 1.0, clearcoatRoughness: 0.08,
    envMapIntensity: 0.9,
  });
  const uniforms = {
    uPaint: { value: paintTexture },
    uTexel: { value: 1 / atlasSize },
    uTeamA: { value: new THREE.Color('#ff8a14') },
    uTeamB: { value: new THREE.Color('#2f5bff') },
    uTime: { value: 0 },
    uInkGlow: { value: 0.06 },
    uMural: { value: muralTexture },
    uLight: { value: opts.lightmap || null },
    uSeeA: { value: new THREE.Vector3() },   // camera position
    uSeeB: { value: new THREE.Vector3() },   // player chest
    uSeeOn: { value: 0 },
    uSeeFeet: { value: 0 },                  // local player's feet height (set per draw below)
    uSeeA2C: { value: 0 },                   // 1 when drawing into a multisampled target (alpha-to-coverage fade)
    uAO: { value: opts.lightmap ? 1.0 : 0.0 },
    uAtlasSize: { value: atlasSize },
    uPpm: { value: opts.ppm || 20 },          // atlas texels per metre (from the paint system, set per draw)
    uFresh: { value: Array.from({ length: 16 }, () => new THREE.Vector4(0, -999, 0, 0)) },
    uFreshAge: { value: new Float32Array(16).fill(99) },
    uGel: { value: 13 },                      // texlib layer of the ink gel micro-surface
  };
  // Texture library: per-pattern slot → (layer, 1/scale, anti-tiling mode, sym) and (tint, normal strength).
  // Slot 17 = concrete, used for the vertical sides of ramps/asphalt slabs.
  const lib = opts.texlib || null;
  if (lib) {
    const L = lib.layers, M = lib.meta;
    const map = ['concrete', 'pavers', 'tiles', 'concrete', 'rubber', 'corrugated', 'planks', 'metalpanel', 'tiles', 'concrete',
      'asphalt', 'metalpanel', 'grate', 'brick', 'rubber', 'glasstile', 'pavers', 'concrete'];
    uniforms.tAlbedo = { value: lib.albedo };
    uniforms.tNormal = { value: lib.normal };
    uniforms.tOrm = { value: lib.orm };
    uniforms.uTexSize = { value: lib.stats?.size || 512 };
    uniforms.uTL = { value: map.map((n) => new THREE.Vector4(L[n] ?? 0, 1 / ((M[n] && M[n].scale) || 4), (M[n] && M[n].mode) ?? 1, (M[n] && M[n].sym) ?? 7)) };
    uniforms.uTLt = { value: map.map((n) => new THREE.Vector2(M[n] && M[n].tint === false ? 0 : 1, n === 'grate' ? 0.6 : 1.0)) };
    uniforms.uGel.value = L.gel ?? -1;
    mat.defines = { ...(mat.defines || {}), USE_TEXLIB: 1 };
  }
  mat.userData.uniforms = uniforms;
  // see-through window: feet height of the local player + whether this draw is multisampled (main.js drives the rest)
  mat.alphaToCoverage = true;
  mat.onBeforeRender = (renderer) => {
    const loc = G.match && !G.match.attract ? G.match.local : null;
    uniforms.uSeeFeet.value = loc ? loc.pos.y : uniforms.uSeeB.value.y - 1.0;
    const rt = renderer.getRenderTarget();
    uniforms.uSeeA2C.value = rt && rt.samples > 0 ? 1 : 0;
    // paint system: atlas density + the most recent splats (fresh-ink sheen)
    const P = opts.paint || G.paint;
    if (P && P.texture === uniforms.uPaint.value) {
      uniforms.uPpm.value = P.ppm;
      if (P.fresh) for (let i = 0; i < 16; i++) { uniforms.uFresh.value[i].copy(P.fresh[i]); uniforms.uFreshAge.value[i] = P.clock - P.freshT[i]; }
    }
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec2 paintUv;
attribute vec2 faceUv;
attribute vec4 faceData;
attribute vec3 faceFlags;
attribute vec3 faceTan;
attribute vec2 lightUv;
varying vec2 vLightUv;
varying vec3 vFaceTan;
varying vec2 vPaintUv;
varying vec2 vFaceUv;
varying vec4 vFaceData;
varying vec3 vFaceFlags;
varying vec3 vWPos;
varying vec3 vWNorm;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
vPaintUv = paintUv; vFaceUv = faceUv; vFaceData = faceData; vFaceFlags = faceFlags;
vFaceTan = normalize(mat3(modelMatrix) * faceTan);
vLightUv = lightUv;
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNorm = normalize(mat3(modelMatrix) * objectNormal);`);

    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uPaint;
uniform float uTexel;
uniform vec3 uTeamA;
uniform vec3 uTeamB;
uniform float uTime;
uniform float uInkGlow;
uniform sampler2D uMural;
uniform sampler2D uLight;
uniform float uAO;
uniform vec3 uSeeA;
uniform vec3 uSeeB;
uniform float uSeeOn;
uniform float uSeeFeet;
uniform float uSeeA2C;
uniform float uAtlasSize;
uniform float uPpm;
uniform vec4 uFresh[16];
uniform float uFreshAge[16];
uniform float uGel;
varying vec2 vLightUv;
varying vec3 vFaceTan;
varying vec2 vPaintUv;
varying vec2 vFaceUv;
varying vec4 vFaceData;
varying vec3 vFaceFlags;
varying vec3 vWPos;
varying vec3 vWNorm;

float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
// anti-aliased grid line: returns 1 on the line
float gridLine(float x, float period, float width) {
  float fx = abs(fract(x / period + 0.5) - 0.5) * period;
  float w = fwidth(x) * 0.75;
  return 1.0 - smoothstep(width - w, width + w, fx);
}
// Paint lookups use textureGrad with gradients clamped to ≤ 8 texels: trilinear + anisotropic filtering (no shimmer at
// distance) while never reaching mip levels coarse enough to bleed across the 8-texel face padding.
vec2 gPdx = vec2(0.0), gPdy = vec2(0.0);
vec4 paintAt(vec2 uv) { return textureGrad(uPaint, uv, gPdx, gPdy); }
// Close-up reconstruction of the paint atlas with a cubic B-spline (C2: smooth, round ink outlines and a smooth height
// field at any magnification) plus its analytic gradient — 12 bilinear taps inside one 4×4 texel footprint.
void inkBspl(float t, out vec4 w, out vec4 dw) {
  float t2 = t * t, t3 = t2 * t, it = 1.0 - t;
  w = vec4(it * it * it, 3.0 * t3 - 6.0 * t2 + 4.0, -3.0 * t3 + 3.0 * t2 + 3.0 * t + 1.0, t3) * (1.0 / 6.0);
  dw = vec4(-it * it, 3.0 * t2 - 4.0 * t, -3.0 * t2 + 2.0 * t + 1.0, t2) * 0.5;
}
vec4 inkTap(vec2 st) { return textureLod(uPaint, (st + 0.5) / uAtlasSize, 0.0); }
vec4 paintCubic(vec2 uv, out vec2 gradA) {
  vec2 st = uv * uAtlasSize - 0.5;
  vec2 i = floor(st), f = st - i;
  vec4 wx, dwx, wy, dwy;
  inkBspl(f.x, wx, dwx); inkBspl(f.y, wy, dwy);
  vec2 gx = vec2(wx.x + wx.y, wx.z + wx.w), gy = vec2(wy.x + wy.y, wy.z + wy.w);
  vec2 ox = vec2(-1.0 + wx.y / gx.x, 1.0 + wx.w / gx.y), oy = vec2(-1.0 + wy.y / gy.x, 1.0 + wy.w / gy.y);
  vec2 dgx = vec2(dwx.x + dwx.y, dwx.z + dwx.w), dgy = vec2(dwy.x + dwy.y, dwy.z + dwy.w);
  vec2 dox = vec2(-1.0 + dwx.y / dgx.x, 1.0 + dwx.w / dgx.y), doy = vec2(-1.0 + dwy.y / dgy.x, 1.0 + dwy.w / dgy.y);
  vec4 v = gx.x * (gy.x * inkTap(i + vec2(ox.x, oy.x)) + gy.y * inkTap(i + vec2(ox.x, oy.y)))
         + gx.y * (gy.x * inkTap(i + vec2(ox.y, oy.x)) + gy.y * inkTap(i + vec2(ox.y, oy.y)));
  float ax = dgx.x * (gy.x * inkTap(i + vec2(dox.x, oy.x)).a + gy.y * inkTap(i + vec2(dox.x, oy.y)).a)
           + dgx.y * (gy.x * inkTap(i + vec2(dox.y, oy.x)).a + gy.y * inkTap(i + vec2(dox.y, oy.y)).a);
  float ay = dgy.x * (gx.x * inkTap(i + vec2(ox.x, doy.x)).a + gx.y * inkTap(i + vec2(ox.y, doy.x)).a)
           + dgy.y * (gx.x * inkTap(i + vec2(ox.x, doy.y)).a + gx.y * inkTap(i + vec2(ox.y, doy.y)).a);
  gradA = vec2(ax, ay);
  return v;
}
// Unnormalised Mikkelsen bump: dHdxy is the per-pixel change of a height in metres, so the tilt equals the true
// slope of the ink surface regardless of distance/viewing angle.
vec3 perturbInk(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection) {
  vec3 vSigmaX = dFdx(surf_pos.xyz);
  vec3 vSigmaY = dFdy(surf_pos.xyz);
  vec3 R1 = cross(vSigmaY, surf_norm);
  vec3 R2 = cross(surf_norm, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDirection;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}
vec2 fsz0(vec4 fd) { return fd.zw; }
#ifdef USE_TEXLIB
precision highp sampler2DArray;
uniform sampler2DArray tAlbedo;
uniform sampler2DArray tNormal;
uniform sampler2DArray tOrm;
uniform float uTexSize;
uniform vec4 uTL[18];
uniform vec2 uTLt[18];
${TEXLIB_GLSL}
#endif
vec3 gTexN = vec3(0.0, 0.0, 1.0);
vec4 gTexORM = vec4(1.0, 0.8, 0.0, 0.5);
float gTexStr = 0.0;
float gTexAlpha = 1.0;
float gInk = 0.0;
vec3 gInkCol = vec3(0.0);
float gBaseRough = 0.8;
float gInkH = 0.0;
vec2 gInkD = vec2(0.0);
float gRib = 0.0;
float gFresh = 0.0;
float gInkNear = 0.0;
float gInkS = 0.0;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  // see-through: geometry in front of the local player that overlaps their on-screen silhouette dissolves, so low
  // cover never hides your character. The window is a capsule in screen space around the body (feet → head) with a
  // soft edge; only fragments clearly in front of the player dissolve (never anything behind them), and floors /
  // platform sides at or below the player's feet are never cut (no holes under you).
  // With MSAA the fade uses alpha-to-coverage (sub-pixel, smooth); without it an 8×8 ordered dither + discard.
  diffuseColor.a = 1.0;
  if (uSeeOn > 0.001) {
    vec3 Bv = (viewMatrix * vec4(uSeeB, 1.0)).xyz;
    float dB = -Bv.z, dP = vViewPosition.z;
    if (dB > 0.6 && dP < dB - 0.2) {
      float bodyH = uSeeB.y - uSeeFeet;                        // kid ≈ 1.0, squid ≈ 0.4
      vec3 Fv = (viewMatrix * vec4(uSeeB.x, uSeeFeet + 0.05, uSeeB.z, 1.0)).xyz;
      vec3 Hv = (viewMatrix * vec4(uSeeB.x, uSeeFeet + bodyH * 1.42 + 0.06, uSeeB.z, 1.0)).xyz;
      vec2 p = -vViewPosition.xy / dP, f = Fv.xy / max(-Fv.z, 0.05), h = Hv.xy / max(-Hv.z, 0.05);
      vec2 fh = h - f;
      float t = clamp(dot(p - f, fh) / max(dot(fh, fh), 1e-8), 0.0, 1.0);
      float sd = length(p - (f + fh * t)) * dB;                  // metres, measured at the player's distance
      float R = mix(0.3, 0.46, clamp(bodyH, 0.0, 1.0));          // body half-width + margin
      float k = 1.0 - smoothstep(R, R + 0.42, sd);
      k *= smoothstep(dB - 0.2, dB - 0.75, dP);                  // only well in front of the player
      // never cut floors at the player's feet, nor the sides of the platform they stand on
      float feetTop = uSeeFeet + 0.3;
      if (vWNorm.y > 0.6 && vWPos.y < feetTop) k = 0.0;
      if (abs(vWNorm.y) < 0.6 && vWPos.y + max(vFaceData.w - vFaceUv.y, 0.0) * 0.9 < feetTop) k = 0.0;
      k *= uSeeOn;
      if (k > 0.002) {
        ivec2 q = ivec2(gl_FragCoord.xy) & 7;
        int xy = q.x ^ q.y;
        float bay = (float(((xy & 1) << 5) | ((q.x & 1) << 4) | ((xy & 2) << 2) | ((q.x & 2) << 1) | ((xy & 4) >> 1) | ((q.x & 4) >> 2)) + 0.5) / 64.0;
        // alpha-to-coverage gives 4 levels per pixel; a small ordered offset fills the steps in between, tapered so
        // the open centre and the untouched rim stay perfectly clean (no screen-door grain over the character)
        float a = 1.0 - k;
        if (uSeeA2C > 0.5) diffuseColor.a = clamp(a + (bay - 0.5) * 0.25 * smoothstep(0.0, 0.2, a) * smoothstep(1.0, 0.8, a), 0.0, 1.0);
        else if (k > bay * 0.98 + 0.01) discard;
      }
    }
  }
  vec2 fu = vFaceUv;
  float pattern = vFaceData.x;
#ifdef GRATE
  // bar grating: 4 cm bars on a 7 cm pitch one way, 2 cm cross-bars every 20 cm; holes are cut out
  {
    float gw = fwidth(fu.x) + 1e-4;
    float bx = 1.0 - smoothstep(0.02 - gw, 0.02 + gw, abs(fract(fu.x / 0.07 + 0.5) - 0.5) * 0.07);
    float by = 1.0 - smoothstep(0.01 - gw, 0.01 + gw, abs(fract(fu.y / 0.2 + 0.5) - 0.5) * 0.2);
    float edge = 1.0 - smoothstep(0.05, 0.06, min(min(fu.x, fsz0(vFaceData).x - fu.x), min(fu.y, fsz0(vFaceData).y - fu.y)));
    float solid = max(max(bx, by), edge);
    if (abs(vWNorm.y) < 0.5) solid = 1.0;
    if (solid < 0.5) discard;
  }
#endif
  vec2 fsz = vFaceData.zw;
  vec3 base = diffuseColor.rgb;
  float rough = 0.82;
  float big = fbm(vWPos.xz * 0.18 + vWPos.y * 0.1);
  float fine = vnoise(fu * 9.0);
#ifdef USE_TEXLIB
  {
    int pid = int(pattern + 0.5);
    bool vertical = abs(vWNorm.y) < 0.5;
    if ((pid == 4 || pid == 10) && vertical) pid = 17;          // ramp / slab sides read as concrete
    vec4 tl = uTL[pid]; vec2 tt = uTLt[pid];
    TexlibSample ts = texlibSample(tAlbedo, tNormal, tOrm, fu * tl.y, tl.x, int(tl.z), int(tl.w));
    base = tt.x > 0.5 ? diffuseColor.rgb * ts.albedo.rgb * 1.25 : ts.albedo.rgb;
    base *= texlibMacro(vWPos.xz + vWPos.y * 0.7);
    base *= mix(1.0, ts.orm.r, 0.85);                            // cavity occlusion in grout / seams / grooves
    rough = ts.orm.g;
    gTexN = ts.normal; gTexORM = ts.orm; gTexStr = tt.y; gTexAlpha = ts.albedo.a;
    #ifdef GRATE
      if (texlibCoverage(ts.albedo.a, fu * tl.y, uTexSize) < 0.5 && !vertical) discard;
    #endif
  }
  if (pattern < 0.5) {
  } else if (pattern < 1.5) {
    // court markings over the pavers
    float rr = length(vWPos.xz);
    float wr = fwidth(rr);
    float mark = 1.0 - smoothstep(0.09 - wr, 0.09 + wr, abs(rr - 9.5));
    float wz = fwidth(vWPos.z);
    mark = max(mark, (1.0 - smoothstep(0.07 - wz, 0.07 + wz, abs(vWPos.z))) * step(9.5, abs(vWPos.x)));
    mark *= 0.75 + 0.25 * step(0.35, vnoise(vWPos.xz * 6.0));
    if (vWNorm.y > 0.5) base = mix(base, vec3(0.97, 0.96, 0.92), mark * 0.9);
  } else if (pattern > 3.5 && pattern < 4.5) {
    float edge = 1.0 - smoothstep(0.16, 0.2, min(fu.x, fsz.x - fu.x));
    if (vWNorm.y > 0.5) { base = mix(base, vec3(0.93, 0.72, 0.12), edge * 0.95); rough = mix(rough, 0.6, edge); }
  } else if (pattern > 7.5 && pattern < 8.5) {
    float e = min(min(fu.x, fsz.x - fu.x), min(fu.y, fsz.y - fu.y));
    float band = 1.0 - smoothstep(0.34, 0.36, e);
    float chev = step(0.5, fract((fu.x + fu.y) * 1.6));
    if (vWNorm.y > 0.5) base = mix(base, mix(vec3(0.95, 0.76, 0.1), vec3(0.12), chev), band * step(0.05, e));
  } else if (pattern > 8.5 && pattern < 9.5) {
    float e = min(min(fu.x, fsz.x - fu.x), min(fu.y, fsz.y - fu.y));
    float bed = smoothstep(0.24, 0.27, e) * step(0.5, vWNorm.y);
    vec3 grass = vec3(0.32, 0.55, 0.22) * (0.8 + 0.35 * fbm(fu * 6.0));
    base = mix(base, grass, bed);
    rough = mix(rough, 0.95, bed);
    gTexStr *= 1.0 - bed;
  } else if (pattern > 9.5 && pattern < 10.5 && abs(vWNorm.y) >= 0.5) {
      vec2 wp = vWPos.xz;
      float ax = abs(wp.x), az = abs(wp.y);
      float mw = fwidth(ax) + 1e-4;
      float dash = step(0.45, fract(az / 3.0));
      float lane = (1.0 - smoothstep(0.07 - mw, 0.07 + mw, abs(ax - 11.5))) * dash * step(4.0, az);
      float bay = (1.0 - smoothstep(0.05 - mw, 0.05 + mw, abs(fract((ax - 2.0) / 2.6) - 0.5) * 2.6)) * step(24.5, az) * step(az, 27.0) * step(ax, 8.0);
      float sx = wp.x * sign(wp.y);
      vec2 hz = vec2(sx - 4.0, az - 17.0);
      float inZone = step(abs(hz.x), 2.0) * step(abs(hz.y), 1.0);
      float hatch = step(0.5, fract((wp.x + wp.y) * 1.25)) * inZone;
      float border = inZone * (1.0 - step(abs(hz.x), 1.9) * step(abs(hz.y), 0.9));
      float wear = 0.9 + 0.1 * smoothstep(0.2, 0.5, vnoise(wp * 3.0));
      float paintM = clamp(lane + hatch * 0.9 + border, 0.0, 1.0) * wear;
      base = mix(base, vec3(0.95, 0.74, 0.18), paintM);
      base = mix(base, vec3(0.93, 0.93, 0.9), bay * wear);
      rough = mix(rough, 0.7, max(paintM, bay));
  }
  // ---- modelled detail (shader-only, no layout change) ----
  {
    int pid = int(pattern + 0.5);
    vec2 wp = vWPos.xz;
    float ef = min(min(fu.x, fsz.x - fu.x), min(fu.y, fsz.y - fu.y));
    bool isTop = vWNorm.y > 0.6;
    bool isWall = abs(vWNorm.y) < 0.5;
    // floors: soft grime patches, sun-bleached warm areas and smoother traffic-polished patches (sheen at grazing sun)
    if (isTop && (pid == 1 || pid == 16 || pid == 10 || pid == 2 || pid == 8)) {
      float m1 = vnoise(wp * 0.09 + 5.3), m2 = vnoise(wp * 0.31 + 1.7), m3 = vnoise(wp * 1.3);
      float grime = smoothstep(0.52, 0.86, m1 * 0.65 + m2 * 0.35);
      base *= 1.0 - 0.075 * grime * (0.7 + 0.3 * m3);
      base *= mix(vec3(1.0), vec3(1.025, 1.005, 0.965), smoothstep(0.42, 0.12, m1));
      rough = mix(rough, rough * 0.72, smoothstep(0.62, 0.9, m2) * 0.7);
    }
    // stone coping on exposed tops of walls / platforms / parapets, with a drip-groove shadow under the cap
    if (pid == 0 || pid == 2 || pid == 3 || pid == 13 || pid == 15 || pid == 16) {
      float cop = 0.0, groove = 0.0;
      float cw = mix(0.2, 0.26, step(3.0, min(fsz.x, fsz.y)));
      if (isTop) {
        cop = min(fsz.x, fsz.y) < 1.15 ? 1.0 : 1.0 - smoothstep(cw - 0.008, cw + 0.008, ef);
        groove = (1.0 - smoothstep(0.004, 0.012, abs(ef - cw))) * step(1.15, min(fsz.x, fsz.y));
      } else if (isWall && vFaceFlags.x > 0.5) {
        float dt = fsz.y - fu.y;
        cop = 1.0 - smoothstep(0.1, 0.108, dt);
        groove = 1.0 - smoothstep(0.005, 0.016, abs(dt - 0.118));
      }
      vec3 stone = vec3(0.9, 0.885, 0.845) * (0.95 + 0.07 * vnoise(fu * 9.0) + 0.03 * vnoise(fu * 41.0));
      base = mix(base, stone * texlibMacro(wp + vWPos.y * 0.7), cop);
      rough = mix(rough, 0.72, cop);
      gTexStr *= 1.0 - 0.8 * cop;
      base *= 1.0 - 0.28 * groove;
    }
    // ramps: anti-slip grooves across the slope
    if (pid == 4 && isTop) {
      vec3 Tt = normalize(vFaceTan - vWNorm * dot(vFaceTan, vWNorm)), Bb = cross(vWNorm, Tt);
      vec2 up2 = vec2(Tt.y, Bb.y);
      float along = dot(fu, up2 / max(length(up2), 1e-4));
      float g = gridLine(along, 0.32, 0.016);
      base *= 1.0 - 0.2 * g;
      rough = mix(rough, 0.95, g);
    }
    // containers: rust streaks bleeding from the top rail and corners, dirt toward the bottom
    if (pid == 5 && isWall) {
      float st = vnoise(vec2(dot(wp, vec2(0.707)) * 5.5 + vWPos.x * 0.8, vWPos.y * 0.35));
      float fromTop = smoothstep(fsz.y * 0.25, fsz.y, fu.y);
      float rust = smoothstep(0.6, 0.92, st) * (0.35 + 0.65 * fromTop);
      rust = max(rust, (1.0 - smoothstep(0.05, 0.3, ef)) * smoothstep(0.45, 0.8, vnoise(fu * 3.0)) * 0.8);
      base = mix(base, vec3(0.42, 0.2, 0.1) * (0.8 + 0.4 * vnoise(fu * 11.0)), rust * 0.42);
      rough = mix(rough, 0.85, rust);
      base *= mix(0.84, 1.0, smoothstep(0.0, 0.7, fu.y));
    }
  }
  if (false) { if (pattern < 0.5) {   // legacy procedural chain below is compiled out of use
#else
  base *= 0.93 + 0.1 * big;
  if (pattern < 0.5) {
#endif
    // plain painted concrete
    base *= 0.97 + 0.05 * fine;
  } else if (pattern < 1.5) {
    // deck: 2 m concrete slabs with dark joints, tone per slab, speckle
    vec2 cell = floor(fu / 2.0);
    base *= 0.95 + 0.08 * h21(cell);
    float j = max(gridLine(fu.x, 2.0, 0.018), gridLine(fu.y, 2.0, 0.018));
    base *= 1.0 - 0.28 * j;
    base *= 0.96 + 0.06 * step(0.93, h21(floor(fu * 22.0)));
    // painted court markings: centre ring + halfway line (slightly worn)
    float rr = length(vWPos.xz);
    float wr = fwidth(rr);
    float mark = 1.0 - smoothstep(0.09 - wr, 0.09 + wr, abs(rr - 9.5));
    float wz = fwidth(vWPos.z);
    mark = max(mark, (1.0 - smoothstep(0.07 - wz, 0.07 + wz, abs(vWPos.z))) * step(9.5, abs(vWPos.x)));
    mark *= 0.75 + 0.25 * step(0.35, vnoise(vWPos.xz * 6.0));
    if (vWNorm.y > 0.5) base = mix(base, vec3(0.97, 0.96, 0.92), mark * 0.9);
    rough = 0.86;
  } else if (pattern < 2.5) {
    // tiles: 0.5 m tiles with lighter grout
    vec2 cell = floor(fu / 0.5);
    base *= 0.94 + 0.09 * h21(cell + 3.1);
    float j = max(gridLine(fu.x, 0.5, 0.012), gridLine(fu.y, 0.5, 0.012));
    base = mix(base, base * 0.78 + 0.08, j);
    rough = 0.6;
  } else if (pattern < 3.5) {
    // concrete wall: formwork bands + tie holes + low grime
    float band = gridLine(fu.y, 1.2, 0.01);
    base *= 1.0 - 0.14 * band;
    vec2 tp = vec2(fract(fu.x / 1.2) - 0.5, fract(fu.y / 1.2 - 0.25) - 0.5) * 1.2;
    base *= 1.0 - 0.35 * (1.0 - smoothstep(0.02, 0.035, length(tp)));
    base *= 0.94 + 0.06 * smoothstep(0.0, 0.9, fu.y);
    rough = 0.9;
  } else if (pattern < 4.5) {
    // ramps: grip grooves + yellow safety edges
    float g = gridLine(fu.y, 0.35, 0.02);
    base *= 1.0 - 0.18 * g;
    float edge = 1.0 - smoothstep(0.16, 0.2, min(fu.x, fsz.x - fu.x));
    if (vWNorm.y > 0.5) base = mix(base, vec3(0.93, 0.72, 0.12), edge * 0.95);
    rough = 0.75;
  } else if (pattern < 5.5) {
    // shipping container: vertical corrugation ribs
    float rib = sin(fu.x / 0.28 * 6.2831);
    gRib = rib;
    base *= 0.92 + 0.1 * rib;
    float frame = 1.0 - smoothstep(0.08, 0.1, min(min(fu.y, fsz.y - fu.y), min(fu.x, fsz.x - fu.x)));
    base = mix(base, base * 0.7, frame);
    base *= 0.95 + 0.07 * fbm(fu * vec2(3.0, 0.7));
    rough = 0.55;
  } else if (pattern < 6.5) {
    // wood planks
    float pl = gridLine(fu.y, 0.26, 0.008);
    float plank = floor(fu.y / 0.26);
    float grain = fbm(vec2(fu.x * 0.7 + h21(vec2(plank)) * 30.0, fu.y * 18.0));
    base *= 0.84 + 0.22 * grain;
    base *= 1.0 - 0.35 * pl;
    float frame = 1.0 - smoothstep(0.1, 0.12, min(min(fu.y, fsz.y - fu.y), min(fu.x, fsz.x - fu.x)));
    base = mix(base, base * 0.82, frame * step(fsz.x, 3.0) * step(fsz.y, 3.0));
    rough = 0.78;
  } else if (pattern < 7.5) {
    // metal railing: brushed + rivets
    base *= 0.92 + 0.08 * vnoise(vec2(fu.x * 40.0, fu.y * 1.5));
    vec2 rp = vec2(fract(fu.x / 0.8) - 0.5, fu.y - fsz.y + 0.12) * vec2(0.8, 1.0);
    base *= 1.0 - 0.3 * (1.0 - smoothstep(0.02, 0.03, length(rp)));
    rough = 0.45;
  } else if (pattern < 8.5) {
    // spawn deck: tiles + chevron hazard band around the edges
    vec2 cell = floor(fu / 0.6);
    base *= 0.95 + 0.06 * h21(cell + 7.7);
    float j = max(gridLine(fu.x, 0.6, 0.01), gridLine(fu.y, 0.6, 0.01));
    base *= 1.0 - 0.15 * j;
    float e = min(min(fu.x, fsz.x - fu.x), min(fu.y, fsz.y - fu.y));
    float band = 1.0 - smoothstep(0.34, 0.36, e);
    float chev = step(0.5, fract((fu.x + fu.y) * 1.6));
    if (vWNorm.y > 0.5) base = mix(base, mix(vec3(0.95, 0.76, 0.1), vec3(0.12), chev), band * step(0.05, e));
    rough = 0.65;
  } else if (pattern > 9.5 && pattern < 10.5) {
    if (abs(vWNorm.y) < 0.5) {
      // slab edges / trench walls read as poured concrete
      base = base * 1.18 * (0.95 + 0.05 * fine);
      base *= 1.0 - 0.12 * gridLine(fu.y, 1.2, 0.01);
      rough = 0.9;
    } else {
      base *= 0.92 + 0.08 * vnoise(fu * 3.0) + 0.04 * (vnoise(fu * 37.0) - 0.5) * (1.0 - smoothstep(0.02, 0.06, length(fwidth(fu))));
      rough = 0.92;
      // container-yard markings (world space, symmetric under the map's 180° rotation)
      vec2 wp = vWPos.xz;
      float ax = abs(wp.x), az = abs(wp.y);
      float mw = fwidth(ax) + 1e-4;
      // dashed yellow lane dividers at x = ±11.5
      float dash = step(0.45, fract(az / 3.0));
      float lane = (1.0 - smoothstep(0.07 - mw, 0.07 + mw, abs(ax - 11.5))) * dash * step(4.0, az);
      // white bay lines beside the base containers
      float bay = (1.0 - smoothstep(0.05 - mw, 0.05 + mw, abs(fract((ax - 2.0) / 2.6) - 0.5) * 2.6)) * step(24.5, az) * step(az, 27.0) * step(ax, 8.0);
      // hatched safety zone at the foot of each central ramp
      float sx = wp.x * sign(wp.y);           // 180°-rotation-symmetric x (ramps sit at x=-4,z<0 and x=+4,z>0)
      vec2 hz = vec2(sx - 4.0, az - 17.0);
      float inZone = step(abs(hz.x), 2.0) * step(abs(hz.y), 1.0);
      float hatch = step(0.5, fract((wp.x + wp.y) * 1.25)) * inZone;
      float border = inZone * (1.0 - step(abs(hz.x), 1.9) * step(abs(hz.y), 0.9));
      float wear = 0.9 + 0.1 * smoothstep(0.2, 0.5, vnoise(wp * 3.0));
      base = mix(base, vec3(0.95, 0.74, 0.18), clamp(lane + hatch * 0.9 + border, 0.0, 1.0) * wear);
      base = mix(base, vec3(0.93, 0.93, 0.9), bay * wear);
    }
  } else if (pattern > 10.5 && pattern < 11.5) {
    // painted steel panels: 1.2 m panels with seams + bolt rows
    float seam = max(gridLine(fu.x, 1.2, 0.008), gridLine(fu.y, 1.2, 0.008));
    base *= 1.0 - 0.22 * seam;
    base *= 0.95 + 0.06 * fbm(fu * 1.3);
    rough = 0.5;
  } else if (pattern > 11.5 && pattern < 12.5) {
    base *= 0.9;
    rough = 0.45;
  } else if (pattern > 15.5 && pattern < 16.5) {
    // pavers: 2 m slabs
    vec2 cell = floor(fu / 2.0);
    base *= 0.95 + 0.07 * h21(cell + 1.3);
    float j = max(gridLine(fu.x, 2.0, 0.02), gridLine(fu.y, 2.0, 0.02));
    base *= 1.0 - 0.25 * j;
    rough = 0.84;
  } else if (pattern > 12.5) {
    base *= 0.95 + 0.05 * fine;
    rough = 0.7;
  } else {
    // planter: stone rim with grass bed on top
    float e = min(min(fu.x, fsz.x - fu.x), min(fu.y, fsz.y - fu.y));
    float bed = smoothstep(0.24, 0.27, e) * step(0.5, vWNorm.y);
    vec3 grass = vec3(0.32, 0.55, 0.22) * (0.8 + 0.35 * fbm(fu * 6.0));
    base = mix(base * (0.95 + 0.05 * fine), grass, bed);
    rough = mix(0.8, 0.95, bed);
  }
#ifdef USE_TEXLIB
  }
#endif
  // murals / signage
  if (vFaceFlags.z > -0.5) {
    float rep = fsz.y * 8.0;
    vec2 muv = vec2(fu.x / rep, (3.0 - vFaceFlags.z + clamp(fu.y / fsz.y, 0.004, 0.996)) / 4.0);
    vec4 mc = texture2D(uMural, muv);
    base = mix(base, mc.rgb * (0.92 + 0.1 * big), mc.a * 0.96);
  }
  // crisp modelled edges: thin bright chamfer + soft inner shadow
  float e = min(min(fu.x, fsz.x - fu.x), min(fu.y, fsz.y - fu.y));
  float ew = fwidth(e);
  // (edges are real bevel geometry now; the old painted chamfer lines drew seams where faces stack)
  // contact darkening at the foot of walls that stand on something
  if (vFaceFlags.x > 0.5 && vFaceFlags.y > 0.5) {
    base *= mix(0.55, 1.0, smoothstep(0.0, 0.85, fu.y));
  }
  gBaseRough = rough;

  // ---- wet ink ----
  // Atlas: A = coverage profile (0.5 at the edge), R/G = team weights, B = per-splat tone. Close up the atlas is
  // rebuilt with a cubic B-spline (round outlines + a smooth height field with an analytic gradient), far away the
  // mip-filtered lookup keeps edges calm. The height profile is a meniscus: steep rounded lip, flat glossy top.
  if (vFaceData.y > 0.5) {
    vec2 pdx = dFdx(vPaintUv), pdy = dFdy(vPaintUv);
    float texFoot = max(length(pdx), length(pdy)) / uTexel;
    float gk = min(1.0, 8.0 / max(texFoot, 1e-4));
    gPdx = pdx * gk; gPdy = pdy * gk;
    vec4 pnt = paintAt(vPaintUv);
    float near = 1.0 - smoothstep(0.9, 2.4, texFoot);
    vec2 gradA = vec2(0.0);
    float lod2 = textureLod(uPaint, vPaintUv, 2.0).a;
    if (near > 0.0 && lod2 > 0.002 && (lod2 < 0.998 || pnt.a < 0.998)) {
      vec4 cub = paintCubic(vPaintUv, gradA);
      pnt = mix(pnt, cub, near);
      gradA *= near;
    }
    gInkNear = near;
    float amt = pnt.a;
    float fw = fwidth(amt);
    float w = clamp(fw * 0.8, 0.008, 0.25);
    gInk = smoothstep(0.5 - w, 0.5 + w, amt);
    float tw = pnt.r + pnt.g;
    float tm = smoothstep(0.4, 0.6, pnt.g / max(tw, 1e-4));
    // thickness profile: 0 at the edge → 1 on the flat top (≈2–3 texels in)
    float s = clamp((amt - 0.5) * 1.7, 0.0, 1.0);
    float hs = 1.0 - (1.0 - s) * (1.0 - s);
    gInkS = hs;
    // meniscus tilt (per texel of the atlas → angle independent of atlas density); fades once a texel is < ~1 px
    gInkD = gradA * 2.0 * (1.0 - s) * 1.7 * 1.9 * gInk;
    // fresh ink (landed in the last ~1.4 s): wetter, glossier, slightly brighter, still settling
    for (int i = 0; i < 16; i++) {
      vec4 fr = uFresh[i];
      float age = uFreshAge[i];
      if (age < 1.4) {
        float d = length(vWPos - fr.xyz);
        gFresh = max(gFresh, (1.0 - age / 1.4) * (1.0 - age / 1.4) * (1.0 - smoothstep(fr.w * 0.6, fr.w, d)));
      }
    }
    gFresh *= gInk;
    vec3 team = mix(uTeamA, uTeamB, tm);
    vec3 inkCol = team * (0.93 + 0.13 * pnt.b);
    // translucent thin lip reads lighter and a touch more saturated; the thick body a little deeper
    float lip = (1.0 - hs) * near;
    inkCol = mix(inkCol, inkCol * 1.16 + team * 0.05, lip * 0.35);
    inkCol *= 1.0 - 0.05 * hs;
    // seam between the two teams' ink: a thin darker crease so the colours never smear into each other
    float crease = (1.0 - abs(tm * 2.0 - 1.0)) * step(0.01, tm) * step(tm, 0.99);
    inkCol *= 1.0 - 0.22 * crease * gInk;
    inkCol *= 1.0 + 0.1 * gFresh;
    gInkCol = inkCol;
    // ink sits ON the ground: soft contact shadow + a faint coloured bounce hugging the outside of every edge
    float halo = smoothstep(0.06, 0.5, amt) * (1.0 - gInk) * near * smoothstep(0.4, 0.85, vWNorm.y);
    base *= mix(vec3(1.0), team * 0.45 + 0.3, halo * 0.5);
    base = mix(base, gInkCol, gInk);
  }
  diffuseColor.rgb = base;
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(gBaseRough, mix(0.24, 0.14, gFresh), gInk);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
#ifdef USE_TEXLIB
metalnessFactor = gTexORM.b * (1.0 - gInk);
#endif`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  // slopes along the face's u / v axes (height per unit length), applied in the face's world tangent frame
  vec2 slope = gInkD;
  if (gInk > 0.01) {
    // gel micro-surface: soft swells + settling ripples so reflections break into wet highlights. Mip-filtered
    // (fades to flat by itself at distance). Walls stretch it vertically, fresh ink sloshes a little.
    vec2 gp = vFaceUv * (abs(vWNorm.y) < 0.5 ? vec2(0.9, 0.42) : vec2(0.75));
    gp += vec2(uTime * 0.011, -uTime * 0.007) + gFresh * 0.05 * vec2(sin(uTime * 7.0), cos(uTime * 5.3));
#ifdef USE_TEXLIB
    if (uGel >= 0.0) {
      vec2 gx = dFdx(gp), gy = dFdy(gp);
      vec3 gn = textureGrad(tNormal, vec3(gp, uGel), gx, gy).xyz * 2.0 - 1.0;
      slope += -gn.xy / max(gn.z, 0.3) * (0.55 + 1.1 * gFresh) * gInk * gInkS;
    }
#else
    {
      const float e = 0.06;
      vec2 q = gp * 2.2;
      float hx = vnoise(q + vec2(e, 0.0)) - vnoise(q - vec2(e, 0.0));
      float hy = vnoise(q + vec2(0.0, e)) - vnoise(q - vec2(0.0, e));
      float gf = 1.0 - smoothstep(0.03, 0.12, length(fwidth(vWPos)));
      slope += vec2(hx, hy) / (2.0 * e) * 0.035 * gf * gInk;
    }
#endif
  }
#ifndef USE_TEXLIB
  if (vFaceData.x > 4.5 && vFaceData.x < 5.5) {
    // corrugation on containers (only where not inked), analytic derivative
    slope.x += (1.0 - gInk) * -sin(vFaceUv.x / 0.28 * 6.2831) * 0.35;
  }
#endif
  vec3 T = normalize(vFaceTan - vWNorm * dot(vFaceTan, vWNorm));
  vec3 Bt = cross(vWNorm, T);
  vec3 nBase = vWNorm;
#ifdef USE_TEXLIB
  // surface relief from the texture library; ink fills the grooves so the relief fades out under it
  // (on corrugated metal the ink still follows the ribs)
  float keep = (vFaceData.x > 4.5 && vFaceData.x < 5.5) ? 0.55 : 0.0;
  nBase = texlibPerturbNormal(gTexN, T, Bt, vWNorm, gTexStr * (1.0 - gInk * (1.0 - keep)));
#endif
  vec3 wn = normalize(nBase - slope.x * T - slope.y * Bt);
  normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
}`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
if (uAO > 0.0 && vLightUv.x >= 0.0) {
  // baked ambient occlusion: full on sky/indirect light, a touch on the sun so contact shadows read in daylight
  float bao = mix(1.0, texture2D(uLight, vLightUv).r, uAO);
  reflectedLight.indirectDiffuse *= bao;
  reflectedLight.indirectSpecular *= mix(1.0, bao, 0.85);
  reflectedLight.directDiffuse *= mix(1.0, bao, 0.4);
}`)
      .replace('#include <clearcoat_normal_fragment_begin>', `#include <clearcoat_normal_fragment_begin>
clearcoatNormal = normal;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
// a little self-light keeps ink loud in shadow and at dusk (subsurface-ish glow, stronger in the thick body)
totalEmissiveRadiance += gInkCol * gInk * uInkGlow * (0.75 + 0.35 * gInkS);`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
{
  // glossy wet coat on ink; roughness widened where the ink normal varies faster than the pixel grid (no sparkle)
  vec3 cdu = dFdx(normal), cdv = dFdy(normal);
  float kern = min(0.3 * (dot(cdu, cdu) + dot(cdv, cdv)), 0.18);
  float cr = mix(0.05, 0.035, gFresh);
  material.clearcoat = gInk;
  material.clearcoatRoughness = min(sqrt(sqrt(cr * cr * cr * cr + kern)), 1.0);
  material.roughness = mix(material.roughness, min(sqrt(sqrt(pow(material.roughness, 4.0) + kern)), 1.0), gInk);
  // the coat carries the gloss; the pigment layer underneath only adds a soft sheen (keeps the hue pure)
  material.specularColor *= 1.0 - 0.7 * gInk;
  material.specularColorBlended *= 1.0 - 0.7 * gInk;
  material.specularF90 = mix(material.specularF90, 0.35, gInk);
}`)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
// ink keeps its hue in shade: the blue sky's ambient is applied hue-neutral to the pigment
if (gInk > 0.0) {
  const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
  irradiance = mix(irradiance, vec3(dot(irradiance, LW)), 0.7 * gInk);
  #if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
  iblIrradiance = mix(iblIrradiance, vec3(dot(iblIrradiance, LW)), 0.7 * gInk);
  #endif
}
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular ) && defined( USE_CLEARCOAT )
  // stylised wet reflections: bright, but pushed toward a neutral sheen so a blue sky never turns yellow ink olive
  clearcoatRadiance = mix(clearcoatRadiance, vec3(dot(clearcoatRadiance, vec3(0.2126, 0.7152, 0.0722))), 0.55 * gInk);
  clearcoatRadiance *= 1.0 + gInk * (0.5 + 0.6 * gFresh);
#endif`)
      .replace('#include <opaque_fragment>', `outgoingLight = min(outgoingLight, vec3(5.0));
#include <opaque_fragment>`);
  };
  if (opts.grate) {
    mat.side = THREE.DoubleSide;
    mat.defines = { ...(mat.defines || {}), GRATE: 1 };
  }
  mat.customProgramCacheKey = () => 'inkwave-level-v3' + (opts.grate ? '-grate' : '');
  return mat;
}
