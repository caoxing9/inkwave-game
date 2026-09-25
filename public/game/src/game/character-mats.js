// INKWAVE — squidkid materials. Body materials are per-character (they carry per-character uniforms for
// hurt splotches / invuln flash / special glow) but share one compiled program per kind. Weapon + glass
// materials are shared and cached by colour hex.
//
// Per-vertex authoring contract (see character-geo.js):
//  • cloth : aEx = colour source (CS_* below), aCloth = (part id, material class, param), uv = part coordinates.
//  • skin  : aEx = sub-material (0 skin, 1 nail, 2 inner ear, 3 lip), aHead = unit head direction (face decals).
//  • hair  : aTint (+ lighter / − darker team ink; ≤ −1.5 = "gear" accessory, class = −aTint − 2),
//            colour = strand data (t, suckers, sinA) | cap flag (b ≥ 1.5) | gear rgb (r < 0 → team × g).
//  • weapon plastic: aMat = material class (0 satin, 1 gloss, 2 rubber, 3 metal, 4 lens, 5 LED, 6 print).
import * as THREE from 'three';

const NOISE = /* glsl */`
float iwHash(vec3 p){ p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float iwNoise(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(iwHash(i), iwHash(i + vec3(1,0,0)), f.x), mix(iwHash(i + vec3(0,1,0)), iwHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(iwHash(i + vec3(0,0,1)), iwHash(i + vec3(1,0,1)), f.x), mix(iwHash(i + vec3(0,1,1)), iwHash(i + vec3(1,1,1)), f.x), f.y), f.z); }
float iwFbm(vec3 p){ return 0.56 * iwNoise(p) + 0.29 * iwNoise(p * 2.07 + 7.1) + 0.15 * iwNoise(p * 4.31 + 3.7); }
float iwBand(float x, float a, float b){ float w = max(fwidth(x) * 0.8, 1e-4); return smoothstep(a - w, a + w, x) - smoothstep(b - w, b + w, x); }
float iwHash2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float iwAAw(float d){ return max(fwidth(d), 1e-5); }
// filled SDF (d < 0 inside) and stroke of half-width hw, both antialiased
float iwFill(float d){ float w = iwAAw(d); return 1.0 - smoothstep(-w, w, d); }
float iwStroke(float d, float hw){ float w = iwAAw(d); return 1.0 - smoothstep(hw - w, hw + w, abs(d)); }
// 1 while a pattern of spatial period P (same units as coord) is resolvable (>= ~3 px), fading to 0 when sub-pixel
float iwLod(float coord, float P){ float px = fwidth(coord) / P; return 1.0 - smoothstep(0.22, 0.55, px); }
// dashed stitch along s (period P, duty 0..1)
float iwDash(float s, float P, float duty){ float x = s / P; float f = fract(x); float w = min(max(fwidth(x), 1e-4) * 1.2, 0.3); return smoothstep(0.0, w, f) * (1.0 - smoothstep(duty - w, duty, f)); }
float iwSdBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float iwSdSeg(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
float iwSmin(float a, float b, float k){ float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
`;

// screen-space bump: perturb the view-space shading normal by a scalar height field (metres)
const BUMP = /* glsl */`
vec3 iwBumpN(vec3 n, float h, vec3 pos){
  vec3 dpx = dFdx(pos), dpy = dFdy(pos);
  vec3 r1 = cross(dpy, n), r2 = cross(n, dpx);
  float det = dot(dpx, r1);
  vec3 g = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return abs(det) > 1e-14 ? normalize(abs(det) * n - g) : n;
}
`;

const HURT_FRAG = /* glsl */`
  float iwHurtM = 0.0;
  if (uHurt.w > 0.002) {
    vec3 hp = vBindPos * vec3(10.0, 6.5, 10.0) + vec3(uHurtSeed);
    hp.y += 0.35 * iwNoise(vBindPos * 23.0);
    float n = iwFbm(hp);
    float th = mix(1.0, 0.47, clamp(uHurt.w, 0.0, 1.0));
    float w = max(fwidth(n) * 0.9, 0.004);
    iwHurtM = smoothstep(th - w, th + w, n);
    float rim = smoothstep(th - 0.05, th - w, n) * (1.0 - iwHurtM);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.8, rim * 0.6);
    diffuseColor.rgb = mix(diffuseColor.rgb, uHurt.rgb, iwHurtM);
  }
`;

function inject(shader, o) {
  let v = shader.vertexShader, f = shader.fragmentShader;
  if (o.vPars) v = v.replace('#include <common>', '#include <common>\n' + o.vPars);
  if (o.vBegin) v = v.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + o.vBegin);
  if (o.fPars) f = f.replace('#include <common>', '#include <common>\n' + o.fPars);
  if (o.fColor) f = f.replace('#include <color_fragment>', '#include <color_fragment>\n' + o.fColor);
  if (o.fRough) f = f.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + o.fRough);
  if (o.fMetal) f = f.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + o.fMetal);
  if (o.fNormal) f = f.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + o.fNormal);
  if (o.fEmissive) f = f.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + o.fEmissive);
  if (o.fLights) f = f.replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n' + o.fLights);
  if (o.fAO) f = f.replace('#include <aomap_fragment>', '#include <aomap_fragment>\n' + o.fAO);
  if (o.fOpaque) f = f.replace('#include <opaque_fragment>', o.fOpaque + '\n#include <opaque_fragment>');
  shader.vertexShader = v; shader.fragmentShader = f;
}

/** Per-character uniform bundle (shared by that character's body materials). */
export function makeCharUniforms() {
  return {
    uTeam: { value: new THREE.Color('#ff8a14') },
    uShirt: { value: new THREE.Color('#f3f1ec') },
    uShorts: { value: new THREE.Color('#2a3350') },
    uShoe: { value: new THREE.Color('#2a2d36') },
    uSole: { value: new THREE.Color('#f4f2ec') },
    uSock: { value: new THREE.Color('#f7f7f4') },
    uStrap: { value: new THREE.Color('#33363f') },
    uPattern: { value: 0 },
    uHurt: { value: new THREE.Vector4(0, 0, 0, 0) },
    uHurtSeed: { value: 0 },
    uFlash: { value: new THREE.Color(0, 0, 0) },
    uGlow: { value: new THREE.Color(0, 0, 0) },
    uLook: { value: new THREE.Vector2(0, 0) },
    uIris: { value: new THREE.Color('#ffb21c') },
    uIris2: { value: new THREE.Color('#ff6a00') },
    uTime: { value: 0 },
    uWig: { value: new THREE.Vector3(0.012, 9, 0) }, // amp, freq, unused
    uOpacity: { value: 1 },
    uMouth: { value: new THREE.Vector4(0.75, 1, 0, 0) },
    uFreckle: { value: 0 },
  };
}

const bodyVPars = /* glsl */`
varying vec3 vBindPos;
attribute float aEx;
varying float vEx;
`;
const bodyVBegin = /* glsl */`
vBindPos = position; vEx = aEx;
`;
const bodyFPars = /* glsl */`
uniform vec4 uHurt; uniform float uHurtSeed; uniform vec3 uFlash;
varying vec3 vBindPos; varying float vEx;
${NOISE}
${BUMP}
`;

// ================================================================================================
// SKIN — face decals live in the skin shader: the goggle visor (analytic SDF in the head's az/el
// parametrisation, with a height field for a bevelled, raised lip) and the mouth (smile line / frown /
// open "D" with teeth + tongue) driven by uMouth = (curve, width, open, tilt). Pixel-crisp at any
// distance and zero extra triangles. Sub-materials via aEx: 1 nail, 2 inner ear, 3 knuckle crease.
// ================================================================================================
const FACE_GLSL = /* glsl */`
float iwSmax(float a, float b, float k){ float h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0); return mix(b, a, h) + k * h * (1.0 - h); }
float iwVisorSD(float az, float el){
  float ax = abs(az);
  float lobe = (1.0 - length(vec2((ax - 0.355) / 0.3, (el - 0.15) / 0.29))) * 0.26;
  float bridge = ax < 0.42 ? 0.1 + 0.1 * smoothstep(0.0, 0.36, ax) - abs(el - 0.17) : -1.0;
  float s = (ax - 0.42) / 0.9;
  float wc = 0.16 + 0.2 * pow(clamp(s, 0.0, 1.0), 1.35);
  float wh = 0.205 * pow(clamp(1.0 - s, 0.0, 1.0), 0.8);
  float wing = (s > -0.1 && s <= 1.0) ? wh - abs(el - wc) : -1.0;
  return iwSmax(iwSmax(lobe, bridge, 0.06), wing, 0.07);
}
float iwHairline(float az){ float a = abs(az) / 3.14159265; float h = mix(0.58, 0.3, smoothstep(0.1, 0.42, a)); return mix(h, -0.8, smoothstep(0.5, 0.96, a)); }
`;

