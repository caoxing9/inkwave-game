// Bot brain: picks turf to claim, paths there (swimming through its own ink), paints on the move, spots and
// fights enemies with human-ish reaction time and aim error, refills ink, throws bombs and uses specials.
// Motion (stream 4): aim is a critically-damped spring with a turn-rate cap and a smoothly wandering error (plus an
// acquisition over/undershoot that settles), shots follow the bot's *actual* aim ray, the move command slews its
// heading (no twitch at waypoint switches / strafe flips), strafes ease, bots dodge-hop when hit, swim in to close
// distance and retreat through own ink to heal when they're losing a duel.
import * as THREE from 'three';
import { G, clamp, angleDiff } from '../core/ctx.js';
import { PLAYER, DIFFICULTY, SUB } from '../config.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _stats = { own: 0, enemy: 0, empty: 0, n: 0 };

export class BotBrain {
  constructor(actor, difficulty = 'normal') {
    this.a = actor;
    this.setDifficulty(difficulty);
    this.reset();
  }
  setDifficulty(d) { this.diff = DIFFICULTY[d] || DIFFICULTY.normal; }
  reset() {
    this.path = null; this.pi = 0; this.goal = -1; this.repath = 0; this.goalTimer = 0;
    this.target = null; this.seeTimer = 0; this.react = 0; this.lostTimer = 0;
    this.stuck = 0; this.lastPos = new THREE.Vector3(); this.jumpCd = 0; this.bestD = Infinity; this.noProg = 0;
    this.mode = 'paint';
    this.sweep = Math.random() * 10;
    this.aimYaw = this.a.yaw; this.aimPitch = 0;
    this.errYaw = 0; this.errPitch = 0; this.errT = 0;
    this.strafe = Math.random() < 0.5 ? 1 : -1; this.strafeT = 0;
    this.bombCd = 3 + Math.random() * 4;
    this.fireHold = 0;
    this.think = Math.random() * 0.2;
    this.refillUntil = 0;
    this.chargeRelease = 0.95 + Math.random() * 0.05;
    this.paintPause = 0;
    this.aimYawV = 0; this.aimPitchV = 0;
    this.acqT = 9; this.acqSignY = 0; this.acqSignP = 0;
    this.ph1 = Math.random() * 20; this.ph2 = Math.random() * 20; this.t = Math.random() * 10;
    this.strafeS = 0; this.strafeAmp = 1;
    this.mvYaw = this.a.yaw; this.mvMag = 0;
    this.dodgeCd = 1 + Math.random() * 2;
    this.retreatT = 0; this._firing = false;
  }

