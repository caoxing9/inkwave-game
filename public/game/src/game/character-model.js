// INKWAVE — authored character model: a static glTF (vertex colours, no rig) dressed onto the procedural squidkid rig.
// The asset is fetched once at import. Each Character then gets an auto-built skeleton for it (joint landmarks below +
// automatic skin weights), named like ours so the procedural animation drives it one-to-one: every frame our bone
// rotations are retargeted with a per-bone rest-pose fix where the rests differ (our arms hang straight, the model's
// arms rest against its body at an angle). Until the asset arrives — or if it fails — the procedural body is shown.
//
// Colour: the base-colour texture (uv); uv1.x weights texture over vertex colour, uv1.y is the part index of the split
// model (drives the skin weights).
// Team colour: the vertex-colour alpha tags regions — 1 = painted colour, 0.5 = team cloth, 0 = team glow. Those are
// recoloured from the character's uTeam uniform, so setColor() needs nothing extra.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MODEL = {
  url: new URL('../../assets/characters/alchemist.glb', import.meta.url).href,
  height: 1.4,
  // joints in the model's own frame: [x in model units (+X = its left), y as a fraction of its height, optional z in
  // model units (+Z = forward); without z the depth is the mesh's mean depth around the joint]. The arm chain was
  // measured from the skin-coloured fists (they hang slightly forward of the body).
  joints: {
    hips: [0, 0.24], spine: [0, 0.32], chest: [0, 0.4], neck: [0, 0.49], head: [0, 0.52],
    clavL: [0.04, 0.46], uArmL: [0.13, 0.455], fArmL: [0.185, 0.38, 0.04], handL: [0.205, 0.315, 0.08], tipL: [0.21, 0.24, 0.09],
    thighL: [0.07, 0.22], shinL: [0.09, 0.135], footL: [0.1, 0.07], toeL: [0.1, 0.02],
  },
};

// [bone, parent, direction child] — direction children mark the limb bones whose rest direction is fixed up
const BONES = [['hips', null, null], ['spine', 'hips', null], ['chest', 'spine', null], ['neck', 'chest', null], ['head', 'neck', null]];
for (const s of ['L', 'R']) BONES.push(
  [`clav${s}`, 'chest', `uArm${s}`], [`uArm${s}`, `clav${s}`, `fArm${s}`], [`fArm${s}`, `uArm${s}`, `hand${s}`], [`hand${s}`, `fArm${s}`, `tip${s}`], [`tip${s}`, `hand${s}`, null],
  [`thigh${s}`, 'hips', `shin${s}`], [`shin${s}`, `thigh${s}`, `foot${s}`], [`foot${s}`, `shin${s}`, `toe${s}`], [`toe${s}`, `foot${s}`, null],
);
const BONE_IDX = Object.fromEntries(BONES.map((b, i) => [b[0], i]));

const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const _sa = new THREE.Vector3(), _sb = new THREE.Vector3();
function segDist(p, a, b) {
  _sa.subVectors(b, a); _sb.subVectors(p, a);
  const t = Math.min(1, Math.max(0, _sb.dot(_sa) / _sa.lengthSq()));
  return _sb.addScaledVector(_sa, -t).length();
}

let shared = null; // { geo, J } once loaded; false if loading failed
new GLTFLoader().load(MODEL.url, (g) => {
  let mesh = null; g.scene.updateMatrixWorld(true);
  g.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
  const geo = mesh.geometry.clone(); geo.applyMatrix4(mesh.matrixWorld);
  // own attribute names, so the stock uv/map paths stay out of it
  geo.setAttribute('aRefUv', geo.attributes.uv); geo.setAttribute('aRefVis', geo.attributes.uv1); geo.deleteAttribute('uv'); geo.deleteAttribute('uv1');
  geo.computeBoundingBox();
  const bb = geo.boundingBox, s = MODEL.height / (bb.max.y - bb.min.y);
  geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2); geo.scale(s, s, s);
  if (!geo.attributes.normal) geo.computeVertexNormals();
  // joints (game units); depth = mean z of the mesh around each joint so the bones sit inside the limbs
  const P = geo.attributes.position, J = {};
  const toGame = (x, yf, z) => new THREE.Vector3(x * s, yf * MODEL.height, z === undefined ? NaN : z * s);
  for (const [n, [x, yf, z]] of Object.entries(MODEL.joints)) {
    J[n] = toGame(x, yf, z);
    if (n.endsWith('L')) J[n.slice(0, -1) + 'R'] = toGame(-x, yf, z);
  }
  const r2 = (0.06 * MODEL.height) ** 2;
  for (const n in J) {
    const j = J[n]; let sz = 0, c = 0;
    if (!Number.isNaN(j.z)) continue;
    j.z = 0;
    for (let i = 0; i < P.count; i++) { const dx = P.getX(i) - j.x, dy = P.getY(i) - j.y; if (dx * dx + dy * dy < r2) { sz += P.getZ(i); c++; } }
    if (c) j.z = sz / c;
  }
  skinWeights(geo, J);
  const mm = mesh.material;
  shared = { geo, J, ref: mm.map, normal: mm.normalMap, mr: mm.roughnessMap || mm.metalnessMap };
}, undefined, (e) => { shared = false; console.warn('[character-model] load failed, keeping the procedural body', e); });