export function makeSkinMaterial(u, skinHex) {
  const m = new THREE.MeshPhysicalMaterial({
    color: skinHex, roughness: 0.52, metalness: 0, vertexColors: true,
    sheen: 1, sheenRoughness: 0.55, sheenColor: new THREE.Color('#ffc2a8'),
    clearcoat: 0.06, clearcoatRoughness: 0.45,
  });
  const tone = new THREE.Color(skinHex);
  const lum = tone.r * 0.3 + tone.g * 0.59 + tone.b * 0.11;
  // freckles on the second-lightest tone only (a character trait, not noise on everyone)
  if (u.uFreckle && Math.abs(lum - 0.5) < 0.2 && tone.r > 0.8) u.uFreckle.value = 1;
  m.userData.iwLum = lum;
  m.onBeforeCompile = (shader) => {
    for (const k of ['uHurt', 'uHurtSeed', 'uFlash', 'uMouth', 'uTeam', 'uFreckle']) shader.uniforms[k] = u[k];
    shader.uniforms.uSkinLum = { value: lum };
    inject(shader, {
      vPars: bodyVPars + 'attribute vec3 aHead; varying vec3 vHead;', vBegin: bodyVBegin + 'vHead = aHead;',
      fPars: bodyFPars + 'uniform vec4 uMouth; uniform vec3 uTeam; uniform float uFreckle; uniform float uSkinLum; varying vec3 vHead;' + FACE_GLSL,
      fColor: /* glsl */`
        float iwVisor = 0.0; float iwVisorH = 0.0; float iwHairP = 0.0; float iwH = 0.0; float iwNail = 0.0; float iwMouthIn = 0.0; float iwAO = 1.0;
        float iwSub = floor(vEx + 0.5);
        // subtle skin mottling (breaks the plastic look up close; invisible at range)
        {
          float mott = iwFbm(vBindPos * 60.0);
          diffuseColor.rgb *= 1.0 + (mott - 0.5) * 0.06 * iwLod(vBindPos.y * 60.0, 1.0);
        }
        if (iwSub > 0.5 && iwSub < 1.5) {        // fingernail
          iwNail = 1.0;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.86, 0.84), 0.45);
        } else if (iwSub > 1.5 && iwSub < 2.5) { // inner ear: warmer, darker
          diffuseColor.rgb *= vec3(1.0, 0.8, 0.78);
          iwAO = 0.72;
        }
        {
          float hl = length(vHead);
          if (hl > 0.5) {
            vec3 d = vHead / hl;
            float az = atan(d.x, d.z), el = asin(clamp(d.y, -1.0, 1.0));
            // ---- painted hairline under the cap edge (hides the cap/skin seam), soft shadow just below it
            float hs = el - iwHairline(az) + 0.004;
            float hw = max(fwidth(hs), 1e-4);
            iwHairP = smoothstep(-hw, hw, hs);
            float capShadow = smoothstep(-0.09, 0.0, hs) * (1.0 - iwHairP);
            diffuseColor.rgb *= 1.0 - 0.22 * capShadow;
            diffuseColor.rgb = mix(diffuseColor.rgb, uTeam * 0.55, iwHairP);
            // ---- freckles across the nose bridge + cheeks
            if (uFreckle > 0.5) {
              vec2 fp = vec2(az, el + 0.12) * 42.0;
              vec2 cell = floor(fp); vec2 fr = fract(fp) - 0.5;
              float rnd = iwHash2(cell);
              vec2 off = vec2(iwHash2(cell + 3.1), iwHash2(cell + 7.7)) - 0.5;
              float region = exp(-pow((abs(az) - 0.3) / 0.28, 2.0) - pow((el + 0.14) / 0.1, 2.0));
              float fd = length(fr - off * 0.5) - 0.13 * rnd;
              float fk = iwFill(fd) * step(0.45, rnd) * region;
              diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.78, 0.6, 0.5), fk * 0.7);
            }
            // ---- nose tip: slightly warmer
            float nose = exp(-pow(az / 0.06, 2.0) - pow((el + 0.125) / 0.06, 2.0));
            diffuseColor.rgb *= mix(vec3(1.0), vec3(1.0, 0.9, 0.88), nose * 0.6);
            // ---- visor: raised, bevelled goggle mask
            float sd = iwVisorSD(az, el);
            float w = max(fwidth(sd), 1e-4);
            iwVisor = smoothstep(-w, w, sd);
            iwVisorH = smoothstep(0.0, 0.03, sd);
            vec3 vc = mix(vec3(0.012, 0.014, 0.024), vec3(0.035, 0.042, 0.07), smoothstep(-0.1, 0.5, el));
            float lip = smoothstep(0.034, 0.008, sd) * iwVisor;                  // rim band
            float inner = smoothstep(0.05, 0.036, sd) * smoothstep(0.024, 0.036, sd); // fine inner groove
            vc += vec3(0.075, 0.08, 0.11) * lip;
            vc *= 1.0 - 0.45 * inner;
            diffuseColor.rgb = mix(diffuseColor.rgb, vc, iwVisor);
            // contact shadow on the skin right outside the mask edge
            float ms = smoothstep(-0.035, 0.0, sd) * (1.0 - iwVisor);
            diffuseColor.rgb *= 1.0 - 0.25 * ms;
            iwH += iwVisorH * 0.0022 - inner * 0.0004;
            // ---- mouth
            float curve = uMouth.x, width = uMouth.y, open = uMouth.z, tilt = uMouth.w;
            float ca = cos(tilt), sa = sin(tilt);
            float mx = az * ca + (el + 0.45) * sa;
            float my = -az * sa + (el + 0.45) * ca;
            float mhw = 0.11 * width;
            // closed mouth: tapered smile line with tucked corners and a soft lower-lip shadow
            float xn = mx / max(mhw, 1e-3);
            float ly = curve * 0.05 * (mx / 0.11) * (mx / 0.11);
            float along = max(abs(mx) - mhw, 0.0);
            float dl = length(vec2(along * 1.3, my - ly));
            float taper = mix(1.0, 0.45, smoothstep(0.55, 1.05, abs(xn)));
            float lw = max(fwidth(dl), 1e-4);
            float closedK = 1.0 - smoothstep(0.15, 0.4, open);
            float line = (1.0 - smoothstep(0.0105 * taper - lw, 0.0105 * taper + lw, dl)) * closedK * step(0.001, width);
            // corner tucks (short upward ticks when smiling)
            float tuckK = clamp(curve, 0.0, 1.2) * closedK;
            for (int s = -1; s <= 1; s += 2) {
              vec2 c0 = vec2(float(s) * mhw, ly * 0.0 + curve * 0.05 * (mhw / 0.11) * (mhw / 0.11));
              float dt = iwSdSeg(vec2(mx, my), c0, c0 + vec2(float(s) * 0.018, 0.016));
              line = max(line, (1.0 - smoothstep(0.0055 - lw, 0.0055 + lw, dt)) * tuckK);
            }
            float lowerLip = exp(-pow(mx / (mhw * 0.7), 2.0) - pow((my - ly + 0.03) / 0.014, 2.0)) * closedK;
            diffuseColor.rgb *= 1.0 - 0.08 * lowerLip;
            // open mouth: D shape (flat-ish top, round bottom), throat gradient, teeth, tongue
            float ow = 0.13 * width * (0.85 + 0.15 * open);
            float u2 = mx / max(ow, 1e-3);
            float top = 0.012 + max(curve, 0.0) * 0.03 * u2 * u2;
            float bot = -open * 0.13 * sqrt(max(0.0, 1.0 - u2 * u2)) * (curve < 0.0 ? 0.7 : 1.0) + top;
            float inside = step(abs(u2), 1.0) * smoothstep(bot - lw, bot + lw, my) * (1.0 - smoothstep(top - lw, top + lw, my)) * step(0.02, open);
            float depth = clamp((top - my) / max(top - bot, 1e-3), 0.0, 1.0);
            vec3 mcol = mix(vec3(0.34, 0.05, 0.08), vec3(0.16, 0.02, 0.05), smoothstep(0.1, 0.6, depth) * (1.0 - abs(u2) * 0.5));
            float tongue = 1.0 - smoothstep(0.8, 1.0, length(vec2(u2 / 0.62, (my - bot - 0.022) / 0.034)));
            float groove = exp(-pow(u2 / 0.06, 2.0)) * tongue;
            mcol = mix(mcol, vec3(0.93, 0.42, 0.47) * (1.0 - 0.18 * groove), tongue * step(0.3, open));
            float teeth = smoothstep(top - 0.02 - lw, top - 0.02 + lw, my) * step(abs(u2), 0.78);
            float gap = iwStroke(fract(u2 * 2.2 + 0.5) - 0.5, 0.012) * 0.25;
            mcol = mix(mcol, vec3(0.97, 0.96, 0.94) * (1.0 - gap), teeth);
            float edge = (1.0 - smoothstep(0.0, 0.012, min(my - bot, top - my))) * inside;
            mcol *= 1.0 - 0.35 * edge;
            iwMouthIn = inside;
            diffuseColor.rgb = mix(diffuseColor.rgb, min(vec3(0.24, 0.05, 0.07), diffuseColor.rgb * vec3(0.42, 0.3, 0.3)), line);
            diffuseColor.rgb = mix(diffuseColor.rgb, mcol, inside);
            iwH -= inside * 0.0012 + line * 0.0003;
          }
        }
      ` + HURT_FRAG,
      fRough: 'roughnessFactor = mix(roughnessFactor, 0.16, iwHurtM); roughnessFactor = mix(roughnessFactor, 0.1, iwVisor); roughnessFactor = mix(roughnessFactor, 0.35, iwHairP); roughnessFactor = mix(roughnessFactor, 0.22, iwNail); roughnessFactor = mix(roughnessFactor, 0.3, iwMouthIn);',
      fNormal: 'normal = iwBumpN(normal, iwH, -vViewPosition);',
      fEmissive: 'totalEmissiveRadiance += uFlash;',
      fLights: /* glsl */`
        #ifdef USE_CLEARCOAT
          material.clearcoat = mix(material.clearcoat, 1.0, max(iwVisor, iwNail * 0.6));
          material.clearcoatRoughness = mix(material.clearcoatRoughness, 0.03, iwVisor);
        #endif
        #ifdef USE_SHEEN
          material.sheenColor *= (1.0 - iwVisor) * (1.0 - iwHairP) * mix(0.55, 0.3, uSkinLum);
        #endif`,
      fAO: 'reflectedLight.indirectDiffuse *= iwAO;',
    });
    shader.fragmentShader = shader.fragmentShader.replace('#include <clearcoat_normal_fragment_maps>', '#include <clearcoat_normal_fragment_maps>\n clearcoatNormal = normal;');
  };
  m.customProgramCacheKey = () => 'iw-skin3';
  return m;
}