  update(dt) {
    const a = this.a;
    const it = a.intent;
    if (!a.alive) { it.move.set(0, 0, 0); it.fire = it.squid = it.sub = it.jump = it.special = false; this.path = null; this.target = null; this._wasDead = true; this.mvMag = 0; return; }
    if (this._wasDead && G.match && G.match.playing()) {
      // just respawned: face the way the body faces, then sometimes super jump to the teammate furthest up the field
      this._wasDead = false;
      this.aimYaw = a.yaw; this.aimPitch = 0; this.aimYawV = 0; this.aimPitchV = 0;
      if (Math.random() < 0.5) {
        const enemyPad = G.level.spawnPads[1 - a.team];
        let best = null, bd = Infinity;
        for (const o of G.actors) {
          if (o === a || o.team !== a.team || !o.alive || o.superJumpState) continue;
          const d = o.pos.distanceTo(enemyPad);
          if (d < bd && o.pos.distanceTo(a.pos) > 18) { bd = d; best = o; }
        }
        if (best && a.superJump(best)) { this.path = null; this.goalTimer = 0; }
      }
    }
    if (a.superJumpState) { it.move.set(0, 0, 0); it.fire = it.squid = it.sub = it.jump = it.special = false; this.mvMag = 0; return; }
    if (!G.match || !G.match.playing()) { it.move.set(0, 0, 0); it.fire = it.squid = it.sub = it.jump = it.special = false; this.mvMag = 0; return; }
    this.think -= dt; this.jumpCd -= dt; this.bombCd -= dt; this.strafeT -= dt; this.paintPause -= dt; this.dodgeCd -= dt;
    this.acqT += dt; this.t += dt;

    // ---------------- perception
    if (this.think <= 0) {
      this.think = 0.15 + Math.random() * 0.1;
      this._perceive();
    }
    const tgt = this.target;
    if (tgt && !tgt.alive) { this.target = null; }

    // ---------------- mode selection (retreat = break line of sight and heal in own ink when losing a duel)
    const inkFrac = a.ink / PLAYER.inkMax;
    const hpFrac = a.hp / PLAYER.hp;
    const w = a.weapon;
    if (this.mode === 'retreat') {
      this.retreatT -= dt;
      if (hpFrac > 0.85 || this.retreatT <= 0 || (!this.target && hpFrac > 0.6)) { this.mode = 'paint'; this.path = null; this.goalTimer = 0; }
    } else if (this.target && this.seeTimer > 0 && ((hpFrac < 0.34 && w.kind !== 'roller' && a.lastDamage < 0.8) || hpFrac < 0.2) && Math.random() < 0.6 * dt * 60 * this.diff.fireDiscipline) {
      this.mode = 'retreat'; this.retreatT = 2.2 + Math.random() * 1.4; this.repath = 0; this._pickRetreat();
    }
    if (this.mode !== 'refill' && this.mode !== 'retreat' && inkFrac < 0.12 && !(this.target && this.seeTimer > 0 && w.kind !== 'roller' && inkFrac > 0.05)) {
      this.mode = 'refill'; this.refillUntil = 0.85 + Math.random() * 0.1;
    }
    if (this.mode === 'refill' && inkFrac >= this.refillUntil) this.mode = 'paint';
    if (this.mode !== 'refill' && this.mode !== 'retreat') this.mode = this.target ? 'fight' : 'paint';

    // ---------------- navigation goal
    this.goalTimer -= dt; this.repath -= dt;
    if (this.mode === 'fight' && this.target) {
      if (this.repath <= 0) this._pathTo(this.target.pos, 0.6);
    } else if (this.mode === 'refill') {
      if (this.repath <= 0 || !this.path) this._pickRefill();
    } else if (this.mode === 'retreat') {
      if (this.repath <= 0 || !this.path) this._pickRetreat();
    } else if (this.goalTimer <= 0 || !this.path || this.pi >= this.path.length) {
      this._pickPaintGoal();
    }

    // ---------------- steering along the path
    const move = this._steer(dt);
    const wantMove = move.lengthSq() > 0.01;

    // ---------------- actions
    it.fire = false; it.sub = false; it.special = false; it.squid = false; it.jump = false;
    let wantYaw = wantMove ? Math.atan2(move.x, move.z) : a.yaw;
    let wantPitch = -0.1;
    const enemyVisible = this.target && this.seeTimer > 0;
    let fightDist = 0, idealYaw = 0, idealPitch = 0, aimDist = 6;

    if ((this.mode === 'fight' || this.mode === 'retreat') && this.target) {
      const t = this.target;
      const dx = t.pos.x - a.pos.x, dz = t.pos.z - a.pos.z;
      const dist = Math.hypot(dx, dz);
      fightDist = dist;
      const range = this._range();
      // lead the target a little (projectile flight time)
      const lead = w.kind === 'charger' ? 0 : dist / (w.projSpeed || 30);
      _v.set(t.pos.x + t.vel.x * lead, t.pos.y + (t.smoothY || 0) + (t.form === 'squid' ? 0.3 : 0.85), t.pos.z + t.vel.z * lead);
      _v2.copy(_v); _v2.x -= a.pos.x; _v2.y -= a.pos.y + 1.1; _v2.z -= a.pos.z;
      idealYaw = Math.atan2(_v2.x, _v2.z);
      idealPitch = Math.atan2(_v2.y, Math.hypot(_v2.x, _v2.z));
      aimDist = _v2.length();
      // human aim error: a slow wander plus an acquisition error that settles over the reaction time
      const e = this.diff.aimError;
      const acq = Math.exp(-this.acqT / Math.max(0.12, this.diff.reaction * 0.9));
      const wander = (x) => Math.sin(x) * 0.6 + Math.sin(x * 2.27 + 1.3) * 0.4;
      wantYaw = idealYaw + e * (0.75 * wander(this.t * 1.7 + this.ph1) + 2.4 * acq * this.acqSignY);
      wantPitch = idealPitch + e * 0.6 * (0.75 * wander(this.t * 2.1 + this.ph2) + 1.6 * acq * this.acqSignP);
      if (this.mode === 'fight') {
        // movement in combat: keep preferred distance + eased strafing (+ swim in to close distance)
        const pref = w.kind === 'charger' ? range * 0.8 : w.kind === 'roller' ? 0.5 : range * 0.7;
        if (this.strafeT <= 0) { this.strafeT = 0.6 + Math.random() * 1.2; this.strafe = Math.random() < 0.5 ? -1 : 1; this.strafeAmp = 0.5 + Math.random() * 0.5; }
        this.strafeS += (this.strafe * this.strafeAmp - this.strafeS) * (1 - Math.exp(-5 * dt));
        const nx = dx / Math.max(dist, 0.01), nz = dz / Math.max(dist, 0.01);
        let mvx = 0, mvz = 0;
        if (dist > pref + 1.2 && wantMove) { mvx = move.x; mvz = move.z; }
        else if (dist < pref - 1.5 && w.kind !== 'roller') { mvx = -nx; mvz = -nz; }
        if (w.kind !== 'charger' || !a.weaponRunner.charging) { mvx += -nz * this.strafeS * 0.9; mvz += nx * this.strafeS * 0.9; }
        if (w.kind === 'roller' && dist < 7) { mvx = nx; mvz = nz; }
        const l = Math.hypot(mvx, mvz);
        if (l > 0.01) move.set(mvx / l, 0, mvz / l); else move.set(0, 0, 0);
        // fire only when the *actual* aim is on the body (shots follow the visible aim, not the target)
        const off = Math.hypot(angleDiff(this.aimYaw, idealYaw), this.aimPitch - idealPitch);
        const tol = Math.max(0.05, Math.atan2(0.55, dist)) * (this._firing ? 2.4 : 1.5);
        const aimed = off < tol;
        this._firing = false;
        if (enemyVisible && this.react <= 0 && aimed && inkFrac > 0.02) {
          if (w.kind === 'charger') {
            it.fire = !(a.weaponRunner.charging && a.weaponRunner.charge >= this.chargeRelease);
            if (a.weaponRunner.charging) move.multiplyScalar(0.3);
          } else if (w.kind === 'roller') {
            it.fire = dist < 5.5 || (a.weaponRunner.rolling && dist < 8);
          } else {
            it.fire = dist < range * 1.08;
          }
          this._firing = it.fire;
          if (this.bombCd <= 0 && a.ink > SUB.bomb.inkCost + 8 && dist > 5 && dist < 14 && Math.random() < 0.02 * (1 + this.diff.fireDiscipline)) {
            it.sub = true; this.bombCd = 5 + Math.random() * 6;
            this._bombAim = true;
          }
        } else if (w.kind === 'charger' && a.weaponRunner.charging && !enemyVisible) {
          it.fire = true; // keep charge while target briefly hidden
        }
        // out of range with own ink underfoot: swim in (fast, hard to hit) instead of walking
        if (!it.fire && !a.weaponRunner.charging && dist > range * 1.15 && a.groundTeam === 1) it.squid = true;
        // dodge: a strafe-hop right after taking a hit
        if (a.lastDamage < 0.25 && this.dodgeCd <= 0 && a.grounded && w.kind !== 'charger' && Math.random() < 0.3) { it.jump = true; this.dodgeCd = 2 + Math.random() * 2.5; }
        // special
        if (a.specialReady()) {
          if (w.special === 'slam' && dist < 4.5) it.special = true;
          if (w.special === 'storm' && dist < 16) it.special = true;
        }
      } else {
        // retreat: swim away through own ink, keep eyes on the threat
        it.squid = true;
      }
    } else if (this.mode === 'paint') {
      // paint the ground ahead with a sweeping aim
      this.sweep += dt * (w.kind === 'charger' ? 0.8 : 2.1);
      const sweepAmt = w.kind === 'roller' ? 0 : 0.55;
      wantYaw += Math.sin(this.sweep) * sweepAmt;
      wantPitch = w.kind === 'charger' ? -0.12 : w.kind === 'blaster' ? -0.28 : -0.42;
      const aheadStats = G.paint.regionStats(a.pos.x + Math.sin(wantYaw) * 4, a.pos.y, a.pos.z + Math.cos(wantYaw) * 4, 3, a.team, _stats);
      const needPaint = aheadStats.n === 0 || aheadStats.own < 0.75;
      if (w.kind === 'roller') {
        it.fire = inkFrac > 0.08 && (needPaint || Math.random() < 0.02) && wantMove;
      } else if (w.kind === 'charger') {
        // charge to ~70 % and release a paint line, then a short breather before the next one
        if (a.weaponRunner.charging) {
          it.fire = a.weaponRunner.charge < 0.7;
          if (!it.fire) this.paintPause = 0.3 + Math.random() * 0.35;
        } else it.fire = needPaint && inkFrac > 0.3 && this.paintPause <= 0;
      } else {
        it.fire = needPaint && inkFrac > 0.18;
      }
      // travel as a squid through own ink when not painting
      if (!it.fire && this._pathRemaining() > 5 && a.groundTeam === 1) it.squid = true;
      if (a.specialReady() && Math.random() < 0.01) {
        const r = G.paint.regionStats(a.pos.x, a.pos.y, a.pos.z, 5, a.team, _stats);
        if (r.own < 0.5) it.special = true;
      }
    } else if (this.mode === 'refill') {
      it.squid = a.groundTeam === 1 || this._pathRemaining() > 2;
      if (a.groundTeam !== 1 && this._pathRemaining() < 1.5 && inkFrac > 0.03) {
        // no ink here: paint a puddle to swim in
        it.squid = false; it.fire = true;
        wantPitch = -1.0;
      }
    }
    if (this._bombAim) { it.sub = true; this._bombAim = false; this._releaseBomb = true; }
    else if (this._releaseBomb) { it.sub = false; this._releaseBomb = false; }

    // ---------------- aim: critically-damped spring with a turn-rate cap (flicks accelerate and settle; no twitch)
    const fighting = this.mode === 'fight';
    const om = fighting ? (this.diff.aimOmega ?? 13) : 8;
    const maxRate = fighting ? (this.diff.aimTurn ?? 10) : 6;
    wantPitch = clamp(wantPitch, -1.1, 1.0);
    this.aimYawV += (om * om * angleDiff(this.aimYaw, wantYaw) - 2 * om * this.aimYawV) * dt;
    this.aimYawV = clamp(this.aimYawV, -maxRate, maxRate);
    this.aimYaw += this.aimYawV * dt;
    if (this.aimYaw > Math.PI) this.aimYaw -= Math.PI * 2; else if (this.aimYaw < -Math.PI) this.aimYaw += Math.PI * 2;
    this.aimPitchV += (om * om * (wantPitch - this.aimPitch) - 2 * om * this.aimPitchV) * dt;
    this.aimPitchV = clamp(this.aimPitchV, -maxRate * 0.7, maxRate * 0.7);
    this.aimPitch = clamp(this.aimPitch + this.aimPitchV * dt, -1.1, 1.0);
    a.aimYaw = this.aimYaw; a.aimPitch = this.aimPitch;
    // shots go where the bot is actually aiming (its eye ray at the target's distance), never straight to the target
    {
      const cp = Math.cos(this.aimPitch);
      const d = fighting && this.target ? aimDist : this.mode === 'refill' ? 1.6 : 6;
      a.aimPoint.set(a.pos.x + Math.sin(this.aimYaw) * cp * d, a.pos.y + 1.1 + Math.sin(this.aimPitch) * d, a.pos.z + Math.cos(this.aimYaw) * cp * d);
      if (!fighting) { const gy = a.pos.y; if (a.aimPoint.y < gy) a.aimPoint.y = gy; }
    }

    // ---------------- smooth the move command: heading slews (no twitch at waypoint switches / strafe flips)
    const ml = Math.min(1, move.length());
    if (ml > 0.01) {
      const des = Math.atan2(move.x, move.z);
      const d = angleDiff(this.mvYaw, des);
      if (this.mvMag < 0.05) this.mvYaw = des;
      else if (Math.abs(d) > 2.1) { this.mvYaw = des; this.mvMag *= 0.35; }      // reversal: let the body plant and reverse
      else this.mvYaw += clamp(d, -11 * dt, 11 * dt);
    }
    this.mvMag += (ml - this.mvMag) * (1 - Math.exp(-14 * dt));
    it.move.set(Math.sin(this.mvYaw) * this.mvMag, 0, Math.cos(this.mvYaw) * this.mvMag);
    // stuck recovery, based on progress toward the current waypoint: hop → skip the waypoint → replan
    const trying = this.path && wantMove && !(w.kind === 'charger' && a.weaponRunner.charging);
    if (!trying) this.noProg = 0;
    if (this.noProg > 0.7 && this.jumpCd <= 0 && a.grounded) { it.jump = true; this.jumpCd = 1.0; }
    if (this.noProg > 1.5 && this.path && this.pi < this.path.length - 1 && !this._skipped) { this.pi++; this._skipped = true; this.bestD = Infinity; }
    if (this.noProg > 2.4) { this.noProg = 0; this._skipped = false; this.path = null; this.goalTimer = 0; this.repath = 0; }
    if (this.noProg === 0) this._skipped = false;
    this.stuck = this.noProg;
    if (this._needJump && this.jumpCd <= 0 && a.grounded) { it.jump = true; this.jumpCd = 0.6; this._needJump = false; }
  }