// part indices of the split model (aRefVis.y): which bones a part may follow
const PART = { strap: 0, buckle: 1, bootL: 2, eyeL: 3, eyeR: 4, coat: 5, head: 6, shorts: 7, belt: 8, bootR: 9, limbs: 10, flasks: 11, hood: 12, mask: 13 };
const HEAD_PARTS = new Set([PART.head, PART.eyeL, PART.eyeR, PART.mask]);

/**
 * Skin weights. Baked weights (glTF JOINTS_0/WEIGHTS_0) are used when the asset has them; otherwise automatic. With part indices: rigid parts snap to one bone (head pieces, boots, flasks), the limbs part
 * takes the arm chains above the hips, the hood drapes from head to chest; everything else (coat, shorts, belts) uses
 * body regions — torso column, distance-gated arm sleeves, legs (+ hips carrying the coat hem).
 */
function skinWeights(geo, J) {
  const P = geo.attributes.position, n = P.count;
  const PT = geo.attributes.aRefVis;
  // weights baked into the asset (Blender Bone Heat, tools in the asset pipeline) take precedence over the region rules
  const BI = geo.attributes.skinIndex, BW = geo.attributes.skinWeight;
  const idx = new Uint16Array(n * 4), wts = new Float32Array(n * 4);
  const v = new THREE.Vector3(), ab = new THREE.Vector3(), av = new THREE.Vector3();
  const proj = (a, b) => { ab.subVectors(J[b], J[a]); av.subVectors(v, J[a]); return av.dot(ab) / ab.lengthSq(); };
  const W = new Map();
  const put = (b, w) => { if (w > 1e-4) W.set(b, (W.get(b) || 0) + w); };
  const flush = (i) => {
    const top = [...W.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((a, e) => a + e[1], 0) || 1;
    top.forEach(([b, w], k) => { idx[i * 4 + k] = BONE_IDX[b]; wts[i * 4 + k] = w / sum; });
    if (!top.length) { idx[i * 4] = BONE_IDX.hips; wts[i * 4] = 1; }
  };
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(P, i); W.clear();
    const sd = v.x >= 0 ? 'L' : 'R', ax = Math.abs(v.x);
    const shoulder = J['uArm' + sd], torsoHalf = Math.abs(shoulder.x) * 0.92;
    const dArm = Math.min(segDist(v, J['uArm' + sd], J['fArm' + sd]), segDist(v, J['fArm' + sd], J['hand' + sd]), segDist(v, J['hand' + sd], J['tip' + sd]));
    const part = PT ? Math.round(PT.getY(i)) : PART.coat;
    if (HEAD_PARTS.has(part)) { put('head', sstep(J.neck.y - 0.02, J.neck.y + 0.04, v.y)); put('neck', 1 - sstep(J.neck.y - 0.02, J.neck.y + 0.04, v.y)); }
    else if (part === PART.hood && !BI) { const k = sstep(J.neck.y - 0.05, J.head.y + 0.08, v.y); put('head', k); put('chest', 1 - k); }
    else if (part === PART.bootL || part === PART.bootR) put('foot' + (part === PART.bootL ? 'L' : 'R'), 1);
    else if (part === PART.flasks) put('chest', 1);
    if (W.size) { flush(i); continue; }
    if (BI && BW) { for (let k = 0; k < 4; k++) { const w = BW.getComponent(i, k); if (w > 0) put(BONES[BI.getComponent(i, k)][0], w); } flush(i); continue; }
    const limb = part === PART.limbs && v.y > J.thighL.y - 0.02;  // the fists hang below the hips; only the shins are lower
    const armK = limb ? 1 : part === PART.coat ? sstep(torsoHalf * 0.85, torsoHalf * 1.15, ax) * sstep(shoulder.y + 0.06, shoulder.y + 0.01, v.y) * sstep(0.11, 0.07, dArm) : 0;
    if (armK > 0) {
      const t1 = proj('uArm' + sd, 'fArm' + sd), t2 = proj('fArm' + sd, 'hand' + sd);
      let up = 0, lo = 0, hd = 0;
      if (t1 < 1) { const k = sstep(0.75, 1.15, t1); up = 1 - k; lo = k; } else { const k = sstep(0.8, 1.05, t2); lo = 1 - k; hd = k; }
      const cl = sstep(0.25, -0.1, t1) * 0.5;                      // shoulder blends into the clavicle
      put('uArm' + sd, up * (1 - cl) * armK); put('fArm' + sd, lo * armK); put('hand' + sd, hd * armK); put('clav' + sd, cl * up * armK);
    }
    const bodyK = 1 - armK, y = v.y;
    if (bodyK > 0) {
      if (y > J.neck.y) {
        const k = sstep(J.neck.y, J.head.y + 0.02, y); put('head', k * bodyK); put('neck', (1 - k) * bodyK);
      } else if (y > J.hips.y) {
        const c = sstep(J.spine.y, J.chest.y, y), nk = sstep(J.chest.y + 0.03, J.neck.y, y), sp = sstep(J.hips.y, J.spine.y + 0.02, y);
        put('neck', nk * bodyK); put('chest', c * (1 - nk) * bodyK); put('spine', sp * (1 - c) * bodyK); put('hips', (1 - sp) * bodyK);
      } else {
        // legs: the hips carry the coat hem, the legs swing it; boots follow the feet fully
        const side = sstep(-0.04, 0.04, v.x), inner = Math.min(1, ax / (J.thighL.x * 1.6));
        const legW = (y < J.footL.y + 0.03 ? 1 : 0.6) * (0.4 + 0.6 * inner) * (ax < J.thighL.x * 2.4 ? 1 : 0.5);
        for (const [s2, k] of [['L', side], ['R', 1 - side]]) {
          if (k <= 0) continue;
          let th = 0, sh = 0, ft = 0;
          if (y > J['shin' + s2].y) { th = sstep(J['shin' + s2].y + 0.02, J.hips.y, y); sh = 1 - th; }
          else { sh = sstep(J['foot' + s2].y - 0.01, J['foot' + s2].y + 0.03, y); ft = 1 - sh; }
          put('thigh' + s2, th * legW * k * bodyK); put('shin' + s2, sh * legW * k * bodyK); put('foot' + s2, ft * legW * k * bodyK);
        }
        put('hips', (1 - legW) * bodyK);
      }
    }
    flush(i);
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wts, 4));
}