// ================================================================================================
// CLOTH — tee, shorts, socks, sneakers, tank harness. One program; per-vertex colour source (aEx),
// part id + material class (aCloth.xy) and part coordinates (uv) drive seams, stitching, graphics,
// ribbing, weave micro-normals, tread and per-class roughness / metalness / sheen / clearcoat.
// ================================================================================================
// colour sources (aEx)
export const CS = { white: 0, team: 1, shirt: 2, shorts: 3, shoe: 4, sock: 5, sole: 6, strap: 7, shoe2: 8, outsole: 9, metal: 10, darkPlastic: 11, lace: 12, teamDark: 13, trim: 14 };
// material classes (aCloth.y)
export const MC = { jersey: 0, twill: 1, rib: 2, leather: 3, foam: 4, rubber: 5, plastic: 6, metal: 7, webbing: 8, mesh: 9, lace: 10, padding: 11, print: 12 };
// part ids (aCloth.x)
export const PART = { none: 0, tee: 1, sleeve: 2, collar: 3, shorts: 4, shortLeg: 5, sock: 6, upper: 7, midsole: 8, outsole: 9, strap: 10, tongue: 11, tankCap: 12, gauge: 13, hem: 14, cuff: 15, cord: 16, collarPad: 17, plate: 18, heelTab: 19, toeCap: 20 };

const CLOTH_GLSL = /* glsl */`
uniform vec3 uTeam; uniform vec3 uShirt; uniform vec3 uShorts; uniform vec3 uShoe; uniform vec3 uSole; uniform vec3 uSock; uniform vec3 uStrap; uniform float uPattern;
varying vec3 vCloth; varying vec2 vIwUv;
float iwLum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 iwContrast(vec3 c){ return iwLum(c) > 0.42 ? c * 0.74 : c * 1.55 + 0.05; }
// ---- tee graphics -------------------------------------------------------------------------------
float iwShirtPattern(vec3 p) {
  float ax = abs(p.x);
  float m = 0.0;
  if (uPattern < 0.5) {            // ringer: no body pattern (trim + big emblem)
    m = 0.0;
  } else if (uPattern < 1.5) {     // double pinstripe
    m = iwBand(p.y, 0.842, 0.852) + iwBand(p.y, 0.866, 0.876);
  } else if (uPattern < 2.5) {     // raglan sleeves + side panel
    float sleeve = smoothstep(0.108, 0.115, ax) * step(0.86, p.y);
    m = max(sleeve, iwBand(ax, 0.098, 0.2) * step(p.y, 0.86) * step(0.74, p.y) * step(abs(p.z + 0.012), 0.05));
  } else {                         // chevron + hem band
    float y0 = 0.925 - 0.55 * ax;
    m = iwBand(p.y - y0, -0.022, 0.0) * step(0.0, p.z);
    m = max(m, iwBand(p.y, 0.726, 0.738));
  }
  return clamp(m, 0.0, 1.0);
}
// squid badge: ink splat with a white squid glyph; returns (splat coverage, glyph coverage)
vec2 iwEmblem(vec2 q, float R) {
  float a = atan(q.y, q.x); float r = length(q);
  float wob = 1.0 + 0.1 * sin(5.0 * a + 0.6) + 0.06 * sin(9.0 * a + 2.1) + 0.035 * sin(14.0 * a + 1.0);
  float splat = r - R * wob;
  splat = min(splat, length(q - vec2(R * 1.18, R * 0.62)) - R * 0.13);
  splat = min(splat, length(q - vec2(-R * 1.12, -R * 0.7)) - R * 0.1);
  splat = min(splat, length(q - vec2(R * 0.5, -R * 1.22)) - R * 0.08);
  // glyph: one silhouette — arrowhead mantle with swept fins flowing into a tall body, low oval eyes, four tentacles
  vec2 g = q / R;
  float fins = max(abs(g.x) * 1.02 + (g.y - 0.7) * 0.95, -(g.y - 0.22));
  float body = iwSdBox(g - vec2(0.0, 0.06), vec2(0.17, 0.3), 0.15);
  float glyph = iwSmin(fins, body, 0.08);
  float tent = 1e3;
  for (int i = 0; i < 4; i++) {
    float fi = float(i) - 1.5;
    vec2 tq = g - vec2(fi * 0.1, -0.2);
    tq.x -= fi * 0.1 * smoothstep(0.0, -0.3, tq.y) + 0.03 * sin(tq.y * 13.0 + fi) * smoothstep(-0.05, -0.3, tq.y);
    float w = mix(0.052, 0.03, smoothstep(-0.02, -0.3, tq.y));
    tent = min(tent, iwSdBox(tq - vec2(0.0, -0.15), vec2(w, 0.15), 0.028));
  }
  glyph = iwSmin(glyph, tent, 0.05);
  vec2 e1 = (g - vec2(0.075, 0.0)) / vec2(0.04, 0.062), e2 = (g - vec2(-0.075, 0.0)) / vec2(0.04, 0.062);
  float eyes = (min(length(e1), length(e2)) - 1.0) * 0.04;
  glyph = max(glyph, -eyes);
  return vec2(iwFill(splat), iwFill(glyph * R));
}
`;