  // Low on health mid-duel: head for own ink away from the threat (swim = heal + hard to spot), then come back.
  _pickRetreat() {
    const a = this.a, t = this.target;
    let bestP = null, bs = -Infinity;
    for (let i = 0; i < 16; i++) {
      const ang = Math.random() * Math.PI * 2, r = 3 + Math.random() * 8;
      _v.set(a.pos.x + Math.cos(ang) * r, a.pos.y, a.pos.z + Math.sin(ang) * r);
      const st = G.paint.regionStats(_v.x, _v.y, _v.z, 1.4, a.team, _stats);
      if (!st.n) continue;
      const away = t ? Math.hypot(_v.x - t.pos.x, _v.z - t.pos.z) - Math.hypot(a.pos.x - t.pos.x, a.pos.z - t.pos.z) : 0;
      const score = st.own * 6 + away * 0.8 - r * 0.15 + (t && !G.physics.los(_v2.set(_v.x, _v.y + 1, _v.z), _v3.set(t.pos.x, t.pos.y + 1, t.pos.z)) ? 4 : 0);
      if (score > bs) { bs = score; bestP = _v.clone(); }
    }
    if (bestP) this._pathTo(bestP, 0.5); else this.path = null;
    this.repath = 1.0;
  }

  _range() {
    const w = this.a.weapon;
    if (w.kind === 'charger') return w.rangeMax * 0.9;
    if (w.kind === 'roller') return 6;
    return w.range;
  }

