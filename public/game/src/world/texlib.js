// INKWAVE texture library — procedural, GPU-generated, tileable PBR surface layers.
//
//   import { createTextureLibrary, TEXLIB_GLSL, TEXLIB_MODE } from './texlib.js';
//   const lib = await createTextureLibrary(renderer, { size: 512 });   // 256 for low quality
//   lib.albedo   DataArrayTexture (WebGLArrayRenderTarget texture) RGBA8 sRGB — rgb albedo, a = alpha mask (1 = solid)
//   lib.normal   same layout, linear — tangent-space normal, +x = texture u, +y = texture v
//   lib.orm      same layout, linear — r cavity/AO, g roughness, b metalness, a height (0 = deepest, 1 = top)
//                (all three: RepeatWrapping, full mip chain, LinearMipmapLinear, anisotropy = renderer max ≤ 16)
//   lib.layers   { concrete: 0, pavers: 1, ..., glasstile: 11, detail: 12, gel: 13 }     name → layer index
//                (layer 12 'detail' is not a surface: a neutral 0.5 m micro-surface used by texlibDetail();
//                 layer 13 'gel' is the wet-ink micro-surface: soft swells + settling ripples, normal only, 1 m repeat)
//   lib.meta     { concrete: { scale, tint, alpha, mode, sym, detail, depth }, ... }
//                  scale = metres per texture repeat · tint = albedo is a neutral detail layer (linear mean
//                  luminance ≈ 0.8) meant to be MULTIPLIED by a per-block colour; tint:false = own colours
//                  alpha = layer uses the alpha mask · mode = recommended anti-tiling mode for texlibSample
//                  (TEXLIB_MODE) · sym = allowed grid transforms (bitmask 1 mirror-u, 2 mirror-v, 4 transpose)
//                  detail = recommended texlibDetail amount · depth = relief depth (m) that orm.a spans
//   lib.names    layer names in index order · lib.size · lib.stats { ms, compileMs, size }
//   lib.dispose()
//
// How it is made: ONE uber fragment shader (all layers behind a uniform switch) renders each layer straight into
// one WebGLArrayRenderTarget with three colour attachments (MRT: albedo sRGB8_A8, normal RGBA8, orm RGBA8). Every
// texel evaluates the surface at 2×2 sub-samples (box-filtered albedo/ORM = pre-filtered base level) and derives
// its normal from the sub-sample height gradient (heights are in metres, so bevels/grout have physical slopes).
// Patterns are periodic, band-limited (edge AA widths ≈ half a texel) and use integer PCG hashing, so output is
// deterministic on any GPU. The mip chain is generated once at the end. Materials declare their noise up front
// (prep → up to 4 fbm + 2 worley requests) and one shared loop evaluates them; loops stay rolled (uOne) and there
// is no integer modulo — all to keep the one-time driver compile short, which dominates a cold start.
// Start it early in loading: the compile half is async (KHR_parallel_shader_compile via compileAsync).
//
// GLSL helpers (TEXLIB_GLSL, WebGL2 / three ShaderChunk-compatible, all names prefixed texlib):
//
//   #define TEXLIB_PLAIN 0   plain repeat
//   #define TEXLIB_GRID  1   per-repeat random dihedral transform (mirror-u / mirror-v / transpose, masked by sym).
//                            Every grid layer has joints/seams on its repeat borders, so the hard switch is
//                            invisible; textureGrad with the continuous uv keeps mips/anisotropy seam-free.
//   #define TEXLIB_HEX   2   hex-tile stochastic blend (Mikkelsen 2022): 3 taps, random rotation + offset per hex,
//                            height-aware contrast blend — for isotropic noise layers (asphalt, rubber).
//
//   struct TexlibSample { vec4 albedo; vec3 normal; vec4 orm; };
//     albedo = linear rgb + alpha mask · normal = normalised tangent-space normal already rotated back into the
//     caller's uv frame (+x = +u, +y = +v) · orm = cavity, roughness (Toksvig-widened where mips average bumps
//     away → no specular sparkle at distance), metalness, height
//
//   TexlibSample texlibSample(sampler2DArray tAlbedo, sampler2DArray tNormal, sampler2DArray tOrm,
//                             vec2 uv, float layer, int mode, int sym)
//       uv = surface position in metres / meta.scale (1.0 = one repeat); layer = lib.layers[name];
//       mode/sym = meta.mode/meta.sym (pass TEXLIB_PLAIN to disable anti-tiling). Takes dFdx/dFdy of uv, so call
//       it in uniform control flow.
//   mat3 texlibTangentFrame(vec3 eyePos, vec3 surfNormal, vec2 uv)
//       derivative-based TBN (columns T = ∂p/∂u, B = ∂p/∂v, N) in the space of eyePos/surfNormal, e.g. view space:
//       texlibTangentFrame(-vViewPosition, normal, uv). Handles mirrored uvs. For double-sided back faces
//       multiply columns 0 and 1 by three's faceDirection (as three does for its own normal maps).
//   vec3 texlibPerturbNormal(vec3 nTS, mat3 tbn, float strength)
//   vec3 texlibPerturbNormal(vec3 nTS, vec3 T, vec3 B, vec3 N, float strength)
//       tangent-space normal → normalised normal in the TBN's space; strength scales the tilt (1 = authored).
//   void texlibDetail(inout TexlibSample s, sampler2DArray tAlbedo, sampler2DArray tNormal, sampler2DArray tOrm,
//                     vec2 pMetres, float detailLayer, float amount)
//       optional close-up crispness: blends the extra 'detail' layer (lib.layers.detail, 0.5 m micro-surface) at two
//       rotated scales. pMetres = surface coords in metres (uv * meta.scale), amount = meta.detail. Costs 6 taps;
//       fades to neutral by itself with distance (mips), so it never aliases. Call right after texlibSample.
//   float texlibSpecularAA(vec3 normal, float roughness)
//       screen-space specular anti-aliasing on the FINAL perturbed normal (any space): returns a widened roughness
//       where the normal varies faster than the pixel grid. Apply after the normal is known, e.g. in three:
//       after <lights_physical_fragment>: material.roughness = texlibSpecularAA(normal, material.roughness);
//   float texlibMacro(vec2 pMetres)
//       smooth, band-limited brightness multiplier (≈0.94–1.06, mean ≈1) — multiply into albedo to break up
//       large-scale repetition, e.g. texlibMacro(worldPos.xz + worldPos.y * 0.7).
//   float texlibCoverage(float alpha, vec2 uv, float texSize)
//       grate alpha for an alpha test (< 0.5 → discard) or alphaToCoverage: crisp anti-aliased holes up close;
//       as the openings drop below pixel size the bars thicken (mip-aware) until the grate reads solid, so it
//       never breaks into dotted, shimmering holes or vanishes at distance. texSize = lib.size.

import * as THREE from 'three';

export const TEXLIB_MODE = { plain: 0, grid: 1, hex: 2 };
const { plain: PLAIN, grid: GRID, hex: HEX } = TEXLIB_MODE;

// ---------------------------------------------------------------------------------------------------------------
// Generator GLSL (GLSL ES 3.00, RawShaderMaterial)
// ---------------------------------------------------------------------------------------------------------------

const GEN_VS = /* glsl */`
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const GEN_COMMON = /* glsl */`
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform float uScale;
uniform int uMat;
uniform int uOne;   // = 1: non-constant trip counts, so drivers keep loops rolled (short cold compile)
uniform vec2 uHRange;  // height range (m) mapped to orm.a 0..1
uniform float uAO;     // depth-occlusion strength
layout(location = 0) out vec4 oAlb;   // -> albedo (sRGB attachment, hardware-encoded)
layout(location = 1) out vec4 oNrm;
layout(location = 2) out vec4 oOrm;
#define PI 3.14159265
#define TAU 6.28318531
struct S { vec3 alb; float a; float h; float cav; float rough; float metal; };
struct Req { vec2 x; ivec2 per; int oct; float gain; uint seed; };   // fbm request
struct WReq { vec2 uv; ivec2 n; float jit; uint seed; };            // worley request
float PX; // metres per sub-sample step (half a texel): the AA width unit

