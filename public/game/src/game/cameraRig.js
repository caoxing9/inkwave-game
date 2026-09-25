// Camera rig: third-person follow, death spectate, cinematic paths, orbit, judge overview (stream 4).
//
// Follow: the pivot rides critically-damped springs toward the character's *visual* position with velocity
// feed-forward (smooth starts/stops/landings, no steady lag), a little strafe look-ahead, a soft vertical for jumps
// and a landing dip. The boom length comes from a soft cylinder probe (physics.cameraProbe): obstacles sweeping
// toward the line of sight start pulling the lens in several frames early, the boom springs in fast / eases out slow,
// never sits more than a hand's width past the hard line of sight and never goes under a floor. Orientation is
// exactly the aim (yaw/pitch) plus spring-driven visual recoil and smooth trauma shake — the aim ray is taken from
// the rendered camera, so the crosshair is always the truth. Mode changes blend the pose (no cuts, no pops).
import * as THREE from 'three';
import { G, clamp, damp, lerp, dampAngle } from '../core/ctx.js';
import { Hit } from './physics.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _fwd = new THREE.Vector3(), _back = new THREE.Vector3();
const _right = new THREE.Vector3(), _q = new THREE.Quaternion();
const _probe = { hard: 0, soft: 0, floor: false };
const _hit = new Hit();

// Critically-damped spring (exact integration — stable and frame-rate independent).
class Spring {
  constructor(x = 0) { this.x = x; this.v = 0; }
  reset(x) { this.x = x; this.v = 0; }
  step(target, omega, dt) {
    const d = this.x - target, e = Math.exp(-omega * dt), k = (this.v + omega * d) * dt;
    this.x = target + (d + k) * e;
    this.v = (this.v - omega * k) * e;
    return this.x;
  }
}

// Damped spring for zeta < 1, sub-stepped so each explicit step stays tiny: stable and frame-rate independent at any dt.
// (A single explicit step per frame diverged below ~27 fps into a frame-alternating jitter that read as flicker.)
function stepDamped(o, target, omega, zeta, dt) {
  const n = Math.max(1, Math.ceil((omega * dt) / 0.12)), h = dt / n;
  for (let i = 0; i < n; i++) { o.v += (-omega * omega * (o.x - target) - 2 * zeta * omega * o.v) * h; o.x += o.v * h; }
  return o.x;
}