  _perceive() {
    const a = this.a;
    const eye = _v.copy(a.pos); eye.y += 1.3;
    let best = null, bd = Infinity;
    const aw = this.diff.awareness;
    for (const e of G.actors) {
      if (e.team === a.team || !e.alive) continue;
      const d = e.pos.distanceTo(a.pos);
      if (d > aw) continue;
      const swimming = e.anim.form === 'swim';
      const hs = Math.hypot(e.vel.x, e.vel.z);
      if (swimming && d > 3 && !(hs > 7 && d < 9)) continue;
      _v2.copy(e.pos); _v2.y += e.form === 'squid' ? 0.3 : 1.0;
      if (!G.physics.los(eye, _v2)) continue;
      const score = d - (e === this.target ? 4 : 0);
      if (score < bd) { bd = score; best = e; }
    }
    if (best) {
      if (best !== this.target) {
        this.target = best; this.react = this.diff.reaction * (0.7 + Math.random() * 0.6); this.repath = 0;
        // first look lands a little off (over- or under-shoot) and settles — like a human flick
        this.acqT = 0; this.acqSignY = (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.5); this.acqSignP = (Math.random() - 0.5) * 1.2;
      }
      this.seeTimer = 1.2;
      this.lostTimer = 0;
    } else {
      this.seeTimer -= 0.2;
      if (this.target) {
        this.lostTimer += 0.2;
        if (this.lostTimer > 2.5 || this.target.pos.distanceTo(a.pos) > aw + 6) this.target = null;
      }
    }
    this.react -= 0.2;
  }