export function makeClothMaterial(u) {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.82, metalness: 0, vertexColors: true,
    sheen: 1, sheenRoughness: 0.6, sheenColor: new THREE.Color(1, 1, 1), clearcoat: 1, clearcoatRoughness: 0.3,
  });
  m.onBeforeCompile = (shader) => {
    for (const k of ['uHurt', 'uHurtSeed', 'uFlash', 'uTeam', 'uShirt', 'uShorts', 'uShoe', 'uSole', 'uSock', 'uStrap', 'uPattern']) shader.uniforms[k] = u[k];
    inject(shader, {
      vPars: bodyVPars + 'attribute vec3 aCloth; varying vec3 vCloth; varying vec2 vIwUv;',
      vBegin: bodyVBegin + 'vCloth = aCloth; vIwUv = uv;',
      fPars: bodyFPars + CLOTH_GLSL,
      fColor: /* glsl */`
        float iwH = 0.0; float iwAO = 1.0; float iwCls = floor(vCloth.y + 0.5); float iwPart = floor(vCloth.x + 0.5);
        float iwGloss = 0.0; float iwShine = 0.0; // extra clearcoat / sheen tweaks from decorations
        {
          float slot = floor(vEx + 0.5);
          vec3 p = vBindPos; vec2 uv = vIwUv;
          vec3 base = vec3(1.0);
          if (slot == 1.0) base = uTeam;
          else if (slot == 2.0) base = mix(uShirt, uTeam, iwShirtPattern(p));
          else if (slot == 3.0) base = uShorts;
          else if (slot == 4.0) base = uShoe;
          else if (slot == 5.0) base = uSock;
          else if (slot == 6.0) base = uSole;
          else if (slot == 7.0) base = uStrap;
          else if (slot == 8.0) base = iwContrast(uShoe);
          else if (slot == 9.0) base = mix(uSole * 0.3 + vec3(0.035), vec3(0.09, 0.09, 0.1), 0.35);
          else if (slot == 10.0) base = vec3(0.78, 0.8, 0.84);
          else if (slot == 11.0) base = uStrap * 0.55 + vec3(0.02);
          else if (slot == 12.0) base = mix(uSock, vec3(0.96), 0.6);
          else if (slot == 13.0) base = uTeam * 0.62;
          else if (slot == 14.0) base = uPattern < 0.5 || uPattern > 2.5 ? uTeam : iwContrast(uShirt);

          // ---------------- part decorations ----------------
          if (iwPart == 1.0) { // TEE body: uv = (theta/2pi, y)
            float circ = 0.68;
            float th = uv.x;
            // side seams (x = +-90 deg) with twin stitching
            for (int s = 0; s < 2; s++) {
              float c = s == 0 ? 0.25 : 0.75;
              float dx = (th - c) * circ;
              float seam = iwStroke(dx, 0.0008);
              iwH -= 0.0005 * exp(-pow(dx / 0.0016, 2.0));
              float st = iwStroke(abs(dx) - 0.004, 0.0005) * iwDash(p.y, 0.0055, 0.6);
              base *= 1.0 - 0.12 * seam;
              base = mix(base, base * 0.8, st * iwLod(p.y, 0.0055));
              iwH += 0.00025 * st;
            }
            // double-needle hem stitching + hem fold
            float hy = p.y - vCloth.z;
            float st2 = (iwStroke(hy - 0.013, 0.0005) + iwStroke(hy - 0.019, 0.0005)) * iwDash(th * circ, 0.0055, 0.62);
            base = mix(base, base * 0.8, st2 * iwLod(th * circ, 0.0055));
            iwH += 0.0003 * st2 - 0.0006 * exp(-pow((hy - 0.024) / 0.002, 2.0));
            // gentle drape folds toward the hem + fabric slack at the waist
            float drape = sin(th * 6.2831 * 7.0 + 1.3 * sin(th * 6.2831 * 3.0)) * smoothstep(0.8, 0.705, p.y);
            iwH += 0.0016 * drape;
            iwH += 0.0009 * sin(p.y * 180.0 + 3.0 * sin(th * 25.0)) * smoothstep(0.8, 0.76, p.y) * smoothstep(0.7, 0.74, p.y);
            // chest emblem (pattern-dependent placement)
            if (p.z > 0.0) {
              vec2 q; float R; float on = 1.0;
              if (uPattern < 0.5) { q = vec2(p.x, p.y - 0.826); R = 0.038; }
              else if (uPattern < 1.5) { q = vec2(p.x, p.y - 0.927); R = 0.0135; }
              else if (uPattern < 2.5) { q = vec2(p.x, p.y - 0.818); R = 0.032; }
              else { q = vec2(p.x, p.y - 0.8); R = 0.028; }
              vec2 e = iwEmblem(q, R) * on;
              vec3 ink = uTeam;
              base = mix(base, ink, e.x);
              base = mix(base, uShirt * 1.02 + 0.02, e.y * e.x);
              iwH += 0.00018 * e.x;             // screen print sits slightly proud
              iwShine += 0.35 * e.x;            // plastisol print: a touch glossier
            }
            // lower-back print (visible around the tank from the gameplay camera)
            if (p.z < 0.0 && uPattern > 0.5) {
              float band = iwBand(p.y, 0.735, 0.748) * step(0.06, abs(p.x));
              base = mix(base, uTeam, band * 0.9);
            }
            // tank-strap pressure shading on the shoulders (strap sits on top)
            iwAO *= 1.0 - 0.18 * exp(-pow((abs(p.x) - 0.075) / 0.018, 2.0)) * smoothstep(0.9, 0.98, p.y);
          } else if (iwPart == 2.0) { // SLEEVE: uv = (theta, s along from shoulder)
            float s = uv.y, L = vCloth.z;
            float cuff = smoothstep(L - 0.02, L - 0.018, s);
            base = mix(base, slot == 2.0 ? (uPattern < 0.5 || uPattern > 2.5 ? uTeam : iwContrast(uShirt)) : base, cuff);
            float circ = 0.3;
            float st = iwStroke(s - (L - 0.024), 0.0005) * iwDash(uv.x * circ, 0.005, 0.6);
            float st2 = iwStroke(s - 0.012, 0.0005) * iwDash(uv.x * circ, 0.005, 0.6);
            base = mix(base, base * 0.78, (st + st2) * iwLod(uv.x * circ, 0.005));
            iwH += 0.0003 * (st + st2);
            // rib on the cuff
            float rib = sin(uv.x * 6.2831 * 70.0);
            iwH += cuff * 0.00035 * rib * iwLod(uv.x * circ, circ / 70.0);
            // crease folds at the armpit side
            iwH += 0.0012 * sin(uv.x * 6.2831 * 3.0 + s * 60.0) * smoothstep(0.03, 0.0, s);
          } else if (iwPart == 3.0) { // COLLAR rib: uv = (theta, across)
            float rib = sin(uv.x * 6.2831 * 90.0);
            iwH += 0.0004 * rib * iwLod(uv.x * 0.3, 0.3 / 90.0);
            iwAO *= mix(0.8, 1.0, smoothstep(0.0, 0.35, uv.y));
          } else if (iwPart == 4.0 || iwPart == 5.0) { // SHORTS: uv = (theta, y | s)
            float circ = iwPart == 4.0 ? 0.66 : 0.46;
            float th = uv.x;
            // side seams + a team side stripe on some outfits
            float dx0 = (th - 0.25) * circ, dx1 = (th - 0.75) * circ;
            float dxs = iwPart == 4.0 ? min(abs(dx0), abs(dx1)) : abs(dx0);   // legs: outer seam only (0.75 = inseam)
            iwH -= 0.0005 * exp(-pow(dxs / 0.0016, 2.0));
            float stripe = (uPattern > 0.5 && uPattern < 2.5) ? iwStroke(dxs, 0.0065) : 0.0;
            base = mix(base, uTeam, stripe);
            float ss = iwStroke(dxs - 0.0045, 0.00045) * iwDash(p.y, 0.005, 0.6);
            base = mix(base, base * 0.75 + 0.02, ss * iwLod(p.y, 0.005));
            if (iwPart == 4.0) {
              vec2 f = vec2(p.x, p.y);
              // front: fly J-stitch + slant pocket openings
              if (p.z > 0.0) {
                float fly = iwSdSeg(f, vec2(0.012, 0.745), vec2(0.012, 0.64));
                fly = min(fly, iwSdSeg(f, vec2(0.012, 0.64), vec2(0.0, 0.625)));
                float fs = iwStroke(fly, 0.0005) * iwDash(p.y + p.x, 0.005, 0.6);
                base = mix(base, base * 0.72 + 0.02, fs * iwLod(p.y, 0.005));
                iwH -= 0.0006 * exp(-pow(abs(p.x) / 0.0018, 2.0)) * step(0.63, p.y);
                for (int s = -1; s <= 1; s += 2) {
                  float sx = float(s);
                  float pk = iwSdSeg(f, vec2(sx * 0.062, 0.752), vec2(sx * 0.112, 0.668));
                  iwH -= 0.0009 * exp(-pow(pk / 0.0018, 2.0));
                  float ps = iwStroke(pk - 0.004, 0.00045) * iwDash(p.y, 0.005, 0.6);
                  base = mix(base, base * 0.72 + 0.02, ps * iwLod(p.y, 0.005));
                  iwAO *= 1.0 - 0.25 * exp(-pow(pk / 0.003, 2.0));
                }
              } else {
                // back patch pockets with a little team label on the right one
                for (int s = -1; s <= 1; s += 2) {
                  float sx = float(s);
                  float pb = iwSdBox(f - vec2(sx * 0.058, 0.668), vec2(0.036, 0.04), 0.01);
                  iwH += 0.0008 * (1.0 - smoothstep(-0.002, 0.0015, pb));
                  float ps = (iwStroke(pb + 0.0035, 0.00045)) * iwDash(p.x + p.y, 0.005, 0.6);
                  base = mix(base, base * 0.72 + 0.02, ps * iwLod(p.y, 0.005));
                  iwAO *= 1.0 - 0.3 * exp(-pow(pb / 0.0022, 2.0)) * step(0.0, pb);
                  if (s < 0) { float lab = iwSdBox(f - vec2(sx * 0.03, 0.692), vec2(0.006, 0.012), 0.002); base = mix(base, uTeam, iwFill(lab)); }
                }
                // seat seam
                iwH -= 0.0006 * exp(-pow(p.x / 0.0017, 2.0));
              }
              // waistband stitch (mostly under the tee hem)
              float ws = iwStroke(p.y - 0.735, 0.0005) * iwDash(th * circ, 0.005, 0.6);
              base = mix(base, base * 0.75, ws);
            } else {
              // leg: inseam
              float dxi = abs((th - 0.75) * circ);
              iwH -= 0.0004 * exp(-pow(dxi / 0.0015, 2.0));
              // hem stitch above the cuff
              float L = vCloth.z;
              float hs = iwStroke(uv.y - (L - 0.02), 0.00045) * iwDash(th * circ, 0.005, 0.6);
              base = mix(base, base * 0.72 + 0.02, hs * iwLod(th * circ, 0.005));
              // relaxed folds
              iwH += 0.0013 * sin(th * 6.2831 * 5.0 + uv.y * 30.0) * smoothstep(0.02, 0.1, uv.y);
            }
          } else if (iwPart == 6.0) { // SOCK: uv = (theta, s from top)
            float rib = sin(uv.x * 6.2831 * 56.0);
            iwH += 0.00045 * rib * iwLod(uv.x * 0.22, 0.22 / 56.0);
            float s = uv.y;
            float stripes = iwBand(s, 0.018, 0.026) + iwBand(s, 0.033, 0.041);
            base = mix(base, uTeam, stripes);
            iwH += 0.0012 * sin(s * 190.0 + uv.x * 18.0) * smoothstep(0.05, 0.1, s) * smoothstep(0.14, 0.1, s); // scrunch
          } else if (iwPart == 7.0 || iwPart == 20.0) { // SHOE UPPER: uv = (phi/2pi from toe, t sole->collar); p = bind pos
            float phi = uv.x, t = uv.y;
            float lat = vCloth.z; // +1 lateral side is +x for the left shoe
            float front = cos(phi * 6.2831);   // 1 at the toe, -1 at the heel
            float side = sin(phi * 6.2831);    // +-1 at the sides
            // overlay panels: toe cap + heel counter in the contrast colour, stitched edges
            float toeCapD = (0.62 - front) - 0.18 * t;           // < 0 inside
            float heelD = (front + 0.55) + 0.25 * (t - 0.2);     // < 0 inside
            vec3 c2 = iwContrast(uShoe);
            float toeM = iwFill(toeCapD * 0.05), heelM = iwFill(heelD * 0.05);
            base = mix(base, c2, max(toeM, heelM));
            float edgeS = iwStroke(toeCapD * 0.05 + 0.0025, 0.0004) + iwStroke(heelD * 0.05 + 0.0025, 0.0004);
            base = mix(base, base * 0.7, edgeS * iwDash(phi * 0.62, 0.004, 0.62) * iwLod(phi * 0.62, 0.004));
            iwH += 0.0006 * (toeM + heelM) - 0.0004 * (iwStroke(toeCapD * 0.05, 0.0006) + iwStroke(heelD * 0.05, 0.0006));
            // side logo: a team-colour wave stripe (both sides)
            float wx = front * 0.5 + 0.12;                       // along the shoe
            float wy = t - 0.42 - 0.12 * sin(wx * 9.0);
            float logo = step(0.2, abs(side)) * iwFill((abs(wy) - 0.075 * (1.0 - smoothstep(-0.2, 0.45, abs(wx - 0.06)))) * 0.06);
            base = mix(base, uTeam, logo);
            iwH += 0.00045 * logo;
            iwShine += 0.5 * logo;
            // perforations on the toe box (vamp top)
            float perfZ = step(0.55, front) * step(0.3, t);
            vec2 pp = vec2(p.x, p.z) * 260.0; vec2 pc = fract(pp) - 0.5;
            float perf = iwFill(length(pc) - 0.18) * perfZ * (1.0 - toeM) * iwLod(p.z * 260.0, 1.0);
            iwAO *= 1.0 - 0.5 * perf; iwH -= 0.0002 * perf;
            // leather grain
            iwH += 0.00012 * (iwNoise(p * 900.0) - 0.5) * iwLod(p.z * 900.0, 1.0);
            // creasing across the vamp
            iwH += 0.0005 * sin(t * 70.0) * smoothstep(0.2, 0.42, front) * smoothstep(0.78, 0.55, front) * smoothstep(0.3, 0.45, t) * smoothstep(0.9, 0.7, t);
            iwAO *= mix(0.72, 1.0, smoothstep(0.0, 0.16, t));   // contact darkening at the sole line
          } else if (iwPart == 8.0) { // MIDSOLE: uv = (phi, h 0..1)
            float phi = uv.x, h = uv.y;
            float front = cos(phi * 6.2831);
            // sculpted groove line + team accent pinstripe
            iwH -= 0.0009 * exp(-pow((h - 0.46 - 0.12 * front) / 0.07, 2.0));
            float pin = iwStroke(h - 0.72, 0.06) * step(abs(front), 0.95);
            base = mix(base, uTeam, pin * 0.95);
            // heel window (team) on both sides
            float side = sin(phi * 6.2831);
            float win = iwSdBox(vec2(front + 0.62, h - 0.4), vec2(0.18, 0.2), 0.09);
            float wm = iwFill(win * 0.05) * step(0.3, abs(side));
            base = mix(base, uTeam * 0.85, wm);
            iwH -= 0.0006 * wm; iwShine += wm;
            // foam micro texture
            iwH += 0.0001 * (iwNoise(p * 700.0) - 0.5) * iwLod(p.z * 700.0, 1.0);
          } else if (iwPart == 9.0) { // OUTSOLE: uv = foot-local (x, z) ; tread on the bottom
            vec2 f = uv;
            float herr = abs(fract(f.y * 55.0 + abs(f.x) * 22.0) - 0.5);
            float lug = smoothstep(0.18, 0.26, herr);
            float edgeZone = step(0.5, vCloth.z);
            iwH += 0.0012 * lug * (1.0 - edgeZone) * iwLod(f.y * 55.0, 1.0);
            iwAO *= mix(0.6, 1.0, lug);
            // siping on the side wall
            iwH += 0.0005 * edgeZone * step(0.5, fract(atan(f.x, f.y) * 12.0));
          } else if (iwPart == 10.0) { // STRAP webbing: uv = (along m, across -1..1)
            float edge = abs(uv.y);
            float st = iwStroke(edge - 0.72, 0.035) * iwDash(uv.x, 0.005, 0.62);
            base = mix(base, base * 0.6 + 0.06, st * iwLod(uv.x, 0.005));
            iwH += 0.00025 * st;
            iwAO *= mix(1.0, 0.8, smoothstep(0.8, 1.0, edge));
          } else if (iwPart == 11.0) { // TONGUE: uv = (across -1..1, along 0..1); team tab + logo at the top
            float tab = smoothstep(0.78, 0.8, uv.y);
            base = mix(base, uTeam, tab);
            vec2 e = iwEmblem(vec2(uv.x * 0.018, (uv.y - 0.9) * 0.02), 0.0065);
            base = mix(base, vec3(0.97), e.x * tab);
            float st = iwStroke(abs(uv.x) - 0.82, 0.03) * iwDash(uv.y * 0.05, 0.004, 0.6);
            base = mix(base, base * 0.7, st);
            vec2 mp = vec2(uv.x * 0.02, uv.y * 0.05) * 700.0; // mesh
            float mh = iwFill(length(fract(mp) - 0.5) - 0.2) * (1.0 - tab) * iwLod(uv.y * 0.05 * 700.0, 1.0);
            iwAO *= 1.0 - 0.35 * mh;
          } else if (iwPart == 12.0) { // TANK CAP: uv = (theta, h); knurled grip band
            float kn = sin(uv.x * 6.2831 * 48.0);
            float band = step(0.18, uv.y) * step(uv.y, 0.82);
            iwH += 0.0005 * kn * band * iwLod(uv.x * 0.42, 0.42 / 48.0);
          } else if (iwPart == 13.0) { // GAUGE face: uv = polar (angle 0..1, r 0..1)
            float a = uv.x, r = uv.y;
            vec3 face = vec3(0.95, 0.94, 0.9);
            float ticks = iwStroke(fract(a * 24.0) - 0.5, 0.06) * step(0.72, r) * step(r, 0.9) * step(0.1, a) * step(a, 0.9);
            float red = step(0.72, r) * step(r, 0.9) * step(0.78, a) * step(a, 0.9);
            face = mix(face, vec3(0.1), ticks);
            face = mix(face, vec3(0.85, 0.15, 0.12), red);
            base = mix(face, vec3(0.05), smoothstep(0.93, 0.97, r));
          } else if (iwPart == 15.0) { // shorts CUFF: rolled hem, rib-less twill + stitch
            float st = iwStroke(uv.y - 0.5, 0.05) * iwDash(uv.x * 0.46, 0.005, 0.6);
            base = mix(base, base * 0.75, st);
          } else if (iwPart == 17.0) { // COLLAR PAD: soft quilting lines
            iwH += 0.0005 * sin(uv.x * 6.2831 * 14.0);
          } else if (iwPart == 18.0) { // PLATE: quilted back pad
            vec2 q = vec2(uv.x, uv.y) * 38.0;
            float quilt = iwStroke(fract(q.x + q.y) - 0.5, 0.03) + iwStroke(fract(q.x - q.y) - 0.5, 0.03);
            iwH -= 0.0004 * quilt; iwAO *= 1.0 - 0.18 * quilt;
          } else if (iwPart == 16.0) { // drawcord: twisted
            iwH += 0.0003 * sin(uv.x * 900.0 + uv.y * 6.2831 * 3.0);
          }

          // ---------------- material-class micro detail ----------------
          if (iwCls == 0.0) {        // jersey knit: fine interlocked loops
            vec3 q = p * 1100.0;
            float k = sin(q.x + q.z) * sin(q.y * 1.4);
            iwH += 0.00006 * k * iwLod(p.y * 1100.0, 6.2831);
          } else if (iwCls == 1.0) { // twill: diagonal wales
            float k = sin((p.y * 0.9 + (p.x + p.z) * 0.6) * 1500.0);
            iwH += 0.00007 * k * iwLod(p.y * 1500.0, 6.2831);
          } else if (iwCls == 8.0) { // webbing: cross ribs
            float k = sin(uv.x * 2600.0);
            iwH += 0.00004 * k * iwLod(uv.x * 2600.0, 6.2831);
          } else if (iwCls == 10.0) { // lace braid
            iwH += 0.00012 * sin(uv.x * 1800.0) * iwLod(uv.x * 1800.0, 6.2831);
          }
          diffuseColor.rgb *= base;
        }
      ` + HURT_FRAG,
      fRough: /* glsl */`
        {
          float r = 0.84;
          if (iwCls == 1.0) r = 0.8; else if (iwCls == 2.0) r = 0.86; else if (iwCls == 3.0) r = 0.46; else if (iwCls == 4.0) r = 0.62;
          else if (iwCls == 5.0) r = 0.86; else if (iwCls == 6.0) r = 0.3; else if (iwCls == 7.0) r = 0.28; else if (iwCls == 8.0) r = 0.7;
          else if (iwCls == 9.0) r = 0.74; else if (iwCls == 10.0) r = 0.8; else if (iwCls == 11.0) r = 0.78; else if (iwCls == 12.0) r = 0.5;
          roughnessFactor = mix(r, r * 0.55, clamp(iwShine, 0.0, 1.0));
          roughnessFactor = mix(roughnessFactor, 0.16, iwHurtM);
        }
      `,
      fMetal: 'metalnessFactor = iwCls == 7.0 ? 1.0 : 0.0;',
      fNormal: 'normal = iwBumpN(normal, iwH, -vViewPosition);',
      fEmissive: 'totalEmissiveRadiance += uFlash;',
      fLights: /* glsl */`
        {
          float cc = 0.0, ccr = 0.3, sh = 0.0, shr = 0.6;
          if (iwCls == 0.0) { sh = 0.55; shr = 0.55; }        // jersey
          else if (iwCls == 1.0) { sh = 0.35; shr = 0.5; }    // twill
          else if (iwCls == 2.0) { sh = 0.6; shr = 0.45; }    // rib knit
          else if (iwCls == 3.0) { cc = 0.35; ccr = 0.28; sh = 0.1; }
          else if (iwCls == 4.0) { cc = 0.05; ccr = 0.5; }
          else if (iwCls == 6.0) { cc = 1.0; ccr = 0.12; }
          else if (iwCls == 7.0) { cc = 0.4; ccr = 0.15; }
          else if (iwCls == 8.0) { sh = 0.45; shr = 0.4; }
          else if (iwCls == 9.0) { sh = 0.4; shr = 0.4; }
          else if (iwCls == 10.0) { sh = 0.5; shr = 0.4; }
          else if (iwCls == 11.0) { sh = 0.7; shr = 0.35; }
          cc = max(cc, iwShine * 0.6); ccr = mix(ccr, 0.15, clamp(iwShine, 0.0, 1.0));
          cc = mix(cc, 1.0, iwHurtM);
          #ifdef USE_CLEARCOAT
            material.clearcoat = cc; material.clearcoatRoughness = max(ccr, 0.06);
          #endif
          #ifdef USE_SHEEN
            material.sheenColor = mix(vec3(1.0), diffuseColor.rgb * 1.3 + 0.12, 0.6) * sh * (1.0 - iwHurtM);
            material.sheenRoughness = shr;
          #endif
        }
      `,
      fAO: 'reflectedLight.indirectDiffuse *= iwAO; reflectedLight.directDiffuse *= mix(1.0, iwAO, 0.5);',
    });
  };
  m.customProgramCacheKey = () => 'iw-cloth3';
  return m;
}

