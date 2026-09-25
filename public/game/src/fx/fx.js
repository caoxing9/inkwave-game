// INKWAVE — ink particle FX. Pooled, allocation-free per frame, 7 draw calls total.
//
// const fx = new FX(scene, { quality: 'high' });      // quality: QUALITY key | QUALITY preset | particles multiplier
// fx.setCollider((from, to) => ({ point, normal }) | null)
// fx.onDropletLand = (point, normal, color, size) => {} // point/normal/color are scratch objects — copy if kept
// fx.update(dt, camera) · fx.clear() · fx.setLighting(env.getSkyColors()) · fx.stats()
//
// Contract API (docs/CONTRACTS.md §4): burst · drop · ring · explosion · splatted · wake · muzzle · spawnFlash · rain
// Recipes added by the VFX stream (all colours: THREE.Color | hex | css string; vectors are read, never kept):
//   footstep(pos, color, surface 0 dry|1 own ink|2 enemy ink, dir, speed)   land(pos, color, surface, speed)
//   jumpOff(pos, color, surface, swim)   formPop(pos, color, toSquid, inInk)   dive(pos, color, speed)   emerge(pos, color, speed)
//   bubbles(pos, color, n)   climbDrip(pos, wallNormal, color)   climbPop(pos, dir, color)   hurtDrip(pos, color, size)
//   hitSplash(pos, dir, color, amount, killed)   mist(pos, vel, color, size, alpha)   shotTrail(pos, vel, color, big)
//   muzzle(pos, dir, color, kind 'shooter'|'blaster'|'charger')   dryFire(pos, dir)
//   chargeGlow(pos, color, k)   chargeFull(pos, color)   laserDot(pos, normal, color, k)   beamImpact(pos, normal, color, charge)
//   beamTrail(from, to, color, charge)   rollerSpray(pos, fwd, width, color, k)   flickCurtain(pos, dir, color, spreadDeg)
//   dangerRing(pos, normal, color, radius, k)   beepPulse(bombPos, groundPos, normal, color, radius, k)   bombTrail(pos, vel, color)
//   bounceSplash(pos, normal, color)   slamLaunch(pos, color)   slamCharge(pos, color, k)   slamFall(pos, color)   slamWave(pos, color, radius)
//   stormStart(pos, color, radius)   stormPuddle(pos, normal, color)   stormFlash(pos, color, radius)
//   superJumpCharge(pos, color, k)   superJumpLaunch(pos, color)   superJumpTrail(pos, vel, color)
//   jumpMarker(pos, color, t)   superJumpLand(pos, color)   ghost(pos, color)   waterSplash(pos, size)   waterPlop(pos, size)
//   specialSparkle(pos, color, height)   enemyInkSizzle(pos, color)   seaSpray(pos, outward, strength)   feather(pos)   glint(pos, color, size)
// Immediate-mode (call every frame while visible; drawn next frame, never aged): dangerRing, jumpMarker, laserDot, mark(), pillar().
// Ambient: a GPU dust-mote field around the camera (no CPU cost) — fx.motes.visible to toggle.
//
// Pools: glossy droplets (sphere impostors stretched along velocity, 2 tris; matte mode for dust grains), soft puffs
// (billboards, alpha: mist / storm cloud / feather / squid ghost / dust), glows (billboards, additive HDR → bloom above the
// engine's 2.4 threshold: soft glow / star glint / bubble / halo ring), rings (normal-aligned decal quads: ink shockwave,
// ripple, splash disc, bomb danger ring, super-jump target, dust ring, splat blot, thin shockwave), shells (displaced ink
// spheres), beams (geysers + immediate light pillars), motes. Peak geometry ≈ 2 tris per sprite/droplet + 320/shell +
// 336/beam — a heavy moment (bomb + slam + 8 players fighting) stays ≈ 10–16k triangles.
import * as THREE from 'three';
import { QUALITY, PLAYER } from '../config.js';

const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;
const rand = Math.random;
const EMPTY = Object.freeze({});
const easeOut = (t) => 1 - (1 - t) * (1 - t) * (1 - t);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// droplet flags
const F_PAINT = 1, F_RING = 2, F_NOCOL = 4, F_QUIET = 8, F_MATTE = 16;
// glow kinds (encoded as kind * 10 + core in the shader)
const G_SOFT = 0, G_STAR = 10, G_BUBBLE = 20, G_HALO = 30;
// puff kinds
const P_MIST = 0, P_CLOUD = 1, P_FEATHER = 2, P_GHOST = 3, P_DUST = 4;
// ring styles
const R_WAVE = 0, R_RIPPLE = 1, R_DISC = 2, R_DANGER = 3, R_TARGET = 4, R_DUST = 5, R_BLOT = 6, R_THIN = 7;