  _pathTo(pos, maxUp = 0.8) {
    const nav = G.nav;
    const s = nav.nearest(this.a.pos, 1.2);
    const g = nav.nearest(pos, maxUp);
    this.repath = 0.8 + Math.random() * 0.4;
    if (s < 0 || g < 0) { this.path = null; return false; }
    const p = nav.path(s, g, this.a.team);
    if (!p) { this.path = null; return false; }
    this.path = p; this.pi = Math.min(1, p.length - 1); this.goal = g; this.bestD = Infinity; this.noProg = 0;
    return true;
  }

  _pickPaintGoal() {
    const a = this.a, nav = G.nav;
    let best = -1, bs = -Infinity;
    const enemyPad = G.level.spawnPads[1 - a.team];
    const ownPad = G.level.spawnPads[a.team];
    const total = ownPad.distanceTo(enemyPad);
    const mates = G.actors.filter((o) => o !== a && o.team === a.team && o.bot);
    for (let i = 0; i < 16; i++) {
      const id = nav.validIds[(Math.random() * nav.validIds.length) | 0];
      const n = nav.nodes[id];
      if (n.zone >= 0) continue;
      const d = Math.hypot(n.x - a.pos.x, n.z - a.pos.z);
      if (d > 34) continue;
      const st = G.paint.regionStats(n.x, n.y, n.z, 3.5, a.team, _stats);
      if (!st.n) continue;
      const progress = 1 - Math.hypot(n.x - enemyPad.x, n.z - enemyPad.z) / total; // 0 at own base → 1 at enemy base
      let score = (st.empty + st.enemy * 1.25) * 12 - d * 0.18 + clamp(progress, 0, 0.8) * 4 + Math.random() * 2.5;
      for (const m of mates) if (m.bot.goal >= 0) { const g = nav.nodes[m.bot.goal]; if (Math.hypot(g.x - n.x, g.z - n.z) < 7) score -= 4; }
      if (score > bs) { bs = score; best = id; }
    }
    this.goalTimer = 4 + Math.random() * 3;
    if (best < 0) return;
    const n = nav.nodes[best];
    this._pathTo(_v3.set(n.x, n.y, n.z), 0.3);
  }