// ================================================================================================
// HAIR — glossy team-ink tentacles. Strands: colour = (t, suckers, sin(angle)), uv = (distance, cos(angle)).
// Cap: colour.b >= 1.5, uv = (az, el) → bundle grooves radiating from the crown. Gear accessories
// (aTint <= -1.5): colour = rgb (r < 0 → team × g), class = -aTint - 2 (0 plastic, 1 metal, 2 fabric, 3 rubber).
// ================================================================================================
export function makeHairMaterial(u) {
  const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08, sheen: 1, sheenRoughness: 0.4, sheenColor: new THREE.Color(1, 1, 1) });
  m.onBeforeCompile = (shader) => {
    for (const k of ['uHurt', 'uHurtSeed', 'uFlash', 'uTeam', 'uGlow', 'uShirt', 'uShorts', 'uStrap']) shader.uniforms[k] = u[k];
    inject(shader, {
      vPars: `varying vec3 vBindPos; attribute float aTint; varying float vTint; varying vec4 vStrand; varying float vSinA; varying vec3 vGearCol;
        #ifndef USE_COLOR
        attribute vec3 color;
        #endif`,
      vBegin: 'vBindPos = position; vTint = aTint; vStrand = vec4(color.r, color.g, uv.x, uv.y); vSinA = color.b * 2.0 - 1.0; vGearCol = color;',
      fPars: bodyFPars.replace('varying float vEx;', '') + 'uniform vec3 uTeam; uniform vec3 uGlow; uniform vec3 uShirt; uniform vec3 uShorts; uniform vec3 uStrap; varying float vTint; varying vec4 vStrand; varying float vSinA; varying vec3 vGearCol;',
      fColor: /* glsl */`
        float iwSuck = 0.0; float iwGear = 0.0; float iwGearCls = 0.0; float iwH = 0.0; float iwTipK = 0.0; float iwAO = 1.0;
        {
          vec3 tc = uTeam;
          float lum = dot(tc, vec3(0.299, 0.587, 0.114));
          vec3 light = mix(tc, vec3(1.0), 0.55);
          vec3 dark = tc * mix(1.0, 0.45, clamp(lum * 1.4, 0.0, 1.0));
          if (vTint <= -1.5) {
            // ---------------- gear accessory ----------------
            iwGear = 1.0; iwGearCls = floor(-vTint - 2.0 + 0.5);
            // colour code in r: >= 0 literal rgb; -1 team, -2 shirt, -3 strap, -4 shorts (each × g)
            vec3 gc = vGearCol;
            if (gc.r < -0.5) { float code = floor(-gc.r + 0.5); gc = (code == 1.0 ? tc : code == 2.0 ? uShirt : code == 3.0 ? uStrap : uShorts) * gc.g; }
            diffuseColor.rgb = gc;
            if (iwGearCls == 2.0) { // terry / knit fabric
              iwH += 0.00018 * iwNoise(vBindPos * 1400.0) * iwLod(vBindPos.y * 1400.0, 1.0);
            }
          } else if (vGearCol.b >= 1.5) {
            // ---------------- scalp cap: tentacle bundles radiating from the crown ----------------
            float az = vStrand.z, el = vStrand.w;
            float crown = smoothstep(1.45, 0.9, el);
            float bundles = sin(az * 9.0 + 0.35 * sin(el * 5.0)) ;
            float groove = pow(1.0 - abs(bundles), 6.0) * crown;
            iwH -= 0.0016 * groove;
            iwAO *= 1.0 - 0.3 * groove;
            float edge = smoothstep(0.0, 0.25, vGearCol.g); // g = distance above the hairline (0 at the rolled lip)
            diffuseColor.rgb = mix(dark, tc, 0.55 + 0.45 * edge);
            diffuseColor.rgb = mix(diffuseColor.rgb, light, 0.18 * smoothstep(0.8, 1.5, el));
          } else {
            // ---------------- strand ----------------
            float t = vStrand.x, on = vStrand.y, dist = vStrand.z, cs = vStrand.w;
            diffuseColor.rgb = vTint >= 0.0 ? mix(tc, light, vTint) : mix(tc, dark, -vTint);
            // root → tip: deeper at the root, brighter toward the tip
            diffuseColor.rgb = mix(diffuseColor.rgb * mix(0.78, 1.0, smoothstep(0.0, 0.35, t)), mix(diffuseColor.rgb, light, 0.22), smoothstep(0.55, 1.0, t));
            iwTipK = smoothstep(0.6, 1.0, t);
            // defined strand edges: a darker crease where neighbouring strands meet, a highlight ridge along the top
            float edgeK = smoothstep(0.66, 0.97, abs(vSinA)) * smoothstep(0.02, 0.12, t);
            diffuseColor.rgb *= 1.0 - 0.26 * edgeK;
            iwAO *= 1.0 - 0.4 * edgeK;
            iwH -= 0.0009 * edgeK;
            float ridge = smoothstep(0.75, 1.0, cs) * (1.0 - smoothstep(0.2, 0.5, abs(vSinA)));
            diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb, light, 0.35), ridge * 0.5);
            // underside darker (occluded by the head), top brighter
            diffuseColor.rgb *= mix(0.82, 1.0, smoothstep(-0.8, 0.3, cs));
            // suction cups: two staggered rows along the underside toward the tip (raised rim + cupped centre)
            if (on > 0.5 && t > 0.3 && t < 0.97 && cs < -0.15) {
              float side = vSinA;
              float row = side > 0.0 ? 0.5 : 0.0;
              float fa = fract(dist / 0.021 + row) - 0.5;
              float lat = (abs(side) - 0.42) / 0.24;
              float size = mix(0.58, 0.34, smoothstep(0.35, 0.96, t));
              float d = length(vec2(fa * 1.2, lat));
              float w = max(fwidth(d), 1e-3);
              float under = smoothstep(-0.15, -0.5, cs);
              iwSuck = (1.0 - smoothstep(size - w, size + w, d)) * under;
              float ring = smoothstep(size * 0.35, size * 0.8, d) * iwSuck;
              float cup = (1.0 - smoothstep(size * 0.25, size * 0.6, d)) * iwSuck;
              diffuseColor.rgb = mix(diffuseColor.rgb, mix(tc, vec3(1.0), 0.45), iwSuck * 0.8);
              diffuseColor.rgb *= 1.0 - cup * 0.22;
              iwH += 0.0009 * ring - 0.0006 * cup;
            }
          }
        }
      ` + HURT_FRAG,
      fRough: 'roughnessFactor = iwGear > 0.5 ? (iwGearCls == 1.0 ? 0.26 : iwGearCls == 2.0 ? 0.85 : iwGearCls == 3.0 ? 0.7 : 0.3) : roughnessFactor; roughnessFactor = mix(roughnessFactor, 0.2, iwHurtM); roughnessFactor = mix(roughnessFactor, 0.42, iwSuck);',
      fMetal: 'metalnessFactor = (iwGear > 0.5 && iwGearCls == 1.0) ? 1.0 : 0.0;',
      fNormal: 'normal = iwBumpN(normal, iwH, -vViewPosition);',
      fEmissive: 'totalEmissiveRadiance += uFlash + (1.0 - iwGear) * uGlow * (0.6 + 0.4 * clamp(vTint + 0.5, 0.0, 1.0));',
      fLights: /* glsl */`
        #ifdef USE_CLEARCOAT
          if (iwGear > 0.5) { material.clearcoat = iwGearCls == 0.0 ? 1.0 : iwGearCls == 1.0 ? 0.3 : 0.0; material.clearcoatRoughness = 0.12; }
          else { material.clearcoat = mix(1.0, 0.55, iwSuck); }
        #endif
        #ifdef USE_SHEEN
          material.sheenColor = iwGear > 0.5 ? (iwGearCls == 2.0 ? vec3(0.6) : vec3(0.0)) : mix(vec3(0.16), mix(uTeam, vec3(1.0), 0.5) * 0.5, iwTipK);
          material.sheenRoughness = 0.35;
        #endif
      `,
      fAO: 'reflectedLight.indirectDiffuse *= iwAO;',
    });
  };
  m.customProgramCacheKey = () => 'iw-hair3';
  return m;
}

