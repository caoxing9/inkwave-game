// Actor: one squidkid (local player or bot). Owns movement physics, ink/health/special state and drives its
// Character visual. Controllers (player input / bot AI) only write `intent` + aim; everything else lives here so
// bots and the player play by exactly the same rules.
//
// Movement = a kinematic character controller (stream 4):
//  · feet: flat-footprint ground probe (physics.groundProbe) — exact on slopes, ledges hold until the whole
//    footprint is off, curbs ≤ stepUp are walked onto, ground is stuck to within stepDown (ramps, steps down)
//  · body: a capsule lifted above the step height, pushed out horizontally while grounded (walls never fight the feet)
//  · grounded velocity follows the ground plane (no micro-hops up ramps, no sliding when standing on them)
//  · vertical discontinuities (step-ups, ledge assists) are absorbed by a critically-damped visual offset (smoothY)
//  · horizontal: S-curve accel, eased braking, heading slew (turns carve at full speed), plant-and-reverse
//  · facing: angular spring with a rate cap (turnRate is fed to the animation)
//  · jump buffer + coyote time, apex hang, hard-landing recovery, fire buffer across form changes
import * as THREE from 'three';
import { G, emit, clamp, damp, angleDiff, smoothstep } from '../core/ctx.js';
import { PLAYER, WEAPONS, SPECIALS } from '../config.js';
import { makeContacts, Hit, GroundHit, WALKABLE } from './physics.js';
import { WeaponRunner } from './weapons.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _fwd = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);
const TAU = Math.PI * 2;

// Local-player gamepad rumble (subtle, scaled by settings.rumble, no-op without a pad).
export function rumble(actor, strong, weak, ms) {
  if (!actor || !actor.isLocal || actor.isBot) return;
  G.input?.rumble?.(strong, weak, ms);
}

export class Actor {
  constructor({ team, name, weapon = 'shooter', isLocal = false, isBot = false, style = { hair: 0, skin: 0 }, slot = 0, CharacterClass }) {
    this.team = team; this.name = name; this.isLocal = isLocal; this.isBot = isBot; this.slot = slot;
    this.weaponId = weapon;
    this.weapon = WEAPONS[weapon];
    // networking: netAuth = this client simulates the actor; remote = interpolation state for actors owned elsewhere
    this.netAuth = true; this.netId = null; this.owner = null; this.remote = null;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0; this.aimYaw = 0; this.aimPitch = 0;
    this.aimDir = new THREE.Vector3(0, 0, 1);
    this.aimPoint = new THREE.Vector3();
    this.intent = { move: new THREE.Vector3(), jump: false, squid: false, fire: false, sub: false, special: false };
    this._prevIntent = { fire: false, sub: false, jump: false, special: false, squid: false };
    this._squidPressT = -1; this._firePressT = -1;
    this.contacts = makeContacts();
    this.groundHit = new Hit();
    this.wallHit = new Hit();
    this.ground = new GroundHit();
    this.groundN = new THREE.Vector3(0, 1, 0);
    this.wallN = new THREE.Vector3(0, 0, 1);
    this._ledgeHit = new Hit();
    this.character = new CharacterClass({ color: G.teamColors[team], weapon, style, name, isLocal });
    // Character → game bus: character.js calls this.onEvent(name, data) (e.g. 'footstep' at each foot plant) and it is
    // re-emitted as 'actor:<name>' with the actor and the surface under it (0 dry, 1 own ink, 2 enemy ink). See docs/EVENTS.md.
    this.character.onEvent = (name, data) => emit('actor:' + name, { actor: this, surface: this.groundTeam, ...(data || {}) });
    this.weaponRunner = new WeaponRunner(this);
    this.stats = { turf: 0, splats: 0, deaths: 0, specials: 0 };
    this.anim = {
      time: 0, speed: 0, localMove: { x: 0, z: 0 }, grounded: true, vy: 0, aimPitch: 0, firing: false, charge: 0, rolling: false,
      form: 'kid', wallNormal: new THREE.Vector3(), ink: 1, lowInk: false, special: 0, invuln: false,
      turnRate: 0, hp: 1, inEnemyInk: false, surface: 0, subAim: false,
    };
    this.reset();
  }

  get color() { return G.teamColors[this.team]; }
  get enemyTeam() { return 1 - this.team; }

  reset() {
    this.alive = true;
    this.hp = PLAYER.hp;
    this.ink = PLAYER.inkMax;
    this.special = 0;            // points toward special
    this.specialActive = null;   // { id, t, phase }
    this.form = 'kid';           // desired form
    this.submerged = false;
    this.climbing = false;
    this.grounded = false;
    this.groundTeam = 0;         // 0 none, 1 own, 2 enemy
    this.respawnTimer = 0;
    this.invuln = 0;
    this.lastDamage = 99; this.lastFire = 99; this.inkIdle = 0;
    this.damageFromInk = 0;
    this.hurtFlash = 0;
    this.lastAttacker = null;
    this.fireFacing = 0;
    this.airTime = 0;
    this.landSpeed = 0;
    this.landT = 99;             // time since the last landing
    this.hardLand = 0;           // 0..1 recovery weight after a hard landing
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.fireBuffer = 0;
    this.kidT = 99;              // time since becoming a kid (emerge delay for the first shot)
    this.climbExit = 0;
    this.climbV = 0;
    this.inkWarnCd = 0;
    this.superJumpState = null;
    this.yawVel = 0; this._faceTarget = null;
    this.smoothY = 0; this.smoothYV = 0;
    this.onEnemy = false;
    this._evSub = false; this._evEnemy = false; this._evClimb = false; this._evForm = 'kid';
    this.weaponRunner?.reset();
  }

  setWeapon(id) {
    this.weaponId = id; this.weapon = WEAPONS[id];
    this.character.setWeapon(id);
    this.weaponRunner.reset();
  }

  specialCost() { return this.weapon.specialCost; }
  specialFrac() { return clamp(this.special / this.specialCost(), 0, 1); }
  specialReady() { return this.special >= this.specialCost() && !this.specialActive; }

  addTurf(area) {
    if (area <= 0) return;
    this.stats.turf += area;
    emit('turf', { actor: this, area });
    if (!this.specialActive) {
      const was = this.specialReady();
      this.special = Math.min(this.specialCost(), this.special + area);
      if (!was && this.specialReady()) emit('special:ready', { actor: this });
    }
  }