// ---------------------------------------------------------------------------------------------------------------
// shared GLSL
// ---------------------------------------------------------------------------------------------------------------
const GLSL_HASH = /* glsl */`
float fxHash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float fxNoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(fxHash(i), fxHash(i+vec2(1.0,0.0)), u.x), mix(fxHash(i+vec2(0.0,1.0)), fxHash(i+vec2(1.0,1.0)), u.x), u.y); }
`;
const OUT_CHUNKS = /* glsl */`
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

// ---- droplets: velocity-stretched sphere impostors with glossy fake-PBR shading (aColA.a = gloss) ----
const DROP_VERT = /* glsl */`
attribute vec4 aPosR;   // xyz, radius
attribute vec4 aVelS;   // velocity, stretch
attribute vec4 aColA;   // rgb, gloss
varying vec2 vUv;
varying vec3 vCol;
varying vec2 vAx;
varying float vGloss;
void main() {
  vec4 c = viewMatrix * vec4(aPosR.xyz, 1.0);
  vec3 vv = mat3(viewMatrix) * aVelS.xyz;
  float s3 = length(vv), s2 = length(vv.xy);
  vec2 ax = s2 > 1e-4 ? vv.xy / s2 : vec2(0.0, 1.0);
  float st = 1.0 + (aVelS.w - 1.0) * (s3 > 1e-4 ? s2 / s3 : 0.0);
  vec2 bx = vec2(ax.y, -ax.x);   // right-handed with ax so the quad stays front-facing
  float r = aPosR.w;
  c.xy += ax * position.y * r * st + bx * position.x * r / sqrt(st);
  c.xyz += normalize(-c.xyz) * r * 0.6;
  vUv = position.xy;
  vCol = aColA.rgb;
  vGloss = aColA.a;
  vAx = ax;
  gl_Position = projectionMatrix * c;
}
`;
const DROP_FRAG = /* glsl */`
uniform vec3 uSunDirV;
uniform vec3 uUpV;
uniform vec3 uSunCol;
uniform vec3 uSkyCol;
uniform vec3 uGroundCol;
varying vec2 vUv;
varying vec3 vCol;
varying vec2 vAx;
varying float vGloss;
void main() {
  float d2 = dot(vUv, vUv);
  if (d2 > 1.0) discard;
  float z = sqrt(1.0 - d2);
  vec2 bx = vec2(vAx.y, -vAx.x);
  vec3 n = normalize(vec3(bx * vUv.x + vAx * vUv.y, z));
  float ndl = dot(n, uSunDirV);
  float wrap = clamp(ndl * 0.55 + 0.45, 0.0, 1.0);
  float up = dot(n, uUpV) * 0.5 + 0.5;
  vec3 amb = mix(uGroundCol, uSkyCol, up);
  float g = vGloss;
  vec3 base = vCol * (amb * 0.7 + uSunCol * wrap * 0.85 + 0.2);
  base += vCol * pow(clamp(-ndl, 0.0, 1.0), 2.0) * 0.3 * (1.0 - z) * g;     // light glowing through the ink
  vec3 R = reflect(vec3(0.0, 0.0, -1.0), n);
  float rup = dot(R, uUpV);
  vec3 env = mix(uGroundCol * 0.7, uSkyCol * 1.35, smoothstep(-0.15, 0.35, rup));
  float fres = (0.05 + 0.95 * pow(1.0 - z, 3.5)) * g;
  vec3 col = mix(base, env, fres * 0.5);
  float spec = pow(clamp(dot(R, uSunDirV), 0.0, 1.0), 80.0);
  col += uSunCol * spec * 5.0 * g;
  col *= mix(0.82, 1.0, g);
  gl_FragColor = vec4(col, smoothstep(1.0, 0.82, d2));
  ${OUT_CHUNKS}
}
`;

// ---- billboards (puffs + glows) ----
const SPRITE_VERT = /* glsl */`
attribute vec4 aPosSize;
attribute vec4 aColA;
attribute vec4 aMisc;   // x rotation, y seed, z t (0..1), w kind
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vMisc;
void main() {
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float c = cos(aMisc.x), s = sin(aMisc.x);
  vec2 q = mat2(c, s, -s, c) * position.xy;
  vec3 wp = aPosSize.xyz + (camR * q.x + camU * q.y) * aPosSize.w;
  vUv = position.xy * 2.0;
  vCol = aColA;
  vMisc = aMisc;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;
const PUFF_FRAG = /* glsl */`
${GLSL_HASH}
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vMisc;
void main() {
  float r = length(vUv);
  float seed = vMisc.y * 37.0;
  float ang = atan(vUv.y, vUv.x);
  float n = fxNoise(vec2(cos(ang), sin(ang)) * 2.2 + seed) * 0.6 + fxNoise(vUv * 3.1 + seed + vMisc.z * 1.5) * 0.4;
  float a = 0.0;
  vec3 col = vCol.rgb;
  float kind = vMisc.w;
  if (kind > 3.5) {
    // dust: grainy, soft-edged, lit from the top
    float n2 = fxNoise(vUv * 4.0 + seed + vMisc.z * 2.0);
    float edge = 0.55 + (n - 0.5) * 0.6;
    a = smoothstep(1.0, edge * 0.4, r + (n2 - 0.5) * 0.35) * (0.72 + 0.28 * n2);
    col = vCol.rgb * (0.86 + 0.24 * clamp(vUv.y * 0.8 + 0.2, -1.0, 1.0)) * (0.92 + 0.12 * n2);
  } else if (kind > 2.5) {
    // squid ghost: pointed mantle with fins, round head, two dark eyes, four wavy tentacles
    vec2 q = vUv * vec2(1.0, 1.05);
    float t = clamp((q.y - 0.05) / 0.9, 0.0, 1.0);
    float mw = mix(0.46, 0.0, pow(t, 0.9));
    float fin = 0.22 * exp(-pow((q.y - 0.3) / 0.12, 2.0));
    float mantle = step(0.02, q.y) * step(q.y, 0.95) * smoothstep(mw + fin + 0.025, mw + fin - 0.025, abs(q.x));
    float head = smoothstep(0.43, 0.39, length(q - vec2(0.0, -0.12)));
    float tent = 0.0;
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      float wx = -0.27 + 0.18 * fi + 0.05 * sin(q.y * 9.0 + vMisc.z * 14.0 + fi * 1.7);
      tent = max(tent, smoothstep(0.07, 0.045, abs(q.x - wx)) * smoothstep(-0.95, -0.85, q.y) * step(q.y, -0.25));
    }
    float body = max(max(mantle, head), tent);
    float eyes = max(smoothstep(0.105, 0.085, length(q - vec2(-0.15, -0.1))), smoothstep(0.105, 0.085, length(q - vec2(0.15, -0.1))));
    float shine = smoothstep(0.035, 0.02, length(q - vec2(-0.17, -0.07))) + smoothstep(0.035, 0.02, length(q - vec2(0.13, -0.07)));
    a = body;
    col = mix(vCol.rgb, vec3(1.0), 0.3) * (0.88 + 0.22 * clamp(q.y + 0.4, 0.0, 1.0));
    col = mix(col, vec3(0.06, 0.06, 0.1), eyes * 0.9);
    col = mix(col, vec3(1.0), clamp(shine, 0.0, 1.0));
  } else if (kind > 1.5) {
    // feather: tapered curved vane with barbs, a notch and a quill
    vec2 q = vUv;
    float y = q.y;
    float xv = q.x - 0.07 * (1.0 - y * y);
    float halfW = 0.3 * sqrt(max(0.0, 1.0 - y * y)) * (1.0 - 0.25 * y);
    float vane = smoothstep(halfW, halfW - 0.07, abs(xv)) * step(-0.78, y);
    float notch = 1.0 - smoothstep(0.03, 0.0, abs(y - 0.2 - xv * 0.7)) * step(0.0, xv) * 0.85;
    float shaft = smoothstep(0.035, 0.0, abs(xv)) * step(y, 0.98);
    float barbs = 0.84 + 0.16 * sin(y * 34.0 + abs(xv) * 24.0 + (xv > 0.0 ? 0.0 : 1.7));
    a = max(vane * notch, shaft);
    col = vCol.rgb * barbs * (0.88 + 0.14 * y);
    col = mix(col, vCol.rgb * 0.78, shaft);
  } else if (kind > 0.5) {
    // storm cloud puff: crisp billowy edge, bright top, dark inky belly
    float rr = r + (n - 0.5) * 0.16;
    a = smoothstep(1.0, 0.84, rr);
    float top = smoothstep(-0.85, 0.75, vUv.y + (n - 0.5) * 0.2);
    col = mix(vCol.rgb * 0.45, mix(vCol.rgb, vec3(1.0), 0.32), top);
    col += vec3(0.18) * smoothstep(0.6, 0.95, rr) * smoothstep(0.0, 0.6, vUv.y);
  } else {
    // soft ink mist, cartoon-lit from the top
    float edge = 0.62 + (n - 0.5) * 0.5;
    a = smoothstep(1.0, edge * 0.55, r + (n - 0.5) * 0.25);
    float lit = 0.78 + 0.32 * clamp(vUv.y * 0.8 + 0.25, -1.0, 1.0) + (n - 0.5) * 0.18;
    col = vCol.rgb * lit;
  }
  gl_FragColor = vec4(col, a * vCol.a);
  if (gl_FragColor.a < 0.004) discard;
  ${OUT_CHUNKS}
}
`;
const GLOW_FRAG = /* glsl */`
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vMisc;
void main() {
  float r = length(vUv);
  float kind = floor(vMisc.w / 10.0 + 0.001);
  float core = vMisc.w - kind * 10.0;
  vec3 col;
  if (kind < 0.5) {
    float g = pow(max(1.0 - r, 0.0), 2.2);
    float c = pow(max(1.0 - r * 1.8, 0.0), 3.0);
    col = vCol.rgb * g + vec3(1.0, 0.97, 0.92) * c * core;
  } else if (kind < 1.5) {
    // star glint: 4-point cross flare + faint diagonals + tight hot core
    vec2 q = vUv;
    float cr = max(exp(-abs(q.x) * 22.0) * exp(-abs(q.y) * 2.6), exp(-abs(q.y) * 22.0) * exp(-abs(q.x) * 2.6));
    vec2 d = vec2(q.x + q.y, q.x - q.y) * 0.7071;
    float dg = max(exp(-abs(d.x) * 30.0) * exp(-abs(d.y) * 6.0), exp(-abs(d.y) * 30.0) * exp(-abs(d.x) * 6.0)) * 0.4;
    float halo = pow(max(1.0 - r, 0.0), 3.0) * 0.45;
    float hot = pow(max(1.0 - r * 3.2, 0.0), 2.0);
    col = vCol.rgb * (cr + dg + halo) + vec3(1.0, 0.98, 0.95) * hot * core;
  } else if (kind < 2.5) {
    // bubble: thin bright rim + specular dot
    float rim = smoothstep(0.16, 0.0, abs(r - 0.8)) * 0.8 + smoothstep(0.5, 0.95, r) * step(r, 0.9) * 0.25;
    float hl = smoothstep(0.24, 0.0, length(vUv - vec2(-0.3, 0.34)));
    col = vCol.rgb * rim + vec3(1.0) * hl * (0.6 + core * 0.2);
  } else {
    // halo ring flash
    float ring = exp(-pow((r - 0.78) * 7.0, 2.0));
    col = vCol.rgb * ring + vec3(1.0) * ring * ring * core * 0.3;
  }
  gl_FragColor = vec4(col * vCol.a, 1.0);
  ${OUT_CHUNKS}
}
`;

// ---- rings (decal quads aligned to a surface normal) ----
const RING_VERT = /* glsl */`
attribute vec4 aPosR;   // xyz, radius (current)
attribute vec4 aNrmT;   // normal, t (0..1)
attribute vec4 aColA;
attribute vec4 aMisc;   // x seed, y style, z thickness
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vMisc;
varying float vT;
void main() {
  vec3 n = normalize(aNrmT.xyz);
  vec3 ref = abs(n.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t = normalize(cross(ref, n));
  vec3 b = cross(n, t);
  vec3 wp = aPosR.xyz + (t * position.x + b * position.y) * aPosR.w + n * 0.025;
  vUv = position.xy;
  vCol = aColA; vMisc = aMisc; vT = aNrmT.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;
const RING_FRAG = /* glsl */`
${GLSL_HASH}
uniform float uTime;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vMisc;
varying float vT;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float ang = atan(vUv.y, vUv.x);
  float seed = vMisc.x * 53.0;
  float wob = fxNoise(vec2(cos(ang), sin(ang)) * 3.0 + seed) - 0.5;
  float a = 0.0;
  vec3 col = vCol.rgb;
  float st = vMisc.y;
  if (st < 0.5) {
    // ink shockwave: thick wobbly band that thins as it expands, plus droplet beads on the rim
    float outer = 0.93 + wob * 0.1;
    float w = mix(0.34, 0.07, vT) * vMisc.z;
    float band = smoothstep(outer + 0.02, outer - 0.02, r) * smoothstep(outer - w - 0.03, outer - w + 0.02, r);
    float beads = smoothstep(0.35, 0.0, length(vec2(fract(ang / 6.2831 * 18.0 + seed) - 0.5, (r - outer) * 7.0))) * step(0.45, fxHash(vec2(floor(ang / 6.2831 * 18.0 + seed), seed)));
    float fill = pow(1.0 - vT, 4.0) * 0.45 * smoothstep(outer, outer * 0.3, r);
    a = max(max(band, beads * (1.0 - vT)), fill);
    col *= 0.9 + 0.35 * smoothstep(outer - w, outer, r);
    a *= pow(1.0 - vT, 1.3);
  } else if (st < 1.5) {
    // water / swim ripple: thin soft outline
    float outer = 0.9 + wob * 0.06;
    a = smoothstep(outer + 0.06, outer, r) * smoothstep(outer - 0.16, outer - 0.03, r) * (1.0 - vT) * (1.0 - vT);
    col = mix(col, vec3(1.0), 0.35);
  } else if (st < 2.5) {
    // splash disc: quick filled blot
    a = smoothstep(0.95 + wob * 0.2, 0.7 + wob * 0.2, r) * pow(1.0 - vT, 2.0);
  } else if (st < 3.5) {
    // bomb danger zone: bold rim, rotating dashes, pulses that quicken with the fuse (vT), tinted fill, dark outline
    float spin = uTime * (0.5 + vT * 1.8);
    float rim = smoothstep(0.045, 0.012, abs(r - 0.955));
    float dashes = step(0.45, fract(ang / 6.2831853 * 16.0 - spin)) * smoothstep(0.04, 0.012, abs(r - 0.87));
    float ph = fract(uTime * (1.0 + vT * 4.0));
    float wave = smoothstep(0.07, 0.0, abs(r - ph * 0.95)) * (1.0 - ph) * 0.85;
    float fill = (0.1 + 0.24 * vT) * (0.55 + 0.45 * smoothstep(0.0, 0.95, r)) * step(r, 0.955);
    float dark = smoothstep(0.03, 0.0, abs(r - 0.99));
    a = max(max(rim, dashes * 0.9), max(wave, fill));
    col = mix(col, vec3(1.0), rim * 0.3 + wave * 0.25);
    col = mix(col, vec3(0.04), dark * 0.7); a = max(a, dark * 0.5);
  } else if (st < 4.5) {
    // super-jump target: rim, inner ring, four rotating inward chevrons, contracting pulse, blinking core
    float spin = uTime * 1.2;
    float outer = smoothstep(0.045, 0.012, abs(r - 0.94));
    float dark = smoothstep(0.035, 0.0, abs(r - 0.99));
    float inner = smoothstep(0.03, 0.008, abs(r - 0.56)) * 0.85;
    float sa = ang - spin;
    float seg = mod(sa + 0.3927, 1.5707963) - 0.7853981;
    vec2 pl = vec2(r - 0.76, seg * 0.76);
    float chev = smoothstep(0.04, 0.0, abs(pl.x + abs(pl.y) * 0.9 - 0.02)) * step(abs(pl.y), 0.14);
    float ph = fract(uTime * 1.1);
    float wave = smoothstep(0.05, 0.0, abs(r - (1.0 - ph) * 0.9)) * ph * 0.85;
    float core = smoothstep(0.2, 0.14, r) * (0.7 + 0.3 * sin(uTime * 9.0));
    float fill = 0.14 * step(r, 0.94);
    a = max(max(outer, inner), max(max(chev, wave), max(core, fill)));
    col = mix(col, vec3(1.0), outer * 0.25 + core * 0.45 + chev * 0.25);
    col = mix(col, vec3(0.04), dark * 0.7); a = max(a, dark * 0.55);
  } else if (st < 5.5) {
    // dust ring: soft noisy band
    float nn = fxNoise(vUv * 5.0 + seed);
    float outer = 0.86 + wob * 0.16;
    float band = smoothstep(outer, outer - 0.3, r) * smoothstep(outer - 0.78, outer - 0.25, r);
    a = band * (0.55 + 0.45 * nn) * pow(1.0 - vT, 1.6);
    col *= 0.9 + 0.2 * nn;
  } else if (st < 6.5) {
    // glossy splat blot with spiky rim + highlight
    float spikes = fxNoise(vec2(ang * 2.6 + seed, seed));
    float edge = 0.55 + 0.38 * spikes + wob * 0.2;
    a = smoothstep(edge, edge - 0.14, r) * pow(1.0 - vT, 1.5);
    float hl = smoothstep(0.35, 0.0, length(vUv - vec2(-0.22, 0.26)));
    col = col * (0.82 + 0.3 * (1.0 - r)) + vec3(0.3) * hl;
  } else {
    // thin shockwave (air bursts / pulses)
    float w = mix(0.14, 0.035, vT) * max(vMisc.z, 0.3);
    float d = (r - 0.93) / w;
    a = exp(-d * d) * pow(1.0 - vT, 1.1);
    col = mix(col, vec3(1.0), 0.4);
  }
  gl_FragColor = vec4(col, a * vCol.a);
  if (gl_FragColor.a < 0.004) discard;
  ${OUT_CHUNKS}
}
`;

// ---- ink shells (translucent wobbly spheres: explosion shell, splat pop) ----
const SHELL_VERT = /* glsl */`
attribute vec4 aPosR;
attribute vec4 aColA;
attribute vec4 aMisc;   // x t, y seed, z kind (0 ink shell, 1 ghost), w wobble amount
uniform float uTime;
varying vec3 vN;
varying vec3 vW;
varying vec4 vCol;
varying vec4 vMisc;
void main() {
  vec3 n = normalize(position);
  float s = aMisc.y * 17.0;
  float w = sin(n.x * 5.1 + s + uTime * 7.0) * sin(n.y * 4.3 + s * 1.7 + uTime * 5.3) * sin(n.z * 4.7 + s * 0.6 - uTime * 6.1);
  w += 0.5 * sin(n.x * 11.0 - n.z * 9.0 + s * 2.1 + uTime * 9.0);
  float rad = aPosR.w * (1.0 + w * aMisc.w);
  if (aMisc.z > 0.5) rad *= 1.0 + 0.18 * n.y;
  vec3 wp = aPosR.xyz + n * rad;
  vN = n;
  vW = wp;
  vCol = aColA; vMisc = aMisc;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;
const SHELL_FRAG = /* glsl */`
uniform vec3 uSunDir;
varying vec3 vN;
varying vec3 vW;
varying vec4 vCol;
varying vec4 vMisc;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float f = 1.0 - clamp(abs(dot(N, V)), 0.0, 1.0);
  vec3 R = reflect(-V, N);
  float spec = pow(clamp(dot(R, uSunDir), 0.0, 1.0), 36.0);
  float lit = 0.62 + 0.45 * clamp(dot(N, uSunDir), 0.0, 1.0) + 0.12 * N.y;
  vec3 col = vCol.rgb * lit;
  float a;
  if (vMisc.z < 0.5) {
    a = 0.02 + 0.9 * pow(f, 3.6);
    col += vec3(1.0) * spec * 1.2 + vCol.rgb * pow(f, 3.0) * 0.5;
  } else {
    a = pow(f, 1.8) * 0.85;
    col = mix(col, vec3(1.0), 0.18);
  }
  gl_FragColor = vec4(col, a * vCol.a);
  if (gl_FragColor.a < 0.004) discard;
  ${OUT_CHUNKS}
}
`;

// ---- beams (geyser columns + light pillars) ----
const BEAM_VERT = /* glsl */`
attribute vec4 aPosR;   // base pos, radius
attribute vec4 aColA;
attribute vec4 aMisc;   // x t, y height, z seed, w mode (0 geyser, 1 pillar)
varying vec3 vN;
varying vec3 vW;
varying float vH;
varying vec4 vCol;
varying vec4 vMisc;
void main() {
  float h = position.y;             // 0..1
  float bulge = aMisc.w > 0.5 ? 1.0 : 1.0 + 0.25 * sin(h * 9.0 + aMisc.z * 10.0 - aMisc.x * 30.0) * (1.0 - h);
  float taper = aMisc.w > 0.5 ? mix(1.0, 0.8, h) : mix(1.0, 0.55, h);
  vec3 wp = aPosR.xyz + vec3(position.x * aPosR.w * bulge * taper, h * aMisc.y, position.z * aPosR.w * bulge * taper);
  vN = normalize(vec3(position.x, 0.0, position.z));
  vW = wp; vH = h; vCol = aColA; vMisc = aMisc;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;
const BEAM_FRAG = /* glsl */`
${GLSL_HASH}
uniform float uTime;
varying vec3 vN;
varying vec3 vW;
varying float vH;
varying vec4 vCol;
varying vec4 vMisc;
void main() {
  vec3 V = normalize(cameraPosition - vW);
  float facing = abs(dot(normalize(vN), V));
  float ang = atan(vN.z, vN.x);
  float rim = pow(max(1.0 - facing, 0.0), 1.5);
  float a; vec3 col;
  if (vMisc.w > 0.5) {
    float streak = fxNoise(vec2(ang * 3.0 + vMisc.z * 13.0, vH * 7.0 - uTime * 2.6));
    a = (0.12 + 0.55 * rim) * (0.45 + 0.75 * streak) * smoothstep(1.0, 0.25, vH) * smoothstep(0.0, 0.04, vH);
    col = vCol.rgb * (1.1 + 0.8 * streak) + vec3(1.2) * pow(streak, 4.0) * (1.0 - vH);
  } else {
    float streak = fxNoise(vec2(ang * 3.0 + vMisc.z * 13.0, vH * 5.0 - vMisc.x * 9.0));
    a = (0.3 + 0.7 * rim) * (0.45 + 0.8 * streak);
    a *= smoothstep(1.0, 0.4, vH) * smoothstep(0.0, 0.05, vH);
    col = vCol.rgb * (1.0 + 0.9 * streak) + vec3(3.2) * pow(streak, 5.0) * (1.0 - vH) * (1.0 - vMisc.x);
  }
  gl_FragColor = vec4(col, clamp(a * vCol.a, 0.0, 1.0));
  ${OUT_CHUNKS}
}
`;

// ---- motes: sunlit dust / sea-salt specks drifting around the camera (fully GPU-animated) ----
const MOTE_VERT = /* glsl */`
attribute vec4 aSeed;
uniform float uTime;
uniform vec3 uCam;
uniform float uBox;
uniform vec3 uWind;
uniform vec3 uSunDir;
varying float vA;
varying vec2 vUv;
void main() {
  vec3 base = aSeed.xyz * uBox + uWind * uTime * (0.55 + aSeed.w * 0.9);
  base += vec3(sin(uTime * 0.71 + aSeed.w * 40.0), sin(uTime * 0.53 + aSeed.x * 30.0) * 0.6, cos(uTime * 0.61 + aSeed.y * 25.0)) * 0.3;
  vec3 rel = mod(base - uCam + 0.5 * uBox, uBox) - 0.5 * uBox;
  vec3 wp = uCam + rel;
  float d = length(rel);
  vA = smoothstep(0.35, 1.3, d) * (1.0 - smoothstep(uBox * 0.28, uBox * 0.5, d));
  vec3 V = rel / max(d, 1e-3);
  float fwd = pow(max(dot(V, uSunDir), 0.0), 4.0);
  vA *= 0.16 + 1.5 * fwd;
  vA *= 0.55 + 0.45 * sin(uTime * (1.3 + aSeed.w * 3.0) + aSeed.x * 50.0);
  vA *= smoothstep(-0.2, 0.4, wp.y);
  float size = mix(0.011, 0.03, aSeed.w * aSeed.w);
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  wp += (camR * position.x + camU * position.y) * size * 2.0;
  vUv = position.xy * 2.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;
const MOTE_FRAG = /* glsl */`
uniform vec3 uCol;
varying float vA;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  float g = pow(max(1.0 - r, 0.0), 2.4);
  if (g * vA < 0.002) discard;
  gl_FragColor = vec4(uCol * g * vA, 1.0);
  ${OUT_CHUNKS}
}
`;

// ---------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3();
const _tA = new THREE.Vector3(), _tB = new THREE.Vector3();
const _from = new THREE.Vector3(), _to = new THREE.Vector3();
const _hitP = new THREE.Vector3(), _hitN = new THREE.Vector3();
const _cbP = new THREE.Vector3(), _cbN = new THREE.Vector3(), _cbC = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);
const _sc = new THREE.Color(), _sc2 = new THREE.Color();
const DUST = new THREE.Color('#b8a98f');
const GRAIN = new THREE.Color('#b9ae9c');
const FOAM = new THREE.Color('#eef9ff');
const WATER = new THREE.Color('#bfe9ff');
const FEATHER = new THREE.Color('#f3f0e8');

// Random unit vector in a cone of half-angle maxAngle around axis n (n must be normalised).
function coneDir(n, maxAngle, out) {
  const cosMax = Math.cos(maxAngle);
  const z = 1 - rand() * (1 - cosMax);
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = rand() * TAU;
  if (Math.abs(n.y) < 0.95) _tA.set(0, 1, 0); else _tA.set(1, 0, 0);
  _tA.cross(n).normalize();
  _tB.copy(n).cross(_tA);
  return out.copy(n).multiplyScalar(z).addScaledVector(_tA, r * Math.cos(phi)).addScaledVector(_tB, r * Math.sin(phi));
}
function randSphere(out) {
  const z = rand() * 2 - 1, r = Math.sqrt(1 - z * z), p = rand() * TAU;
  return out.set(r * Math.cos(p), z, r * Math.sin(p));
}
// two unit vectors perpendicular to n
function basis(n, outT, outB) {
  if (Math.abs(n.y) < 0.95) outT.set(0, 1, 0); else outT.set(1, 0, 0);
  outT.cross(n).normalize();
  outB.copy(n).cross(outT);
}

function makeQuadGeo(cap, attrs) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const list = [];
  for (const [name, size] of attrs) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size);
    a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(name, a);
    list.push(a);
  }
  g.instanceCount = 0;
  g.userData.dyn = list;
  return g;
}
function withInstanceAttrs(base, cap, attrs) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.setAttribute('position', base.attributes.position);
  if (base.attributes.normal) g.setAttribute('normal', base.attributes.normal);
  const list = [];
  for (const [name, size] of attrs) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size);
    a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(name, a);
    list.push(a);
  }
  g.instanceCount = 0;
  g.userData.dyn = list;
  return g;
}
// Upload only the live part of every dynamic attribute. Reuses one range object per attribute (no per-frame garbage).
function markUpdated(geo, count) {
  const list = geo.userData.dyn;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const r = a._fxRange || (a._fxRange = { start: 0, count: 0 });
    r.start = 0; r.count = Math.max(1, count) * a.itemSize;
    a.updateRanges.length = 0;
    a.updateRanges.push(r);
    a.needsUpdate = true;
  }
}

// scheduler ops (delayed parts of multi-stage effects)
const OP_RING = 1, OP_CROWN = 2, OP_DUSTRING = 3;

// ---------------------------------------------------------------------------------------------------------------
// FX
// ---------------------------------------------------------------------------------------------------------------
export class FX {
  constructor(scene, opts = {}) {
    this.scene = scene;
    const q = opts.quality;
    this.q = typeof q === 'number' ? q : (typeof q === 'object' && q ? q.particles : (QUALITY[q] || QUALITY.high).particles) ?? 1;
    this.q = Math.max(0.25, this.q);
    this.waterY = opts.waterY ?? PLAYER.waterY;
    this.gravity = opts.gravity ?? 17;
    this.collider = null;
    this.onDropletLand = null;
    this.paintEffects = true;  // explosion / splatted / flick droplets may leave cosmetic paint via onDropletLand
    this.maxChecks = Math.round(1100 * this.q);
    this._checks = 0;
    this._dt = 1 / 60;
    this._time = 0;
    this._recycle = 0;
    this._colCache = new Map();
    this._col = new THREE.Color();
    this._colB = new THREE.Color();
    this._camPos = new THREE.Vector3(0, 10, 0);
    this._camDir = new THREE.Vector3(0, 0, -1);
    // lighting used by the droplet impostors + shells (defaults ≈ 'day'; call setLighting(env.getSkyColors()) on theme change)
    this._light = {
      sunDir: new THREE.Vector3(-0.41, 0.83, -0.38).normalize(),
      sunCol: new THREE.Color(1.0, 0.93, 0.84),
      sky: new THREE.Color(0.42, 0.62, 0.95),
      ground: new THREE.Color(0.5, 0.46, 0.42),
    };
    this.sunDir = this._light.sunDir;

    this.root = new THREE.Group();
    this.root.name = 'FX';
    scene.add(this.root);

    this._initDrops(Math.round(2600 * this.q));
    this._initSprites(Math.round(520 * this.q), Math.round(300 * this.q));
    this._initRings(Math.round(300 * this.q));
    this._initShells(16);
    this._initBeams(10);
    this._initMotes(Math.round(300 * this.q));
    // scheduler: [t, op, px, py, pz, nx, ny, nz, r, g, b, a0, a1, a2]
    this._sq = new Float32Array(96 * 14); this._sqN = 0;
  }

  setCollider(fn) { this.collider = fn; }

  // ------------------------------------------------------------------ colour input → linear THREE.Color (no alloc after first use of a string)
  _color(c, out) {
    if (c && c.isColor) return out.copy(c);
    if (typeof c === 'number') return out.setHex(c);
    if (typeof c === 'string') {
      let k = this._colCache.get(c);
      if (!k) { k = new THREE.Color(c); this._colCache.set(c, k); }
      return out.copy(k);
    }
    if (c && c.r !== undefined) return out.setRGB(c.r, c.g, c.b);
    return out.set(0xffffff);
  }
  _near(pos, d) { return this._camPos.distanceToSquared(pos) < d * d; }