let _dark = null;
export function getDarkMaterial() {
  if (!_dark) {
    _dark = new THREE.MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.25, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.03 });
    _dark.name = 'iw-dark';
  }
  return _dark;
}

// ================================================================================================
// EYES — sclera, layered iris (gradient, striations, limbal ring, inner glow), vertical pupil,
// catch-lights, heavy top lid line with outer-corner lash flicks. uv = polar patch coords, aEx = side.
// ================================================================================================
export function makeEyeMaterial(u) {
  const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.14, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04 });
  m.onBeforeCompile = (shader) => {
    for (const k of ['uLook', 'uIris', 'uIris2', 'uFlash']) shader.uniforms[k] = u[k];
    inject(shader, {
      vPars: 'varying vec2 vEyeUv; attribute float aEx; varying float vSide;',
      vBegin: 'vEyeUv = uv; vSide = aEx;',
      fPars: /* glsl */`
        uniform vec2 uLook; uniform vec3 uIris; uniform vec3 uIris2; uniform vec3 uFlash;
        varying vec2 vEyeUv; varying float vSide;
        float iwCircle(vec2 p, vec2 c, float r){ float d = length(p - c) - r; float w = max(fwidth(d), 1e-4); return 1.0 - smoothstep(-w, w, d); }
        float iwHashE(float n){ return fract(sin(n) * 43758.5453); }
      `,
      fColor: /* glsl */`
        vec3 iwEyeEmit = vec3(0.0); float iwEyeRim = 0.0;
        {
          vec2 p = vEyeUv;
          float r = length(p);
          float outer = p.x * sign(vSide + 1e-3);           // + toward the outer corner
          vec2 q = p - uLook;
          // sclera: cool white, shaded under the top lid and toward the rim
          vec3 sclera = mix(vec3(0.93, 0.94, 0.97), vec3(0.78, 0.8, 0.88), smoothstep(0.35, 1.0, r));
          sclera *= mix(0.72, 1.0, smoothstep(0.98, 0.3, p.y));
          // iris
          vec2 iq = q * vec2(1.0, 0.94);
          float ir = length(iq) / 0.66;
          float iris = iwCircle(iq, vec2(0.0), 0.66);
          float ang = atan(iq.y, iq.x);
          vec3 ic = mix(uIris2, uIris, smoothstep(0.55, -0.75, q.y));
          float stri = 0.5 + 0.5 * sin(ang * 23.0 + 3.0 * sin(ang * 5.0)) ;
          ic *= mix(0.86, 1.08, stri * smoothstep(0.25, 0.8, ir));
          ic = mix(ic, ic * 1.45 + 0.06, smoothstep(0.3, 0.95, ir) * smoothstep(0.15, -0.65, q.y)); // lower glow crescent
          ic = mix(ic, ic * 1.25 + 0.04, (1.0 - smoothstep(0.34, 0.5, ir)) * 0.6);                  // inner ring
          ic *= mix(1.0, 0.42, smoothstep(0.78, 1.0, ir));                                           // limbal ring
          ic *= mix(0.7, 1.0, smoothstep(0.75, 0.1, q.y));                                           // lid shadow
          // pupil: tall rounded capsule
          vec2 pq = (q - vec2(0.0, 0.03)) * vec2(1.0, 0.8);
          float pd = length(vec2(pq.x, max(abs(pq.y) - 0.07, 0.0))) - 0.24;
          float pw = max(fwidth(pd), 1e-4);
          float pupil = 1.0 - smoothstep(-pw, pw, pd);
          vec3 col = mix(sclera, ic, iris);
          col = mix(col, vec3(0.012, 0.01, 0.028), pupil);
          // catch-lights (same key light for both eyes) + a soft window reflection
          float h1 = iwCircle(p * vec2(1.0, 0.9), uLook * 0.5 + vec2(-0.25, 0.3), 0.19);
          float h2 = iwCircle(p, uLook * 0.5 + vec2(0.24, -0.3), 0.075);
          float h3 = iwCircle(p * vec2(1.0, 1.6), uLook * 0.5 + vec2(0.08, 0.62), 0.07) * 0.6;
          col = mix(col, vec3(1.0), max(max(h1, h2 * 0.9), h3));
          // top lid: thick dark lash line, thinner lower lid, lash flicks at the outer corner
          float lidTop = smoothstep(0.7, 0.82, p.y + 0.12 * outer * outer) * smoothstep(0.35, 0.6, r);
          float lash1 = iwCircle(vec2(outer, p.y) , vec2(0.86, 0.46), 0.1);
          float lash2 = iwCircle(vec2(outer, p.y) , vec2(0.95, 0.24), 0.07);
          float rim = smoothstep(0.84, 0.97, r);
          float lids = max(max(lidTop, rim), max(lash1, lash2) * smoothstep(0.7, 0.9, r));
          col = mix(col, vec3(0.018, 0.018, 0.03), lids);
          iwEyeRim = lids;
          diffuseColor.rgb = col;
          iwEyeEmit = col * (0.07 * (1.0 - lids)) + vec3(1.0) * max(h1, h2) * 0.2 + ic * iris * (1.0 - pupil) * 0.06;
        }
      `,
      fRough: 'roughnessFactor = mix(roughnessFactor, 0.35, iwEyeRim);',
      fEmissive: 'totalEmissiveRadiance += iwEyeEmit + uFlash * 0.5;',
    });
  };
  m.customProgramCacheKey = () => 'iw-eye3';
  return m;
}