uint pcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
uint hu(ivec2 p, uint s) { return pcg((uint(p.x) * 0x8da6b343u) ^ (uint(p.y) * 0xd8163841u) ^ (s * 0xcb1ab31fu)); }
float hf(ivec2 p, uint s) { return float(hu(p, s) >> 8u) * (1.0 / 16777216.0); }
vec2 hf2(ivec2 p, uint s) { uint a = hu(p, s); return vec2(float(a >> 8u), float(pcg(a) >> 8u)) * (1.0 / 16777216.0); }
// float wrap: integer % by a non-constant divisor is emulated in software and bloats driver compile time
ivec2 wrp(ivec2 i, ivec2 n) { vec2 fi = vec2(i), fn = vec2(n); return ivec2(fi - fn * floor((fi + 0.5) / fn)); }
vec3 lin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec2 gr(uint h) { return vec2(float(h & 0xffffu), float(h >> 16u)) * (1.0 / 32767.5) - 1.0; }

// periodic gradient noise ~[-1,1]; x in lattice units, n = period in lattice cells
float gn(vec2 x, ivec2 n, uint s) {
  ivec2 i = ivec2(floor(x)); vec2 f = x - vec2(i);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float v0 = dot(gr(hu(wrp(i, n), s)), f);
  float v1 = dot(gr(hu(wrp(i + ivec2(1, 0), n), s)), f - vec2(1.0, 0.0));
  float v2 = dot(gr(hu(wrp(i + ivec2(0, 1), n), s)), f - vec2(0.0, 1.0));
  float v3 = dot(gr(hu(wrp(i + ivec2(1, 1), n), s)), f - vec2(1.0, 1.0));
  return 1.6 * mix(mix(v0, v1, u.x), mix(v2, v3, u.x), u.y);
}
float fbmR(Req r) {
  float sum = 0.0, amp = 1.0, nrm = 0.0; vec2 x = r.x; ivec2 per = r.per;
  for (int o = 0; o < r.oct * uOne; o++) { sum += amp * gn(x, per, r.seed + uint(o) * 1013u); nrm += amp; amp *= r.gain; x *= 2.0; per *= 2; }
  return nrm > 0.0 ? sum / nrm : 0.0;
}
// periodic worley on the tile: n cells per repeat; returns (F1, F2, id of nearest, id of 2nd) in cell units
vec4 worR(WReq q) {
  if (q.n.x == 0) return vec4(0.0);
  vec2 x = q.uv * vec2(q.n); ivec2 i = ivec2(floor(x)); vec2 f = x - vec2(i);
  float F1 = 9.0, F2 = 9.0, id = 0.0, id2 = 0.0;
  for (int y = -uOne; y <= uOne; y++) for (int xx = -uOne; xx <= uOne; xx++) {
    ivec2 c = ivec2(xx, y); ivec2 w = wrp(i + c, q.n);
    vec2 o = vec2(c) + 0.5 + (hf2(w, q.seed) - 0.5) * q.jit;
    float d = length(o - f);
    if (d < F1) { F2 = F1; F1 = d; id2 = id; id = hf(w, q.seed + 7u); } else if (d < F2) { F2 = d; }
  }
  return vec4(F1, F2, id, id2);
}
// request builders: FB = periodic fbm over the repeat (f0 cells), FNP = aperiodic fbm on explicit coords
Req FB(vec2 uv, ivec2 f0, int oct, float gain, uint s) { return Req(uv * vec2(f0), f0, oct, gain, s); }
Req FNP(vec2 x, int oct, uint s) { return Req(x, ivec2(4096), oct, 0.5, s); }
WReq WO(vec2 uv, ivec2 n, float jit, uint s) { return WReq(uv, n, jit, s); }