  // ------------------------------------------------------------------ droplets (velocity-stretched glossy sphere impostors, 2 tris each)
  _initDrops(cap) {
    this.dCap = cap;
    this.dN = 0;
    this.dP = new Float32Array(cap * 3);   // position
    this.dV = new Float32Array(cap * 3);   // velocity
    this.dC = new Float32Array(cap * 3);   // colour
    this.dK = new Float32Array(cap * 3);   // last collision-checked point
    this.dA = new Float32Array(cap * 8);   // size, age, life, grav, stretch, seed, -, flags
    const geo = makeQuadGeo(cap, [['aPosR', 4], ['aVelS', 4], ['aColA', 4]]);
    geo.attributes.position.array.forEach((v, i, a) => { a[i] = v * 2; }); // quad −1..1
    const L = this._light;
    this._dropU = { uSunDirV: { value: new THREE.Vector3(0, 1, 0) }, uUpV: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: L.sunCol }, uSkyCol: { value: L.sky }, uGroundCol: { value: L.ground } };
    const mat = new THREE.ShaderMaterial({ uniforms: this._dropU, vertexShader: DROP_VERT, fragmentShader: DROP_FRAG, alphaToCoverage: true, fog: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; mesh.renderOrder = 4; mesh.name = 'FX_Droplets';
    this.dGeo = geo;
    this.dMesh = mesh;
    this.root.add(mesh);
  }

  // flags: 1 paint, 2 ripple ring on land, 4 no-collide, 8 quiet landing (no blot / beads), 16 matte (dust grain)
  _spawnDrop(px, py, pz, vx, vy, vz, col, size, life, grav, stretch, flags) {
    let i;
    if (this.dN < this.dCap) i = this.dN++;
    else { i = this._recycle % this.dCap; this._recycle += 7; }
    const i3 = i * 3, i8 = i * 8;
    this.dP[i3] = px; this.dP[i3 + 1] = py; this.dP[i3 + 2] = pz;
    this.dK[i3] = px; this.dK[i3 + 1] = py; this.dK[i3 + 2] = pz;
    this.dV[i3] = vx; this.dV[i3 + 1] = vy; this.dV[i3 + 2] = vz;
    this.dC[i3] = col.r; this.dC[i3 + 1] = col.g; this.dC[i3 + 2] = col.b;
    const A = this.dA;
    A[i8] = size; A[i8 + 1] = 0; A[i8 + 2] = life; A[i8 + 3] = grav; A[i8 + 4] = stretch; A[i8 + 5] = rand(); A[i8 + 6] = 0; A[i8 + 7] = flags;
    return i;
  }
  _killDrop(i) {
    const last = --this.dN;
    if (i !== last) {
      this.dP.copyWithin(i * 3, last * 3, last * 3 + 3);
      this.dV.copyWithin(i * 3, last * 3, last * 3 + 3);
      this.dC.copyWithin(i * 3, last * 3, last * 3 + 3);
      this.dK.copyWithin(i * 3, last * 3, last * 3 + 3);
      this.dA.copyWithin(i * 8, last * 8, last * 8 + 8);
    }
  }
  // Droplet hit something: paint callback, a quick flattening blot decal, and a couple of rebound beads.
  _landDrop(i, px, py, pz, nx, ny, nz, water) {
    const i3 = i * 3, i8 = i * 8, A = this.dA;
    const size = A[i8], flags = A[i8 + 7];
    _cbC.setRGB(this.dC[i3], this.dC[i3 + 1], this.dC[i3 + 2]);
    if (water) {
      if (flags & (F_MATTE | F_QUIET)) return;
      _cbP.set(px, this.waterY + 0.01, pz);
      this._ringRaw(_cbP, UP, _cbC.lerp(_white, 0.55), 0.18 + size * 2.5, 0.45, R_RIPPLE, 0.7, 1);
      return;
    }
    if ((flags & F_PAINT) && this.onDropletLand) {
      _cbP.set(px, py, pz); _cbN.set(nx, ny, nz);
      this.onDropletLand(_cbP, _cbN, _cbC, size);
      _cbC.setRGB(this.dC[i3], this.dC[i3 + 1], this.dC[i3 + 2]);
    }
    if (flags & (F_QUIET | F_MATTE)) return;
    _cbP.set(px, py, pz); _cbN.set(nx, ny, nz);
    this._ringRaw(_cbP, _cbN, _cbC, size * 2.3 + 0.03, 0.2 + size * 0.6, R_DISC, 0.95, 1);
    if (flags & F_RING) this._ringRaw(_cbP, _cbN, _cbC, 0.14 + size * 1.8, 0.22, R_RIPPLE, 0.55, 1);
    if (size > 0.085 && this.dN < this.dCap - 8 && rand() < 0.65) {
      const n = 1 + (rand() < 0.5 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        coneDir(_cbN, 1.15, _v4);
        const sp = 1.3 + rand() * 1.9;
        this._spawnDrop(px + nx * 0.03, py + ny * 0.03, pz + nz * 0.03, _v4.x * sp, _v4.y * sp, _v4.z * sp, _cbC, size * 0.32, 0.45, 1, 1, F_NOCOL);
      }
    }
  }

  _updateDrops(dt) {
    const P = this.dP, Vv = this.dV, A = this.dA, K = this.dK;
    const g = this.gravity, wy = this.waterY;
    const col = this.collider;
    for (let i = 0; i < this.dN; i++) {
      const i3 = i * 3, i8 = i * 8;
      A[i8 + 1] += dt;
      if (A[i8 + 1] >= A[i8 + 2]) { this._killDrop(i); i--; continue; }
      const drag = 1 - 0.35 * dt;
      Vv[i3] *= drag; Vv[i3 + 2] *= drag;
      Vv[i3 + 1] = Vv[i3 + 1] * drag - g * A[i8 + 3] * dt;
      const ox = P[i3], oy = P[i3 + 1], oz = P[i3 + 2];
      const nx = ox + Vv[i3] * dt, ny = oy + Vv[i3 + 1] * dt, nz = oz + Vv[i3 + 2] * dt;
      P[i3] = nx; P[i3 + 1] = ny; P[i3 + 2] = nz;
      const flags = A[i8 + 7];
      if (!(flags & F_NOCOL) && col && this._checks < this.maxChecks) {
        this._checks++;
        _from.set(K[i3], K[i3 + 1], K[i3 + 2]);
        _to.set(nx, ny, nz);
        const hit = col(_from, _to);
        K[i3] = nx; K[i3 + 1] = ny; K[i3 + 2] = nz;
        if (hit) {
          _hitP.copy(hit.point); _hitN.copy(hit.normal);
          this._landDrop(i, _hitP.x, _hitP.y, _hitP.z, _hitN.x, _hitN.y, _hitN.z, false);
          this._killDrop(i); i--; continue;
        }
      } else if (flags & F_NOCOL) { K[i3] = nx; K[i3 + 1] = ny; K[i3 + 2] = nz; }
      if (oy >= wy && ny < wy) {
        const t = (oy - wy) / Math.max(1e-5, oy - ny);
        this._landDrop(i, ox + (nx - ox) * t, wy, oz + (nz - oz) * t, 0, 1, 0, true);
        this._killDrop(i); i--; continue;
      }
    }
    // --- write instance attributes ---
    const aP = this.dGeo.attributes.aPosR.array, aV = this.dGeo.attributes.aVelS.array, aC = this.dGeo.attributes.aColA.array;
    for (let i = 0; i < this.dN; i++) {
      const i3 = i * 3, i4 = i * 4, i8 = i * 8;
      const size = A[i8], age = A[i8 + 1], life = A[i8 + 2];
      const vx = Vv[i3], vy = Vv[i3 + 1], vz = Vv[i3 + 2];
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const st = A[i8 + 4];
      let stretch = 1 + Math.min(sp * 0.05 * st, 1.8 * st);
      stretch *= 1 + 0.14 * Math.sin(age * 38 + A[i8 + 5] * 20) * Math.min(1, age * 6);
      const grow = Math.min(1, age * 22 + 0.35);
      const fade = Math.min(1, (life - age) / 0.12);
      aP[i4] = P[i3]; aP[i4 + 1] = P[i3 + 1]; aP[i4 + 2] = P[i3 + 2]; aP[i4 + 3] = size * grow * fade;
      aV[i4] = vx; aV[i4 + 1] = vy; aV[i4 + 2] = vz; aV[i4 + 3] = Math.max(1, stretch);
      aC[i4] = this.dC[i3]; aC[i4 + 1] = this.dC[i3 + 1]; aC[i4 + 2] = this.dC[i3 + 2]; aC[i4 + 3] = (A[i8 + 7] & F_MATTE) ? 0 : 1;
    }
    this.dGeo.instanceCount = this.dN;
    markUpdated(this.dGeo, this.dN);
  }

  // ------------------------------------------------------------------ sprites (puffs = alpha, glows = additive)
  _initSprites(capPuff, capGlow) {
    const attrs = [['aPosSize', 4], ['aColA', 4], ['aMisc', 4]];
    const mkPool = (cap, frag, blending, order, name) => {
      const geo = makeQuadGeo(cap, attrs);
      const mat = new THREE.ShaderMaterial({ vertexShader: SPRITE_VERT, fragmentShader: frag, transparent: true, depthWrite: false, blending, fog: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false; mesh.renderOrder = order; mesh.name = name;
      this.root.add(mesh);
      return {
        cap, n: 0, geo, mesh,
        P: new Float32Array(cap * 3), V: new Float32Array(cap * 3), C: new Float32Array(cap * 3),
        // size0, size1, age, life, alpha, rot, rotVel, drag, buoy, kind, fadeIn, seed, wobble, fadeOut
        X: new Float32Array(cap * 14),
      };
    };
    this.puffs = mkPool(capPuff, PUFF_FRAG, THREE.NormalBlending, 12, 'FX_Puffs');
    this.glows = mkPool(capGlow, GLOW_FRAG, THREE.AdditiveBlending, 20, 'FX_Glows');
  }
  _sprite(pool, px, py, pz, vx, vy, vz, col, size0, size1, life, alpha, drag = 2.2, buoy = 0, kind = 0, fadeIn = 0.08, spin = 1.2, wobble = 0, fadeOut = 0) {
    let i;
    if (pool.n < pool.cap) i = pool.n++; else i = Math.floor(rand() * pool.cap);
    const i3 = i * 3, x = i * 14;
    pool.P[i3] = px; pool.P[i3 + 1] = py; pool.P[i3 + 2] = pz;
    pool.V[i3] = vx; pool.V[i3 + 1] = vy; pool.V[i3 + 2] = vz;
    pool.C[i3] = col.r; pool.C[i3 + 1] = col.g; pool.C[i3 + 2] = col.b;
    const X = pool.X;
    X[x] = size0; X[x + 1] = size1; X[x + 2] = 0; X[x + 3] = life; X[x + 4] = alpha;
    X[x + 5] = pool === this.puffs && kind === P_GHOST ? 0 : rand() * TAU; X[x + 6] = (rand() - 0.5) * spin; X[x + 7] = drag; X[x + 8] = buoy;
    X[x + 9] = kind; X[x + 10] = fadeIn; X[x + 11] = rand(); X[x + 12] = wobble; X[x + 13] = fadeOut;
    return i;
  }
  _updateSprites(pool, dt, additive) {
    const P = pool.P, Vv = pool.V, C = pool.C, X = pool.X;
    const aPS = pool.geo.attributes.aPosSize.array, aC = pool.geo.attributes.aColA.array, aM = pool.geo.attributes.aMisc.array;
    for (let i = 0; i < pool.n; i++) {
      const x = i * 14;
      X[x + 2] += dt;
      if (X[x + 2] >= X[x + 3]) {
        const last = --pool.n;
        if (i !== last) { P.copyWithin(i * 3, last * 3, last * 3 + 3); Vv.copyWithin(i * 3, last * 3, last * 3 + 3); C.copyWithin(i * 3, last * 3, last * 3 + 3); X.copyWithin(x, last * 14, last * 14 + 14); }
        i--; continue;
      }
      const i3 = i * 3;
      const drag = Math.max(0, 1 - X[x + 7] * dt);
      Vv[i3] *= drag; Vv[i3 + 1] = Vv[i3 + 1] * drag + X[x + 8] * dt; Vv[i3 + 2] *= drag;
      const w = X[x + 12];
      if (w > 0) {
        // sway (feathers / ghosts / drifting mist): a slow lissajous push
        const ph = X[x + 2] * 2.1 + X[x + 11] * 40;
        Vv[i3] += Math.cos(ph) * w * dt * 2.4; Vv[i3 + 2] += Math.sin(ph * 0.83) * w * dt * 2.4;
      }
      P[i3] += Vv[i3] * dt; P[i3 + 1] += Vv[i3 + 1] * dt; P[i3 + 2] += Vv[i3 + 2] * dt;
      X[x + 5] += X[x + 6] * dt;
    }
    for (let i = 0; i < pool.n; i++) {
      const x = i * 14, i3 = i * 3, i4 = i * 4;
      const age = X[x + 2], life = X[x + 3];
      const t = age / life;
      const size = X[x] + (X[x + 1] - X[x]) * easeOut(t);
      const fi = X[x + 10] > 0 ? Math.min(1, age / X[x + 10]) : 1;
      const fo = X[x + 13] > 0 ? Math.min(1, (life - age) / X[x + 13]) : (additive ? (1 - t) : (1 - t * t));
      const a = X[x + 4] * fi * fo;
      aPS[i4] = P[i3]; aPS[i4 + 1] = P[i3 + 1]; aPS[i4 + 2] = P[i3 + 2]; aPS[i4 + 3] = size;
      aC[i4] = C[i3]; aC[i4 + 1] = C[i3 + 1]; aC[i4 + 2] = C[i3 + 2]; aC[i4 + 3] = a;
      aM[i4] = X[x + 5]; aM[i4 + 1] = X[x + 11]; aM[i4 + 2] = t; aM[i4 + 3] = X[x + 9];
    }
    pool.geo.instanceCount = pool.n;
    markUpdated(pool.geo, pool.n);
  }

  // ------------------------------------------------------------------ rings (+ immediate-mode marks appended each frame)
  _initRings(cap) {
    const mCap = 48;
    const geo = makeQuadGeo(cap + mCap, [['aPosR', 4], ['aNrmT', 4], ['aColA', 4], ['aMisc', 4]]);
    geo.attributes.position.array.forEach((v, i, a) => { a[i] = v * 2; }); // quad −1..1
    this._ringU = { uTime: { value: 0 } };
    const mat = new THREE.ShaderMaterial({ uniforms: this._ringU, vertexShader: RING_VERT, fragmentShader: RING_FRAG, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; mesh.renderOrder = 8; mesh.name = 'FX_Rings';
    this.root.add(mesh);
    // P pos, V velocity, N normal, C colour, X: radius, age, life, alpha, style, thick, seed, grow0
    this.rings = { cap, n: 0, geo, mesh, P: new Float32Array(cap * 3), V: new Float32Array(cap * 3), N: new Float32Array(cap * 3), C: new Float32Array(cap * 3), X: new Float32Array(cap * 8) };
    // immediate marks: P, N, C, X: radius, t, alpha, style, thick, seed
    this.marks = { cap: mCap, n: 0, P: new Float32Array(mCap * 3), N: new Float32Array(mCap * 3), C: new Float32Array(mCap * 3), X: new Float32Array(mCap * 6) };
  }
  _ringRaw(pos, normal, col, radius, life, style, alpha, thick, vx = 0, vy = 0, vz = 0) {
    const R = this.rings;
    let i;
    if (R.n < R.cap) i = R.n++; else i = Math.floor(rand() * R.cap);
    const i3 = i * 3, x = i * 8;
    R.P[i3] = pos.x; R.P[i3 + 1] = pos.y; R.P[i3 + 2] = pos.z;
    R.V[i3] = vx; R.V[i3 + 1] = vy; R.V[i3 + 2] = vz;
    const nl = Math.hypot(normal.x, normal.y, normal.z) || 1;
    R.N[i3] = normal.x / nl; R.N[i3 + 1] = normal.y / nl; R.N[i3 + 2] = normal.z / nl;
    R.C[i3] = col.r; R.C[i3 + 1] = col.g; R.C[i3 + 2] = col.b;
    R.X[x] = radius; R.X[x + 1] = 0; R.X[x + 2] = life; R.X[x + 3] = alpha; R.X[x + 4] = style; R.X[x + 5] = thick; R.X[x + 6] = rand();
    R.X[x + 7] = style === R_DISC || style === R_BLOT ? 0.55 : style === R_DUST ? 0.35 : 0.22;
    return i;
  }
  // Immediate-mode decal for this frame only (drawn next frame, then discarded).
  mark(pos, normal, color, radius, style = R_TARGET, alpha = 1, t = 0, thick = 1, seed = 0.5) {
    const M = this.marks;
    if (M.n >= M.cap) return;
    const i = M.n++, i3 = i * 3, x = i * 6;
    const col = this._color(color, this._colB);
    M.P[i3] = pos.x; M.P[i3 + 1] = pos.y; M.P[i3 + 2] = pos.z;
    const n = normal || UP, nl = Math.hypot(n.x, n.y, n.z) || 1;
    M.N[i3] = n.x / nl; M.N[i3 + 1] = n.y / nl; M.N[i3 + 2] = n.z / nl;
    M.C[i3] = col.r; M.C[i3 + 1] = col.g; M.C[i3 + 2] = col.b;
    M.X[x] = radius; M.X[x + 1] = t; M.X[x + 2] = alpha; M.X[x + 3] = style; M.X[x + 4] = thick; M.X[x + 5] = seed;
  }
  _updateRings(dt) {
    const R = this.rings, X = R.X;
    const aP = R.geo.attributes.aPosR.array, aN = R.geo.attributes.aNrmT.array, aC = R.geo.attributes.aColA.array, aM = R.geo.attributes.aMisc.array;
    for (let i = 0; i < R.n; i++) {
      const x = i * 8, i3 = i * 3;
      X[x + 1] += dt;
      if (X[x + 1] >= X[x + 2]) {
        const last = --R.n;
        if (i !== last) { R.P.copyWithin(i3, last * 3, last * 3 + 3); R.V.copyWithin(i3, last * 3, last * 3 + 3); R.N.copyWithin(i3, last * 3, last * 3 + 3); R.C.copyWithin(i3, last * 3, last * 3 + 3); X.copyWithin(x, last * 8, last * 8 + 8); }
        i--; continue;
      }
      const vx = R.V[i3], vy = R.V[i3 + 1], vz = R.V[i3 + 2];
      if (vx !== 0 || vy !== 0 || vz !== 0) {
        const k = Math.max(0, 1 - 1.6 * dt);
        R.P[i3] += vx * dt; R.P[i3 + 1] += vy * dt; R.P[i3 + 2] += vz * dt;
        R.V[i3] = vx * k; R.V[i3 + 1] = vy * k; R.V[i3 + 2] = vz * k;
      }
    }
    for (let i = 0; i < R.n; i++) {
      const x = i * 8, i3 = i * 3, i4 = i * 4;
      const t = X[x + 1] / X[x + 2];
      const r = X[x] * (X[x + 7] + (1 - X[x + 7]) * easeOut(t));
      aP[i4] = R.P[i3]; aP[i4 + 1] = R.P[i3 + 1]; aP[i4 + 2] = R.P[i3 + 2]; aP[i4 + 3] = r;
      aN[i4] = R.N[i3]; aN[i4 + 1] = R.N[i3 + 1]; aN[i4 + 2] = R.N[i3 + 2]; aN[i4 + 3] = t;
      aC[i4] = R.C[i3]; aC[i4 + 1] = R.C[i3 + 1]; aC[i4 + 2] = R.C[i3 + 2]; aC[i4 + 3] = X[x + 3];
      aM[i4] = X[x + 6]; aM[i4 + 1] = X[x + 4]; aM[i4 + 2] = X[x + 5]; aM[i4 + 3] = 0;
    }
    // immediate marks appended after the live rings
    const M = this.marks, MX = M.X;
    let n = R.n;
    for (let j = 0; j < M.n; j++, n++) {
      const x = j * 6, j3 = j * 3, i4 = n * 4;
      aP[i4] = M.P[j3]; aP[i4 + 1] = M.P[j3 + 1]; aP[i4 + 2] = M.P[j3 + 2]; aP[i4 + 3] = MX[x];
      aN[i4] = M.N[j3]; aN[i4 + 1] = M.N[j3 + 1]; aN[i4 + 2] = M.N[j3 + 2]; aN[i4 + 3] = MX[x + 1];
      aC[i4] = M.C[j3]; aC[i4 + 1] = M.C[j3 + 1]; aC[i4 + 2] = M.C[j3 + 2]; aC[i4 + 3] = MX[x + 2];
      aM[i4] = MX[x + 5]; aM[i4 + 1] = MX[x + 3]; aM[i4 + 2] = MX[x + 4]; aM[i4 + 3] = 0;
    }
    M.n = 0;
    R.geo.instanceCount = n;
    markUpdated(R.geo, n);
  }

  // ------------------------------------------------------------------ shells
  _initShells(cap) {
    const base = new THREE.IcosahedronGeometry(1, 2);
    const geo = withInstanceAttrs(base, cap, [['aPosR', 4], ['aColA', 4], ['aMisc', 4]]);
    this._shellUniforms = { uTime: { value: 0 }, uSunDir: { value: this.sunDir } };
    const mat = new THREE.ShaderMaterial({ uniforms: this._shellUniforms, vertexShader: SHELL_VERT, fragmentShader: SHELL_FRAG, transparent: true, depthWrite: false, fog: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; mesh.renderOrder = 10; mesh.name = 'FX_Shells';
    this.root.add(mesh);
    // P pos, V vel, C col, X: r0, r1, age, life, expand, alpha, kind, seed, wobble
    this.shells = { cap, n: 0, geo, mesh, P: new Float32Array(cap * 3), V: new Float32Array(cap * 3), C: new Float32Array(cap * 3), X: new Float32Array(cap * 9) };
  }
  _shell(pos, col, r0, r1, expand, life, alpha, kind, vy = 0, wobble = 0.08) {
    const S = this.shells;
    let i;
    if (S.n < S.cap) i = S.n++; else i = Math.floor(rand() * S.cap);
    const i3 = i * 3, x = i * 9;
    S.P[i3] = pos.x; S.P[i3 + 1] = pos.y; S.P[i3 + 2] = pos.z;
    S.V[i3] = 0; S.V[i3 + 1] = vy; S.V[i3 + 2] = 0;
    S.C[i3] = col.r; S.C[i3 + 1] = col.g; S.C[i3 + 2] = col.b;
    S.X[x] = r0; S.X[x + 1] = r1; S.X[x + 2] = 0; S.X[x + 3] = life; S.X[x + 4] = expand; S.X[x + 5] = alpha; S.X[x + 6] = kind; S.X[x + 7] = rand(); S.X[x + 8] = wobble;
  }
  _updateShells(dt) {
    const S = this.shells, X = S.X;
    const aP = S.geo.attributes.aPosR.array, aC = S.geo.attributes.aColA.array, aM = S.geo.attributes.aMisc.array;
    for (let i = 0; i < S.n; i++) {
      const x = i * 9, i3 = i * 3;
      X[x + 2] += dt;
      if (X[x + 2] >= X[x + 3]) {
        const last = --S.n;
        if (i !== last) { S.P.copyWithin(i3, last * 3, last * 3 + 3); S.V.copyWithin(i3, last * 3, last * 3 + 3); S.C.copyWithin(i3, last * 3, last * 3 + 3); X.copyWithin(x, last * 9, last * 9 + 9); }
        i--; continue;
      }
      S.P[i3 + 1] += S.V[i3 + 1] * dt;
    }
    for (let i = 0; i < S.n; i++) {
      const x = i * 9, i3 = i * 3, i4 = i * 4;
      const age = X[x + 2], life = X[x + 3];
      const te = Math.min(1, age / X[x + 4]);
      const r = X[x] + (X[x + 1] - X[x]) * easeOut(te);
      const t = age / life;
      const fadeStart = X[x + 4] / life * 0.45;
      const a = X[x + 5] * (t < fadeStart ? 1 : Math.pow(1 - (t - fadeStart) / (1 - fadeStart), 2.0));
      aP[i4] = S.P[i3]; aP[i4 + 1] = S.P[i3 + 1]; aP[i4 + 2] = S.P[i3 + 2]; aP[i4 + 3] = r;
      aC[i4] = S.C[i3]; aC[i4 + 1] = S.C[i3 + 1]; aC[i4 + 2] = S.C[i3 + 2]; aC[i4 + 3] = a;
      aM[i4] = t; aM[i4 + 1] = X[x + 7]; aM[i4 + 2] = X[x + 6]; aM[i4 + 3] = X[x + 8] * (1 - te * 0.6);
    }
    S.geo.instanceCount = S.n;
    markUpdated(S.geo, S.n);
  }

  // ------------------------------------------------------------------ beams (+ immediate pillars)
  _initBeams(cap) {
    const pCap = 8;
    const base = new THREE.CylinderGeometry(1, 1, 1, 24, 7, true);
    base.translate(0, 0.5, 0);
    const geo = withInstanceAttrs(base, cap + pCap, [['aPosR', 4], ['aColA', 4], ['aMisc', 4]]);
    this._beamU = { uTime: { value: 0 } };
    const mat = new THREE.ShaderMaterial({ uniforms: this._beamU, vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; mesh.renderOrder = 18; mesh.name = 'FX_Beams';
    this.root.add(mesh);
    this.beams = { cap, n: 0, geo, mesh, P: new Float32Array(cap * 3), C: new Float32Array(cap * 3), X: new Float32Array(cap * 5) }; // radius, height, age, life, seed
    this.pillars = { cap: pCap, n: 0, P: new Float32Array(pCap * 3), C: new Float32Array(pCap * 4), X: new Float32Array(pCap * 3) }; // radius, height, seed
  }
  _beam(pos, col, radius, height, life) {
    const B = this.beams;
    let i;
    if (B.n < B.cap) i = B.n++; else i = 0;
    B.P[i * 3] = pos.x; B.P[i * 3 + 1] = pos.y; B.P[i * 3 + 2] = pos.z;
    B.C[i * 3] = col.r; B.C[i * 3 + 1] = col.g; B.C[i * 3 + 2] = col.b;
    B.X[i * 5] = radius; B.X[i * 5 + 1] = height; B.X[i * 5 + 2] = 0; B.X[i * 5 + 3] = life; B.X[i * 5 + 4] = rand();
  }
  // Immediate-mode light pillar (this frame only).
  pillar(pos, color, radius = 0.5, height = 8, alpha = 0.6, seed = 0.3) {
    const Pl = this.pillars;
    if (Pl.n >= Pl.cap) return;
    const i = Pl.n++;
    const col = this._color(color, this._colB);
    Pl.P[i * 3] = pos.x; Pl.P[i * 3 + 1] = pos.y; Pl.P[i * 3 + 2] = pos.z;
    Pl.C[i * 4] = col.r; Pl.C[i * 4 + 1] = col.g; Pl.C[i * 4 + 2] = col.b; Pl.C[i * 4 + 3] = alpha;
    Pl.X[i * 3] = radius; Pl.X[i * 3 + 1] = height; Pl.X[i * 3 + 2] = seed;
  }
  _updateBeams(dt) {
    const B = this.beams, X = B.X;
    const aP = B.geo.attributes.aPosR.array, aC = B.geo.attributes.aColA.array, aM = B.geo.attributes.aMisc.array;
    for (let i = 0; i < B.n; i++) {
      const x = i * 5;
      X[x + 2] += dt;
      if (X[x + 2] >= X[x + 3]) {
        const last = --B.n;
        if (i !== last) { B.P.copyWithin(i * 3, last * 3, last * 3 + 3); B.C.copyWithin(i * 3, last * 3, last * 3 + 3); X.copyWithin(x, last * 5, last * 5 + 5); }
        i--; continue;
      }
    }
    for (let i = 0; i < B.n; i++) {
      const x = i * 5, i3 = i * 3, i4 = i * 4;
      const t = X[x + 2] / X[x + 3];
      const h = X[x + 1] * easeOut(Math.min(1, t * 3.2));
      const r = X[x] * (0.55 + 0.6 * easeOut(Math.min(1, t * 4))) * (1 - 0.5 * t);
      aP[i4] = B.P[i3]; aP[i4 + 1] = B.P[i3 + 1]; aP[i4 + 2] = B.P[i3 + 2]; aP[i4 + 3] = r;
      aC[i4] = B.C[i3]; aC[i4 + 1] = B.C[i3 + 1]; aC[i4 + 2] = B.C[i3 + 2]; aC[i4 + 3] = Math.pow(1 - t, 1.6) * Math.min(1, t * 25);
      aM[i4] = t; aM[i4 + 1] = h; aM[i4 + 2] = X[x + 4]; aM[i4 + 3] = 0;
    }
    const Pl = this.pillars;
    let n = B.n;
    for (let j = 0; j < Pl.n; j++, n++) {
      const i4 = n * 4;
      aP[i4] = Pl.P[j * 3]; aP[i4 + 1] = Pl.P[j * 3 + 1]; aP[i4 + 2] = Pl.P[j * 3 + 2]; aP[i4 + 3] = Pl.X[j * 3];
      aC[i4] = Pl.C[j * 4]; aC[i4 + 1] = Pl.C[j * 4 + 1]; aC[i4 + 2] = Pl.C[j * 4 + 2]; aC[i4 + 3] = Pl.C[j * 4 + 3];
      aM[i4] = 0.35; aM[i4 + 1] = Pl.X[j * 3 + 1]; aM[i4 + 2] = Pl.X[j * 3 + 2]; aM[i4 + 3] = 1;
    }
    Pl.n = 0;
    B.geo.instanceCount = n;
    markUpdated(B.geo, n);
  }

  // ------------------------------------------------------------------ motes (GPU)
  _initMotes(count) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = rand();
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    g.instanceCount = count;
    this._moteU = {
      uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uBox: { value: 16 },
      uWind: { value: new THREE.Vector3(0.28, 0.05, 0.12) }, uSunDir: { value: this.sunDir },
      uCol: { value: new THREE.Color(1.0, 0.94, 0.8).multiplyScalar(0.9) },
    };
    const mat = new THREE.ShaderMaterial({ uniforms: this._moteU, vertexShader: MOTE_VERT, fragmentShader: MOTE_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false; mesh.renderOrder = 21; mesh.name = 'FX_Motes';
    this.motes = mesh;
    this.root.add(mesh);
  }

  // ------------------------------------------------------------------ scheduler (delayed stages; allocation-free)
  _after(delay, op, pos, normal, col, a0 = 0, a1 = 0, a2 = 0) {
    if (this._sqN >= 96) return;
    const o = this._sqN++ * 14, S = this._sq;
    S[o] = delay; S[o + 1] = op;
    S[o + 2] = pos.x; S[o + 3] = pos.y; S[o + 4] = pos.z;
    S[o + 5] = normal.x; S[o + 6] = normal.y; S[o + 7] = normal.z;
    S[o + 8] = col.r; S[o + 9] = col.g; S[o + 10] = col.b;
    S[o + 11] = a0; S[o + 12] = a1; S[o + 13] = a2;
  }
  _runSchedule(dt) {
    const S = this._sq;
    for (let i = 0; i < this._sqN; i++) {
      const o = i * 14;
      S[o] -= dt;
      if (S[o] > 0) continue;
      _v5.set(S[o + 2], S[o + 3], S[o + 4]); _v6.set(S[o + 5], S[o + 6], S[o + 7]); _sc2.setRGB(S[o + 8], S[o + 9], S[o + 10]);
      const op = S[o + 1], a0 = S[o + 11], a1 = S[o + 12], a2 = S[o + 13];
      // remove first (ops may schedule more)
      const last = --this._sqN;
      if (i !== last) S.copyWithin(o, last * 14, last * 14 + 14);
      i--;
      if (op === OP_RING) this._ringRaw(_v5, _v6, _sc2, a0, a1, a2, 0.9, 1);
      else if (op === OP_CROWN) this._crown(_v5, _v6, _sc2, a0, a1, a2);
      else if (op === OP_DUSTRING) this._dustRing(_v5, _sc2, a0, a1);
    }
  }

  // ------------------------------------------------------------------ ground probe (for rings under explosions)
  _probeDown(pos, depth, outP, outN) {
    if (this.collider) {
      _from.copy(pos); _to.copy(pos); _to.y -= depth;
      const h = this.collider(_from, _to);
      if (h) { outP.copy(h.point); outN.copy(h.normal); return true; }
    }
    if (pos.y - depth <= this.waterY && pos.y >= this.waterY) { outP.set(pos.x, this.waterY + 0.01, pos.z); outN.set(0, 1, 0); return true; }
    return false;
  }

  // ------------------------------------------------------------------ internal building blocks
  // radial splash crown on a surface: droplets thrown outward + upward along the normal
  _crown(pos, normal, col, n, speed, size, flags = 0) {
    basis(normal, _tA, _v4);
    const count = Math.max(1, Math.round(n * this.q));
    const a0 = rand() * TAU;
    for (let i = 0; i < count; i++) {
      const a = a0 + (i / count) * TAU + (rand() - 0.5) * 0.5;
      const c = Math.cos(a), s = Math.sin(a);
      const up = 0.7 + rand() * 0.9, out = 0.6 + rand() * 0.6;
      const sp = speed * (0.6 + rand() * 0.6);
      const dx = (_tA.x * c + _v4.x * s) * out + normal.x * up, dy = (_tA.y * c + _v4.y * s) * out + normal.y * up, dz = (_tA.z * c + _v4.z * s) * out + normal.z * up;
      const sz = size * (0.55 + rand() * 0.8);
      this._spawnDrop(pos.x + normal.x * 0.04, pos.y + normal.y * 0.04, pos.z + normal.z * 0.04, dx * sp, dy * sp, dz * sp, col, sz, 1.2, 1, 1, flags);
    }
  }
  // puffs of dust thrown radially along the ground
  _dustRing(pos, col, n, speed) {
    const count = Math.max(2, Math.round(n * this.q));
    const a0 = rand() * TAU;
    for (let i = 0; i < count; i++) {
      const a = a0 + (i / count) * TAU + (rand() - 0.5) * 0.4, sp = speed * (0.6 + rand() * 0.6);
      this._sprite(this.puffs, pos.x + Math.cos(a) * 0.25, pos.y + 0.12 + rand() * 0.12, pos.z + Math.sin(a) * 0.25, Math.cos(a) * sp, 0.3 + rand() * 0.5, Math.sin(a) * sp,
        col, 0.16 + rand() * 0.1, 0.5 + rand() * 0.35, 0.55 + rand() * 0.35, 0.3, 3.2, 0.25, P_DUST, 0.05, 1.2);
    }
  }
  _grains(pos, dir, n, speed) {
    const count = Math.max(1, Math.round(n * this.q));
    for (let i = 0; i < count; i++) {
      coneDir(dir, 0.9, _v1);
      const sp = speed * (0.6 + rand() * 0.7);
      this._spawnDrop(pos.x, pos.y + 0.03, pos.z, _v1.x * sp, _v1.y * sp, _v1.z * sp, GRAIN, 0.01 + rand() * 0.012, 0.3 + rand() * 0.2, 1.1, 1, F_NOCOL | F_MATTE);
    }
  }
  _toCam(pos, out) { return out.copy(this._camPos).sub(pos).normalize(); }

  // =================================================================== contract API
  burst(pos, normal, color, opts = EMPTY) {
    const col = this._color(color, this._col);
    const count = Math.max(1, Math.round((opts.count ?? 12) * this.q));
    const speed = opts.speed ?? 4, size = opts.size ?? 0.1, spread = opts.spread ?? 0.9, grav = opts.gravity ?? 1;
    const paint = opts.paint ? F_PAINT : 0;
    _v3.copy(normal || UP); if (_v3.lengthSq() < 1e-6) _v3.copy(UP); _v3.normalize();
    const px = pos.x + _v3.x * 0.04, py = pos.y + _v3.y * 0.04, pz = pos.z + _v3.z * 0.04;
    for (let i = 0; i < count; i++) {
      coneDir(_v3, Math.max(0.05, spread) * Math.PI * 0.5, _v1);
      const sp = speed * (0.45 + rand() * 0.75);
      const sz = size * (0.55 + rand() * 0.8);
      this._spawnDrop(px, py, pz, _v1.x * sp, _v1.y * sp, _v1.z * sp, col, sz, 1.6 + rand() * 0.6, grav, 1, paint);
      if (rand() < 0.45) { // satellite
        const s2 = sp * (0.7 + rand() * 0.5);
        this._spawnDrop(px, py, pz, _v1.x * s2 + (rand() - 0.5) * 0.8, _v1.y * s2 + (rand() - 0.5) * 0.8, _v1.z * s2 + (rand() - 0.5) * 0.8, col, sz * 0.42, 1.2, grav, 1, 0);
      }
    }
    if (opts.ring !== false) this._ringRaw(pos, _v3, col, 0.22 + size * 3.2, 0.26, R_WAVE, 0.9, 1.1);
    if (opts.mist !== false && count >= 6) {
      this._colB.copy(col).lerp(_white, 0.3);
      this._sprite(this.puffs, px, py, pz, _v3.x * 1.2, _v3.y * 1.2, _v3.z * 1.2, this._colB, size * 2, size * 5, 0.35, 0.35, 5);
    }
  }

  drop(pos, vel, color, opts = EMPTY) {
    const col = this._color(color, this._col);
    this._spawnDrop(pos.x, pos.y, pos.z, vel.x, vel.y, vel.z, col, opts.size ?? 0.1, opts.life ?? 1.2, opts.gravity ?? 1, opts.stretch ?? 1, (opts.paint ? F_PAINT : 0) | (opts.ring ? F_RING : 0) | (opts.quiet ? F_QUIET : 0) | (opts.noCollide ? F_NOCOL : 0));
  }

  ring(pos, normal, color, opts = EMPTY) {
    const col = this._color(color, this._col);
    this._ringRaw(pos, normal || UP, col, opts.radius ?? 1.5, opts.life ?? 0.35, opts.style ?? R_WAVE, opts.alpha ?? 0.95, opts.thickness ?? 1);
  }

  explosion(pos, color, radius = 3) {
    const col = this._color(color, this._col);
    const q = this.q, R = radius;
    // volumetric parts (halo, shell, mist) are capped so a big blast (e.g. Tidal Slam) never swallows the camera;
    // the ground rings + droplets still show the full radius
    const Rv = Math.min(R, 2.4);
    const paint = this.paintEffects ? F_PAINT : 0;
    // flash: white-hot core (HDR → blooms) + team-coloured halo
    this._colB.copy(col).multiplyScalar(4.5);
    this._sprite(this.glows, pos.x, pos.y, pos.z, 0, 0, 0, this._colB, Rv * 0.7, Rv * 1.25, 0.2, 1, 2.2, 0, G_SOFT + 7.0, 0);
    this._colB.copy(col).multiplyScalar(1.3);
    this._sprite(this.glows, pos.x, pos.y, pos.z, 0, 0, 0, this._colB, Rv * 1.3, Rv * 2.1, 0.22, 0.7, 2.2, 0, G_SOFT, 0);
    // bright halo ring flash in the air
    this._colB.copy(col).lerp(_white, 0.35).multiplyScalar(2.2);
    this._sprite(this.glows, pos.x, pos.y, pos.z, 0, 0, 0, this._colB, Rv * 0.9, Rv * 2.4, 0.2, 0.9, 0, 0, G_HALO + 2, 0, 0);
    // thin translucent ink shell that pops out and fades fast
    this._shell(pos, col, Rv * 0.3, Rv * 1.0, 0.1, 0.22, 0.55, 0, 0, 0.08);
    // camera-facing air shockwave (reads for mid-air bursts where there is no ground ring)
    this._toCam(pos, _v4);
    this._ringRaw(pos, _v4, col, R * 1.15, 0.24, R_THIN, 0.95, 1.3);
    // ground rings
    if (this._probeDown(pos, R + 1.5, _v2, _v3)) {
      this._ringRaw(_v2, _v3, col, R * 1.22, 0.5, R_WAVE, 0.95, 1.25);
      this._ringRaw(_v2, _v3, col, R * 0.75, 0.3, R_DISC, 0.8, 1);
      this._after(0.07, OP_RING, _v2, _v3, col, R * 1.6, 0.55, R_RIPPLE);
    }
    // droplets
    const n = Math.round(46 * q);
    const spd = Math.sqrt(R / 3);
    for (let i = 0; i < n; i++) {
      randSphere(_v1); _v1.y = Math.abs(_v1.y) * 0.9 + 0.15; _v1.normalize();
      const sp = (5 + rand() * 7.5) * spd;
      const sz = rand() < 0.15 ? 0.11 + rand() * 0.05 : 0.04 + rand() * 0.07;
      const o = R * 0.25;
      this._spawnDrop(pos.x + _v1.x * o, pos.y + _v1.y * o, pos.z + _v1.z * o, _v1.x * sp, _v1.y * sp, _v1.z * sp, col, sz, 1.8, 1, 1, sz > 0.09 ? paint : 0);
    }
    // heavy gloops lobbed in slow arcs: they paint little satellite splats around the blast
    const nb = Math.round(7 * q);
    for (let i = 0; i < nb; i++) {
      const a = rand() * TAU, sp = (2.5 + rand() * 2.5) * spd;
      this._spawnDrop(pos.x, pos.y + 0.2, pos.z, Math.cos(a) * sp, 3.5 + rand() * 3, Math.sin(a) * sp, col, 0.12 + rand() * 0.06, 2.2, 1, 1, paint);
    }
    // lingering mist
    this._colB.copy(col).lerp(_white, 0.28);
    const m = Math.round(10 * q);
    for (let i = 0; i < m; i++) {
      randSphere(_v1); _v1.y = Math.abs(_v1.y) * 0.6;
      const d = R * (0.2 + rand() * 0.45);
      this._sprite(this.puffs, pos.x + _v1.x * d, pos.y + _v1.y * d * 0.6, pos.z + _v1.z * d, _v1.x * 2.2, 0.6 + rand() * 0.8, _v1.z * 2.2, this._colB, Rv * (0.3 + rand() * 0.2), Rv * (0.62 + rand() * 0.3), 0.7 + rand() * 0.4, 0.34, 2.8, 0.2);
    }
    // sparks + star glints
    this._colB.copy(col).lerp(_white, 0.45).multiplyScalar(5);
    for (let i = 0; i < 8; i++) {
      randSphere(_v1); _v1.y = Math.abs(_v1.y);
      const sp = 9 + rand() * 6;
      this._sprite(this.glows, pos.x, pos.y, pos.z, _v1.x * sp, _v1.y * sp, _v1.z * sp, this._colB, 0.28, 0.08, 0.22, 1, 5, 0, G_SOFT + 1, 0);
    }
    this._colB.copy(col).lerp(_white, 0.5).multiplyScalar(2.2);
    for (let i = 0; i < 4; i++) {
      randSphere(_v1); _v1.y = Math.abs(_v1.y) * 0.8 + 0.2;
      const d = Rv * (0.4 + rand() * 0.4);
      this._sprite(this.glows, pos.x + _v1.x * d, pos.y + _v1.y * d, pos.z + _v1.z * d, 0, 0.6, 0, this._colB, 0.5, 0.25, 0.3, 1, 1, 0, G_STAR + 2, 0.02, 2);
    }
  }

  splatted(pos, color) {
    const col = this._color(color, this._col);
    const q = this.q;
    const paint = this.paintEffects ? F_PAINT : 0;
    this._colB.copy(col).multiplyScalar(4);
    this._sprite(this.glows, pos.x, pos.y, pos.z, 0, 0, 0, this._colB, 1.1, 2.0, 0.18, 1, 2.2, 0, G_SOFT + 5.5, 0);
    this._colB.copy(col).lerp(_white, 0.3).multiplyScalar(2);
    this._sprite(this.glows, pos.x, pos.y, pos.z, 0, 0, 0, this._colB, 0.8, 2.6, 0.22, 0.9, 0, 0, G_HALO + 2, 0, 0);
    this._shell(pos, col, 0.4, 1.35, 0.1, 0.24, 0.6, 0, 0, 0.11);
    this._colB.copy(col).lerp(_white, 0.25);
    for (let i = 0; i < Math.round(7 * q); i++) {
      randSphere(_v1);
      this._sprite(this.puffs, pos.x + _v1.x * 0.35, pos.y + _v1.y * 0.3, pos.z + _v1.z * 0.35, _v1.x * 1.6, 0.9 + rand() * 0.6, _v1.z * 1.6, this._colB, 0.45, 1.1 + rand() * 0.4, 0.9 + rand() * 0.5, 0.5, 2, 0.5);
    }
    // droplets
    const n = Math.round(66 * q);
    for (let i = 0; i < n; i++) {
      randSphere(_v1); _v1.y = _v1.y * 0.8 + 0.35; _v1.normalize();
      const sp = 3.5 + rand() * 7;
      const sz = rand() < 0.2 ? 0.11 + rand() * 0.05 : 0.045 + rand() * 0.07;
      this._spawnDrop(pos.x + _v1.x * 0.3, pos.y + _v1.y * 0.3, pos.z + _v1.z * 0.3, _v1.x * sp, _v1.y * sp, _v1.z * sp, col, sz, 1.8, 1, 1, sz > 0.1 ? paint : 0);
    }
    if (this._probeDown(pos, 3, _v2, _v3)) {
      this._ringRaw(_v2, _v3, col, 2.1, 0.45, R_WAVE, 0.95, 1.2);
      this._ringRaw(_v2, _v3, col, 1.0, 0.35, R_DISC, 0.85, 1);
      this._ringRaw(_v2, _v3, col, 0.9, 0.6, R_BLOT, 0.9, 1);
      this._after(0.08, OP_RING, _v2, _v3, col, 2.9, 0.55, R_RIPPLE);
    }
  }

  // Swimming wake: called ~every 0.05 s by the actor while submerged (dir = unit horizontal heading).
  wake(pos, dir, color, speed = 8, normal = UP) {
    if (!this._near(pos, 45)) return;
    const col = this._color(color, this._col);
    const k = Math.min(1, speed / 11.8);
    this._colB.copy(col).lerp(_white, 0.18);
    // Kelvin-style V: two ripples shed behind the head, drifting outward so the trail opens into a V
    const rx = dir.z, rz = -dir.x;   // right vector (dir × up)
    this._wakeFlip = !this._wakeFlip;
    if (this._wakeFlip || this.q >= 1) for (let s = -1; s <= 1; s += 2) {
      _v2.set(pos.x - dir.x * 0.32 + rx * s * 0.16, pos.y + 0.02, pos.z - dir.z * 0.32 + rz * s * 0.16);
      const out = 0.55 + 0.6 * k;
      this._ringRaw(_v2, normal, this._colB, 0.2 + 0.1 * k, 0.5 + rand() * 0.15, R_RIPPLE, 0.5, 1, rx * s * out - dir.x * 0.25, 0, rz * s * out - dir.z * 0.25);
    }
    if (rand() < 0.35) {
      _v2.copy(pos).addScaledVector(normal, 0.02);
      this._ringRaw(_v2, normal, this._colB, 0.45 + 0.35 * k + rand() * 0.2, 0.5 + rand() * 0.2, R_RIPPLE, 0.45, 1);
    }
    // spray kicked up behind
    let n = Math.floor((0.5 + 1.6 * k) * this.q + rand());
    while (n-- > 0) {
      const back = speed * (0.1 + rand() * 0.14);
      const up = 1.5 + rand() * 1.6;
      const side = (rand() - 0.5) * 1.8;
      _v1.set(-dir.x * back + normal.x * up + rx * side, -dir.y * back + normal.y * up, -dir.z * back + normal.z * up + rz * side);
      this._spawnDrop(pos.x - dir.x * 0.2, pos.y + 0.05, pos.z - dir.z * 0.2, _v1.x, _v1.y, _v1.z, col, 0.028 + rand() * 0.032, 0.7, 1, 1, 0);
    }
    // bubbles popping on the surface
    if (rand() < 0.3 * this.q + 0.1) {
      this._colB.copy(col).lerp(_white, 0.5).multiplyScalar(1.1);
      this._sprite(this.glows, pos.x - dir.x * (0.3 + rand() * 0.5) + (rand() - 0.5) * 0.3, pos.y + 0.06, pos.z - dir.z * (0.3 + rand() * 0.5) + (rand() - 0.5) * 0.3, 0, 0.25, 0, this._colB, 0.05 + rand() * 0.04, 0.09, 0.3 + rand() * 0.15, 0.7, 1, 0, G_BUBBLE + 1, 0.03, 0);
    }
  }

  muzzle(pos, dir, color, kind = 'shooter') {
    const col = this._color(color, this._col);
    _v3.copy(dir).normalize();
    if (kind === 'blaster') {
      this._colB.copy(col).multiplyScalar(4.5);
      this._sprite(this.glows, pos.x + _v3.x * 0.1, pos.y + _v3.y * 0.1, pos.z + _v3.z * 0.1, _v3.x * 2, _v3.y * 2, _v3.z * 2, this._colB, 0.35, 0.7, 0.09, 1, 2.2, 0, G_SOFT + 4.0, 0);
      this._colB.copy(col).lerp(_white, 0.3);
      this._ringRaw(_v2.copy(pos).addScaledVector(_v3, 0.25), _v3, this._colB, 0.55, 0.16, R_THIN, 0.9, 1.2, _v3.x * 3, _v3.y * 3, _v3.z * 3);
      const n = Math.max(3, Math.round(9 * this.q));
      for (let i = 0; i < n; i++) {
        coneDir(_v3, 0.4, _v1);
        const sp = 6 + rand() * 6;
        this._spawnDrop(pos.x, pos.y, pos.z, _v1.x * sp, _v1.y * sp, _v1.z * sp, col, 0.03 + rand() * 0.035, 0.4 + rand() * 0.2, 0.8, 1.3, 0);
      }
      this._colB.copy(col).lerp(_white, 0.45);
      for (let i = 0; i < 2; i++) this._sprite(this.puffs, pos.x + _v3.x * 0.3, pos.y + _v3.y * 0.3, pos.z + _v3.z * 0.3, _v3.x * (2 + i * 1.5), _v3.y * 2 + 0.4, _v3.z * (2 + i * 1.5), this._colB, 0.2, 0.7, 0.4, 0.32, 5);
      return;
    }
    if (kind === 'charger') {
      this._colB.copy(col).lerp(_white, 0.4).multiplyScalar(3.5);
      this._sprite(this.glows, pos.x, pos.y, pos.z, 0, 0, 0, this._colB, 0.7, 0.4, 0.14, 1, 0, 0, G_STAR + 3, 0, 0);
      this._colB.copy(col).lerp(_white, 0.3);
      this._ringRaw(_v2.copy(pos).addScaledVector(_v3, 0.15), _v3, this._colB, 0.38, 0.14, R_THIN, 0.9, 1, _v3.x * 2, _v3.y * 2, _v3.z * 2);
      const n = Math.max(2, Math.round(5 * this.q));
      for (let i = 0; i < n; i++) {
        coneDir(_v3, 0.14, _v1);
        const sp = 10 + rand() * 8;
        this._spawnDrop(pos.x, pos.y, pos.z, _v1.x * sp, _v1.y * sp, _v1.z * sp, col, 0.018 + rand() * 0.02, 0.25, 0.4, 1.8, F_QUIET);
      }
      return;
    }
    // shooter (default)
    this._colB.copy(col).multiplyScalar(4);
    this._sprite(this.glows, pos.x + _v3.x * 0.05, pos.y + _v3.y * 0.05, pos.z + _v3.z * 0.05, _v3.x * 2, _v3.y * 2, _v3.z * 2, this._colB, 0.2, 0.38, 0.07, 1, 2.2, 0, G_SOFT + 4.0, 0);
    this._colB.copy(col).multiplyScalar(1.2);
    this._sprite(this.glows, pos.x, pos.y, pos.z, 0, 0, 0, this._colB, 0.4, 0.6, 0.1, 0.8, 2.2, 0, G_SOFT, 0);
    const n = Math.max(2, Math.round(5 * this.q));
    for (let i = 0; i < n; i++) {
      coneDir(_v3, 0.28, _v1);
      const sp = 6 + rand() * 7;
      this._spawnDrop(pos.x, pos.y, pos.z, _v1.x * sp, _v1.y * sp, _v1.z * sp, col, 0.022 + rand() * 0.028, 0.28 + rand() * 0.12, 0.6, 1.4, 0);
    }
    this._colB.copy(col).lerp(_white, 0.4);
    this._sprite(this.puffs, pos.x + _v3.x * 0.15, pos.y + _v3.y * 0.15, pos.z + _v3.z * 0.15, _v3.x * 2.5, _v3.y * 2.5 + 0.3, _v3.z * 2.5, this._colB, 0.12, 0.38, 0.28, 0.3, 6);
  }

  spawnFlash(pos, color) {
    const col = this._color(color, this._col);
    const q = this.q;
    this._colB.copy(col).multiplyScalar(1.25);
    this._beam(pos, this._colB, 1.15, 10, 1.0);
    this._colB.copy(col).multiplyScalar(4);
    this._sprite(this.glows, pos.x, pos.y + 0.8, pos.z, 0, 0, 0, this._colB, 2.2, 3.8, 0.3, 1, 2.2, 0, G_SOFT + 5, 0);
    this._ringRaw(pos, UP, col, 2.8, 0.6, R_WAVE, 0.95, 1.3);
    this._ringRaw(pos, UP, col, 1.6, 0.4, R_DISC, 0.8, 1);
    this._after(0.12, OP_RING, pos, UP, col, 3.6, 0.6, R_THIN);
    this._after(0.24, OP_RING, pos, UP, col, 4.2, 0.7, R_RIPPLE);
    const n = Math.round(40 * q);
    for (let k = 0; k < n; k++) {
      const a = rand() * TAU, r = rand() * 0.7;
      const sp = 7 + rand() * 9;
      const hx = Math.cos(a) * (0.6 + rand() * 1.8), hz = Math.sin(a) * (0.6 + rand() * 1.8);
      this._spawnDrop(pos.x + Math.cos(a) * r, pos.y + 0.1, pos.z + Math.sin(a) * r, hx, sp, hz, col, 0.05 + rand() * 0.07, 1.6, 1, 1.2, 0);
    }
    this._colB.copy(col).lerp(_white, 0.3);
    for (let k = 0; k < Math.round(8 * q); k++) {
      const a = rand() * TAU;
      this._sprite(this.puffs, pos.x + Math.cos(a) * 0.8, pos.y + 0.3, pos.z + Math.sin(a) * 0.8, Math.cos(a) * 2.5, 0.8, Math.sin(a) * 2.5, this._colB, 0.5, 1.3, 0.7 + rand() * 0.4, 0.45, 3, 0.4);
    }
    this._colB.copy(col).lerp(_white, 0.55).multiplyScalar(2.4);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU + rand() * 0.5, r = 0.9 + rand() * 0.8;
      this._sprite(this.glows, pos.x + Math.cos(a) * r, pos.y + 0.5 + rand() * 2.5, pos.z + Math.sin(a) * r, 0, 1.2 + rand(), 0, this._colB, 0.35, 0.18, 0.5 + rand() * 0.3, 1, 1, 0, G_STAR + 2, 0.05, 1.5);
    }
  }

  rain(pos, radius = 3.4, color, dt = this._dt, opts = EMPTY) {
    const col = this._color(color, this._col);
    const area = radius * radius;
    let n = Math.floor(area * 8.5 * this.q * dt + rand());
    while (n-- > 0) {
      const a = rand() * TAU, r = Math.sqrt(rand()) * radius * 0.92;
      const sp = 15 + rand() * 5;
      this._spawnDrop(pos.x + Math.cos(a) * r, pos.y - 0.25 - rand() * 0.4, pos.z + Math.sin(a) * r, 0.4, -sp, 0.15, col, 0.03 + rand() * 0.018, 1.4, 1, 3.2, (opts.paint ? F_PAINT : 0) | F_RING);
    }
    if (opts.cloud !== false) {
      let c = Math.floor(dt * (14 + radius * 3.5) + rand());
      this._colB.copy(col).lerp(_white, 0.1);
      while (c-- > 0) {
        const a = rand() * TAU, r = Math.sqrt(rand()) * radius * 0.9;
        const up = (1 - r / radius) * 0.6;
        this._sprite(this.puffs, pos.x + Math.cos(a) * r, pos.y + up + (rand() - 0.4) * 0.5, pos.z + Math.sin(a) * r, (rand() - 0.5) * 0.3, 0.04, (rand() - 0.5) * 0.3, this._colB, radius * 0.3, radius * (0.4 + rand() * 0.14), 1.6 + rand() * 0.6, 1.0, 1, 0, P_CLOUD, 0.3, 0.25);
      }
    }
  }

  // =================================================================== VFX-stream recipes
  // Foot plant. surface: 0 dry, 1 own ink, 2 enemy ink (color = the ink under the foot). dir: unit horizontal heading.
  footstep(pos, color, surface = 0, dir = null, speed = 5) {
    const col = this._color(color, this._col);
    const dx = dir ? dir.x : 0, dz = dir ? dir.z : 0;
    if (surface === 0) {
      if (speed < 3.2) return;
      this._sprite(this.puffs, pos.x - dx * 0.1, pos.y + 0.08, pos.z - dz * 0.1, -dx * 0.6 + (rand() - 0.5) * 0.3, 0.3 + rand() * 0.2, -dz * 0.6 + (rand() - 0.5) * 0.3,
        DUST, 0.1 + rand() * 0.05, 0.34 + rand() * 0.14, 0.5 + rand() * 0.2, 0.42, 3.2, 0.15, P_DUST, 0.04, 1.2);
      _v3.set(-dx * 0.7, 0.75, -dz * 0.7).normalize();
      this._grains(pos, _v3, 2, 1.5);
      return;
    }
    const k = clamp(speed / 7, 0.3, 1.2);
    _v3.set(-dx * 0.55, 1, -dz * 0.55).normalize();
    if (surface === 1) {
      const n = Math.max(1, Math.round((2 + 2.5 * k) * this.q));
      for (let i = 0; i < n; i++) {
        coneDir(_v3, 0.75, _v1);
        const sp = 1.4 + rand() * 1.5 * k;
        this._spawnDrop(pos.x, pos.y + 0.03, pos.z, _v1.x * sp, _v1.y * sp, _v1.z * sp, col, 0.026 + rand() * 0.026, 0.6, 1, 1, 0);
      }
      _v2.set(pos.x, pos.y + 0.01, pos.z);
      this._ringRaw(_v2, UP, col, 0.15 + 0.05 * k, 0.2, R_BLOT, 0.9, 1);
      this._colB.copy(col).lerp(_white, 0.2);
      this._ringRaw(_v2, UP, this._colB, 0.32 + 0.1 * k, 0.4, R_RIPPLE, 0.45, 1);
    } else {
      // enemy ink: gloopy, sticky, sizzling
      const n = Math.max(1, Math.round(3 * this.q));
      for (let i = 0; i < n; i++) {
        coneDir(_v3, 0.6, _v1);
        const sp = 0.9 + rand() * 0.9;
        this._spawnDrop(pos.x, pos.y + 0.03, pos.z, _v1.x * sp, _v1.y * sp, _v1.z * sp, col, 0.03 + rand() * 0.025, 0.6, 1.3, 0.8, 0);
      }
      _v2.set(pos.x, pos.y + 0.01, pos.z);
      this._ringRaw(_v2, UP, col, 0.2, 0.32, R_BLOT, 0.95, 1);
      this.enemyInkSizzle(pos, col);
    }
  }

  land(pos, color, surface = 0, speed = 8) {
    const col = this._color(color, this._col);
    const k = clamp((speed - 3) / 12, 0, 1);
    _v2.set(pos.x, pos.y + 0.01, pos.z);
    if (surface === 0) {
      _sc.copy(DUST);
      this._ringRaw(_v2, UP, _sc, 0.8 + 1.1 * k, 0.5, R_DUST, 0.62, 1);
      this._dustRing(pos, _sc, 4 + 6 * k, 1.4 + 1.6 * k);
      _v3.set(0, 1, 0);
      this._grains(pos, _v3, 4 + 6 * k, 1.6 + k * 1.5);
      if (k > 0.5) this._ringRaw(_v2, UP, _sc, 1.3 + k, 0.3, R_THIN, 0.55, 1);
      return;
    }
    this._crown(pos, UP, col, 8 + 16 * k, 2.4 + 2.2 * k, 0.05 + 0.02 * k);
    this._ringRaw(_v2, UP, col, 0.7 + 1.1 * k, 0.35, R_WAVE, 0.9, 1);
    this._ringRaw(_v2, UP, col, 0.35 + 0.3 * k, 0.25, R_DISC, 0.9, 1);
    this._colB.copy(col).lerp(_white, 0.2);
    this._ringRaw(_v2, UP, this._colB, 1.1 + 1.2 * k, 0.55, R_RIPPLE, 0.5, 1);
    this._colB.copy(col).lerp(_white, 0.35);
    for (let i = 0; i < 2; i++) this._sprite(this.puffs, pos.x + (rand() - 0.5) * 0.4, pos.y + 0.15, pos.z + (rand() - 0.5) * 0.4, (rand() - 0.5) * 1.2, 0.6, (rand() - 0.5) * 1.2, this._colB, 0.15, 0.45 + k * 0.3, 0.35, 0.3, 4);
  }

  jumpOff(pos, color, surface = 0, swim = false) {
    const col = this._color(color, this._col);
    _v2.set(pos.x, pos.y + 0.01, pos.z);
    if (swim || surface === 1) {
      const n = Math.max(2, Math.round(8 * this.q));
      for (let i = 0; i < n; i++) {
        coneDir(UP, 0.5, _v1);
        const sp = 3 + rand() * 2.5;
        this._spawnDrop(pos.x + (rand() - 0.5) * 0.3, pos.y + 0.05, pos.z + (rand() - 0.5) * 0.3, _v1.x * sp, _v1.y * sp, _v1.z * sp, col, 0.03 + rand() * 0.03, 0.9, 1, 1, 0);
      }
      this._colB.copy(col).lerp(_white, 0.2);
      this._ringRaw(_v2, UP, this._colB, 0.8, 0.45, R_RIPPLE, 0.5, 1);
      this._ringRaw(_v2, UP, col, 0.3, 0.2, R_DISC, 0.9, 1);
      this._colB.copy(col).lerp(_white, 0.35);
      this._sprite(this.puffs, pos.x, pos.y + 0.2, pos.z, 0, 1.2, 0, this._colB, 0.15, 0.45, 0.3, 0.3, 4);
    } else if (surface === 2) {
      this.footstep(pos, col, 2, null, 5);
    } else {
      this._sprite(this.puffs, pos.x, pos.y + 0.08, pos.z, 0.3, 0.2, 0, DUST, 0.1, 0.36, 0.45, 0.24, 3.5, 0.2, P_DUST, 0.03, 1);
      this._sprite(this.puffs, pos.x, pos.y + 0.08, pos.z, -0.3, 0.2, 0, DUST, 0.1, 0.34, 0.45, 0.22, 3.5, 0.2, P_DUST, 0.03, 1);
      this._grains(pos, UP, 3, 1.4);
      this._ringRaw(_v2, UP, DUST, 0.45, 0.35, R_DUST, 0.35, 1);
    }
  }

  // kid ⇄ squid transform pop
  formPop(pos, color, toSquid = true, inInk = false) {
    const col = this._color(color, this._col);
    const y = pos.y + (toSquid ? 0.35 : 0.55);
    this._colB.copy(col).lerp(_white, 0.35);
    this._sprite(this.puffs, pos.x, y, pos.z, 0, toSquid ? -0.2 : 0.6, 0, this._colB, 0.22, 0.62, 0.26, inInk ? 0.25 : 0.38, 5);
    _v2.set(pos.x, y, pos.z);
    this._toCam(_v2, _v4);
    this._colB.copy(col).lerp(_white, 0.4);
    this._ringRaw(_v2, _v4, this._colB, 0.5, 0.16, R_THIN, 0.7, 1);
    const n = Math.max(2, Math.round(5 * this.q));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rand() * 0.6, sp = 1.4 + rand() * 1.2;
      this._spawnDrop(pos.x, y, pos.z, Math.cos(a) * sp, 1.2 + rand() * 1.6, Math.sin(a) * sp, col, 0.022 + rand() * 0.02, 0.6, 1, 1, 0);
    }
  }

  // squid slips into its own ink (from the air or from kid form)
  dive(pos, color, speed = 4) {
    const col = this._color(color, this._col);
    _v2.set(pos.x, pos.y + 0.01, pos.z);
    this._crown(_v2, UP, col, 10 + speed * 0.6, 2.2 + Math.min(2.5, speed * 0.18), 0.045);
    this._ringRaw(_v2, UP, col, 0.4, 0.2, R_DISC, 0.9, 1);
    this._colB.copy(col).lerp(_white, 0.2);
    this._ringRaw(_v2, UP, this._colB, 0.9, 0.5, R_RIPPLE, 0.55, 1);
    this._after(0.09, OP_RING, _v2, UP, this._colB, 1.5, 0.75, R_RIPPLE);
    this.bubbles(pos, col, 3);
  }
  emerge(pos, color, speed = 4) {
    const col = this._color(color, this._col);
    _v2.set(pos.x, pos.y + 0.01, pos.z);
    const n = Math.max(2, Math.round(8 * this.q));
    for (let i = 0; i < n; i++) {
      coneDir(UP, 0.55, _v1);
      const sp = 2.5 + rand() * 2;
      this._spawnDrop(pos.x + (rand() - 0.5) * 0.25, pos.y + 0.08, pos.z + (rand() - 0.5) * 0.25, _v1.x * sp, _v1.y * sp, _v1.z * sp, col, 0.028 + rand() * 0.03, 0.9, 1, 1, 0);
    }
    this._colB.copy(col).lerp(_white, 0.2);
    this._ringRaw(_v2, UP, this._colB, 0.8, 0.45, R_RIPPLE, 0.5, 1);
    this._ringRaw(_v2, UP, col, 0.3, 0.2, R_DISC, 0.9, 1);
  }
  bubbles(pos, color, n = 3) {
    const col = this._color(color, this._col);
    this._colB.copy(col).lerp(_white, 0.55).multiplyScalar(1.1);
    const c = Math.max(1, Math.round(n * this.q));
    for (let i = 0; i < c; i++) {
      this._sprite(this.glows, pos.x + (rand() - 0.5) * 0.5, pos.y + 0.05 + rand() * 0.05, pos.z + (rand() - 0.5) * 0.5, 0, 0.3 + rand() * 0.3, 0, this._colB,
        0.04 + rand() * 0.04, 0.08 + rand() * 0.04, 0.3 + rand() * 0.25, 0.8, 1, 0, G_BUBBLE + 1, 0.04 + rand() * 0.1, 0);
    }
  }

  // squid wall-climb: a drip sliding down the wall + a ripple on the wall
  climbDrip(pos, normal, color) {
    const col = this._color(color, this._col);
    this._spawnDrop(pos.x + normal.x * 0.06 + (rand() - 0.5) * 0.2, pos.y + (rand() - 0.5) * 0.2, pos.z + normal.z * 0.06 + (rand() - 0.5) * 0.2,
      normal.x * 0.25 + (rand() - 0.5) * 0.2, -0.4 - rand() * 0.6, normal.z * 0.25 + (rand() - 0.5) * 0.2, col, 0.028 + rand() * 0.024, 1.4, 0.5, 1.3, 0);
    _v2.copy(pos).addScaledVector(normal, 0.03);
    this._colB.copy(col).lerp(_white, 0.2);
    this._ringRaw(_v2, normal, this._colB, 0.35 + rand() * 0.1, 0.45, R_RIPPLE, 0.45, 1);
    if (rand() < 0.4) this._ringRaw(_v2, normal, col, 0.14, 0.2, R_BLOT, 0.8, 1);
  }
  // squid pops over the top of a wall: spray flung up and forward
  climbPop(pos, dir, color) {
    const col = this._color(color, this._col);
    _v3.set(dir.x * 0.5, 1, dir.z * 0.5).normalize();
    const n = Math.max(3, Math.round(10 * this.q));
    for (let i = 0; i < n; i++) {
      coneDir(_v3, 0.55, _v1);
      const sp = 2.5 + rand() * 2.5;
      this._spawnDrop(pos.x, pos.y + 0.1, pos.z, _v1.x * sp, _v1.y * sp, _v1.z * sp, col, 0.03 + rand() * 0.03, 1.0, 1, 1, 0);
    }
    this._colB.copy(col).lerp(_white, 0.35);
    this._sprite(this.puffs, pos.x, pos.y + 0.3, pos.z, dir.x, 1.2, dir.z, this._colB, 0.15, 0.5, 0.35, 0.3, 4);
  }
  // enemy-ink drip falling off a damaged character
  hurtDrip(pos, color, size = 0.035) {
    const col = this._color(color, this._col);
    this._spawnDrop(pos.x, pos.y, pos.z, (rand() - 0.5) * 0.5, -0.2 - rand() * 0.4, (rand() - 0.5) * 0.5, col, size * (0.7 + rand() * 0.6), 1.6, 1, 1.3, 0);
  }
  // ink hitting a body: splash crown facing the shooter, rebound + pass-through spray, a quick flash. dir = shot direction.
  hitSplash(pos, dir, color, amount = 30, killed = false) {
    const col = this._color(color, this._col);
    const k = clamp(amount / 60, 0.3, 1.5);
    _v3.copy(dir); _v3.y *= 0.5; if (_v3.lengthSq() < 1e-6) _v3.set(0, 0, 1); _v3.normalize();
    _v4.copy(_v3).negate();
    _v2.copy(pos).addScaledVector(_v4, 0.3);
    this._ringRaw(_v2, _v4, col, 0.4 + 0.25 * k, 0.2, R_BLOT, 0.95, 1);
    this._colB.copy(col).lerp(_white, 0.3);
    this._ringRaw(_v2, _v4, this._colB, 0.6 + 0.3 * k, 0.18, R_THIN, 0.85, 1);
    const n = Math.max(2, Math.round((5 + 7 * k) * this.q));
    for (let i = 0; i < n; i++) {
      const back = i & 1;
      coneDir(back ? _v4 : _v3, back ? 1.1 : 0.6, _v1);
      _v1.y += 0.35;
      const sp = back ? 2 + rand() * 2 : 3 + rand() * 3;
      this._spawnDrop(_v2.x, _v2.y, _v2.z, _v1.x * sp, _v1.y * sp, _v1.z * sp, col, 0.03 + rand() * 0.035 * k, 1.1, 1, 1, 0);
    }
    this._colB.copy(col).multiplyScalar(3);
    this._sprite(this.glows, _v2.x, _v2.y, _v2.z, 0, 0, 0, this._colB, 0.3, 0.55 + 0.2 * k, 0.08, 1, 0, 0, G_SOFT + 2, 0);
    this._colB.copy(col).lerp(_white, 0.35);
    this._sprite(this.puffs, _v2.x, _v2.y, _v2.z, _v3.x * 1.5, 0.3, _v3.z * 1.5, this._colB, 0.2, 0.55 + 0.2 * k, 0.3, killed ? 0.2 : 0.35, 4);
  }
  // one mist puff (shot trails, spray)
  mist(pos, vel, color, size = 0.2, alpha = 0.25) {
    const col = this._color(color, this._col);
    this._colB.copy(col).lerp(_white, 0.4);
    this._sprite(this.puffs, pos.x, pos.y, pos.z, vel ? vel.x : 0, vel ? vel.y : 0, vel ? vel.z : 0, this._colB, size * 0.45, size * 1.4, 0.3 + rand() * 0.12, alpha, 4.5, 0.2);
  }
  // shot in flight: faint mist + an occasional shed micro-droplet
  shotTrail(pos, vel, color, big = false) {
    const col = this._color(color, this._col);
    this._colB.copy(col).lerp(_white, 0.42);
    const s = big ? 0.3 : 0.14;
    this._sprite(this.puffs, pos.x, pos.y, pos.z, vel.x * 0.06, vel.y * 0.06 + 0.1, vel.z * 0.06, this._colB, s * 0.5, s * 1.5, big ? 0.4 : 0.26, big ? 0.3 : 0.2, 5, 0.1);
    if (rand() < (big ? 0.8 : 0.35)) this._spawnDrop(pos.x, pos.y, pos.z, vel.x * 0.25 + (rand() - 0.5), vel.y * 0.25, vel.z * 0.25 + (rand() - 0.5), col, big ? 0.03 + rand() * 0.02 : 0.016 + rand() * 0.012, 0.8, 1, 1.4, F_QUIET);
  }
  // empty tank: a dry wisp from the muzzle
  dryFire(pos, dir) {
    this._sprite(this.puffs, pos.x, pos.y, pos.z, dir.x * 0.8, dir.y * 0.8 + 0.3, dir.z * 0.8, DUST, 0.05, 0.22, 0.35, 0.35, 5, 0.3, P_DUST, 0.02, 1);
  }

  // ---- charger
  chargeGlow(pos, color, k) {
    const col = this._color(color, this._col);
    const flick = 0.85 + 0.15 * Math.sin(this._time * 40);
    this._colB.copy(col).lerp(_white, 0.2 + 0.4 * k).multiplyScalar(1.5 + 2.5 * k);
    this._sprite(this.glows, pos.x, pos.y, pos.z, 0, 0, 0, this._colB, (0.07 + 0.2 * k) * flick, (0.07 + 0.2 * k) * flick, Math.max(0.03, this._dt * 1.6), 1, 0, 0, G_SOFT + 1 + 3 * k, 0, 0);
    // energy gathering: sparks converge on the muzzle
    let n = Math.floor((10 + 36 * k) * this._dt * Math.max(0.5, this.q) + rand());
    this._colB.copy(col).lerp(_white, 0.5).multiplyScalar(2.2);
    while (n-- > 0) {
      randSphere(_v1);
      const r = 0.3 + rand() * 0.25;
      this._sprite(this.glows, pos.x + _v1.x * r, pos.y + _v1.y * r, pos.z + _v1.z * r, -_v1.x * r / 0.17, -_v1.y * r / 0.17, -_v1.z * r / 0.17, this._colB, 0.05, 0.02, 0.17, 1, 0, 0, G_SOFT + 1, 0.03, 0);
    }
  }
  chargeFull(pos, color) {
    const col = this._color(color, this._col);
    this._colB.copy(col).lerp(_white, 0.5).multiplyScalar(3.2);
    this._sprite(this.glows, pos.x, pos.y, pos.z, 0, 0, 0, this._colB, 1.0, 0.5, 0.32, 1, 0, 0, G_STAR + 3, 0, 0.6);
    this._toCam(pos, _v4);
    this._colB.copy(col).lerp(_white, 0.35);
    this._ringRaw(pos, _v4, this._colB, 0.6, 0.2, R_THIN, 0.9, 1);
    this._colB.copy(col).lerp(_white, 0.5).multiplyScalar(2);
    for (let i = 0; i < 8; i++) {
      randSphere(_v1);
      this._sprite(this.glows, pos.x, pos.y, pos.z, _v1.x * 2.2, _v1.y * 2.2, _v1.z * 2.2, this._colB, 0.12, 0.05, 0.3, 1, 3, 0, G_STAR + 1, 0, 2);
    }
  }
  // charger laser sight hitting a surface (immediate)
  laserDot(pos, normal, color, k = 0.5) {
    const col = this._color(color, this._col);
    const pulse = 0.8 + 0.2 * Math.sin(this._time * 22);
    this._colB.copy(col).lerp(_white, 0.35).multiplyScalar(2 + 2 * k);
    _v2.copy(pos).addScaledVector(normal, 0.03);
    this._sprite(this.glows, _v2.x, _v2.y, _v2.z, 0, 0, 0, this._colB, (0.08 + 0.1 * k) * pulse, (0.08 + 0.1 * k) * pulse, Math.max(0.03, this._dt * 1.6), 1, 0, 0, G_STAR + 1 + 2 * k, 0, 0);
    this.mark(_v2, normal, col, 0.12 + 0.12 * k, R_BLOT, 0.5, 0, 1, 0.3);
  }
  beamImpact(pos, normal, color, charge = 1) {
    const col = this._color(color, this._col);
    const c = clamp(charge, 0, 1);
    this._colB.copy(col).multiplyScalar(4);
    this._sprite(this.glows, pos.x, pos.y, pos.z, 0, 0, 0, this._colB, 0.4 + 0.5 * c, 0.9 + 0.6 * c, 0.12, 1, 0, 0, G_SOFT + 4, 0);
    this._colB.copy(col).lerp(_white, 0.5).multiplyScalar(2.6);
    this._sprite(this.glows, pos.x, pos.y, pos.z, 0, 0, 0, this._colB, 0.9, 0.4, 0.22, 1, 0, 0, G_STAR + 3, 0, 1);
    _v2.copy(pos).addScaledVector(normal, 0.02);
    this._ringRaw(_v2, normal, col, 0.55 + 0.6 * c, 0.3, R_WAVE, 0.95, 1);
    this._ringRaw(_v2, normal, col, 0.9 + c, 0.2, R_THIN, 0.8, 1);
    const n = Math.max(3, Math.round((8 + 10 * c) * this.q));
    for (let i = 0; i < n; i++) {
      coneDir(normal, 0.95, _v1);
      const sp = 3 + rand() * 3.5;
      this._spawnDrop(_v2.x, _v2.y, _v2.z, _v1.x * sp, _v1.y * sp, _v1.z * sp, col, 0.03 + rand() * 0.04, 1.1, 1, 1, 0);
    }
  }
  // mist + drizzle along a fired charger beam
  beamTrail(from, to, color, charge = 1) {
    const col = this._color(color, this._col);
    _v3.copy(to).sub(from);
    const len = _v3.length();
    if (len < 0.5) return;
    _v3.multiplyScalar(1 / len);
    const step = 0.75, n = Math.min(40, Math.floor(len / step));
    this._colB.copy(col).lerp(_white, 0.45);
    for (let i = 1; i <= n; i++) {
      const d = i * step - rand() * 0.3;
      const px = from.x + _v3.x * d, py = from.y + _v3.y * d, pz = from.z + _v3.z * d;
      if (i % 2 === 0 || this.q >= 1) this._sprite(this.puffs, px, py, pz, (rand() - 0.5) * 0.3, 0.15, (rand() - 0.5) * 0.3, this._colB, 0.06, 0.2 + 0.1 * charge, 0.3 + rand() * 0.2, 0.28, 4, 0.1);
      if (rand() < 0.45 * this.q) this._spawnDrop(px, py, pz, (rand() - 0.5) * 0.6, -0.5 - rand(), (rand() - 0.5) * 0.6, col, 0.016 + rand() * 0.018, 0.9, 1, 1.4, F_QUIET);
    }
  }

  // ---- roller: wet spray flung off the drum front while rolling (call per frame; k = speed / roll speed)
  rollerSpray(pos, fwd, width, color, k = 1) {
    const col = this._color(color, this._col);
    const rx = fwd.z, rz = -fwd.x;
    let n = Math.floor((30 * k) * this.q * this._dt + rand());
    while (n-- > 0) {
      const o = (rand() - 0.5) * width;
      const sp = 1.6 + rand() * 2.2;
      this._spawnDrop(pos.x + rx * o + fwd.x * 0.05, pos.y + 0.1, pos.z + rz * o + fwd.z * 0.05,
        fwd.x * sp * k + rx * Math.sign(o) * 0.7, 1.4 + rand() * 1.8, fwd.z * sp * k + rz * Math.sign(o) * 0.7, col, 0.025 + rand() * 0.03, 1.0, 1, 1, rand() < 0.3 ? F_PAINT : 0);
    }
    if (rand() < 8 * this._dt * k) {
      const s = rand() < 0.5 ? -1 : 1;
      this._colB.copy(col).lerp(_white, 0.4);
      this._sprite(this.puffs, pos.x + rx * s * width * 0.5, pos.y + 0.15, pos.z + rz * s * width * 0.5, rx * s * 0.8 + fwd.x, 0.5, rz * s * 0.8 + fwd.z, this._colB, 0.1, 0.35, 0.3, 0.28, 4);
    }
  }
  // roller flick: a wide curtain of spray (droplets that paint where they land)
  flickCurtain(pos, dir, color, spreadDeg = 50) {
    const col = this._color(color, this._col);
    const paint = this.paintEffects ? F_PAINT : 0;
    const yaw = Math.atan2(dir.x, dir.z), spread = spreadDeg * Math.PI / 180;
    const n = Math.max(6, Math.round(30 * this.q));
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * 2 - 1;
      const a = yaw + t * spread * 0.55 + (rand() - 0.5) * 0.08;
      const up = 0.35 + rand() * 0.35, sp = 6 + rand() * 5 * (1 - 0.4 * Math.abs(t));
      const cu = Math.cos(up);
      const sz = 0.03 + rand() * 0.04;
      this._spawnDrop(pos.x + Math.sin(a) * 0.4, pos.y + (rand() - 0.3) * 0.4, pos.z + Math.cos(a) * 0.4, Math.sin(a) * cu * sp, Math.sin(up) * sp, Math.cos(a) * cu * sp, col, sz, 1.4, 1, 1.2, sz > 0.055 ? paint : 0);
    }
    this._colB.copy(col).lerp(_white, 0.4);
    for (let i = 0; i < 3; i++) {
      const a = yaw + (i - 1) * spread * 0.35;
      this._sprite(this.puffs, pos.x + Math.sin(a) * 0.8, pos.y + 0.2, pos.z + Math.cos(a) * 0.8, Math.sin(a) * 3, 1.0, Math.cos(a) * 3, this._colB, 0.2, 0.7, 0.4, 0.3, 4);
    }
  }

  // ---- bombs
  dangerRing(pos, normal, color, radius = 3.1, k = 0) { this.mark(pos, normal, color, radius, R_DANGER, 0.95, k, 1, 0.37); }
  beepPulse(bombPos, groundPos, normal, color, radius = 3.1, k = 0) {
    const col = this._color(color, this._col);
    this._colB.copy(col).lerp(_white, 0.3).multiplyScalar(3 + 3 * k);
    this._sprite(this.glows, bombPos.x, bombPos.y, bombPos.z, 0, 0, 0, this._colB, 0.35, 0.8 + 0.4 * k, 0.14, 1, 0, 0, G_SOFT + 2 + 3 * k, 0);
    if (groundPos) this._ringRaw(groundPos, normal || UP, col, radius, 0.32, R_THIN, 0.55 + 0.35 * k, 1.2);
  }
  bombTrail(pos, vel, color) {
    const col = this._color(color, this._col);
    if (rand() < 0.5 * this.q + 0.2) this._spawnDrop(pos.x, pos.y, pos.z, vel.x * 0.1 + (rand() - 0.5) * 0.6, vel.y * 0.1, vel.z * 0.1 + (rand() - 0.5) * 0.6, col, 0.02 + rand() * 0.02, 0.8, 1, 1.2, 0);
    if (rand() < 0.35) { this._colB.copy(col).lerp(_white, 0.45); this._sprite(this.puffs, pos.x, pos.y, pos.z, 0, 0.2, 0, this._colB, 0.06, 0.2, 0.25, 0.22, 4); }
  }
  bounceSplash(pos, normal, color) {
    const col = this._color(color, this._col);
    this._crown(pos, normal, col, 6, 2, 0.035);
    _v2.copy(pos).addScaledVector(normal, 0.01);
    this._ringRaw(_v2, normal, col, 0.35, 0.25, R_BLOT, 0.9, 1);
  }

  // ---- Tidal Slam
  slamLaunch(pos, color) {
    const col = this._color(color, this._col);
    _v2.set(pos.x, pos.y + 0.02, pos.z);
    this._ringRaw(_v2, UP, col, 1.5, 0.4, R_WAVE, 0.9, 1.1);
    this._colB.copy(col).lerp(_white, 0.2);
    this._ringRaw(_v2, UP, this._colB, 2.2, 0.6, R_RIPPLE, 0.5, 1);
    const n = Math.max(6, Math.round(18 * this.q));
    for (let i = 0; i < n; i++) {
      coneDir(UP, 0.45, _v1);
      const sp = 5 + rand() * 5;
      this._spawnDrop(pos.x + (rand() - 0.5) * 0.4, pos.y + 0.1, pos.z + (rand() - 0.5) * 0.4, _v1.x * sp, _v1.y * sp, _v1.z * sp, col, 0.035 + rand() * 0.045, 1.4, 1, 1.3, 0);
    }
    this._colB.copy(col).lerp(_white, 0.35);
    for (let i = 0; i < 3; i++) this._sprite(this.puffs, pos.x, pos.y + 0.3, pos.z, (rand() - 0.5) * 2, 1.5 + rand(), (rand() - 0.5) * 2, this._colB, 0.3, 0.9, 0.5, 0.32, 3);
  }
  // hovering at the apex: energy gathering around the body (per frame, k 0..1)
  slamCharge(pos, color, k = 0.5) {
    const col = this._color(color, this._col);
    this._colB.copy(col).lerp(_white, 0.25).multiplyScalar(1.6 + 2 * k);
    this._sprite(this.glows, pos.x, pos.y, pos.z, 0, 0, 0, this._colB, 0.9 + 0.6 * k, 0.9 + 0.6 * k, Math.max(0.03, this._dt * 1.6), 0.8, 0, 0, G_SOFT + 1 + 2 * k, 0, 0);
    let n = Math.floor(40 * this._dt * Math.max(0.5, this.q) + rand());
    this._colB.copy(col).lerp(_white, 0.5).multiplyScalar(2.4);
    while (n-- > 0) {
      randSphere(_v1);
      const r = 1.2 + rand() * 0.6;
      this._sprite(this.glows, pos.x + _v1.x * r, pos.y + _v1.y * r * 0.7, pos.z + _v1.z * r, -_v1.x * r / 0.22, -_v1.y * r * 0.7 / 0.22, -_v1.z * r / 0.22, this._colB, 0.14, 0.05, 0.22, 1, 0, 0, G_STAR + 1, 0.03, 2);
    }
  }
  // plummeting: speed streaks trailing above the body (per frame)
  slamFall(pos, color) {
    const col = this._color(color, this._col);
    this._colB.copy(col).lerp(_white, 0.45);
    let n = Math.max(1, Math.round(3 * this.q));
    while (n-- > 0) {
      const a = rand() * TAU, r = 0.25 + rand() * 0.4;
      this._spawnDrop(pos.x + Math.cos(a) * r, pos.y + 0.6 + rand() * 1.2, pos.z + Math.sin(a) * r, 0, -14 - rand() * 4, 0, this._colB, 0.018 + rand() * 0.015, 0.14, 0, 3.4, F_NOCOL | F_QUIET);
    }
  }
  // extra impact layers on top of explosion(): staggered ground waves, a dust ring, heavy painting gloops, a short geyser
  slamWave(pos, color, radius = 5.2) {
    const col = this._color(color, this._col);
    const R = radius;
    if (!this._probeDown(_v2.set(pos.x, pos.y + 0.5, pos.z), 2.5, _v5, _v6)) { _v5.copy(pos); _v6.copy(UP); }
    this._ringRaw(_v5, _v6, col, R * 1.45, 0.6, R_WAVE, 0.95, 1.4);
    this._after(0.1, OP_RING, _v5, _v6, col, R * 1.85, 0.5, R_THIN);
    this._after(0.2, OP_RING, _v5, _v6, col, R * 2.25, 0.8, R_RIPPLE);
    _sc.copy(DUST).lerp(col, 0.25);
    this._ringRaw(_v5, _v6, _sc, R * 1.1, 0.7, R_DUST, 0.55, 1);
    this._dustRing(_v5, _sc, 14, 6);
    const paint = this.paintEffects ? F_PAINT : 0;
    const n = Math.max(6, Math.round(20 * this.q));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rand() * 0.3, sp = 5 + rand() * 4;
      this._spawnDrop(_v5.x + Math.cos(a) * 0.6, _v5.y + 0.3, _v5.z + Math.sin(a) * 0.6, Math.cos(a) * sp, 4 + rand() * 3, Math.sin(a) * sp, col, 0.1 + rand() * 0.06, 2.2, 1, 1.1, paint);
    }
    this._colB.copy(col).multiplyScalar(1.2);
    this._beam(_v5, this._colB, 1.3, 5.5, 0.6);
  }

  // ---- Ink Tempest
  stormStart(pos, color, radius = 3.4) {
    const col = this._color(color, this._col);
    this._colB.copy(col).lerp(_white, 0.2);
    for (let i = 0; i < Math.round(10 * this.q) + 2; i++) {
      const a = rand() * TAU, r = rand() * radius * 0.6;
      this._sprite(this.puffs, pos.x + Math.cos(a) * r, pos.y + (rand() - 0.5) * 0.6, pos.z + Math.sin(a) * r, Math.cos(a) * 3.4, (rand() - 0.3) * 1.5, Math.sin(a) * 3.4, this._colB, radius * 0.25, radius * 0.6, 0.7 + rand() * 0.4, 0.4, 2.5, 0, P_MIST, 0.05, 0.4);
    }
    this._colB.copy(col).multiplyScalar(3);
    this._sprite(this.glows, pos.x, pos.y, pos.z, 0, 0, 0, this._colB, radius * 0.5, radius * 1.3, 0.25, 1, 0, 0, G_SOFT + 3, 0);
    this._toCam(pos, _v4);
    this._ringRaw(pos, _v4, col, radius * 1.4, 0.3, R_THIN, 0.8, 1.3);
  }
  // extra long, bright rain streaks under a storm cloud so the downpour reads from across the map (call per frame)
  rainSheet(pos, radius, color, dt = this._dt) {
    const col = this._color(color, this._col);
    this._colB.copy(col).lerp(_white, 0.35);
    let n = Math.floor(radius * radius * 3.2 * this.q * dt + rand());
    while (n-- > 0) {
      const a = rand() * TAU, r = Math.sqrt(rand()) * radius * 0.95;
      this._spawnDrop(pos.x + Math.cos(a) * r, pos.y - 0.4 - rand() * 0.5, pos.z + Math.sin(a) * r, 0.35, -19 - rand() * 4, 0.12, this._colB, 0.022 + rand() * 0.012, 1.0, 1, 5.5, F_QUIET);
    }
  }
  stormPuddle(pos, normal, color) {
    const col = this._color(color, this._col);
    _v2.copy(pos).addScaledVector(normal || UP, 0.01);
    this._colB.copy(col).lerp(_white, 0.15);
    this._ringRaw(_v2, normal || UP, this._colB, 0.25 + rand() * 0.25, 0.45, R_RIPPLE, 0.55, 1);
    if (rand() < 0.35) this._crown(_v2, normal || UP, col, 2, 1.4, 0.02, F_QUIET);
  }
  // a flicker inside the cloud
  stormFlash(pos, color, radius = 3.4) {
    const col = this._color(color, this._col);
    this._colB.copy(col).lerp(_white, 0.5).multiplyScalar(2.5);
    this._sprite(this.glows, pos.x + (rand() - 0.5) * radius, pos.y + (rand() - 0.3) * 0.8, pos.z + (rand() - 0.5) * radius, 0, 0, 0, this._colB, radius * 0.4, radius * 0.7, 0.12, 1, 0, 0, G_SOFT + 1, 0);
  }

  // ---- super jump
  superJumpCharge(pos, color, k = 0.5) {
    const col = this._color(color, this._col);
    const q = Math.max(0.5, this.q);
    // rising spiral of sparkles + droplets
    let n = Math.floor((24 + 30 * k) * this._dt * q + rand());
    this._colB.copy(col).lerp(_white, 0.5).multiplyScalar(2.2);
    while (n-- > 0) {
      const a = this._time * 9 + rand() * TAU, r = 0.75 - 0.35 * k + rand() * 0.15;
      const c = Math.cos(a), s = Math.sin(a);
      this._sprite(this.glows, pos.x + c * r, pos.y + 0.1 + rand() * 0.4, pos.z + s * r, -s * 2.4, 2.5 + 2 * k, c * 2.4, this._colB, 0.12, 0.05, 0.4, 1, 1.5, 0, G_STAR + 1, 0.03, 1.5);
    }
    n = Math.floor((14 + 24 * k) * this._dt * q + rand());
    while (n-- > 0) {
      const a = rand() * TAU, r = 0.5 + rand() * 0.3;
      this._spawnDrop(pos.x + Math.cos(a) * r, pos.y + 0.05, pos.z + Math.sin(a) * r, -Math.sin(a) * 1.8, 2.5 + rand() * 3 * (0.5 + k), Math.cos(a) * 1.8, col, 0.025 + rand() * 0.025, 0.7, 0.8, 1.3, F_QUIET);
    }
    this._colB.copy(col).lerp(_white, 0.2).multiplyScalar(1.4 + 2 * k);
    this._sprite(this.glows, pos.x, pos.y + 0.45, pos.z, 0, 0, 0, this._colB, 0.7 + 0.5 * k, 0.7 + 0.5 * k, Math.max(0.03, this._dt * 1.6), 0.7, 0, 0, G_SOFT + 2 * k, 0, 0);
    if (rand() < 5 * this._dt) this._ringRaw(_v2.set(pos.x, pos.y + 0.02, pos.z), UP, col, 1.1 + 0.4 * k, 0.35, R_THIN, 0.7, 1);
  }
  superJumpLaunch(pos, color) {
    const col = this._color(color, this._col);
    this._colB.copy(col).multiplyScalar(1.3);
    this._beam(pos, this._colB, 0.9, 12, 0.8);
    _v2.set(pos.x, pos.y + 0.02, pos.z);
    this._ringRaw(_v2, UP, col, 2.2, 0.45, R_WAVE, 0.95, 1.2);
    this._ringRaw(_v2, UP, col, 2.9, 0.3, R_THIN, 0.8, 1);
    const n = Math.max(8, Math.round(30 * this.q));
    for (let i = 0; i < n; i++) {
      coneDir(UP, 0.35, _v1);
      const sp = 9 + rand() * 7;
      this._spawnDrop(pos.x + (rand() - 0.5) * 0.5, pos.y + 0.1, pos.z + (rand() - 0.5) * 0.5, _v1.x * sp, _v1.y * sp, _v1.z * sp, col, 0.035 + rand() * 0.05, 1.6, 1, 1.5, 0);
    }
    this._colB.copy(col).lerp(_white, 0.3);
    for (let i = 0; i < Math.round(6 * this.q) + 1; i++) {
      const a = rand() * TAU;
      this._sprite(this.puffs, pos.x + Math.cos(a) * 0.5, pos.y + 0.2, pos.z + Math.sin(a) * 0.5, Math.cos(a) * 3, 0.8, Math.sin(a) * 3, this._colB, 0.3, 0.9, 0.6, 0.4, 3);
    }
    this._colB.copy(col).multiplyScalar(4);
    this._sprite(this.glows, pos.x, pos.y + 0.6, pos.z, 0, 0, 0, this._colB, 1.2, 2.4, 0.22, 1, 0, 0, G_SOFT + 4, 0);
  }
  superJumpTrail(pos, vel, color) {
    const col = this._color(color, this._col);
    let n = Math.max(1, Math.round(2 * this.q));
    while (n-- > 0) this._spawnDrop(pos.x + (rand() - 0.5) * 0.3, pos.y + (rand() - 0.5) * 0.3, pos.z + (rand() - 0.5) * 0.3, vel.x * 0.15 + (rand() - 0.5), vel.y * 0.15, vel.z * 0.15 + (rand() - 0.5), col, 0.03 + rand() * 0.035, 1.1, 1, 1.4, 0);
    this._colB.copy(col).lerp(_white, 0.2).multiplyScalar(2.2);
    this._sprite(this.glows, pos.x, pos.y, pos.z, 0, 0, 0, this._colB, 0.55, 0.3, 0.16, 0.9, 0, 0, G_SOFT + 1.5, 0);
    if (rand() < 0.5) { this._colB.copy(col).lerp(_white, 0.35); this._sprite(this.puffs, pos.x, pos.y, pos.z, 0, 0.2, 0, this._colB, 0.2, 0.55, 0.45, 0.3, 3); }
  }
  // landing target seen by everyone (immediate): ground reticle + light pillar
  jumpMarker(pos, color, t = 0) {
    const col = this._color(color, this._col);
    _v2.set(pos.x, pos.y + 0.03, pos.z);
    this.mark(_v2, UP, col, 1.5, R_TARGET, 1, t, 1, 0.5);
    this._colB.copy(col).multiplyScalar(1.5);
    this.pillar(_v2, this._colB, 0.5, 9, 0.55 + 0.15 * Math.sin(this._time * 6), 0.4);
  }
  superJumpLand(pos, color) {
    const col = this._color(color, this._col);
    _v2.set(pos.x, pos.y + 0.02, pos.z);
    this._ringRaw(_v2, UP, col, 2.4, 0.45, R_WAVE, 0.95, 1.2);
    this._ringRaw(_v2, UP, col, 3.0, 0.3, R_THIN, 0.8, 1);
    this._ringRaw(_v2, UP, col, 0.9, 0.5, R_BLOT, 0.95, 1);
    this._crown(_v2, UP, col, 26, 4.2, 0.06);
    this._colB.copy(col).multiplyScalar(3);
    this._sprite(this.glows, pos.x, pos.y + 0.5, pos.z, 0, 0, 0, this._colB, 0.8, 1.8, 0.18, 1, 0, 0, G_SOFT + 3, 0);
    _sc.copy(DUST).lerp(col, 0.2);
    this._dustRing(_v2, _sc, 8, 3);
  }

  // the victim's squid ghost floating up out of the splat
  ghost(pos, color) {
    const col = this._color(color, this._col);
    this._colB.copy(col).lerp(_white, 0.3);
    this._sprite(this.puffs, pos.x, pos.y + 0.35, pos.z, 0, 0.5, 0, this._colB, 0.55, 0.85, 1.5, 0.8, 1.2, 0.9, P_GHOST, 0.18, 0, 0.35, 0.6);
  }
  // falling into the sea
  waterSplash(pos, size = 1) {
    _v2.set(pos.x, this.waterY + 0.02, pos.z);
    this._crown(_v2, UP, WATER, 22 * size, 4 + 2 * size, 0.06);
    this._ringRaw(_v2, UP, FOAM, 1.2 * size, 0.6, R_RIPPLE, 0.8, 1);
    this._after(0.12, OP_RING, _v2, UP, FOAM, 2.2 * size, 0.9, R_RIPPLE);
    this._ringRaw(_v2, UP, FOAM, 0.6 * size, 0.4, R_DISC, 0.7, 1);
    for (let i = 0; i < Math.round(5 * this.q) + 1; i++) this._sprite(this.puffs, pos.x + (rand() - 0.5), this.waterY + 0.4, pos.z + (rand() - 0.5), (rand() - 0.5) * 1.5, 1.5 + rand(), (rand() - 0.5) * 1.5, FOAM, 0.3, 1.0, 0.9 + rand() * 0.4, 0.4, 2, 0.1);
    const n = Math.max(3, Math.round(8 * this.q));
    for (let i = 0; i < n; i++) {
      coneDir(UP, 0.25, _v1);
      const sp = 6 + rand() * 4 * size;
      this._spawnDrop(pos.x + (rand() - 0.5) * 0.4, this.waterY + 0.1, pos.z + (rand() - 0.5) * 0.4, _v1.x * sp, _v1.y * sp, _v1.z * sp, FOAM, 0.05 + rand() * 0.05, 1.6, 1, 1.4, F_NOCOL);
    }
  }
  // something small hitting the sea (shots, bombs)
  waterPlop(pos, size = 0.3) {
    _v2.set(pos.x, this.waterY + 0.02, pos.z);
    this._ringRaw(_v2, UP, FOAM, 0.35 + size, 0.5, R_RIPPLE, 0.7, 1);
    this._crown(_v2, UP, WATER, 4 + size * 8, 1.8 + size * 2, 0.03, F_NOCOL);
  }

  // special gauge full: glints swirling around the character (call at ~10–14 Hz per character)
  specialSparkle(pos, color, height = 1.5) {
    const col = this._color(color, this._col);
    const a = rand() * TAU, r = 0.38 + rand() * 0.18, y = 0.2 + rand() * height;
    this._colB.copy(col).lerp(_white, 0.35).multiplyScalar(2.4);
    this._sprite(this.glows, pos.x + Math.cos(a) * r, pos.y + y, pos.z + Math.sin(a) * r, -Math.sin(a) * 0.6, 0.45 + rand() * 0.3, Math.cos(a) * 0.6, this._colB, 0.26 + rand() * 0.12, 0.07, 0.5 + rand() * 0.2, 1, 0.5, 0, G_STAR + 1.5, 0.08, 3);
    if (rand() < 0.35) {
      this._colB.copy(col).multiplyScalar(2);
      this._sprite(this.glows, pos.x + Math.cos(a + 2) * r * 0.8, pos.y + y * 0.6, pos.z + Math.sin(a + 2) * r * 0.8, 0, 0.8, 0, this._colB, 0.07, 0.03, 0.6, 1, 0.5, 0, G_SOFT + 1, 0.05, 0);
    }
  }
  // standing in enemy ink: sticky bubbles popping at the feet
  enemyInkSizzle(pos, color) {
    const col = this._color(color, this._col);
    this._colB.copy(col).lerp(_white, 0.35).multiplyScalar(1.3);
    const n = 1 + (rand() < 0.5 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const a = rand() * TAU, r = 0.12 + rand() * 0.25;
      this._sprite(this.glows, pos.x + Math.cos(a) * r, pos.y + 0.04, pos.z + Math.sin(a) * r, 0, 0.22 + rand() * 0.2, 0, this._colB, 0.035 + rand() * 0.03, 0.07 + rand() * 0.03, 0.28 + rand() * 0.18, 0.85, 1, 0, G_BUBBLE + 1, 0.05, 0);
    }
    if (rand() < 0.3) this._spawnDrop(pos.x + (rand() - 0.5) * 0.3, pos.y + 0.04, pos.z + (rand() - 0.5) * 0.3, (rand() - 0.5) * 0.4, 0.8 + rand() * 0.6, (rand() - 0.5) * 0.4, col, 0.018 + rand() * 0.012, 0.4, 1, 1, F_QUIET);
  }

  // ---- ambient
  // a wave slapping the deck edge. pos: on the wall at the waterline; outward: unit horizontal normal pointing out to sea.
  // The sheet of spray has to clear the deck edge (1.6 m) and the railing (+1.05 m) to be seen from the deck.
  seaSpray(pos, outward, strength = 1) {
    const s = clamp(strength, 0.3, 1.6);
    const ax = -outward.z, az = outward.x;   // along the edge
    const n = Math.max(6, Math.round((16 + 20 * s) * this.q));
    const along0 = (rand() - 0.5) * 0.6;
    for (let i = 0; i < n; i++) {
      const along = along0 + (rand() - 0.5) * 2.6 * s, up = (7.5 + rand() * 4.5) * (0.75 + 0.3 * s), out = 0.3 + rand() * 1.6;
      this._spawnDrop(pos.x + ax * along + outward.x * 0.12, pos.y + rand() * 0.25, pos.z + az * along + outward.z * 0.12,
        outward.x * out + ax * (rand() - 0.5) * 1.4, up, outward.z * out + az * (rand() - 0.5) * 1.4, FOAM, 0.03 + rand() * 0.06, 2.2, 1, 1.25, F_NOCOL | (rand() < 0.3 ? 0 : F_QUIET));
    }
    // foam curtain: soft white plumes that climb past the edge, hang, and drift off with the breeze
    const m = Math.max(3, Math.round((5 + 4 * s) * this.q));
    for (let i = 0; i < m; i++) {
      const along = along0 + (rand() - 0.5) * 2.8 * s, h = rand();
      this._sprite(this.puffs, pos.x + ax * along + outward.x * (0.25 + h * 0.4), pos.y + 0.8 + h * 1.6 * s, pos.z + az * along + outward.z * (0.25 + h * 0.4),
        outward.x * 0.7 + 0.25, (2.6 + rand() * 2.2) * s, outward.z * 0.7 + 0.1, FOAM, 0.4 * s, (1.1 + rand() * 0.7) * s, 1.0 + rand() * 0.6, 0.42, 2.2, -1.2, P_MIST, 0.06, 0.4, 0.3);
    }
    _v2.set(pos.x + outward.x * 0.8, this.waterY + 0.03, pos.z + outward.z * 0.8);
    this._ringRaw(_v2, UP, FOAM, 1.5 * s + 0.5, 0.9, R_RIPPLE, 0.8, 1);
    this._ringRaw(_v2, UP, FOAM, 0.9 * s, 0.55, R_DISC, 0.5, 1);
    this._after(0.18, OP_RING, _v2, UP, FOAM, 2.4 * s + 0.6, 0.9, R_RIPPLE);
  }
  feather(pos) {
    this._sprite(this.puffs, pos.x, pos.y, pos.z, (rand() - 0.5) * 0.4, -0.25, (rand() - 0.5) * 0.4, FEATHER, 0.24, 0.24, 11 + rand() * 4, 0.97, 1.6, -0.7, P_FEATHER, 0.5, 1.8, 0.9, 1.5);
  }
  // sun glint on wet ink (or any glossy surface)
  glint(pos, color, size = 0.12) {
    const col = this._color(color, this._col);
    this._colB.copy(col).lerp(_white, 0.6).multiplyScalar(2.6);
    this._sprite(this.glows, pos.x, pos.y, pos.z, 0, 0, 0, this._colB, size * 0.4, size, 0.35 + rand() * 0.2, 1, 0, 0, G_STAR + 2, 0.12, 0.8);
  }

  // =================================================================== frame
  update(dt, camera) {
    dt = Math.min(dt || 0, 0.05);
    this._dt = dt > 0 ? dt : this._dt;
    this._time += dt;
    this._checks = 0;
    this._shellUniforms.uTime.value = this._time;
    this._ringU.uTime.value = this._time;
    this._beamU.uTime.value = this._time;
    if (camera) {
      camera.getWorldPosition(this._camPos);
      camera.getWorldDirection(this._camDir);
      const inv = camera.matrixWorldInverse;
      this._dropU.uSunDirV.value.copy(this._light.sunDir).transformDirection(inv);
      this._dropU.uUpV.value.copy(UP).transformDirection(inv);
      this._moteU.uCam.value.copy(this._camPos);
    }
    this._moteU.uTime.value = this._time;
    this._runSchedule(dt);
    this._updateDrops(dt);
    this._updateSprites(this.puffs, dt, false);
    this._updateSprites(this.glows, dt, true);
    this._updateRings(dt);
    this._updateShells(dt);
    this._updateBeams(dt);
  }

  clear() {
    this.dN = 0; this.dGeo.instanceCount = 0;
    for (const p of [this.puffs, this.glows, this.rings, this.shells, this.beams]) { p.n = 0; p.geo.instanceCount = 0; }
    this.marks.n = 0; this.pillars.n = 0; this._sqN = 0;
  }

  // Sync the droplet/shell lighting with the environment: fx.setLighting(env.getSkyColors()).
  // Accepts { sunDir, sun|sunColor, sunIntensity, zenith|sky, ground }.
  setLighting(o = EMPTY) {
    const L = this._light;
    if (o.sunDir) L.sunDir.copy(o.sunDir).normalize();
    const sc = o.sunColor || o.sun;
    if (sc) L.sunCol.copy(sc).multiplyScalar(Math.min(1.25, (o.sunIntensity ?? 3) / 3));
    const sky = o.sky || o.zenith;
    if (sky) { L.sky.copy(sky); if (o.horizon) L.sky.lerp(o.horizon, 0.45); }
    if (o.ground) L.ground.copy(o.ground);
    if (sc) this._moteU.uCol.value.copy(sc).lerp(_white, 0.35).multiplyScalar(0.9);
  }
  setSunDir(v) { this._light.sunDir.copy(v).normalize(); }

  stats() {
    return { drops: this.dN, puffs: this.puffs.n, glows: this.glows.n, rings: this.rings.n, shells: this.shells.n, beams: this.beams.n, checks: this._checks, sched: this._sqN, caps: { drops: this.dCap, puffs: this.puffs.cap, glows: this.glows.cap, rings: this.rings.cap } };
  }
  // Triangles currently submitted by the FX meshes (for budget audits).
  triangles() {
    const per = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
    return (this.dGeo.instanceCount + this.puffs.geo.instanceCount + this.glows.geo.instanceCount + this.rings.geo.instanceCount) * 2
      + this.shells.geo.instanceCount * per(this.shells.geo) + this.beams.geo.instanceCount * per(this.beams.geo)
      + (this.motes.visible ? this.motes.geometry.instanceCount * 2 : 0);
  }

  dispose() {
    this.scene.remove(this.root);
    this.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  }
}