// ================================================================================================
// TANK — glass capsule with an etched level gauge; ink fill whose surface stays level in world space
// (onBeforeRender feeds world-up in fill space), with a bright meniscus and suspended bubbles.
// ================================================================================================
let _glass = null;
export function getGlassMaterial() {
  if (!_glass) {
    const m = new THREE.MeshPhysicalMaterial({ color: 0xf2fbff, roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, transparent: true, opacity: 0.14, depthWrite: false, envMapIntensity: 1.5 });
    m.onBeforeCompile = (shader) => {
      inject(shader, {
        vPars: 'varying vec3 vIwPos;', vBegin: 'vIwPos = position;',
        fPars: 'varying vec3 vIwPos;',
        fColor: /* glsl */`
          float iwTick = 0.0;
          {
            // etched gauge on the back face: a scale spine with ticks every 10 % (majors every 20 %)
            vec3 q = vIwPos;
            float ang = atan(q.x, -q.z);                 // 0 = straight back
            float s = ang * 0.068;                       // metres around the glass
            float inStrip = step(abs(q.y), 0.0745) * step(0.0, -q.z);
            float yv = (q.y + 0.074) / 0.0148;
            float yd = abs(fract(yv + 0.5) - 0.5) * 0.0148;
            float aa = max(fwidth(yd), 1e-5);
            float tickLine = 1.0 - smoothstep(0.00045 - aa, 0.00045 + aa, yd);
            float major = mod(floor(yv + 0.5), 2.0) < 0.5 ? 1.0 : 0.0;
            float len = major > 0.5 ? 0.009 : 0.0048;
            float tick = tickLine * step(0.004, s) * step(s, 0.004 + len);
            float sa = max(fwidth(s), 1e-5);
            float spine = 1.0 - smoothstep(0.0004 - sa, 0.0004 + sa, abs(s - 0.004));
            float tick2 = tick; float spine2 = spine;
            iwTick = clamp(max(tick2, spine2) * inStrip, 0.0, 1.0);
          }
        `,
        fOpaque: /* glsl */`
          {
            float fr = pow(1.0 - saturate(dot(normalize(geometryNormal), normalize(geometryViewDir))), 2.5);
            diffuseColor.a = clamp(opacity + fr * 0.6, 0.0, 0.9);
            outgoingLight = mix(outgoingLight, vec3(0.92), iwTick * 0.75);
            diffuseColor.a = max(diffuseColor.a, iwTick * 0.8);
          }
        `,
      });
    };
    m.customProgramCacheKey = () => 'iw-glass3';
    _glass = m;
  }
  return _glass;
}