  spawnAt(p, yaw) {
    this.reset();
    this.pos.copy(p);
    this.vel.set(0, 0, 0);
    this.yaw = this.aimYaw = yaw;
    this.aimPitch = 0;
    this.invuln = PLAYER.spawnInvuln;
    this.character.root.position.copy(p);
    this.character.root.rotation.y = yaw;
    this.character.setVisible(true);
    this.character.setHurt(0, G.teamColors[this.enemyTeam]);
    // settle onto whatever is under the spawn point
    const gh = G.physics.groundProbe(p.x, p.y, p.z, 0.3, 0.3, PLAYER.footRadius, this.ground, false);
    if (gh.hit && Math.abs(gh.y - p.y) < 0.3) { this.pos.y = gh.y; this.grounded = true; this.groundN.copy(gh.normal); }
  }

  // Drop in from above the spawn pad (respawn), landing with a splash.
  respawn() {
    const pad = G.level.spawnPads[this.team];
    const a = (this.slot / 4) * Math.PI * 2 + 0.6;
    const p = _v.set(pad.x + Math.cos(a) * 1.1, pad.y + 4.5, pad.z + Math.sin(a) * 1.1);
    const yaw = this.team === 0 ? 0 : Math.PI;
    this.spawnAt(p, yaw);
    this.grounded = false;
    this.vel.set(0, -4, 0);
    this.character.trigger('spawn');
    G.fx?.spawnFlash(_v2.set(p.x, pad.y, p.z), this.color);
    if (this.isLocal) G.audio?.play('respawn');
    emit('respawn', { actor: this });
  }

  // ------------------------------------------------------------------ damage
  damage(amount, attacker, source = 'weapon') {
    if (!this.alive || amount <= 0) return false;
    if (this.invuln > 0) return false;
    if (this.specialActive && this.specialActive.armor) amount *= 0.25;
    this.hp -= amount;
    this.lastDamage = 0;
    this.hurtFlash = Math.min(1, this.hurtFlash + amount / 60);
    if (attacker) this.lastAttacker = attacker;
    if (source !== 'ink') {
      // flinch toward the attacker: direction in the character's local frame (+z forward, +x to the character's left
      // in world terms = root space x). The object also coerces to the old numeric amplitude (valueOf) so an older
      // character.js that expects a number keeps working.
      let dx = 0, dz = 1;
      const src = attacker && attacker !== this ? attacker.pos : null;
      if (src) { dx = src.x - this.pos.x; dz = src.z - this.pos.z; }
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      let lx = dx * cy - dz * sy, lz = dx * sy + dz * cy;
      const l = Math.hypot(lx, lz) || 1; lx /= l; lz /= l;
      const amp = clamp(amount / 60, 0.4, 1.2);
      this.character.trigger('hit', { x: lx, z: lz, amp, valueOf() { return amp; } });
      if (this.isLocal) rumble(this, clamp(amount / 110, 0.18, 0.7), clamp(amount / 80, 0.25, 0.8), 90 + Math.min(120, amount));
    }
    emit('damage', { victim: this, attacker, amount, source });
    if (this.hp <= 0) { this.splat(attacker, source); return true; }
    return false;
  }

  splat(attacker, cause = 'weapon') {
    if (!this.alive) return;
    this.alive = false;
    this.hp = 0;
    this.respawnTimer = PLAYER.respawnTime;
    this.stats.deaths++;
    this.special *= 0.5;
    this.specialActive = null;
    this.climbing = false;
    this.weaponRunner.onDeath();
    const col = attacker ? attacker.color : G.teamColors[this.enemyTeam];
    _v.copy(this.pos); _v.y += 0.6;
    G.fx?.splatted(_v, col);
    if (attacker) {
      attacker.stats.splats++;
      // burst into the attacker's ink
      _v.copy(this.pos); _v.y += 0.35;
      attacker.addTurf(G.paint.splat(_v, 1.7, attacker.team, { seed: Math.random() }));
    }
    this.character.setVisible(false);
    if (this.isLocal) rumble(this, 0.8, 0.6, 260);
    emit('splatted', { victim: this, attacker, cause });
    G.net?.onSplatted(this, attacker, cause);
  }