// smooth pseudo-noise in [-1, 1]: two low incommensurate sines, no high partials (those alias into flicker at 30-60 fps)
const nz = (t, p) => Math.sin(t + p) * 0.62 + Math.sin(t * 1.87 + p * 1.7) * 0.38;
const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'orbit';
    this.yaw = 0; this.pitch = -0.1;
    this.pivot = new THREE.Vector3();
    this.pivotY = 0;
    this.dist = 4.5;
    this.curDist = 4.5;
    this.fovKick = 0;
    this.trauma = 0;
    this.shakeScale = 1;
    this.target = null;           // actor followed
    this.spectate = null;
    this.path = null;             // cinematic path { from, to, lookFrom, lookTo, t, dur, ease }
    this.lookAt = new THREE.Vector3();
    this.baseFov = 70;
    this.zoom = 0;
    this.time = 0;
    this.kick = 0;                // visual recoil pitch (radians)
    // follow springs
    this.sx = new Spring(); this.sy = new Spring(); this.sz = new Spring();
    this.boom = new Spring(4.5);
    this.hgt = new Spring(1.85);
    this.dipS = { x: 0, v: 0 };  // landing dip (lightly under-damped, sub-stepped)
    this.side = new Spring(0);    // strafe look-ahead (metres along camera right)
    this.lensLift = new Spring(0); // eased clearance over surfaces just under the lens
    this.wantDist = 4.5;
    this._lastTY = null;
    this._landSeen = 99;
    this._sjWasFlight = false; this._sjLandT = 99;
    // recoil: pitch-only kick on an exact critically-damped spring (stable at any frame rate)
    this.kickS = new Spring(0);
    this._traumaIn = 0;            // pending trauma, fed in over a few frames so a shake never pops in on one frame
    this.shakeSeed = Math.random() * 100;
    // blending between modes
    this.blend = null;
    this._prevMode = this.mode;
    this._prevTarget = null;
    this.spectateT = 0;
  }

  // Visual recoil: a pitch impulse on a critically-damped spring (smooth ~45 ms rise, ~0.15 s settle) — only the heavy
  // single shots send it. No sideways pattern: yaw kicks read as the camera shaking. The aim is taken from the rendered
  // camera, so this is real (tiny) recoil.
  recoil(amount) {
    this.kickS.v = Math.min(this.kickS.v + amount * 55, 3);
  }

  // Trauma shake. The noise runs on continuous time (no reseeding mid-shake, which jumped the view on one frame) and
  // new trauma is fed in over ~2-3 frames instead of being added in one step.
  addShake(amount, pos) {
    let a = amount;
    if (pos) { const d = pos.distanceTo(this.camera.position); a *= clamp(1 - (d - 4) / 22, 0, 1); }
    if (a <= 0) return;
    this._traumaIn = Math.min(1 - this.trauma, this._traumaIn + a * 0.75);
  }

  follow(actor, snap = false) {
    this.mode = 'follow';
    this.target = actor;
    if (snap) {
      const p = actor.visualPos ? actor.visualPos(_v) : _v.copy(actor.pos);
      const h = actor.form === 'squid' ? 1.3 : 1.85;
      this.sx.reset(p.x); this.sy.reset(p.y + h); this.sz.reset(p.z);
      this.pivot.set(p.x, p.y + h, p.z); this.pivotY = p.y + h;
      this.hgt.reset(h);
      this.boom.reset(this.dist); this.curDist = this.dist; this.wantDist = this.dist;
      this.dipS.x = 0; this.dipS.v = 0; this.side.reset(0); this.lensLift.reset(0);
      this.kickS.reset(0);
      this._lastTY = null; this._takeoffY = p.y;
      this._landSeen = actor.landT ?? 99;
    }
  }

  // Cinematic: move along a smooth arc from->to while looking from lookFrom->lookTo.
  cinematic(from, to, lookFrom, lookTo, dur, onDone) {
    this.mode = 'path';
    this.path = { from: from.clone(), to: to.clone(), lookFrom: lookFrom.clone(), lookTo: lookTo.clone(), t: 0, dur, onDone };
  }

  orbit(center, radius, height, speed = 0.05, phase = 0) {
    this.mode = 'orbit';
    this.orbitP = { center: center.clone(), radius, height, speed, phase };
  }

  overview() {
    this.mode = 'overview';
  }

  // Pose blend from the current rendered camera into whatever the new mode computes (ease in-out).
  _startBlend(dur) {
    const cam = this.camera;
    if (!this.blend) this.blend = { t: 0, dur, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 0 };
    this.blend.t = 0; this.blend.dur = dur;
    this.blend.pos.copy(cam.position); this.blend.quat.copy(cam.quaternion); this.blend.fov = cam.fov;
    this.blend.active = true;
  }

  _modeChanged(prev, next) {
    this.spectateT = 0;
    if (next === 'overview') this._ovFresh = true;
    if (G.match?.attract || !prev) return;                   // attract mode cuts between shots on purpose
    let dur = 0;
    if (next === 'spectate') dur = 0.55;                     // splatted → death cam
    else if (next === 'follow' && prev === 'spectate') dur = 0.7;   // respawn
    else if (next === 'follow' && prev === 'path') dur = 0.6;       // intro fly-in → gameplay
    else if (next === 'overview') dur = 1.2;                 // time's up → judge
    else if (next === 'follow' && prev !== 'follow') dur = 0.45;
    if (dur > 0) this._startBlend(dur);
  }

  update(dt) {
    this.time += dt;
    if (!Number.isFinite(this.pivot.x + this.pivot.y + this.pivot.z + this.pivotY + this.curDist + this.sx.x + this.sy.x + this.sz.x + this.boom.x + this.dipS.x + this.kickS.x + this.trauma)) {
      this.pivot.set(0, 2, 0); this.pivotY = 2; this.curDist = this.dist;
      this.sx.reset(0); this.sy.reset(2); this.sz.reset(0); this.boom.reset(this.dist); this.dipS.x = 0; this.dipS.v = 0;
      this.kickS.reset(0); this.trauma = 0; this._traumaIn = 0;
    }
    if (this.mode !== this._prevMode || (this.mode === 'follow' && this.target !== this._prevTarget)) {
      if (this.mode !== this._prevMode) this._modeChanged(this._prevMode, this.mode);
      this._prevMode = this.mode; this._prevTarget = this.target;
    }
    const cam = this.camera;
    const s = G.settings;
    this.baseFov = s?.fov ?? 82;
    if (this.mode === 'follow' && this.target) this._follow(dt);
    else if (this.mode === 'spectate' && this.spectate) this._spectate(dt);
    else if (this.mode === 'path' && this.path) this._path(dt);
    else if (this.mode === 'orbit' && this.orbitP) this._orbit(dt);
    else if (this.mode === 'overview') this._overview(dt);
    // settings.fov is the HORIZONTAL field of view at a 16:9 reference (Hor+: wider screens see more, never a stretched
    // fisheye); kicks/zoom are in vertical degrees
    const vBase = 2 * Math.atan(Math.tan((this.baseFov * Math.PI) / 360) / (16 / 9)) * (180 / Math.PI);
    let fov = vBase + (this.fovKick - this.zoom) * 0.8;
    // pose blend (mode transitions)
    const b = this.blend;
    if (b && b.active) {
      b.t += dt;
      const k = easeInOut(clamp(b.t / b.dur, 0, 1));
      cam.position.lerpVectors(b.pos, cam.position, k);
      _q.copy(cam.quaternion); cam.quaternion.slerpQuaternions(b.quat, _q, k);
      fov = lerp(b.fov, fov, k);
      if (k >= 1) b.active = false;
    }
    // trauma shake: smooth low-frequency noise (≤ ~4.5 Hz), rotation-led with a touch of translation; eased in, eased out
    if (this._traumaIn > 0) { const m = Math.min(this._traumaIn, dt * 14); this.trauma = Math.min(1, this.trauma + m); this._traumaIn -= m; }
    else this.trauma = Math.max(0, this.trauma - dt * 2.1);
    const sh = this.trauma * this.trauma * (s?.cameraShake ?? 1) * this.shakeScale;
    if (sh > 0.0005) {
      const t = this.time * 13, p = this.shakeSeed;
      cam.rotateX(nz(t, p) * 0.014 * sh);
      cam.rotateY(nz(t * 1.13, p + 3.1) * 0.01 * sh);
      cam.rotateZ(nz(t * 0.87, p + 7.7) * 0.008 * sh);
      _right.set(1, 0, 0).applyQuaternion(cam.quaternion);
      cam.position.addScaledVector(_right, nz(t * 1.07, p + 11) * 0.025 * sh);
      cam.position.y += nz(t * 0.93, p + 19) * 0.025 * sh;
    }
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
  }

  forward(out) {
    const cp = Math.cos(this.pitch);
    return out.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
  }

  _follow(dt) {
    const a = this.target, cam = this.camera;
    const squid = a.form === 'squid';
    const af = a.anim.form;
    const swim = af === 'swim' || af === 'climb';
    const sj = a.superJumpState;
    const flying = !!(sj && sj.phase === 'flight');
    const special = !!a.specialActive;
    const p = a.visualPos ? a.visualPos(_v3) : _v3.copy(a.pos);
    // ---- pivot height above the feet (form changes glide)
    const hT = swim ? 1.15 : squid ? 1.3 : 1.85;
    const h = this.hgt.step(hT, 11, dt);
    // ---- horizontal: critically-damped with 72 % velocity feed-forward (fluid, no persistent lag)
    const omegaH = flying ? 20 : 30, lead = 0.72 * 2 / omegaH;
    const fwd = this.forward(_fwd);
    _right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));   // camera right on the ground plane
    // strafe look-ahead: a hair more view where you're heading sideways
    const lat = a.vel.x * _right.x + a.vel.z * _right.z;
    const sideT = clamp(lat * 0.045, -0.32, 0.32) * (flying ? 0 : 1);
    const so = this.side.step(sideT, 3.2, dt);
    const tx = p.x + a.vel.x * lead + _right.x * so, tz = p.z + a.vel.z * lead + _right.z * so;
    // snap if the target teleported (respawn, NaN recovery)
    const ty = p.y + h;
    if (Math.abs(this.sx.x - p.x) + Math.abs(this.sz.x - p.z) > 6 || Math.abs(this.sy.x - ty) > 6) {
      this.sx.reset(p.x); this.sz.reset(p.z); this.sy.reset(ty); this._lastTY = null; this._vyF = 0;
    }
    this.sx.step(tx, omegaH, dt); this.sz.step(tz, omegaH, dt);
    // ---- vertical: firm on the ground (ramps, steps), soft through ordinary jumps, firm again for falls/super jumps
    // vertical velocity for the feed-forward, low-passed: a raw per-frame difference turned tiny contact wobbles and
    // uneven frame times into a vertical buzz
    const fresh = this._lastTY === null || dt <= 0;
    const vyRaw = fresh ? 0 : clamp((ty - this._lastTY) / dt, -30, 30);
    this._lastTY = ty;
    this._vyF = fresh ? 0 : damp(this._vyF || 0, vyRaw, 30, dt);
    const vyT = this._vyF;
    let omegaV = 13, leadV = 0.5;
    if (a.grounded || a.climbing) this._takeoffY = p.y;
    if (!a.grounded && !a.climbing) {
      if (flying || special) { omegaV = 16; leadV = 0.85; }
      else if (p.y < (this._takeoffY ?? p.y) - 0.25) { omegaV = 15; leadV = 0.8; }   // dropping below where we left the ground: follow the fall
      else { omegaV = 7.5; leadV = 0.25; }                                  // a hop: keep the horizon calm
    }
    this.sy.step(ty + vyT * leadV * 2 / omegaV, omegaV, dt);
    // ---- landing dip (lightly under-damped: one soft settle with weight, no bob)
    if (a.landT !== undefined) {
      if (a.landT < this._landSeen - 1e-6 && a.landSpeed > 4) this.dipS.v -= clamp((a.landSpeed - 4) * 0.045, 0, 0.45);
      this._landSeen = a.landT;
    }
    const dip = clamp(stepDamped(this.dipS, 0, 13, 0.82, dt), -0.3, 0.12);
    this.pivot.set(this.sx.x, this.sy.x + dip, this.sz.x);
    this.pivotY = this.pivot.y;
    // ---- super jump: swing toward the landing spot and look down on it during the descent; settle after landing
    const hs = Math.hypot(a.vel.x, a.vel.z);
    if (flying) {
      const dx = sj.to.x - sj.from.x, dz = sj.to.z - sj.from.z;
      if (dx * dx + dz * dz > 1) this.yaw = dampAngle(this.yaw, Math.atan2(dx, dz), 3.5, dt);
      const k = clamp(sj.t / sj.dur, 0, 1);
      this.pitch = damp(this.pitch, lerp(-0.3, -0.75, clamp((k - 0.35) / 0.5, 0, 1)), 4, dt);
      this._sjWasFlight = true;
    } else if (this._sjWasFlight) { this._sjWasFlight = false; this._sjLandT = 0; }
    if (this._sjLandT < 0.45) { this._sjLandT += dt; if (this.pitch < -0.2) this.pitch = damp(this.pitch, -0.16, 7, dt); }
    // ---- FOV: swim speed, super jump, a touch on takeoff; charger zoom
    let fk = 0;
    if (swim) fk = clamp((hs - 6) * 1.1, 0, 7);
    else if (flying) fk = 6;
    else if (!a.grounded && a.vel.y > 2) fk = 1.2;
    this.fovKick = damp(this.fovKick, fk, 5, dt);
    const charging = a.weaponRunner?.charging ? a.weaponRunner.charge : 0;
    this.zoom = damp(this.zoom, charging > 0.99 ? 14 : charging * 6, 8, dt);
    // ---- boom length: soft probe, fast in / slow out
    let want = (squid ? 4.1 : this.dist) - charging * 0.6;
    if (swim) want += clamp((hs - 6) / 6, 0, 1) * 0.35;
    if (flying) want += 1.2;
    this.wantDist = damp(this.wantDist, want, 6, dt);
    _back.copy(fwd).negate();
    G.physics.cameraProbe(this.pivot, _back, this.wantDist, 0.62, _probe);
    const tgt = _probe.soft;
    // fast in / slow out. The lens may trail a fast-closing obstacle for a few frames (bounded to 1.2 m past the line of
    // sight — back faces cull and the level's see-through dither covers the brief occlusion) instead of popping.
    const deep = clamp((this.boom.x - _probe.hard) / 1.0, 0, 1);   // the further past the line of sight, the faster in
    this.boom.step(tgt, tgt < this.boom.x ? 22 + 26 * deep : 3.6, dt);
    if (this.boom.x > _probe.hard + 1.6) { this.boom.x = _probe.hard + 1.6; this.boom.v = Math.min(this.boom.v, 0); }
    if (_probe.floor && this.boom.x > _probe.hard) { this.boom.x = _probe.hard; this.boom.v = Math.min(this.boom.v, 0); }
    if (this.boom.x < 0.45) { this.boom.x = 0.45; this.boom.v = Math.max(0, this.boom.v); }
    this.curDist = this.boom.x;
    cam.position.copy(this.pivot).addScaledVector(fwd, -this.curDist);
    cam.position.y += 0.15;
    // keep the lens off the floor under it (only real floors well below the pivot — not wall tops at head height)
    const gy = G.level?.groundHeight(cam.position.x, cam.position.z, cam.position.y + 0.2) ?? -Infinity;
    const liftT = gy > -Infinity && gy < this.pivot.y - 0.6 ? Math.max(0, gy + 0.24 - cam.position.y) : 0;
    this.lensLift.step(liftT, liftT > this.lensLift.x ? 34 : 7, dt);
    cam.position.y += this.lensLift.x;
    // ---- over-the-shoulder when the boom is forced short (wall right behind you): ease the lens to the right so your
    // head never sits on the crosshair; never slide it into a wall on that side
    const closeK = clamp((2.8 - this.curDist) / 1.8, 0, 1);
    let shT = 0.55 * closeK * closeK * (3 - 2 * closeK);
    if (shT > 0.01 && G.physics) {
      const hr = G.physics.raycast(cam.position, _right, shT + 0.25, _hit, true);
      if (hr.hit) shT = Math.max(0, hr.dist - 0.25);
    }
    this.shoulder = damp(this.shoulder || 0, shT, 8, dt);
    if (this.shoulder > 1e-3) cam.position.addScaledVector(_right, this.shoulder);
    // ---- visual recoil (pitch kick up), exact critically-damped spring
    this.kick = clamp(this.kickS.step(0, 22, dt), -0.01, 0.035);
    // ---- orientation = the aim, exactly
    _v2.copy(this.pivot).addScaledVector(fwd, 10);
    _v2.y += 0.15;
    if (this.shoulder > 1e-3) _v2.addScaledVector(_right, this.shoulder);   // parallel shift: aim direction unchanged
    cam.up.set(0, 1, 0);
    cam.lookAt(_v2);
    if (Math.abs(this.kick) > 1e-6) cam.rotateX(this.kick);
  }

  _spectate(dt) {
    const s = this.spectate, cam = this.camera;
    this.spectateT += dt;
    // first ~0.8 s: hold on the spot where you were splatted; then turn to watch whoever did it
    const killer = s.actor && s.actor.alive ? s.actor : null;
    const focus = this.spectateT < 0.8 || !killer ? s.pos : killer.pos;
    _v.copy(focus); _v.y += 1.1;
    this.lookAt.lerp(_v, 1 - Math.exp(-(this.spectateT < 0.8 ? 7 : 4.5) * dt));
    // sit on the victim's side of the killer, slowly drifting round
    const want = _v2.copy(s.from).sub(this.lookAt); want.y = 0;
    if (want.lengthSq() < 0.01) want.set(0, 0, 1);
    want.normalize();
    const ang = Math.atan2(want.x, want.z) + Math.min(this.spectateT, 6) * 0.07;
    const r = this.spectateT < 0.8 ? 4.2 : 5.5;
    want.set(Math.sin(ang) * r, 2.4, Math.cos(ang) * r);
    _v.copy(this.lookAt).add(want);
    const h = G.physics?.segment(this.lookAt, _v, _hit, true);
    if (h && h.hit) _v.copy(h.point).lerp(this.lookAt, 0.12);
    cam.position.lerp(_v, 1 - Math.exp(-3 * dt));
    cam.up.set(0, 1, 0);
    cam.lookAt(this.lookAt);
    this.fovKick = damp(this.fovKick, -6, 3, dt);
    this.zoom = damp(this.zoom, 0, 6, dt);
  }

  _path(dt) {
    const p = this.path, cam = this.camera;
    p.t += dt;
    const k = clamp(p.t / p.dur, 0, 1);
    const e = easeInOut(k);
    cam.position.lerpVectors(p.from, p.to, e);
    cam.position.y += Math.sin(e * Math.PI) * 1.5;
    _v.lerpVectors(p.lookFrom, p.lookTo, e);
    cam.up.set(0, 1, 0);
    cam.lookAt(_v);
    this.fovKick = 0; this.zoom = 0;
    if (k >= 1 && p.onDone) { const cb = p.onDone; p.onDone = null; cb(); }
  }

  _orbit(dt) {
    const o = this.orbitP, cam = this.camera;
    const a = o.phase + this.time * o.speed;
    _v.set(o.center.x + Math.sin(a) * o.radius, o.center.y + o.height + Math.sin(this.time * 0.13) * 1.2, o.center.z + Math.cos(a) * o.radius);
    cam.position.lerp(_v, 1 - Math.exp(-2 * dt));
    cam.up.set(0, 1, 0);
    cam.lookAt(o.center);
    this.fovKick = 0; this.zoom = 0;
  }

  _overview(dt) {
    const cam = this.camera;
    // crane up to the judge view on critically-damped springs (starts from rest — no lurch)
    if (!this._ov || this._ovFresh) { this._ov = [new Spring(cam.position.x), new Spring(cam.position.y), new Spring(cam.position.z)]; this._ovFresh = false; }
    _v.set(0, 62, -18);
    cam.position.set(this._ov[0].step(_v.x, 1.9, dt), this._ov[1].step(_v.y, 1.9, dt), this._ov[2].step(_v.z, 1.9, dt));
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 0, 3);
    this.fovKick = damp(this.fovKick, -12, 2, dt);
    this.zoom = 0;
  }
}