/** Ink fill inside the tank (per character: emissive blink on low ink). Surface stays level in world space. */
export function makeInkFillMaterial() {
  const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, emissive: 0x000000 });
  const U = { uUpL: { value: new THREE.Vector3(0, 1, 0) }, uSY: { value: 0.1 } };
  const _mq = new THREE.Quaternion(), _mv = new THREE.Vector3(), _ms = new THREE.Vector3();
  // world-up expressed in the PARENT (tank) frame: the free surface stays level however the kid leans, while any
  // slosh rotation animation applies on top of it (character.js rotates the fill mesh itself).
  m.onBeforeRender = (renderer, scene, camera, geometry, object) => {
    const par = object.parent || object;
    par.matrixWorld.decompose(_mv, _mq, _ms);
    U.uUpL.value.set(0, 1, 0).applyQuaternion(_mq.invert());
    const s = object.scale;
    U.uSY.value = Math.max(1e-3, s.y / Math.max(1e-4, (s.x + s.z) * 0.5));
  };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uUpL = U.uUpL; shader.uniforms.uSY = U.uSY;
    inject(shader, {
      vPars: 'uniform vec3 uUpL; uniform float uSY; varying vec3 vIwP; varying float vIwTop;',
      vBegin: /* glsl */`
        {
          // shear the column so the free surface is level in world space (x/z in metres, y in fill units)
          vec3 up = normalize(uUpL);
          float tilt = -(up.x * transformed.x + up.z * transformed.z) / max(up.y, 0.35);
          float k = clamp(transformed.y, 0.0, 1.0);
          transformed.y = clamp(transformed.y + k * tilt / uSY, 0.0, 0.186 / uSY);
          vIwTop = smoothstep(0.93, 1.0, position.y);
          vIwP = position;
        }
      `,
      fPars: 'varying vec3 vIwP; varying float vIwTop;' + NOISE,
      fColor: /* glsl */`
        vec3 iwFillEmit = vec3(0.0);
        {
          float depth = 1.0 - clamp(vIwP.y, 0.0, 1.0);
          diffuseColor.rgb *= mix(1.0, 0.72, depth);          // deeper ink reads darker
          // suspended bubbles
          vec3 bp = vec3(vIwP.x * 60.0, vIwP.y * 9.0, vIwP.z * 60.0);
          vec3 bc = floor(bp); vec3 bf = fract(bp) - 0.5;
          float rnd = iwHash(bc);
          float bub = (1.0 - smoothstep(0.12, 0.17, length(bf * vec3(1.0, 1.0, 1.0)) - 0.12 * rnd)) * step(0.82, rnd);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.5 + 0.12, bub * 0.7);
          // meniscus: bright rim where the surface meets the glass
          float r = length(vIwP.xz) / 0.0615;
          float men = vIwTop * smoothstep(0.82, 1.0, r);
          iwFillEmit = diffuseColor.rgb * men * 0.35;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.35 + 0.1, men);
        }
      `,
      fEmissive: 'totalEmissiveRadiance += iwFillEmit;',
    });
  };
  m.customProgramCacheKey = () => 'iw-fill3';
  return m;
}

// ================================================================================================
// SQUID — glossy team ink + tentacle wiggle in the vertex shader. colour = (tint, wiggle, phase);
// uv = (t along tentacle, cos(angle)) with aEx = 1 on tentacles (suckers on the inner face).
// ================================================================================================
export function makeSquidMaterial(u, ghost = false) {
  const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.24, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, sheen: 1, sheenRoughness: 0.4, sheenColor: new THREE.Color(1, 1, 1) });
  if (ghost) {
    m.transparent = true; m.depthWrite = false; m.depthFunc = THREE.GreaterDepth; m.opacity = 0.42;
  }
  m.onBeforeCompile = (shader) => {
    for (const k of ['uFlash', 'uTeam', 'uGlow', 'uTime', 'uWig', 'uOpacity']) shader.uniforms[k] = u[k];
    inject(shader, {
      vPars: /* glsl */`
        uniform float uTime; uniform vec3 uWig;
        #ifndef USE_COLOR
        attribute vec3 color;
        #endif
        attribute float aEx;
        varying float vTint; varying vec2 vSqUv; varying float vSqPart; varying vec3 vSqP;
      `,
      vBegin: /* glsl */`
        {
          float wig = color.g; float ph = color.b * 6.2831;
          float s = sin(uTime * uWig.y + ph + wig * 3.2);
          float c = cos(uTime * uWig.y * 0.8 + ph * 1.3 + wig * 2.6);
          transformed.x += s * wig * wig * uWig.x * 2.0;
          transformed.z += c * wig * wig * uWig.x * 2.0;
          transformed.y += (s * 0.5 + 0.5) * wig * uWig.x * 0.8;
          vTint = color.r; vSqUv = uv; vSqPart = aEx; vSqP = position;
        }
      `,
      fPars: 'uniform vec3 uTeam; uniform vec3 uFlash; uniform vec3 uGlow; uniform float uOpacity; varying float vTint; varying vec2 vSqUv; varying float vSqPart; varying vec3 vSqP;' + NOISE + BUMP,
      fColor: /* glsl */`
        float iwH = 0.0; float iwSuck = 0.0;
        {
          vec3 tc = uTeam;
          float lum = dot(tc, vec3(0.299, 0.587, 0.114));
          vec3 light = mix(tc, vec3(1.0), 0.6);
          vec3 dark = tc * mix(1.0, 0.5, clamp(lum * 1.4, 0.0, 1.0));
          diffuseColor.rgb = vTint >= 0.0 ? mix(tc, light, clamp(vTint, 0.0, 1.0)) : mix(tc, dark, clamp(-vTint, 0.0, 1.0));
          if (vSqPart > 0.5) {
            float t = vSqUv.x, cs = vSqUv.y;
            diffuseColor.rgb *= mix(0.85, 1.05, t);
            if (cs < -0.2 && t > 0.2 && t < 0.95) {
              float fa = fract(t * 14.0) - 0.5;
              float d = length(vec2(fa * 1.0, (cs + 0.78) * 2.2));
              float size = mix(0.3, 0.2, t);
              float w = max(fwidth(d), 1e-3);
              iwSuck = 1.0 - smoothstep(size - w, size + w, d);
              diffuseColor.rgb = mix(diffuseColor.rgb, light, iwSuck * 0.75);
              iwH += 0.0006 * smoothstep(size * 0.4, size * 0.85, d) * iwSuck - 0.0004 * (1.0 - smoothstep(0.0, size * 0.5, d)) * iwSuck;
            }
          }
          diffuseColor.a *= uOpacity;
        }
      `,
      fNormal: 'normal = iwBumpN(normal, iwH, -vViewPosition);',
      fEmissive: 'totalEmissiveRadiance += uFlash + uGlow * 0.5;' + (ghost ? 'totalEmissiveRadiance += uTeam * 0.6;' : ''),
      fLights: `
        #ifdef USE_SHEEN
          material.sheenColor = mix(uTeam, vec3(1.0), 0.5) * 0.35;
        #endif`,
    });
  };
  m.customProgramCacheKey = () => (ghost ? 'iw-squid-ghost3' : 'iw-squid3');
  return m;
}

// ================================================================================================
// WEAPONS — one shared vertex-coloured physical material; aMat picks the surface class:
// 0 satin plastic · 1 gloss paint · 2 rubber (diamond knurl) · 3 metal (brushed) · 4 lens/dark glass ·
// 5 LED (emissive vertex colour) · 6 matte print
// ================================================================================================
let _plastic = null;
export const WMAT = { satin: 0, gloss: 1, rubber: 2, metal: 3, lens: 4, led: 5, print: 6 };
export function getPlasticMaterial() {
  if (!_plastic) {
    const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.4, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.1, name: 'iw-plastic' });
    m.onBeforeCompile = (shader) => {
      inject(shader, {
        vPars: 'attribute float aMat; varying float vMat; varying vec3 vWPos;',
        vBegin: 'vMat = aMat; vWPos = position;',
        fPars: 'varying float vMat; varying vec3 vWPos;' + NOISE + BUMP,
        fColor: /* glsl */`
          float iwM = floor(vMat + 0.5); float iwH = 0.0; vec3 iwLed = vec3(0.0);
          if (iwM == 2.0) {                   // rubber: diamond knurl
            vec3 q = vWPos * 520.0;
            float k = abs(fract((q.x + q.y + q.z) * 0.5) - 0.5) + abs(fract((q.y - q.z + q.x * 0.3) * 0.5) - 0.5);
            iwH += 0.0003 * smoothstep(0.25, 0.6, k) * iwLod(vWPos.y * 520.0, 2.0);
          } else if (iwM == 3.0) {            // brushed metal streaks along the weapon axis
            float br = iwNoise(vec3(vWPos.x * 1800.0, vWPos.y * 1800.0, vWPos.z * 40.0));
            diffuseColor.rgb *= 0.9 + 0.2 * br;
          } else if (iwM == 5.0) {
            iwLed = diffuseColor.rgb * 2.2;
          } else if (iwM == 0.0) {            // satin: faint moulding texture
            iwH += 0.00004 * (iwNoise(vWPos * 1400.0) - 0.5) * iwLod(vWPos.y * 1400.0, 1.0);
          }
        `,
        fRough: 'roughnessFactor = iwM == 1.0 ? 0.2 : iwM == 2.0 ? 0.82 : iwM == 3.0 ? 0.3 : iwM == 4.0 ? 0.04 : iwM == 5.0 ? 0.25 : iwM == 6.0 ? 0.62 : 0.42;',
        fMetal: 'metalnessFactor = iwM == 3.0 ? 1.0 : 0.0;',
        fNormal: 'normal = iwBumpN(normal, iwH, -vViewPosition);',
        fEmissive: 'totalEmissiveRadiance += iwLed;',
        fLights: /* glsl */`
          #ifdef USE_CLEARCOAT
            material.clearcoat = iwM == 1.0 ? 1.0 : iwM == 4.0 ? 1.0 : iwM == 0.0 ? 0.25 : iwM == 3.0 ? 0.2 : 0.0;
            material.clearcoatRoughness = iwM == 4.0 ? 0.02 : 0.1;
          #endif
        `,
      });
    };
    m.customProgramCacheKey = () => 'iw-plastic3';
    _plastic = m;
  }
  return _plastic;
}
const _inkCache = new Map();
/** Glossy team ink for weapon parts, cached by hex. */
export function getInkMaterial(color) {
  const hex = color.getHexString();
  if (!_inkCache.has(hex)) {
    const m = new THREE.MeshPhysicalMaterial({ color: color.clone(), roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, sheen: 0.4, sheenRoughness: 0.3, sheenColor: color.clone().lerp(new THREE.Color(1, 1, 1), 0.5), name: 'iw-ink-' + hex });
    _inkCache.set(hex, m);
  }
  return _inkCache.get(hex);
}
export function makeGlowMaterial() {
  return new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffffff, emissiveIntensity: 0.4, roughness: 0.3 });
}