  _pickRefill() {
    const a = this.a;
    // search nearby for own ink
    let bestP = null, bd = Infinity;
    for (let i = 0; i < 14; i++) {
      const ang = Math.random() * Math.PI * 2, r = 1 + Math.random() * 7;
      _v.set(a.pos.x + Math.cos(ang) * r, a.pos.y, a.pos.z + Math.sin(ang) * r);
      const st = G.paint.regionStats(_v.x, _v.y, _v.z, 1.2, a.team, _stats);
      if (st.n && st.own > 0.6 && r < bd) { bd = r; bestP = _v.clone(); }
    }
    if (bestP) this._pathTo(bestP, 0.4);
    else { this.path = null; }
    this.repath = 1.2;
  }

  _pathRemaining() {
    if (!this.path) return 0;
    const n = G.nav.nodes[this.path[this.path.length - 1]];
    return Math.hypot(n.x - this.a.pos.x, n.z - this.a.pos.z);
  }

  // body-width line of sight at knee height (centre + both shoulders) so bots never cut corners they can't fit past
  _fatLos(ax, ay, az, bx, by, bz) {
    let dx = bx - ax, dz = bz - az;
    const l = Math.hypot(dx, dz) || 1;
    const px = (-dz / l) * 0.34, pz = (dx / l) * 0.34;
    for (const o of [0, 1, -1]) {
      _v.set(ax + px * o, ay + 0.45, az + pz * o); _v2.set(bx + px * o, by + 0.45, bz + pz * o);
      if (!G.physics.los(_v, _v2)) return false;
    }
    return true;
  }