function makeMaterial(u, { ref, normal, mr }) {
  // detail maps (baked high-poly normals, metal/roughness) when the asset carries them
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: mr ? 1 : 0.72, metalness: mr ? 1 : 0,
    normalMap: normal || null, roughnessMap: mr || null, metalnessMap: mr || null,
  });
  if (normal) m.normalScale.set(0.85, 0.85);
  m.onBeforeCompile = (shader) => {
    for (const k of ['uTeam', 'uFlash', 'uGlow']) shader.uniforms[k] = u[k];
    shader.uniforms.uRef = { value: ref };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aRefUv; attribute vec2 aRefVis; varying vec2 vRefUv; varying float vRefVis;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRefUv = aRefUv; vRefVis = aRefVis.x;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uTeam; uniform vec3 uFlash; uniform vec3 uGlow; uniform sampler2D uRef; varying vec2 vRefUv; varying float vRefVis;')
      .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
        float iwTag = diffuseColor.a;
        diffuseColor.rgb = mix(diffuseColor.rgb, texture2D(uRef, vRefUv).rgb, vRefVis);
        float iwGlowK = 1.0 - step(0.25, iwTag), iwClothK = step(0.25, iwTag) * (1.0 - step(0.75, iwTag));
        // softened luminance: the cloth keeps its folds without the dark creases turning into blotches
        float iwLum = mix(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.16, 0.35);
        // team cloth keeps the painted shading: the team hue at the cloth's own brightness, a touch of the original kept
        diffuseColor.rgb = mix(diffuseColor.rgb, uTeam * clamp(0.25 + 3.2 * iwLum, 0.18, 1.0), iwClothK * 0.88);
        diffuseColor.rgb = mix(diffuseColor.rgb, uTeam, iwGlowK);
        diffuseColor.a = 1.0;`)
      // the generated roughness map runs glossy: remap it to a matte cloth/skin range, keep a hint of metal on the brass
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(0.62, 1.0, roughnessFactor);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n metalnessFactor *= 0.6;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += uTeam * iwGlowK * 0.9 + uFlash + uGlow * iwClothK * 0.4;');
  };
  m.customProgramCacheKey = () => 'iw-model4';
  return m;
}

/** Build the model for one character (skeleton, skinned mesh, retarget pairs) and hide the procedural body. */
function attach(ch) {
  const { geo, J } = shared;
  const holder = new THREE.Group(); holder.name = 'model';
  const bones = {}; const list = [];
  for (const [n, p] of BONES) {
    const b = new THREE.Bone(); b.name = n; bones[n] = b; list.push(b);
    if (p) { bones[p].add(b); b.position.subVectors(J[n], J[p]); } else { holder.add(b); b.position.copy(J[n]); }
  }
  ch.kid.add(holder); holder.updateMatrixWorld(true);
  const mesh = new THREE.SkinnedMesh(geo, makeMaterial(ch.u, shared));
  mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
  holder.add(mesh); mesh.bind(new THREE.Skeleton(list));
  const pairs = []; const fixOf = {};
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (const [n, p, dc] of BONES) {
    let fix = new THREE.Quaternion();
    if (dc && ch.rest[dc] && ch.rest[n]) {
      a.subVectors(ch.rest[dc], ch.rest[n]).normalize(); b.subVectors(J[dc], J[n]).normalize();
      fix.setFromUnitVectors(b, a);
    } else if (p && fixOf[p]) fix = fixOf[p].clone();
    fixOf[n] = fix;
    if (ch.bones[n]) pairs.push({ ob: ch.bones[n], mb: bones[n], fix });  // model rest = identity in the kid frame
  }
  for (const k of ['skin', 'cloth', 'hair', 'eyes']) ch.meshes[k].visible = false;
  ch.tank.group.visible = false;                                         // the model carries its own flask
  // held props ride the model's hands (its arms are shorter than ours); the grip frame undoes the hand's rest fix
  const grip = {};
  for (const s of ['L', 'R']) { const g = new THREE.Object3D(); g.quaternion.copy(fixOf['hand' + s]).invert(); bones['hand' + s].add(g); grip[s] = g; }
  ch._model = { holder, mesh, pairs, grip, hipRatio: J.hips.y / ch.rest.hips.y };
}

const _q = new THREE.Quaternion(), _qk = new THREE.Quaternion(), _qkI = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _v = new THREE.Vector3();

/** Per frame, after the procedural pose is applied: attach once the asset is in, then retarget the pose onto it. */
export function syncModel(ch) {
  if (!shared) return;
  if (!ch._model) attach(ch);
  if (!ch.kid.visible) return;
  const { holder, pairs, grip, hipRatio } = ch._model;
  ch.kid.getWorldQuaternion(_qk); _qkI.copy(_qk).invert();
  for (const p of pairs) {
    p.ob.getWorldQuaternion(_q);
    _q.premultiply(_qkI).multiply(p.fix).premultiply(_qk);              // world target = Qk · delta · fix (· identity rest)
    p.mb.parent.getWorldQuaternion(_qp).invert();
    p.mb.quaternion.copy(_qp.multiply(_q));
    p.mb.updateMatrixWorld(true);
  }
  // pelvis bob / crouch / lean: our hip offset from rest, scaled to the model's leg length
  ch.bones.hips.getWorldPosition(_v); ch.kid.worldToLocal(_v); _v.sub(ch.rest.hips);
  holder.position.set(_v.x, _v.y * hipRatio, _v.z);
  if (ch.weapon && ch.weapon.pivot.parent !== grip.R) grip.R.add(ch.weapon.pivot);
  if (ch.bomb && ch.bomb.group.parent !== grip.L) grip.L.add(ch.bomb.group);
}

/** Before a weapon swap: hand the current weapon back to our hand bone so setWeapon() can detach it as usual. */
export function releaseWeapon(ch) {
  const w = ch.weapon;
  if (ch._model && w && w.pivot.parent === ch._model.grip.R) ch.bones.handR.add(w.pivot);
}

export function disposeModel(ch) {
  if (ch._model) ch._model.mesh.material.dispose();
}