  // ------------------------------------------------------------------ update
  update(dt) {
    this.anim.time = G.time;
    // safety net: a non-finite position/velocity must never poison the camera or physics
    if (!Number.isFinite(this.pos.x + this.pos.y + this.pos.z + this.vel.x + this.vel.y + this.vel.z + this.yaw + this.smoothY)) {
      console.warn('[inkwave] non-finite actor state recovered', this.name);
      this.superJumpState = null; this.specialActive = null; this.yaw = 0; this.yawVel = 0; this.smoothY = 0; this.smoothYV = 0;
      if (this.alive) this.respawn(); else { this.pos.copy(G.level.spawnPads[this.team]); this.vel.set(0, 0, 0); }
    }
    if (!this.alive) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0 && G.match?.canRespawn()) this.respawn();
      return;
    }
    const P = PLAYER;
    const intent = this.intent;
    const prev = this._prevIntent;
    const firePressed = intent.fire && !prev.fire;
    const jumpPressed = intent.jump && !prev.jump;
    const subReleased = !intent.sub && prev.sub;
    const specialPressed = intent.special && !prev.special;
    if (intent.squid && !prev.squid) this._squidPressT = G.time;
    if (firePressed) this._firePressT = G.time;
    prev.fire = intent.fire; prev.jump = intent.jump; prev.sub = intent.sub; prev.special = intent.special; prev.squid = intent.squid;

    this.invuln = Math.max(0, this.invuln - dt);
    this.lastDamage += dt; this.lastFire += dt; this.landT += dt; this.kidT += dt;
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 0.6);
    this.inkWarnCd -= dt;
    this.jumpBuffer = jumpPressed ? P.jumpBuffer : Math.max(0, this.jumpBuffer - dt);
    this.fireBuffer = firePressed ? P.fireBuffer : Math.max(0, this.fireBuffer - dt);
    this.hardLand = Math.max(0, this.hardLand - dt / P.hardLandTime);

    // aim vector from yaw/pitch
    const cp = Math.cos(this.aimPitch);
    this.aimDir.set(Math.sin(this.aimYaw) * cp, Math.sin(this.aimPitch), Math.cos(this.aimYaw) * cp);

    // ---- super jump / specials in progress own the body
    if (this.superJumpState) { this._updateSuperJump(dt); this._finishFrame(dt); return; }
    if (this.specialActive) { this._updateSpecial(dt); this._finishFrame(dt); return; }
    if (specialPressed && this.specialReady()) { this._startSpecial(); this._finishFrame(dt); return; }

    // ---- form: squid while the swim button is held. Swim + fire both held → the most recent press wins, so diving
    // mid-spray and popping out of the ink to shoot both work instantly (the pop-out shot is buffered, never lost).
    const fireWins = (intent.fire || this.fireBuffer > 0) && this._firePressT >= this._squidPressT;
    const wantSquid = intent.squid && !fireWins && !this.weaponRunner.busy();
    if (wantSquid !== (this.form === 'squid')) {
      this.form = wantSquid ? 'squid' : 'kid';
      if (!wantSquid) this.kidT = 0;
      if (this.isLocal || this._nearCamera()) G.audio?.play(wantSquid ? 'squid_in' : 'squid_out', { pos: this.pos, volume: this.isLocal ? 0.8 : 0.5 });
      if (wantSquid && this.groundTeam === 1) G.fx?.burst(_v.copy(this.pos).setY(this.pos.y + 0.1), _v2.set(0, 1, 0), this.color, { count: 8, speed: 2.5, size: 0.07 });
    }
    const isSquid = this.form === 'squid';

    // ---- surface under feet (from last frame's ground probe; position hasn't moved since)
    this._surface();
    this.submerged = isSquid && this.grounded && this.groundTeam === 1;
    const onEnemy = this.grounded && this.groundTeam === 2 && !this.submerged;
    this.onEnemy = onEnemy;

    // ---- wall climb (squid on own-ink wall, pushing into it)
    this._updateClimb(dt, isSquid);

    // ---- horizontal movement
    if (!this.climbing) this._horizontal(dt, isSquid, onEnemy);

    // ---- jump (buffered, with coyote time)
    this.coyote = this.grounded ? P.coyoteTime : this.coyote - dt;
    let jumped = false;
    if (this.jumpBuffer > 0 && (this.grounded || this.coyote > 0) && !this.climbing) {
      let jv = this.submerged ? P.swimJumpVel : P.jumpVel;
      if (onEnemy) jv *= 0.72;
      this.vel.y = jv;
      this.grounded = false; this.coyote = 0; this.jumpBuffer = 0;
      jumped = true;
      this.character.trigger('jump');
      if (this.submerged) G.fx?.burst(_v.copy(this.pos), _v2.set(0, 1, 0), this.color, { count: 10, speed: 3.5, size: 0.08 });
      if (this.isLocal || this._nearCamera()) G.audio?.play(this.submerged ? 'swim_splash' : 'jump', { pos: this.pos, volume: 0.6 });
      emit('actor:jump', { actor: this, surface: this.groundTeam, swim: this.submerged });
    }

    // ---- integrate + collide (feet + body)
    this._integrate(dt, isSquid, jumped);
    this._spawnBarrier();

    // ---- ink / hp
    if (onEnemy) {
      if (this.damageFromInk < P.enemyInkDamageCap && this.invuln <= 0) {
        const d = Math.min(P.enemyInkDps * dt, P.enemyInkDamageCap - this.damageFromInk);
        this.damageFromInk += d;
        this.hp = Math.max(1, this.hp - d);
        this.hurtFlash = Math.min(1, this.hurtFlash + dt * 0.5);
      }
      this.lastDamage = Math.min(this.lastDamage, 0.4);
    } else {
      this.damageFromInk = Math.max(0, this.damageFromInk - dt * 30);
    }
    if (this.lastDamage > P.regenDelay && this.hp < P.hp) {
      this.hp = Math.min(P.hp, this.hp + (this.submerged ? P.regenRateSwim : P.regenRate) * dt);
    }
    const wasFull = this.ink >= P.inkMax;
    if (this.submerged || this.climbing) this.ink = Math.min(P.inkMax, this.ink + P.inkRefillSwim * dt);
    else if (!isSquid && this.lastFire > P.inkRefillDelay && !this.weaponRunner.busy()) this.ink = Math.min(P.inkMax, this.ink + P.inkRefillKid * dt);
    else if (isSquid) this.ink = Math.min(P.inkMax, this.ink + P.inkRefillKid * 0.5 * dt);
    if (!wasFull && this.ink >= P.inkMax && this.isLocal) G.audio?.play('refill_full', { volume: 0.5 });

    // ---- weapons (a squid → kid pop-out holds the first shot for emergeDelay; a tap during it is buffered, not lost)
    let fire = false, pressed = false;
    if (!isSquid && this.kidT >= P.emergeDelay) {
      const buffered = this.fireBuffer > 0;
      fire = intent.fire || buffered;
      pressed = firePressed || buffered;
      this.fireBuffer = 0;
    }
    this.weaponRunner.update(dt, { fire, firePressed: pressed, sub: intent.sub && !isSquid, subReleased: subReleased && !isSquid });

    // ---- fall into the sea
    // the sea: below the waterline with no deck underneath (dry-dock trenches sit below sea level and are safe)
    if (this.pos.y < P.fallDeathY && G.level.groundHeight(this.pos.x, this.pos.z, this.pos.y + 0.6) === -Infinity) {
      G.fx?.burst(_v.copy(this.pos).setY(P.waterY + 0.05), _v2.set(0, 1, 0), new THREE.Color('#bfe9ff'), { count: 18, speed: 5, size: 0.1 });
      G.audio?.play('splat_big', { pos: this.pos });
      this.splat(this.lastDamage < 4 ? this.lastAttacker : null, 'water');
      return;
    }

    this._finishFrame(dt);
  }

  _nearCamera() {
    const c = G.camera; if (!c) return false;
    return c.position.distanceToSquared(this.pos) < 30 * 30;
  }

  // Paint under the feet: 0 dry, 1 own ink, 2 enemy ink (only while grounded).
  _surface() {
    const g = this.ground;
    if (this.grounded && g.hit && g.face >= 0) {
      const t = G.paint.sample(g.face, g.u, g.v);
      this.groundTeam = t === 0 ? 0 : (t - 1 === this.team ? 1 : 2);
    } else this.groundTeam = 0;
  }

  // Legacy probe (super jump charge / external callers): refresh ground + surface at the current position.
  _probeGround() {
    const gh = G.physics.groundProbe(this.pos.x, this.pos.y, this.pos.z, 0.4, 0.35, PLAYER.footRadius, this.ground, this.form === 'squid');
    if (gh.hit) { const t = G.paint.sample(gh.face, gh.u, gh.v); this.groundTeam = gh.face < 0 || t === 0 ? 0 : (t - 1 === this.team ? 1 : 2); }
    else this.groundTeam = 0;
  }

  // ------------------------------------------------------------------ horizontal movement model
  _horizontal(dt, isSquid, onEnemy) {
    const P = PLAYER;
    const mv = this.intent.move;
    const mh = Math.hypot(mv.x, mv.z);
    const mag = Math.min(1, mh);
    const vx = this.vel.x, vz = this.vel.z;
    const sp = Math.hypot(vx, vz);
    // ---- airborne: vector steering with light air control (momentum is kept)
    if (!this.grounded) {
      let target, accel, decel;
      if (isSquid) { target = Math.max(P.squidDrySpeed, sp); accel = P.squidAirAccel; decel = P.squidAirDecel; }
      else { target = Math.max(this.weaponRunner.moveSpeed(), P.airMinSpeed); accel = P.airAccel; decel = P.airDecel; }
      const tvx = mh > 0.01 ? (mv.x / mh) * target * mag : 0, tvz = mh > 0.01 ? (mv.z / mh) * target * mag : 0;
      const dvx = tvx - vx, dvz = tvz - vz, dl = Math.hypot(dvx, dvz);
      const rate = (mh > 0.01 ? accel : decel) * dt;
      if (dl <= rate) { this.vel.x = tvx; this.vel.z = tvz; } else { this.vel.x += (dvx / dl) * rate; this.vel.z += (dvz / dl) * rate; }
      return;
    }
    // ---- grounded: speed + heading model
    let vt, A, aIn, inKnee, outKnee, D, dMin, dKnee, W;
    if (isSquid && this.submerged) {
      vt = P.swimSpeed; A = P.swimAccel; aIn = P.swimAccelIn; inKnee = 3; outKnee = P.swimOutKnee; D = P.swimDecel; dMin = 0.5; dKnee = 4; W = P.swimTurn;
    } else if (isSquid) {
      vt = P.squidDrySpeed; A = P.squidAccel; aIn = 0.6; inKnee = 1; outKnee = 0.3; D = P.squidDecel; dMin = 0.5; dKnee = 2; W = P.squidTurn;
    } else {
      vt = this.weaponRunner.moveSpeed(); A = P.runAccel; aIn = P.runAccelIn; inKnee = P.runInKnee; outKnee = P.runOutKnee;
      D = P.runDecel; dMin = P.runDecelMin; dKnee = P.runDecelKnee; W = P.turnRate;
      if (this.hardLand > 0) vt *= 1 - (1 - P.hardLandSlow) * this.hardLand;
    }
    if (onEnemy) { vt = Math.min(vt, P.enemyInkSpeed); A = Math.min(A, P.enemyInkAccel); D = Math.max(P.enemyInkDecel, 0); }
    if (mh < 0.01) {
      // brake: strong at speed, easing into the stop
      if (sp < 1e-4) { this.vel.x = 0; this.vel.z = 0; return; }
      const d = D * (dMin + (1 - dMin) * smoothstep(0, dKnee, sp)) * dt;
      const k = Math.max(0, sp - d) / sp;
      this.vel.x *= k; this.vel.z *= k;
      return;
    }
    const tx = mv.x / mh, tz = mv.z / mh, vts = vt * mag;
    let dx = tx, dz = tz;
    if (sp > 0.05) { dx = vx / sp; dz = vz / sp; }
    const cosA = clamp(dx * tx + dz * tz, -1, 1);
    const ang = Math.acos(cosA);
    if (sp > 0.5 && ang > P.reverseAngle) {
      // plant-and-reverse: brake through zero toward the new direction
      const tvx = tx * vts, tvz = tz * vts, ex = tvx - vx, ez = tvz - vz, el = Math.hypot(ex, ez);
      const r = Math.max(P.reverseDecel, D) * dt * (onEnemy ? 0.5 : 1);
      if (el <= r) { this.vel.x = tvx; this.vel.z = tvz; } else { this.vel.x += (ex / el) * r; this.vel.z += (ez / el) * r; }
      return;
    }
    // heading slews toward the input (faster when slow) — turns carve at full speed instead of dipping
    const wmax = W * (1 + P.turnRateSlow * (1 - smoothstep(0, vt, sp)));
    const rot = Math.min(ang, wmax * dt);
    if (rot > 1e-6) {
      const s = (dz * tx - dx * tz) >= 0 ? 1 : -1;
      const c = Math.cos(rot * s), sn = Math.sin(rot * s);
      const nx = dx * c + dz * sn, nz = -dx * sn + dz * c;
      dx = nx; dz = nz;
    }
    let ns;
    if (sp < vts) {
      const a = A * (aIn + (1 - aIn) * smoothstep(0, inKnee, sp)) * clamp((vts - sp) / (outKnee * vt), P.runOutMin, 1);
      ns = Math.min(vts, sp + a * dt);
    } else {
      // over speed (swim exit glide, entering enemy ink, starting to fire): shed it at the brake rate
      ns = Math.max(vts, sp - D * (dMin + (1 - dMin) * smoothstep(0, dKnee, sp - vts)) * dt);
    }
    this.vel.x = dx * ns; this.vel.z = dz * ns;
  }

  // ------------------------------------------------------------------ character controller
  _integrate(dt, isSquid, jumped) {
    const P = PLAYER;
    if (this.climbing) {
      this.pos.addScaledVector(this.vel, dt);
      G.physics.collideBody(this.pos, P.radius, P.squidBodyLift, P.squidHeight, this.contacts, false, true);
      if (this.contacts.ceiling && this.vel.y > 0) this.vel.y = 0;
      this.grounded = false;
      this.airTime = 0;
      return;
    }
    const wasGrounded = this.grounded && !jumped;
    if (wasGrounded) {
      // follow the ground plane: the vertical component keeps the feet on the surface at the current horizontal speed
      const n = this.groundN;
      this.vel.y = -(this.vel.x * n.x + this.vel.z * n.z) / Math.max(0.35, n.y);
    } else {
      let g = P.gravity;
      if (this.vel.y < 0) g *= P.fallGravityMul;
      if (Math.abs(this.vel.y) < P.apexBand) g *= P.apexGravityMul;
      this.vel.y = Math.max(-P.maxFall, this.vel.y - g * dt);
    }
    const prevY = this.pos.y;
    this.pos.addScaledVector(this.vel, dt);
    this._resolve(isSquid, prevY, wasGrounded);
  }

  // Body (walls/ceilings) then feet (ground stick / landing). `stick` = we were grounded and did not jump.
  _resolve(isSquid, prevY, stick) {
    const P = PLAYER;
    const lift = isSquid ? P.squidBodyLift : P.stepUp;
    const height = isSquid ? P.squidHeight : P.height;
    const c = G.physics.collideBody(this.pos, P.radius, lift, height, this.contacts, stick, isSquid);
    if (c.ceiling && this.vel.y > 0) this.vel.y = 0;
    if (c.wall) {
      const n = c.wallNormal;
      const vn = this.vel.x * n.x + this.vel.z * n.z;
      if (vn < 0) { this.vel.x -= n.x * vn; this.vel.z -= n.z * vn; }
    }
    const gh = this.ground;
    const up = isSquid ? P.squidStepUp : P.stepUp;
    const wasGrounded = this.grounded;
    let grounded = false;
    if (stick) {
      G.physics.groundProbe(this.pos.x, this.pos.y, this.pos.z, up, P.stepDown, P.footRadius, gh, isSquid);
      if (gh.hit) {
        const dy = gh.y - this.pos.y;
        this.pos.y = gh.y;
        grounded = true;
        // discontinuities (curbs, steps up / down) are eased visually; slope following and ramp creases stay exact
        if (Math.abs(dy) > 0.06) this.smoothY -= dy;
      }
    } else if (this.vel.y <= 0.5) {
      // landing: probe from the highest point this frame passed through (never tunnels), with ledge assist
      const top = Math.max(prevY, this.pos.y);
      const assist = isSquid ? P.squidStepUp : P.ledgeAssist;
      G.physics.groundProbe(this.pos.x, this.pos.y, this.pos.z, (top - this.pos.y) + assist, 0.02, P.footRadius, gh, isSquid);
      if (gh.hit && gh.y >= this.pos.y - 0.02 && (this.vel.y <= 0 || gh.y - this.pos.y < 0.02)) {
        // touching down from above is continuous; only a ledge-assist pop (feet were already below the top last
        // frame) is a visual step to ease
        const pop = gh.y - prevY;
        this.pos.y = gh.y;
        grounded = true;
        if (pop > 0.035) this.smoothY -= pop;
      }
    }
    if (grounded) {
      this.groundN.copy(gh.normal);
      if (!wasGrounded) this._onLand(isSquid);
      this.vel.y = 0;
    }
    this.grounded = grounded;
    this.airTime = grounded ? 0 : this.airTime + 1 / 60;
  }

  _onLand(isSquid) {
    const P = PLAYER;
    const speed = Math.max(0, -this.vel.y);
    this.landSpeed = speed;
    this.landT = 0;
    if (speed > P.hardLandSpeed) this.hardLand = clamp((speed - P.hardLandSpeed) / 6 + 0.5, 0, 1);
    if (speed > 3) {
      this.character.trigger('land', speed);
      this.grounded = true; this._surface();
      const swim = isSquid && this.groundTeam === 1;
      if (!this.specialActive && (this.isLocal || this._nearCamera())) G.audio?.play(swim ? 'swim_splash' : 'land', { pos: this.pos, volume: clamp(speed / 14, 0.25, 0.9) });
      emit('actor:land', { actor: this, speed, surface: this.groundTeam, pos: this.pos.clone() });
      if (this.isLocal && speed > 7) rumble(this, clamp((speed - 7) / 14, 0.05, 0.5), clamp(speed / 22, 0.1, 0.55), 70 + Math.min(90, speed * 4));
    }
  }

  _spawnBarrier() {
    const pad = G.level.spawnPads[this.enemyTeam];
    const R = G.level.spawnBarrier;
    const dx = this.pos.x - pad.x, dz = this.pos.z - pad.z;
    const d = Math.hypot(dx, dz);
    if (d < R && this.pos.y > pad.y - 1.0) {
      const k = (R - d) / Math.max(d, 0.01);
      this.pos.x += dx * k; this.pos.z += dz * k;
      const vn = (this.vel.x * dx + this.vel.z * dz) / Math.max(d, 0.01);
      if (vn < 0) { this.vel.x -= (dx / d) * vn * 1.6; this.vel.z -= (dz / d) * vn * 1.6; }
    }
  }

  // ------------------------------------------------------------------ wall climb
  _updateClimb(dt, isSquid) {
    const P = PLAYER;
    this.climbExit = Math.max(0, this.climbExit - dt);
    if (!isSquid || this.climbExit > 0) { if (this.climbing) this._setClimb(false); return; }
    const mv = this.intent.move;
    const mh = Math.hypot(mv.x, mv.z), mag = Math.min(1, mh);
    const dir = _fwd;
    if (this.climbing) dir.set(-this.wallN.x, 0, -this.wallN.z);
    else { if (mh < 0.2) return; dir.set(mv.x, 0, mv.z); }
    if (dir.lengthSq() < 1e-6) return;
    dir.normalize();
    _v.copy(this.pos); _v.y += 0.3;
    const h = G.physics.raycast(_v, dir, P.radius + 0.35, this.wallHit);
    const isWall = h.hit && Math.abs(h.normal.y) < 0.5;
    const inked = isWall && h.face >= 0 && G.paint.sample(h.face, h.u, h.v) - 1 === this.team;
    const into = isWall && mh > 0.01 ? -(mv.x * h.normal.x + mv.z * h.normal.z) / mh : 0;
    if (!this.climbing) {
      if (!(inked && into > P.climbAttachDot)) return;
      this.wallN.copy(h.normal);
      this.climbV = Math.max(0, this.vel.y);
      this._setClimb(true);
    }
    if (!h.hit) { this._ledgePop(dir); return; }                       // over the top
    if (!inked) {                                                        // ink ran out under us: let go
      this._setClimb(false); this.vel.y = Math.min(this.vel.y, 1.5);
      this.vel.x += h.normal.x * 1.2; this.vel.z += h.normal.z * 1.2; this.climbExit = 0.2;
      return;
    }
    if (into < P.climbDetachDot) {                                       // pushing away: hop off the wall
      this._setClimb(false);
      this.vel.set(h.normal.x * 3.2, 3.2, h.normal.z * 3.2); this.climbExit = 0.3;
      return;
    }
    this.wallN.copy(h.normal);
    // is there more of our ink above? (stop at the ink line instead of flying past it)
    _v.copy(this.pos); _v.y += 0.85;
    const hu = G.physics.raycast(_v, dir, P.radius + 0.45, this._ledgeHit);
    const capped = hu.hit && Math.abs(hu.normal.y) < 0.5 && !(hu.face >= 0 && G.paint.sample(hu.face, hu.u, hu.v) - 1 === this.team);
    // climb speed eases in (no instant 0 → 7.5 m/s snap), cling when the stick is neutral, and eases toward the
    // ledge-pop speed as the top comes into reach (so the pop never yanks the squid's vertical speed)
    let want = capped ? 0 : P.climbSpeed * clamp(into, 0, 1) * mag;
    if (!hu.hit && want > 0) want = Math.min(want, Math.sqrt(2 * P.gravity * P.apexGravityMul * (P.ledgePopClear + 0.3)));
    const a = P.climbAccel * dt * (want > this.climbV ? 1 : 1.6);
    this.climbV = this.climbV < want ? Math.min(want, this.climbV + a) : Math.max(want, this.climbV - a);
    this.vel.y = this.climbV;
    // hug the wall, slide sideways along it
    const n = h.normal;
    const side = _v2.set(mv.x, 0, mv.z);
    side.addScaledVector(n, -side.dot(n));
    this.vel.x = side.x * P.climbSideSpeed - n.x * 1.2;
    this.vel.z = side.z * P.climbSideSpeed - n.z * 1.2;
    this.anim.wallNormal.copy(n);
  }

  _setClimb(on) {
    if (this.climbing === on) return;
    this.climbing = on;
    if (!on) this.climbV = 0;
    emit('actor:climb', { actor: this, on });
  }

  // Reached the top of the wall: a controlled hop that clears the ledge by ledgePopClear and carries onto it.
  _ledgePop(dir) {
    const P = PLAYER;
    _v.copy(this.pos).addScaledVector(dir, P.radius + 0.32); _v.y = this.pos.y + 1.4;
    const t = G.physics.raycast(_v, DOWN, 2.0, this._ledgeHit, true);
    const top = t.hit && t.normal.y > WALKABLE ? t.point.y : this.pos.y + 0.3;
    const g = P.gravity * P.apexGravityMul;
    const rise = Math.max(0.25, top + P.ledgePopClear - this.pos.y);
    const cv = this.climbV;             // (read before _setClimb clears it) — keeps the vertical speed continuous
    this._setClimb(false);
    this.vel.y = Math.max(Math.sqrt(2 * g * rise), Math.min(cv, 6.5));
    this.vel.x = dir.x * P.ledgePopCarry; this.vel.z = dir.z * P.ledgePopCarry;
    this.climbExit = 0.3;
    this.grounded = false;
    G.fx?.burst(_v2.copy(this.pos).setY(this.pos.y + 0.3), _v.set(0, 1, 0), this.color, { count: 7, speed: 2.6, size: 0.07 });
    if (this.isLocal || this._nearCamera()) G.audio?.play('swim_splash', { pos: this.pos, volume: 0.45 });
  }

  // ------------------------------------------------------------------ super jump
  canSuperJump() { return this.alive && !this.superJumpState && !this.specialActive && G.match?.playing(); }

  // Launch toward an ally (or a fixed point). Charge in place as a glowing squid, then arc through the sky.
  superJump(target) {
    if (!this.canSuperJump()) return false;
    this.superJumpState = { phase: 'charge', t: 0, target, from: new THREE.Vector3(), to: new THREE.Vector3(), marker: 0 };
    this.form = 'squid';
    this._setClimb(false);
    this.weaponRunner.reset();
    G.audio?.play('super_jump', { pos: this.isLocal ? undefined : this.pos, volume: this.isLocal ? 0.9 : 0.6 });
    emit('superjump', { actor: this, phase: 'charge' });
    return true;
  }

  _updateSuperJump(dt) {
    const s = this.superJumpState;
    s.t += dt;
    if (s.phase === 'charge') {
      this.vel.set(0, 0, 0);
      this.form = 'squid';
      this._probeGround();
      if (s.t > 0.75) {
        const tgt = s.target;
        const isActor = !!(tgt && tgt.pos && tgt.pos.isVector3);
        if (isActor && !tgt.alive) { this.superJumpState = null; return; }
        s.from.copy(this.pos);
        if (isActor) {
          // land just short of the teammate (on their side facing us) instead of on top of them
          s.to.copy(tgt.pos);
          const dx = this.pos.x - tgt.pos.x, dz = this.pos.z - tgt.pos.z, d = Math.hypot(dx, dz) || 1;
          _v2.set(tgt.pos.x + (dx / d) * 1.1, tgt.pos.y + 0.6, tgt.pos.z + (dz / d) * 1.1);
          const g = G.physics.raycast(_v2, DOWN, 2.5, this.groundHit);
          if (g.hit && g.normal.y > 0.6 && !G.level.pointInside(_v.copy(g.point).setY(g.point.y + 0.5), 0.3)) s.to.copy(g.point);
        } else s.to.copy(tgt);
        s.phase = 'flight'; s.t = 0;
        s.dur = 1.15 + Math.min(0.6, s.from.distanceTo(s.to) / 80);
        this.invuln = Math.max(this.invuln, s.dur + 0.2);
        G.fx?.burst(_v.copy(this.pos), _v2.set(0, 1, 0), this.color, { count: 16, speed: 6, size: 0.1 });
        rumble(this, 0.35, 0.5, 140);
        emit('superjump', { actor: this, phase: 'flight', to: s.to.clone() });
      }
      return;
    }
    if (s.phase === 'flight') {
      const k = Math.min(1, s.t / s.dur);
      // horizontal: ease-in-out; vertical: a quick launch and a steeper, faster drop onto the target
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const apex = 11 + s.from.distanceTo(s.to) * 0.08;
      const kv = Math.pow(k, 0.86);
      _v.lerpVectors(s.from, s.to, e);
      _v.y += Math.sin(Math.PI * kv) * apex;
      this.vel.copy(_v).sub(this.pos).multiplyScalar(1 / Math.max(dt, 1e-3));
      this.pos.copy(_v);
      this.form = k > 0.82 ? 'kid' : 'squid';
      s.marker += dt;
      if (s.marker > 0.12) { s.marker = 0; G.fx?.ring(_v2.copy(s.to).setY(s.to.y + 0.05), _v.set(0, 1, 0), this.color, { radius: 1.6, life: 0.5 }); }
      if (k >= 1) {
        this.superJumpState = null;
        this.vel.set(0, -12, 0);          // lands through _onLand (squash, land event, audio)
        this.form = 'kid'; this.kidT = 0.05;
        this.grounded = false;
        this._resolve(false, this.pos.y + 0.4, false);
        if (!this.grounded) { this.grounded = true; this._resolve(false, this.pos.y, true); if (!this.grounded) this.vel.y = -6; }
        this.addTurf(G.paint.splat(_v.copy(this.pos).setY(this.pos.y + 0.3), 1.4, this.team, { seed: Math.random() }));
        G.fx?.burst(this.pos, _v2.set(0, 1, 0), this.color, { count: 14, speed: 5, size: 0.09 });
        if (this.isLocal) emit('shake', { amount: 0.35 });
        rumble(this, 0.55, 0.45, 170);
        emit('superjump:land', { actor: this, pos: this.pos.clone() });
      }
    }
  }

  // ------------------------------------------------------------------ specials
  _startSpecial() {
    const id = this.weapon.special;
    this.special = 0;
    this.stats.specials++;
    this.form = 'kid';
    this._setClimb(false);
    emit('special:use', { actor: this, id });
    G.net?.onSpecial(this, id);
    G.audio?.play('special_activate', { pos: this.isLocal ? undefined : this.pos, volume: this.isLocal ? 1 : 0.7 });
    rumble(this, 0.25, 0.45, 120);
    if (id === 'slam') {
      this.specialActive = { id, t: 0, phase: 'rise', armor: true, startY: this.pos.y };
      this.vel.set(this.vel.x * 0.3, 11.5, this.vel.z * 0.3);
      this.grounded = false;
      this.character.trigger('special_leap');
    } else if (id === 'storm') {
      this.specialActive = { id, t: 0, phase: 'throw', armor: false };
      this.character.trigger('throw');
      G.projectiles.throwStorm(this);
    }
  }

  _updateSpecial(dt) {
    const s = this.specialActive;
    s.t += dt;
    const sp = SPECIALS[s.id];
    if (s.id === 'storm') {
      // brief throw animation, then control returns
      if (s.t > 0.35) this.specialActive = null;
      this.vel.x *= Math.exp(-6 * dt); this.vel.z *= Math.exp(-6 * dt);
      const stick = this.grounded;
      if (!stick) this.vel.y -= PLAYER.gravity * dt; else this.vel.y = 0;
      const py = this.pos.y;
      this.pos.addScaledVector(this.vel, dt);
      this._resolve(false, py, stick);
      return;
    }
    // slam
    const mv = this.intent.move;
    if (s.phase === 'rise') {
      this.vel.y -= PLAYER.gravity * 0.9 * dt;
      this.vel.x = damp(this.vel.x, mv.x * 2.5, 6, dt); this.vel.z = damp(this.vel.z, mv.z * 2.5, 6, dt);
      if (s.t > sp.rise) { s.phase = 'hang'; s.t = 0; this.vel.set(0, 0.6, 0); }
    } else if (s.phase === 'hang') {
      this.vel.y = 0.4;
      if (s.t > sp.hang) { s.phase = 'fall'; s.t = 0; this.vel.set(0, -34, 0); this.character.trigger('special_slam'); }
    } else if (s.phase === 'fall') {
      this.vel.y = -34;
    }
    const py = this.pos.y;
    this.pos.addScaledVector(this.vel, dt);
    this.grounded = false;
    this._resolve(false, py, false);
    if (s.phase === 'fall' && (this.grounded || s.t > 1.2)) {
      this._slamImpact(sp);
      this.specialActive = null;
      this.invuln = 0.3;
    }
  }

  _slamImpact(sp) {
    const c = this.pos;
    let area = 0;
    area += G.paint.splat(_v.copy(c).setY(c.y + 0.3), sp.radius * 0.72, this.team, { seed: Math.random() });
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + Math.random() * 0.3;
      const r = sp.radius * (0.55 + Math.random() * 0.3);
      _v.set(c.x + Math.cos(a) * r, c.y + 0.6, c.z + Math.sin(a) * r);
      area += G.paint.splat(_v, 1.1 + Math.random() * 0.6, this.team, { seed: Math.random() });
    }
    this.addTurfNoSpecial(area);
    G.fx?.explosion(_v.copy(c).setY(c.y + 0.3), this.color, sp.radius);
    G.audio?.play('special_slam', { pos: c });
    emit('shake', { pos: c.clone(), amount: 1.0 });
    emit('special:slam', { actor: this, pos: c.clone(), radius: sp.radius });
    rumble(this, 0.9, 0.7, 320);
    for (const a of G.actors) {
      if (a.team === this.team || !a.alive) continue;
      const d = a.pos.distanceTo(c);
      if (d > sp.radius) continue;
      const dmg = d < sp.killRadius ? sp.damageMax : sp.damageMin + (sp.damageMax - sp.damageMin) * 0.3 * (1 - (d - sp.killRadius) / (sp.radius - sp.killRadius));
      _v.copy(a.pos); _v.y += 0.8;
      if (G.physics.los(_v2.copy(c).setY(c.y + 0.8), _v)) G.projectiles.applyHit(this, a, dmg, 'slam');
    }
  }

  addTurfNoSpecial(area) { if (area > 0) { this.stats.turf += area; emit('turf', { actor: this, area }); } }

  // ------------------------------------------------------------------ facing
  // Critically-damped angular spring with a rate cap: small corrections are quick, big turns sweep with a smooth
  // ease-in/out instead of an exponential snap. yawVel doubles as the animation's turnRate.
  _face(dt, isSquid) {
    const P = PLAYER;
    const a = this.anim;
    const mv = this.intent.move;
    const mh = Math.hypot(mv.x, mv.z);
    const hs = Math.hypot(this.vel.x, this.vel.z);
    this.fireFacing = Math.max(0, this.fireFacing - dt);
    let target = null, omega = P.faceOmega, maxRate = P.faceMaxRate, maxAcc = P.faceMaxAcc;
    if (this.specialActive || this.superJumpState) {
      if (hs > 0.6) target = Math.atan2(this.vel.x, this.vel.z);
    } else if (this.weaponRunner.firingPose() || this.fireFacing > 0 || this.intent.sub) {
      target = this.aimYaw; omega = P.aimFaceOmega; maxRate = P.aimFaceMaxRate; maxAcc = P.aimFaceMaxAcc;
    } else if (this.climbing) {
      target = Math.atan2(-this.wallN.x, -this.wallN.z); omega = 26; maxRate = 18;
    } else {
      if (mh > 0.2) target = Math.atan2(mv.x, mv.z);
      else if (hs > 0.6) target = Math.atan2(this.vel.x, this.vel.z);
      if (isSquid) { omega = P.squidFaceOmega; maxRate = this.submerged ? P.swimFaceMaxRate : P.squidFaceMaxRate; maxAcc = P.squidFaceMaxAcc; }
    }
    // feed-forward the target's own angular velocity (mouse turning while firing, carving runs) so the body tracks a
    // smoothly moving target with no steady-state lag; discrete jumps (new stick/key direction) get no kick
    let targetRate = 0;
    if (target !== null && this._faceTarget !== null) {
      const d = angleDiff(this._faceTarget, target);
      if (Math.abs(d) < 0.12) targetRate = clamp(d / Math.max(dt, 1e-4), -maxRate, maxRate);
    }
    this._faceTarget = target;
    let acc;
    if (target === null) acc = -2 * omega * this.yawVel;
    else acc = omega * omega * angleDiff(this.yaw, target) + 2 * omega * (targetRate - this.yawVel);
    // angular acceleration is capped too: turns spin up over a few frames instead of snapping to full rate
    this.yawVel = clamp(this.yawVel + clamp(acc, -maxAcc, maxAcc) * dt, -maxRate, maxRate);
    if (Math.abs(this.yawVel) < 1e-5) this.yawVel = 0;   // no denormal tails
    this.yaw += this.yawVel * dt;
    if (this.yaw > Math.PI) this.yaw -= TAU; else if (this.yaw < -Math.PI) this.yaw += TAU;
    a.turnRate = this.yawVel;
  }

  // ------------------------------------------------------------------ visuals
  _finishFrame(dt) {
    const a = this.anim;
    const isSquid = this.form === 'squid';
    const R = this.remote;
    if (!R) this._face(dt, isSquid);
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    a.speed = hs;
    const inv = 1 / Math.max(hs, 0.001);
    const lmx = hs > 0.1 ? (this.vel.x * cy - this.vel.z * sy) * inv : 0;
    const lmz = hs > 0.1 ? (this.vel.x * sy + this.vel.z * cy) * inv : 0;
    a.localMove.x = -lmx; a.localMove.z = lmz;
    a.grounded = this.grounded;
    a.vy = this.vel.y;
    a.aimPitch = this.aimPitch;
    a.firing = R ? R.firing : this.weaponRunner.firingPose();
    a.charge = R ? R.charge : this.weaponRunner.charge;
    a.rolling = R ? R.rolling : this.weaponRunner.rolling;
    a.subAim = R ? R.subAim : !!this.weaponRunner.aimingSub;      // bomb cocked (stream 2 request)
    a.form = !isSquid ? 'kid' : this.climbing ? 'climb' : this.submerged ? 'swim' : 'squid';
    if (this.specialActive) a.form = 'kid';
    a.ink = this.ink / PLAYER.inkMax;
    a.lowInk = this.ink < 18;
    a.special = this.specialFrac();
    a.invuln = this.invuln > 0;
    a.hp = clamp(this.hp / PLAYER.hp, 0, 1);
    a.inEnemyInk = !!this.onEnemy;
    a.surface = this.grounded ? this.groundTeam : 0;
    // visual step smoothing (critically damped, ~0.12 s)
    const w = 24;
    const acc = -w * w * this.smoothY - 2 * w * this.smoothYV;
    this.smoothYV += acc * dt; this.smoothY += this.smoothYV * dt;
    if (Math.abs(this.smoothY) > 0.7) { this.smoothY = Math.sign(this.smoothY) * 0.7; }
    if (Math.abs(this.smoothY) < 1e-4 && Math.abs(this.smoothYV) < 1e-3) { this.smoothY = 0; this.smoothYV = 0; }
    const ch = this.character;
    ch.root.position.copy(this.pos);
    ch.root.position.y += this.smoothY;
    ch.root.rotation.y = this.yaw;
    ch.setHurt(Math.max(this.hurtFlash, 1 - this.hp / PLAYER.hp) * (this.hp < PLAYER.hp ? 1 : 0), G.teamColors[this.enemyTeam]);
    ch.update(dt, a);
    this._events(a);
    // swim wake
    if (a.form === 'swim' && hs > 2 && G.fx) {
      this._wakeT = (this._wakeT || 0) + dt;
      if (this._wakeT > 0.05) { this._wakeT = 0; G.fx.wake(this.pos, _v.set(this.vel.x, 0, this.vel.z).normalize(), this.color, hs); }
    }
  }

  // state-change events for the FX / HUD / audio streams (docs/EVENTS.md)
  _events(a) {
    const kidForm = this.form === 'squid' ? 'squid' : 'kid';
    if (kidForm !== this._evForm) { this._evForm = kidForm; emit('actor:form', { actor: this, form: kidForm, surface: this.groundTeam }); }
    const sub = a.form === 'swim' || a.form === 'climb';
    if (sub !== this._evSub) {
      this._evSub = sub;
      const speed = Math.hypot(this.vel.x, this.vel.z);
      emit(sub ? 'actor:dive' : 'actor:emerge', { actor: this, pos: this.pos.clone(), speed });
    }
    if (!!this.onEnemy !== this._evEnemy) { this._evEnemy = !!this.onEnemy; emit('actor:enemyInk', { actor: this, on: this._evEnemy }); }
  }

  // Visual (smoothed) world position of the feet — cameras and name tags should follow this, not the raw pos.
  visualPos(out) { return out.set(this.pos.x, this.pos.y + this.smoothY, this.pos.z); }
}