  _steer(dt) {
    const a = this.a, nav = G.nav, out = this._mv || (this._mv = new THREE.Vector3());
    out.set(0, 0, 0);
    if (!this.path || this.pi >= this.path.length) return out;
    // advance waypoints we've reached (generous vertically when dropping down)
    while (this.pi < this.path.length) {
      const n = nav.nodes[this.path[this.pi]];
      const dx = n.x - a.pos.x, dz = n.z - a.pos.z, dy = n.y - a.pos.y;
      if (dx * dx + dz * dz < 0.6 * 0.6 && dy < 0.9 && dy > -1.8) { this.pi++; this.bestD = Infinity; this.noProg = 0; }
      else break;
    }
    if (this.pi >= this.path.length) return out;
    const cur = nav.nodes[this.path[this.pi]];
    const hd = Math.hypot(cur.x - a.pos.x, cur.z - a.pos.z);
    // waypoint is above us and we can't get there from here (slipped off a ledge, got pushed): replan now
    if (a.grounded && cur.y - a.pos.y > 0.9 && hd < 1.2 && nav.edgeType(this.path[Math.max(0, this.pi - 1)], this.path[this.pi]) !== 'jump') {
      this.path = null; this.repath = 0; this.goalTimer = 0;
      return out;
    }
    // look ahead: aim at the furthest waypoint we can walk to in a straight line on this level
    let ti = this.pi;
    for (let k = this.pi + 1; k < Math.min(this.path.length, this.pi + 7); k++) {
      const n = nav.nodes[this.path[k]];
      if (Math.abs(n.y - a.pos.y) > 0.4) break;
      if (nav.edgeType(this.path[k - 1], this.path[k]) !== 'walk') break;
      if (!this._fatLos(a.pos.x, a.pos.y, a.pos.z, n.x, n.y, n.z)) break;
      ti = k;
    }
    const n = nav.nodes[this.path[ti]];
    out.set(n.x - a.pos.x, 0, n.z - a.pos.z);
    const l = out.length();
    if (l > 0.001) out.multiplyScalar(1 / l);
    // jump edges
    if (this.pi > 0) {
      const et = nav.edgeType(this.path[this.pi - 1], this.path[this.pi]);
      if (et === 'jump' && cur.y - a.pos.y > 0.4 && hd < 1.6) this._needJump = true;
    }
    // separation from teammates (only sideways relative to travel, so it never stalls forward progress)
    for (const o of G.actors) {
      if (o === a || !o.alive) continue;
      const dx = a.pos.x - o.pos.x, dz = a.pos.z - o.pos.z, d2 = dx * dx + dz * dz;
      if (d2 < 1.4 * 1.4 && d2 > 1e-4) {
        const d = Math.sqrt(d2), k = (1.4 - d) * 0.7;
        const side = (dx * -out.z + dz * out.x) >= 0 ? 1 : -1;
        const ox = out.x, oz = out.z;
        out.x = ox - oz * side * k; out.z = oz + ox * side * k;
      }
    }
    const l2 = out.length();
    if (l2 > 1) out.multiplyScalar(1 / l2);
    // progress tracking toward the current waypoint (used by the stuck recovery)
    if (hd < this.bestD - 0.2) { this.bestD = hd; this.noProg = 0; } else this.noProg += dt;
    return out;
  }

}