float aa(float edge, float x) { return smoothstep(edge - PX * 0.75, edge + PX * 0.75, x); }
float jd(float x, float p) { return abs(x - p * floor(x / p + 0.5)); }
float sdRB(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
// joint + rounded arris profile. e = distance from the joint centre line (m), jw = half joint width,
// r = rounding width, de = drop at the arris, dj = joint depth. returns (height, jointMask)
vec2 edgeProf(float e, float jw, float r, float de, float dj) {
  float t = clamp(1.0 - (e - jw) / r, 0.0, 1.0);
  float hE = -de * (1.0 - sqrt(max(1.0 - t * t, 0.0)));
  float inJ = 1.0 - aa(jw, e);
  return vec2(mix(hE, -dj, inJ), inJ);
}
`;

const GEN_MAIN = /* glsl */`
// Surface evaluation at 2x2 sub-samples per texel (rotated into one rolled loop, so the whole material pipeline
// exists once in the binary): box-filtered albedo/ORM, normal from the sub-sample height gradient.
void main() {
  PX = uScale / (2.0 * uRes.x);   // AA width unit: half a texel
  vec3 alb = vec3(0.0); float alpha = 0.0, cav = 0.0, rough = 0.0, metal = 0.0; float hs[4];
  for (int k = 0; k < 4 * uOne; k++) {
    vec2 uv = (gl_FragCoord.xy + (vec2(k & 1, k >> 1) - 0.5) * 0.5) / uRes;
    vec2 P = uv * uScale;
    Req f[4]; WReq w[2];
    for (int q = 0; q < 4; q++) f[q] = Req(vec2(0.0), ivec2(1), 0, 0.5, 0u);
    w[0] = WReq(vec2(0.0), ivec2(0), 0.0, 0u); w[1] = w[0];
    PREP_SWITCH
    float n[4]; vec4 c[2];
    for (int q = 0; q < 4 * uOne; q++) n[q] = fbmR(f[q]);
    for (int q = 0; q < 2 * uOne; q++) c[q] = worR(w[q]);
    S s; s.alb = vec3(0.8); s.a = 1.0; s.h = 0.0; s.cav = 1.0; s.rough = 0.8; s.metal = 0.0;
    SURF_SWITCH
    alb += max(s.alb, vec3(0.0)); alpha += clamp(s.a, 0.0, 1.0);
    cav += clamp(s.cav, 0.0, 1.0) * (1.0 - uAO * clamp(-s.h / -uHRange.x, 0.0, 1.0));
    rough += clamp(s.rough, 0.02, 1.0); metal += clamp(s.metal, 0.0, 1.0);
    hs[k] = s.h;
  }
  float dx = (hs[1] - hs[0] + hs[3] - hs[2]) / (2.0 * PX);
  float dy = (hs[2] - hs[0] + hs[3] - hs[1]) / (2.0 * PX);
  float h = (hs[0] + hs[1] + hs[2] + hs[3]) * 0.25;
  oAlb = vec4(alb * 0.25, alpha * 0.25);
  oNrm = vec4(normalize(vec3(-dx, -dy, 1.0)) * 0.5 + 0.5, 1.0);
  oOrm = vec4(cav * 0.25, rough * 0.25, metal * 0.25, clamp((h - uHRange.x) / (uHRange.y - uHRange.x), 0.0, 1.0));
}
`;

// ---------------------------------------------------------------------------------------------------------------
// Materials. prep() declares noise (f[0..3] fbm, w[0..1] worley); surf() gets the results as n[] / c[].
// Heights in metres (0 = nominal top surface). Colours linear. hr = height range mapped to orm.a.
// ---------------------------------------------------------------------------------------------------------------

const PREP_SIG = 'vec2 uv, vec2 P, inout Req f[4], inout WReq w[2]';
const SURF_SIG = 'vec2 uv, vec2 P, float n[4], vec4 c[2], inout S s';

const MATERIALS = [
  {
    name: 'concrete', detail: 1.0, scale: 4.0, tint: true, alpha: false, mode: GRID, sym: 7, hr: [-0.004, 0.0008], ao: 0.5,
    prep: `f[0] = FB(uv, ivec2(3), 5, 0.55, 11u); f[1] = FB(uv, ivec2(8), 3, 0.5, 19u); f[2] = FB(uv, ivec2(24), 3, 0.5, 23u);
  w[0] = WO(uv, ivec2(64), 0.8, 37u);`,
    surf: /* glsl */`
  // 2 x 2 m cast panels: hairline seams, per-pour tone, one form-tie hole per panel, sparse bug-hole pores
  ivec2 pan = wrp(ivec2(floor(P / 2.0)), ivec2(2));
  float dSeam = min(jd(P.x, 2.0), jd(P.y, 2.0));
  float seam = 1.0 - aa(0.003, dSeam);
  float seamSoft = 1.0 - smoothstep(0.0, 0.045, dSeam);
  float mott = n[0], cloud = n[1], fine = n[2];
  float tone = 1.0 + 0.07 * (hf(pan, 5u) - 0.5);
  vec3 col = vec3(0.805) * tone * (1.0 + 0.09 * mott + 0.05 * cloud + 0.025 * fine);
  float rh = length(mod(P, 2.0) - 1.0);
  float hole = 1.0 - aa(0.011, rh);
  float ring = (1.0 - aa(0.02, rh)) * (1.0 - hole);
  vec4 wc = c[0];
  float pr = wc.x * (4.0 / 64.0);
  float pore = step(0.975, wc.z) * (1.0 - smoothstep(0.003 + 0.004 * fract(wc.z * 13.7), 0.0045 + 0.004 * fract(wc.z * 13.7) + PX, pr));
  col *= (1.0 - 0.07 * pore) * (1.0 - 0.10 * hole) * (1.0 - 0.12 * seam) * (1.0 - 0.035 * seamSoft) * (1.0 + 0.02 * ring);
  s.alb = col;
  s.h = 0.00035 * mott + 0.0001 * fine - 0.0015 * pore - 0.0032 * hole - 0.0008 * seam + 0.0001 * ring;
  s.rough = 0.78 + 0.07 * mott - 0.04 * cloud + 0.04 * (hf(pan, 9u) - 0.5);
  s.cav = 1.0 - 0.3 * hole - 0.2 * pore - 0.25 * seam;`,
  },
  {
    name: 'pavers', detail: 0.9, scale: 4.0, tint: true, alpha: false, mode: GRID, sym: 7, hr: [-0.008, 0.001], ao: 0.55,
    prep: `f[0] = FB(uv, ivec2(6), 4, 0.5, 17u); f[1] = FB(uv, ivec2(3), 3, 0.5, 29u); w[0] = WO(uv, ivec2(240), 1.0, 31u);`,
    surf: /* glsl */`
  // 2 x 2 m plaza slabs, 15 mm joints, rounded arrises, per-slab tone + micro tilt, fine aggregate speckle
  ivec2 cell = ivec2(floor(P / 2.0));
  ivec2 cw = wrp(cell, ivec2(2));
  vec2 lp = P - (vec2(cell) * 2.0 + 1.0);
  float e = -sdRB(lp, vec2(1.0), 0.016);
  vec2 pr = edgeProf(e, 0.0075, 0.016, 0.0045, 0.0075);
  float inJ = pr.y;
  float hid = hf(cw, 3u), hid2 = hf(cw, 11u);
  vec2 tilt = hf2(cw, 9u) - 0.5;
  float mott = n[0], cloud = n[1];
  float grain = smoothstep(0.05, 0.2, c[0].y - c[0].x) * (c[0].z - 0.5);
  vec3 col = vec3(0.84) * (1.0 + 0.2 * (hid - 0.5)) * (1.0 + 0.07 * mott + 0.05 * cloud + 0.1 * grain);
  float arris = clamp(1.0 - (e - 0.0075) / 0.016, 0.0, 1.0) * (1.0 - inJ);
  float grime = (1.0 - smoothstep(0.0, 0.06, e - 0.0075)) * (1.0 - inJ);   // soft dirt band hugging the joints
  col *= (1.0 - 0.06 * arris) * (1.0 - 0.09 * grime * (0.7 + 0.3 * cloud));
  col = mix(col, vec3(0.42) * (1.0 + 0.1 * mott), inJ);
  s.alb = col;
  s.h = pr.x + dot(tilt, lp) * 0.0012 * (1.0 - inJ) + 0.00015 * mott + 0.00005 * grain;
  s.rough = mix(0.7 + 0.12 * hid2 + 0.06 * mott + 0.05 * grime, 0.95, inJ);
  s.cav = mix(1.0, 0.5, inJ) * (1.0 - 0.1 * grime);`,
  },
  {
    name: 'tiles', detail: 0.15, scale: 2.0, tint: true, alpha: false, mode: GRID, sym: 7, hr: [-0.003, 0.0006], ao: 0.5,
    prep: `ivec2 cw = wrp(ivec2(floor(P / 0.5)), ivec2(4));
  f[0] = FB(uv, ivec2(12), 1, 0.5, 41u + uint(cw.x * 4 + cw.y) * 131u); f[1] = FB(uv, ivec2(8), 3, 0.5, 13u); f[2] = FB(uv, ivec2(96), 2, 0.5, 7u);`,
    surf: /* glsl */`
  // 0.5 m glazed ceramic tiles, 9 mm grout, cushion edges, per-tile tone / gloss / glaze wave
  ivec2 cell = ivec2(floor(P / 0.5));
  ivec2 cw = wrp(cell, ivec2(4));
  vec2 lp = P - (vec2(cell) * 0.5 + 0.25);
  float e = -sdRB(lp, vec2(0.25), 0.007);
  vec2 pr = edgeProf(e, 0.0045, 0.006, 0.0014, 0.0026);
  float inG = pr.y;
  float hid = hf(cw, 3u), hid2 = hf(cw, 5u);
  float wave = n[0], mott = n[1];
  float edgeTone = 1.0 - smoothstep(0.0, 0.035, e - 0.0045);
  vec3 col = vec3(0.84) * (1.0 + 0.07 * (hid - 0.5) + 0.015 * mott) * (1.0 - 0.05 * edgeTone);
  vec3 grout = vec3(0.6) * (1.0 + 0.06 * n[2]);
  s.alb = mix(col, grout, inG);
  s.h = pr.x + (0.00022 * wave + 0.00004 * mott) * (1.0 - inG);
  s.rough = mix(0.18 + 0.08 * hid2 + 0.03 * mott, 0.9, inG);
  s.cav = mix(1.0, 0.6, inG);`,
  },
  {
    name: 'asphalt', detail: 0.4, scale: 2.0, tint: true, alpha: false, mode: HEX, sym: 7, hr: [-0.0014, 0.0008], ao: 0.45,
    prep: `f[0] = FB(uv, ivec2(4), 4, 0.5, 13u); f[1] = FB(uv, ivec2(64), 2, 0.5, 7u);
  w[0] = WO(uv, ivec2(150), 1.0, 41u); w[1] = WO(uv, ivec2(360), 1.0, 53u);`,
    surf: /* glsl */`
  // fine aggregate in binder, sparse light stones, very low contrast
  vec4 wc = c[0], w2 = c[1];
  float stone = smoothstep(0.06, 0.24, wc.y - wc.x);
  float light = step(0.9, wc.z);
  float st = mix(0.76 + 0.16 * fract(wc.z * 7.13), 1.05, light);
  float big = n[0];
  float binder = 0.63 + 0.05 * n[1];
  float grit = smoothstep(0.05, 0.25, w2.y - w2.x) * (fract(w2.z * 5.31) - 0.5);
  float worn = smoothstep(-0.2, 0.5, big);                 // traffic-polished patches: lighter, a bit smoother
  s.alb = vec3(mix(binder, st, stone)) * (1.0 + 0.06 * big + 0.06 * grit) * (1.0 + 0.04 * worn);
  s.h = -0.0011 * (1.0 - stone) + 0.0005 * stone * (1.0 - wc.x * wc.x) + 0.00012 * grit + 0.0001 * big;
  s.rough = mix(0.94, 0.8, stone * (1.0 - light * 0.5)) - 0.1 * worn;`,
  },
  {
    name: 'planks', detail: 0.3, scale: 2.0, tint: false, alpha: false, mode: GRID, sym: 1, hr: [-0.015, 0.0012], ao: 0.4,
    prep: `int row = int(floor(P.y / 0.25)); int rw = (row + 8) % 8;
  int kk[8] = int[8](0, 2, 1, 3, 2, 0, 3, 1);
  float xp = mod(P.x - 0.25 - 0.5 * float(kk[rw]), 2.0), ly = P.y - float(row) * 0.25;
  float rh = hf(ivec2(rw, 0), 3u), rh2 = hf(ivec2(rw, 1), 3u);
  uint sd = uint(rw) * 7919u + 101u;
  f[0] = FNP(vec2(xp * 1.3, ly * 17.0) + rh * 40.0, 4, sd); f[1] = FNP(vec2(xp * 0.5, ly * 4.0) + rh2 * 30.0, 3, sd + 17u);`,
    surf: /* glsl */`
  // 0.25 m boardwalk planks along u, 8 mm gaps, butt joints on joists (every 0.5 m), grain, nail heads
  const float PW = 0.25;
  int row = int(floor(P.y / PW));
  int rw = (row + 8) % 8;
  float ly = P.y - float(row) * PW;
  int kk[8] = int[8](0, 2, 1, 3, 2, 0, 3, 1);
  float jx = 0.25 + 0.5 * float(kk[rw]);
  float xp = mod(P.x - jx, 2.0);
  float eSide = min(ly, PW - ly);
  float eEnd = min(xp, 2.0 - xp);
  vec2 ps = edgeProf(eSide, 0.004, 0.006, 0.0022, 0.015);
  vec2 pe = edgeProf(eEnd, 0.0015, 0.004, 0.0014, 0.012);
  float gap = max(ps.y, pe.y);
  float h = min(ps.x, pe.x);
  float rh = hf(ivec2(rw, 0), 3u), rh2 = hf(ivec2(rw, 1), 3u), rh3 = hf(ivec2(rw, 2), 3u);
  float streak = n[0], warp = n[1];
  float ring = 0.5 + 0.5 * cos((ly * 64.0 + warp * 3.5 + rh2 * 9.0) * PI);
  float lines = smoothstep(0.72, 1.0, ring);
  vec3 wa = lin(vec3(0.79, 0.64, 0.47)), wb = lin(vec3(0.74, 0.57, 0.42)), wc = lin(vec3(0.82, 0.69, 0.51));
  vec3 base = mix(wa, rh3 > 0.5 ? wb : wc, abs(rh3 - 0.5) * 1.4) * (0.94 + 0.12 * rh);
  vec3 col = base * (1.0 + 0.07 * streak) * (1.0 - 0.07 * lines);
  col *= 1.0 - 0.1 * (1.0 - smoothstep(0.0, 0.035, eEnd - 0.0015));
  col *= 1.0 - 0.05 * (1.0 - smoothstep(0.0, 0.02, eSide - 0.004));
  float nx = eEnd < 0.1 ? abs(eEnd - 0.03) : jd(P.x - 0.25, 0.5);
  float ny = min(abs(ly - 0.045), abs(ly - (PW - 0.045)));
  float nd = length(vec2(nx, ny));
  float nail = 1.0 - aa(0.0042, nd);
  col *= 1.0 - 0.1 * (1.0 - smoothstep(0.004, 0.018, nd));
  col = mix(col, lin(vec3(0.46, 0.45, 0.44)) * (0.85 + 0.3 * smoothstep(0.0042, 0.0, nd)), nail);
  col = mix(col, lin(vec3(0.20, 0.15, 0.11)), gap);
  h += (0.0007 * (1.0 - pow((ly - PW * 0.5) / (PW * 0.5), 2.0)) + 0.00011 * streak - 0.00006 * lines) * (1.0 - gap);
  s.alb = col;
  s.h = h - nail * 0.0003;
  s.rough = mix(mix(0.64 + 0.05 * streak + 0.05 * lines, 0.42, nail), 0.92, gap);
  s.metal = nail * 0.75;
  s.cav = mix(1.0, 0.4, gap);`,
  },
  {
    name: 'metalpanel', detail: 0.2, scale: 2.0, tint: true, alpha: false, mode: GRID, sym: 3, hr: [-0.006, 0.003], ao: 0.45,
    prep: `f[0] = FB(uv, ivec2(20, 2), 4, 0.55, 3u); f[1] = FB(uv, ivec2(4), 4, 0.5, 5u); f[2] = FB(uv, ivec2(40), 4, 0.55, 7u);`,
    surf: /* glsl */`
  // painted steel wall panels 1 x 2 m: V-seams, folded edges, two pressed ribs, rivet rows, light edge wear
  ivec2 cell = ivec2(floor(P / vec2(1.0, 2.0)));
  vec2 lp = P - (vec2(cell) * vec2(1.0, 2.0) + vec2(0.5, 1.0));
  float e = -sdRB(lp, vec2(0.5, 1.0), 0.015);
  vec2 pr = edgeProf(e, 0.0035, 0.01, 0.0032, 0.006);
  float inS = pr.y;
  float rib = exp(-pow((abs(lp.y) - 0.333) / 0.022, 2.0)) * smoothstep(0.03, 0.09, e);
  float ry = -0.9 + 0.2 * clamp(floor((lp.y + 1.0) / 0.2), 0.0, 9.0);
  float d1 = length(vec2(abs(lp.x) - 0.465, lp.y - ry));
  float rx = -0.4 + 0.2 * clamp(floor((lp.x + 0.5) / 0.2), 0.0, 4.0);
  float d2 = length(vec2(lp.x - rx, abs(lp.y) - 0.965));
  float rd = min(d1, d2);
  float rv = 1.0 - aa(0.0065, rd);
  float dome = sqrt(max(1.0 - pow(rd / 0.0065, 2.0), 0.0));
  float streak = n[0], mott = n[1], wn = n[2] * 0.5 + 0.5;
  float edgeP = 1.0 - smoothstep(0.004, 0.03, e);
  float wear = smoothstep(0.7, 0.78, wn + 0.3 * edgeP * (1.0 - inS)) * (1.0 - inS);
  wear = max(wear, rv * smoothstep(0.55, 0.9, dome) * smoothstep(0.35, 0.6, wn));
  vec3 col = vec3(0.81) * (1.0 + 0.035 * streak + 0.025 * mott) * (1.0 - 0.08 * edgeP);
  col = mix(col, vec3(0.93), wear * 0.7);
  s.alb = mix(col, vec3(0.36), inS);
  s.h = pr.x + 0.0022 * rib + rv * 0.0025 * dome + 0.00008 * mott - wear * 0.00005;
  s.rough = mix(mix(0.36 + 0.04 * streak, 0.42, wear), 0.7, inS);
  s.metal = mix(mix(0.3, 0.45, wear), 0.2, inS);
  s.cav = mix(1.0, 0.55, inS) * (1.0 - 0.25 * rv * (1.0 - dome));`,
  },
  {
    name: 'corrugated', detail: 0.2, scale: 2.4, tint: true, alpha: false, mode: PLAIN, sym: 0, hr: [-0.03, 0.001], ao: 0.3,
    prep: `f[0] = FB(uv, ivec2(3, 4), 3, 0.5, 5u); f[1] = FB(uv, ivec2(16, 2), 4, 0.55, 9u); f[2] = FB(uv, ivec2(5), 4, 0.5, 11u);
  f[3] = FB(uv, ivec2(8, 40), 4, 0.55, 13u);`,
    surf: /* glsl */`
  // container corrugation: vertical ribs (along v), 0.3 m period, trapezoid 30 mm deep, crest-edge paint wear
  float x = mod(P.x + 0.15, 0.3) - 0.15;
  float a = abs(x);
  float t = clamp((a - 0.042) / 0.066, 0.0, 1.0);
  float prof = mix(t, t * t * (3.0 - 2.0 * t), 0.65);
  float dent = n[0], streak = n[1], mott = n[2], wn = n[3] * 0.5 + 0.5;
  float crestEdge = exp(-pow((a - 0.045) / 0.007, 2.0));
  float troughEdge = exp(-pow((a - 0.105) / 0.009, 2.0));
  float wear = crestEdge * smoothstep(0.52, 0.62, wn);
  vec3 col = vec3(0.81) * (1.0 + 0.03 * streak + 0.025 * mott) * (1.0 - 0.07 * smoothstep(0.1, 0.15, a));
  s.alb = mix(col, vec3(0.95), wear * 0.55);
  s.h = -0.03 * prof + 0.0006 * dent - wear * 0.00005;
  s.rough = mix(0.5 + 0.05 * streak, 0.45, wear);
  s.metal = mix(0.25, 0.4, wear);
  s.cav = 1.0 - 0.18 * troughEdge;`,
  },
  {
    name: 'hazard', detail: 0.5, scale: 2.0, tint: false, alpha: false, mode: PLAIN, sym: 0, hr: [-0.0004, 0.0004], ao: 0.3,
    prep: `f[0] = FB(uv, ivec2(5), 5, 0.55, 5u); f[1] = FB(uv, ivec2(40), 3, 0.5, 9u); f[2] = FB(uv, ivec2(4, 80), 3, 0.5, 15u);`,
    surf: /* glsl */`
  // 45° yellow / black safety stripes (~12 cm each), paint worn through to concrete in soft patches
  const float PER = 1.0 / 3.0;
  float q = fract((P.x + P.y) / PER);
  float dY = q < 0.5 ? min(q, 0.5 - q) : -min(q - 0.5, 1.0 - q);
  float dm = dY * PER * 0.70710678;
  float yel = smoothstep(-PX * 0.75, PX * 0.75, dm);
  vec3 Y = lin(vec3(0.96, 0.77, 0.16)), K = lin(vec3(0.14, 0.14, 0.15));
  float n1 = n[0] * 0.5 + 0.5, n2 = n[1] * 0.5 + 0.5, scuff = n[2] * 0.5 + 0.5;
  float edgeW = 1.0 - smoothstep(0.0, 0.012, abs(dm));
  float thin = smoothstep(0.5, 0.75, n1 + 0.15 * (n2 - 0.5));                    // paint worn thin, broad and soft
  float wear = smoothstep(0.72, 0.8, n1 + 0.35 * (n2 - 0.5) + 0.05 * edgeW);  // worn through, rare
  vec3 paint = mix(K, Y, yel) * (1.0 - 0.05 * (n1 - 0.5)) * (1.0 - 0.06 * smoothstep(0.55, 0.8, scuff));
  vec3 under = lin(vec3(0.63, 0.62, 0.6)) * (1.0 + 0.06 * (n2 - 0.5));
  paint = mix(paint, mix(paint, under, 0.3), thin * (0.2 + 0.25 * yel));
  s.alb = mix(paint, under, wear * 0.85);
  s.h = 0.0003 * (1.0 - wear) + 0.00005 * n2;
  s.rough = mix(0.52 + 0.08 * scuff, 0.86, wear);`,
  },
  {
    name: 'grate', detail: 0.3, scale: 1.2, tint: false, alpha: true, mode: GRID, sym: 3, hr: [-0.009, 0.0006], ao: 0.35,
    prep: `f[0] = FB(uv, ivec2(6), 4, 0.5, 3u); f[1] = FB(uv, ivec2(12), 3, 0.5, 9u); w[0] = WO(uv, ivec2(30), 1.0, 21u);`,
    surf: /* glsl */`
  // galvanised bar grating: bearing bars along u (20 mm, serrated), cross bars along v (14 mm, 3 mm lower),
  // 75 mm pitch -> ~5.5-6 cm openings (alpha 0)
  float db = jd(P.y, 0.075);
  float dc = jd(P.x, 0.075);
  float bb = 1.0 - aa(0.01, db);
  float cb = 1.0 - aa(0.007, dc);
  float hb = -0.0026 * pow(clamp(db / 0.01, 0.0, 1.0), 2.0) - 0.0005 * (0.5 + 0.5 * cos(TAU * P.x / 0.0125)) * smoothstep(0.0075, 0.0, db);
  float hc = -0.003 - 0.002 * pow(clamp(dc / 0.007, 0.0, 1.0), 2.0);
  float h = max(mix(-0.009, hb, bb), mix(-0.009, hc, cb));
  float spang = (c[0].z - 0.5) * smoothstep(0.0, 0.08, c[0].y - c[0].x);
  float mott = n[0];
  vec3 steel = vec3(0.53, 0.55, 0.57) * (1.0 + 0.07 * spang + 0.04 * mott);
  float top = bb * (1.0 - smoothstep(0.0, 0.01, db));
  float polish = top * smoothstep(0.45, 0.7, n[1] * 0.5 + 0.75);
  steel = mix(steel, vec3(0.64, 0.65, 0.66), polish * 0.7);
  float junction = cb * (1.0 - bb) * (1.0 - smoothstep(0.01, 0.02, db));
  s.alb = steel * (1.0 - 0.18 * junction);
  s.a = max(bb, cb);
  s.h = h;
  s.rough = mix(0.46 + 0.05 * mott, 0.3, polish);
  s.metal = 0.85;
  s.cav = 1.0 - 0.35 * junction;`,
  },
  {
    name: 'brick', detail: 0.7, scale: 2.0, tint: true, alpha: false, mode: GRID, sym: 1, hr: [-0.007, 0.0008], ao: 0.5,
    prep: `f[0] = FB(uv, ivec2(80), 3, 0.5, 11u); f[1] = FB(uv, ivec2(6), 4, 0.5, 13u); f[2] = FB(uv, ivec2(128), 2, 0.5, 19u);
  w[0] = WO(uv, ivec2(120), 1.0, 17u);`,
    surf: /* glsl */`
  // stylised running-bond brick 250 x 100 mm (incl. 10 mm mortar), recessed joints, soft arrises
  int row = int(floor(P.y / 0.1));
  float ly = P.y - float(row) * 0.1;
  float bx = P.x - ((row % 2 == 1) ? 0.125 : 0.0);
  int col = int(floor(bx / 0.25));
  float lx = bx - float(col) * 0.25;
  ivec2 bid = wrp(ivec2(col, row), ivec2(8, 20));
  vec2 lp = vec2(lx - 0.125, ly - 0.05);
  float e = -sdRB(lp, vec2(0.125, 0.05), 0.007);
  vec2 pr = edgeProf(e, 0.005, 0.007, 0.0035, 0.0065);
  float inM = pr.y;
  float hid = hf(bid, 3u), hid2 = hf(bid, 5u);
  float sand = n[0], mott = n[1];
  float pit = step(0.9, c[0].z) * (1.0 - aa(0.0022, c[0].x * (2.0 / 120.0)));
  float bulge = (1.0 - pow(lp.x / 0.125, 2.0)) * (1.0 - pow(lp.y / 0.05, 2.0));
  vec3 cb = vec3(0.79) * (1.0 + 0.1 * (hid - 0.5)) * (1.0 + 0.025 * sand + 0.02 * mott) * (1.0 - 0.1 * pit);
  cb *= 1.0 - 0.04 * clamp(1.0 - (e - 0.005) / 0.01, 0.0, 1.0) * (1.0 - inM);
  vec3 mort = vec3(0.9) * (1.0 + 0.05 * n[2]);
  s.alb = mix(cb, mort, inM);
  s.h = pr.x + (0.0005 * bulge * hid2 + 0.00012 * sand - 0.0008 * pit) * (1.0 - inM) + inM * 0.0008 * (pow(clamp(e / 0.005, 0.0, 1.0), 2.0) - 1.0);
  s.rough = mix(0.82 + 0.05 * sand, 0.95, inM);
  s.cav = mix(1.0, 0.72, inM);`,
  },
  {
    name: 'rubber', detail: 0.35, scale: 2.0, tint: true, alpha: false, mode: HEX, sym: 7, hr: [-0.0007, 0.0007], ao: 0.35,
    prep: `f[0] = FB(uv, ivec2(5), 4, 0.5, 71u); w[0] = WO(uv, ivec2(240), 1.0, 61u);`,
    surf: /* glsl */`
  // poured EPDM rubber: ~8 mm bonded granules, sparse light flecks, soft large-scale blotches
  vec4 wc = c[0];
  float gr = smoothstep(0.04, 0.18, wc.y - wc.x);
  float tone = mix(0.78 + 0.08 * fract(wc.z * 3.71), 0.97, step(0.95, wc.z));
  float big = n[0];
  s.alb = vec3(mix(0.7, tone, gr)) * (1.0 + 0.03 * big);
  s.h = 0.00055 * gr * (1.0 - 0.8 * wc.x * wc.x) - 0.0004 * (1.0 - gr) + 0.00008 * big;
  s.rough = 0.9 - 0.04 * gr;`,
  },
  {
    name: 'glasstile', detail: 0.0, scale: 1.2, tint: true, alpha: false, mode: GRID, sym: 7, hr: [-0.004, 0.0018], ao: 0.45,
    prep: `f[0] = FB(uv, ivec2(96), 2, 0.5, 7u);`,
    surf: /* glsl */`
  // 100 mm glossy glass-mosaic tiles: pillowed edges, slight dome + per-tile tilt, 4 mm grout
  ivec2 cell = ivec2(floor(P / 0.1));
  ivec2 cw = wrp(cell, ivec2(12));
  vec2 lp = P - (vec2(cell) * 0.1 + 0.05);
  float e = -sdRB(lp, vec2(0.05), 0.01);
  vec2 pr = edgeProf(e, 0.002, 0.008, 0.002, 0.0036);
  float inG = pr.y;
  float hid = hf(cw, 3u), hid2 = hf(cw, 5u);
  vec2 tilt = hf2(cw, 9u) - 0.5;
  float dome = 1.0 - dot(lp, lp) / 0.005;
  float inner = exp(-pow((e - 0.016) / 0.004, 2.0));
  vec3 col = vec3(0.8) * (1.0 + 0.09 * (hid - 0.5)) * (1.0 + 0.04 * inner);
  vec3 grout = vec3(0.7) * (1.0 + 0.05 * n[0]);
  s.alb = mix(col, grout, inG);
  s.h = pr.x + (0.0007 * dome + dot(tilt, lp) * 0.012 + 0.0001 * inner) * (1.0 - inG);
  s.rough = mix(0.1 + 0.08 * hid2, 0.85, inG);
  s.cav = mix(1.0, 0.65, inG);`,
  },
  {
    // not a surface: neutral micro-surface for close-up crispness, blended in by texlibDetail() (albedo mean 0.5
    // = multiplier 1.0, roughness mean 0.5 = delta 0). Mips fade it to neutral on their own.
    name: 'detail', detail: 0, scale: 0.5, tint: true, alpha: false, mode: PLAIN, sym: 0, hr: [-0.0003, 0.0002], ao: 0.0,
    prep: `f[0] = FB(uv, ivec2(24), 3, 0.5, 3u); f[1] = FB(uv, ivec2(96), 2, 0.5, 5u);
  w[0] = WO(uv, ivec2(150), 1.0, 7u); w[1] = WO(uv, ivec2(40), 0.9, 9u);`,
    surf: /* glsl */`
  vec4 g = c[0];                                   // ~3 mm grains
  float grain = smoothstep(0.05, 0.3, g.y - g.x);
  float tone = fract(g.z * 7.31) - 0.5;
  float pit = step(0.93, c[1].z) * (1.0 - smoothstep(0.0007, 0.0007 + 2.0 * PX, c[1].x * (0.5 / 40.0)));
  float m = 1.0 + 0.14 * tone * grain + 0.06 * n[0] + 0.035 * n[1] - 0.16 * pit;
  s.alb = vec3(0.5 * m);
  s.h = 0.0002 * grain * (1.0 - g.x * g.x) + 0.00006 * n[1] - 0.00025 * pit;
  s.rough = 0.5 + 0.05 * n[0] + 0.04 * tone * grain;`,
  },
  {
    // not a surface: the gelatinous top of wet ink (normal only). Broad soft swells, a finer settling ripple and a
    // few shallow dimples; the level shader tilts the ink's clearcoat with it so reflections break into wet highlights.
    name: 'gel', detail: 0, scale: 1.0, tint: true, alpha: false, mode: PLAIN, sym: 0, hr: [-0.006, 0.006], ao: 0.0,
    prep: `f[0] = FB(uv, ivec2(4), 3, 0.45, 91u); f[1] = FB(uv, ivec2(12), 2, 0.5, 97u); w[0] = WO(uv, ivec2(7), 1.0, 101u);`,
    surf: /* glsl */`
  vec4 wc = c[0];
  float dimple = (1.0 - smoothstep(0.0, 0.22, wc.x)) * step(0.6, wc.z);
  s.h = 0.0034 * n[0] + 0.0009 * n[1] - 0.0012 * dimple * dimple;
  s.alb = vec3(0.5);
  s.rough = 0.5;`,
  },
];

// ---------------------------------------------------------------------------------------------------------------
// Runtime sampling helpers
// ---------------------------------------------------------------------------------------------------------------

export const TEXLIB_GLSL = /* glsl */`
// ---- INKWAVE texlib (see src/world/texlib.js header for the API) ----
#ifndef TEXLIB_INCLUDED
#define TEXLIB_INCLUDED
#define TEXLIB_PLAIN 0
#define TEXLIB_GRID 1
#define TEXLIB_HEX 2
#ifndef TEXLIB_HEX_SCALE
#define TEXLIB_HEX_SCALE 0.5
#endif
struct TexlibSample { vec4 albedo; vec3 normal; vec4 orm; };

uint texlib_pcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
uint texlib_hash(ivec2 p) { return texlib_pcg(uint(p.x) + texlib_pcg(uint(p.y) + 0x9e3779b9u)); }
float texlib_h01(uint h) { return float(h >> 8u) * (1.0 / 16777216.0); }

void texlib_triGrid(vec2 st, out vec3 w, out ivec2 v1, out ivec2 v2, out ivec2 v3) {
  st *= 3.46410162;
  vec2 sk = mat2(1.0, 0.0, -0.57735027, 1.15470054) * st;
  ivec2 b = ivec2(floor(sk));
  vec3 t = vec3(fract(sk), 0.0); t.z = 1.0 - t.x - t.y;
  float s = step(0.0, -t.z), s2 = 2.0 * s - 1.0;
  w = vec3(-t.z * s2, s - t.y * s2, s - t.x * s2);
  int si = int(s);
  v1 = b + ivec2(si, si); v2 = b + ivec2(si, 1 - si); v3 = b + ivec2(1 - si, si);
}
vec2 texlib_hexCentre(ivec2 v) { return mat2(1.0, 0.0, 0.5, 0.8660254) * vec2(v) / (3.46410162 * TEXLIB_HEX_SCALE); }
mat2 texlib_rot(uint h) { float a = texlib_h01(h) * 6.28318531; float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

void texlib_tap(sampler2DArray tA, sampler2DArray tN, sampler2DArray tO, vec2 st, float layer, vec2 gx, vec2 gy, mat2 M,
                out vec4 a, out vec3 n, out float nl, out vec4 o) {
  vec3 p = vec3(st, layer);
  a = textureGrad(tA, p, M * gx, M * gy);
  vec3 nr = textureGrad(tN, p, M * gx, M * gy).xyz * 2.0 - 1.0;
  o = textureGrad(tO, p, M * gx, M * gy);
  nl = length(nr);
  n = vec3(transpose(M) * nr.xy, nr.z);
}

TexlibSample texlibSample(sampler2DArray tA, sampler2DArray tN, sampler2DArray tO, vec2 uv, float layer, int mode, int sym) {
  vec2 gx = dFdx(uv), gy = dFdy(uv);
  // keep the footprint anisotropy within what 16x hardware AF resolves (≤ 12:1): past that, blur instead of alias
  float lx = dot(gx, gx), ly = dot(gy, gy);
  if (lx > ly * 144.0) gy = ly > 1e-20 ? gy * sqrt(lx / (ly * 144.0)) : vec2(-gx.y, gx.x) / 12.0;
  else if (ly > lx * 144.0) gx = lx > 1e-20 ? gx * sqrt(ly / (lx * 144.0)) : vec2(gy.y, -gy.x) / 12.0;
  TexlibSample r;
  vec3 n; float nl;
  if (mode == TEXLIB_HEX) {
    vec3 w; ivec2 v1, v2, v3;
    texlib_triGrid(uv * TEXLIB_HEX_SCALE, w, v1, v2, v3);
    uint h1 = texlib_hash(v1), h2 = texlib_hash(v2), h3 = texlib_hash(v3);
    mat2 R1 = texlib_rot(h1), R2 = texlib_rot(h2), R3 = texlib_rot(h3);
    vec2 c1 = texlib_hexCentre(v1), c2 = texlib_hexCentre(v2), c3 = texlib_hexCentre(v3);
    vec2 o1 = vec2(texlib_h01(texlib_pcg(h1)), texlib_h01(texlib_pcg(h1 + 1u)));
    vec2 o2 = vec2(texlib_h01(texlib_pcg(h2)), texlib_h01(texlib_pcg(h2 + 1u)));
    vec2 o3 = vec2(texlib_h01(texlib_pcg(h3)), texlib_h01(texlib_pcg(h3 + 1u)));
    vec4 a1, a2, a3, q1, q2, q3; vec3 n1, n2, n3; float l1, l2, l3;
    texlib_tap(tA, tN, tO, R1 * (uv - c1) + c1 + o1, layer, gx, gy, R1, a1, n1, l1, q1);
    texlib_tap(tA, tN, tO, R2 * (uv - c2) + c2 + o2, layer, gx, gy, R2, a2, n2, l2, q2);
    texlib_tap(tA, tN, tO, R3 * (uv - c3) + c3 + o3, layer, gx, gy, R3, a3, n3, l3, q3);
    vec3 W = w * w; W *= W; W *= w * w * w;                   // w^7
    W *= mix(vec3(1.0), vec3(q1.a, q2.a, q3.a) + 0.05, 0.6);  // height-aware contrast blend
    W /= max(W.x + W.y + W.z, 1e-6);
    r.albedo = W.x * a1 + W.y * a2 + W.z * a3;
    r.orm = W.x * q1 + W.y * q2 + W.z * q3;
    n = W.x * n1 + W.y * n2 + W.z * n3;
    nl = W.x * l1 + W.y * l2 + W.z * l3;
  } else if (mode == TEXLIB_GRID) {
    uint h = texlib_hash(ivec2(floor(uv))) & uint(sym);
    mat2 M = mat2(1.0);
    if ((h & 4u) != 0u) M = mat2(0.0, 1.0, 1.0, 0.0);
    if ((h & 1u) != 0u) M = mat2(-1.0, 0.0, 0.0, 1.0) * M;
    if ((h & 2u) != 0u) M = mat2(1.0, 0.0, 0.0, -1.0) * M;
    texlib_tap(tA, tN, tO, M * (fract(uv) - 0.5) + 0.5, layer, gx, gy, M, r.albedo, n, nl, r.orm);
  } else {
    texlib_tap(tA, tN, tO, uv, layer, gx, gy, mat2(1.0), r.albedo, n, nl, r.orm);
  }
  // Toksvig: mips average bumps into shorter normals -> widen the lobe instead of sparkling
  float v = max((1.0 - nl) / max(nl, 1e-3) - 0.006, 0.0);
  float a = r.orm.g * r.orm.g;
  r.orm.g = sqrt(sqrt(min(a * a + 2.0 * v, 1.0)));
  r.normal = normalize(vec3(n.xy, max(n.z, 1e-3)));
  return r;
}

mat3 texlibTangentFrame(vec3 eyePos, vec3 surfNormal, vec2 uv) {
  vec3 q0 = dFdx(eyePos), q1 = dFdy(eyePos);
  vec2 st0 = dFdx(uv), st1 = dFdy(uv);
  vec3 N = surfNormal;
  vec3 q1perp = cross(q1, N), q0perp = cross(N, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float sc = det == 0.0 ? 0.0 : inversesqrt(det);
  return mat3(T * sc, B * sc, N);
}
vec3 texlibPerturbNormal(vec3 nTS, vec3 T, vec3 B, vec3 N, float strength) {
  return normalize(T * (nTS.x * strength) + B * (nTS.y * strength) + N * nTS.z);
}
vec3 texlibPerturbNormal(vec3 nTS, mat3 tbn, float strength) {
  return texlibPerturbNormal(nTS, tbn[0], tbn[1], tbn[2], strength);
}

#ifndef TEXLIB_DETAIL_SCALE
#define TEXLIB_DETAIL_SCALE 0.5
#endif
// blends the 'detail' layer into a sample at two rotated scales (no visible period). pMetres = surface coords in
// metres; amount = meta.detail (0 = skip). Albedo x (2 * detail), normal UDN-blended, roughness += delta.
void texlibDetail(inout TexlibSample s, sampler2DArray tA, sampler2DArray tN, sampler2DArray tO, vec2 pMetres, float layer, float amount) {
  vec2 u1 = pMetres / TEXLIB_DETAIL_SCALE;
  vec2 gx = dFdx(u1), gy = dFdy(u1);
  if (amount <= 0.0) return;
  const mat2 R = mat2(0.8660254, 0.5, -0.5, 0.8660254);
  vec2 u2 = R * u1 * 0.61 + vec2(0.37, 0.71);
  vec2 hx = R * gx * 0.61, hy = R * gy * 0.61;
  vec4 a1 = textureGrad(tA, vec3(u1, layer), gx, gy), a2 = textureGrad(tA, vec3(u2, layer), hx, hy);
  vec3 n1 = textureGrad(tN, vec3(u1, layer), gx, gy).xyz * 2.0 - 1.0, n2 = textureGrad(tN, vec3(u2, layer), hx, hy).xyz * 2.0 - 1.0;
  vec4 o1 = textureGrad(tO, vec3(u1, layer), gx, gy), o2 = textureGrad(tO, vec3(u2, layer), hx, hy);
  s.albedo.rgb *= mix(1.0, a1.r + a2.r, amount);
  vec2 dn = (n1.xy + transpose(R) * n2.xy) * 0.7071;
  s.normal = normalize(vec3(s.normal.xy + dn * amount, s.normal.z));
  s.orm.g = clamp(s.orm.g + (o1.g + o2.g - 1.0) * amount, 0.02, 1.0);
}

// screen-space specular AA on the final (perturbed) normal (Tokuyoshi-Kaplanyan / Filament): widens the lobe where
// the normal changes faster than the pixel grid can resolve — kills glints on bevels/rivets at distance.
float texlibSpecularAA(vec3 n, float roughness) {
  vec3 du = dFdx(n), dv = dFdy(n);
  float kernel = min(2.0 * 0.15 * (dot(du, du) + dot(dv, dv)), 0.2);
  float a = roughness * roughness;
  return sqrt(sqrt(clamp(a * a + kernel, 0.0, 1.0)));
}
float texlib_vn(vec2 p) {
  vec2 i = floor(p), f = p - i; vec2 u = f * f * (3.0 - 2.0 * f);
  ivec2 c = ivec2(i);
  float a = texlib_h01(texlib_hash(c)), b = texlib_h01(texlib_hash(c + ivec2(1, 0)));
  float d = texlib_h01(texlib_hash(c + ivec2(0, 1))), e = texlib_h01(texlib_hash(c + ivec2(1, 1)));
  return mix(mix(a, b, u.x), mix(d, e, u.x), u.y);
}
float texlibMacro(vec2 p) {
  float n = 0.62 * texlib_vn(p * 0.085 + 3.7) + 0.38 * texlib_vn(p * 0.29 + 11.3);
  return 0.94 + 0.12 * n;
}
float texlibCoverage(float a, vec2 uv, float texSize) {
  vec2 dx = dFdx(uv) * texSize, dy = dFdy(uv) * texSize;
  float lod = 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8));
  float sharp = clamp((a - 0.5) / max(fwidth(a), 1e-4) + 0.5, 0.0, 1.0);
  // coverage-preserving: as openings fall below the pixel grid the bars thicken until the grate reads solid
  // (as real grating does at a distance / grazing angle) instead of breaking into dotted, shimmering holes
  float far = clamp(a * (1.0 + 1.6 * max(lod, 0.0)), 0.0, 1.0);
  return mix(sharp, far, smoothstep(-0.5, 0.8, lod));
}
#endif
`;

// ---------------------------------------------------------------------------------------------------------------
// Library construction
// ---------------------------------------------------------------------------------------------------------------

export async function createTextureLibrary(renderer, { size = 512 } = {}) {
  const t0 = performance.now();
  const L = MATERIALS.length;
  const aniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());

  // one array target with three colour attachments (albedo sRGB, normal + orm linear), written in one MRT pass
  const out = new THREE.WebGLArrayRenderTarget(size, size, L, {
    count: 3, type: THREE.UnsignedByteType, format: THREE.RGBAFormat, colorSpace: THREE.SRGBColorSpace,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    magFilter: THREE.LinearFilter, minFilter: THREE.LinearMipmapLinearFilter,
    generateMipmaps: true, anisotropy: aniso, depthBuffer: false, stencilBuffer: false,
  });
  for (let k = 1; k < 3; k++) {   // three only makes attachment 0 an array texture; swap the others in
    const t = new THREE.DataArrayTexture(null, size, size, L);
    const t0 = out.texture;
    for (const k2 of ['format', 'type', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'anisotropy', 'generateMipmaps', 'flipY', 'internalFormat']) t[k2] = t0[k2];
    t.colorSpace = THREE.NoColorSpace;
    t.isRenderTargetTexture = true;
    t.renderTarget = out;
    out.textures[k] = t;
  }
  out.textures[0].name = 'texlib.albedo'; out.textures[1].name = 'texlib.normal'; out.textures[2].name = 'texlib.orm';

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const raw = (fs, uniforms) => new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: GEN_VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false,
  });
  // one uber-program for all layers: one driver compile / pipeline instead of twelve (cold start matters)
  const fns = MATERIALS.map((m, i) => `void prep${i}(${PREP_SIG}) {\n  ${m.prep}\n}\nvoid surf${i}(${SURF_SIG}) {${m.surf}\n}`).join('\n');
  const sw = (fn, args) => MATERIALS.map((m, i) => `${i ? 'else ' : ''}if (uMat == ${i}) ${fn}${i}(${args});`).join('\n  ');
  const gen = raw(GEN_COMMON + fns + GEN_MAIN.replace('PREP_SWITCH', sw('prep', 'uv, P, f, w')).replace('SURF_SWITCH', sw('surf', 'uv, P, n, c, s')), {
    uRes: { value: new THREE.Vector2(size, size) }, uScale: { value: 1 }, uMat: { value: 0 }, uOne: { value: 1 },
    uHRange: { value: new THREE.Vector2() }, uAO: { value: 0.5 },
  });
  const scene = new THREE.Scene();
  const quad = new THREE.Mesh(geo, gen); quad.frustumCulled = false; scene.add(quad);
  await renderer.compileAsync(scene, cam);   // async where KHR_parallel_shader_compile exists
  const tCompiled = performance.now();

  const prevRT = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevXR = renderer.xr.enabled;
  renderer.autoClear = false;
  renderer.xr.enabled = false;
  renderer.initRenderTarget(out);
  for (const t of out.textures) t.generateMipmaps = false;   // build the mip chain once, after the last layer

  for (let i = 0; i < L; i++) {
    const m = MATERIALS[i];
    gen.uniforms.uMat.value = i;
    gen.uniforms.uScale.value = m.scale;
    gen.uniforms.uHRange.value.set(m.hr[0], m.hr[1]);
    gen.uniforms.uAO.value = m.ao;
    if (i === L - 1) for (const t of out.textures) t.generateMipmaps = true;
    renderer.setRenderTarget(out, i);
    renderer.render(scene, cam);
  }
  // wait for the GPU so the reported time is honest (one-pixel readback)
  renderer.readRenderTargetPixels(out, 0, 0, 1, 1, new Uint8Array(4), undefined, 2);

  renderer.setRenderTarget(prevRT);
  renderer.autoClear = prevAutoClear;
  renderer.xr.enabled = prevXR;
  gen.dispose();
  geo.dispose();

  const layers = {}, meta = {};
  MATERIALS.forEach((m, i) => {
    layers[m.name] = i;
    meta[m.name] = { scale: m.scale, tint: m.tint, alpha: m.alpha, mode: m.mode, sym: m.sym, detail: m.detail, depth: +(m.hr[1] - m.hr[0]).toFixed(4) };
  });
  const t1 = performance.now();
  return {
    albedo: out.textures[0],
    normal: out.textures[1],
    orm: out.textures[2],
    layers,
    meta,
    names: MATERIALS.map((m) => m.name),
    size,
    stats: { ms: +(t1 - t0).toFixed(1), compileMs: +(tCompiled - t0).toFixed(1), size },
    dispose() { out.dispose(); },
  };
}
