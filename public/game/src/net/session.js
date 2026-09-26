// 对局同步。
//
// 权威划分（每个客户端只模拟自己"拥有"的角色）：
//   · 玩家本人：自己角色的移动、血量、死亡、复活（手感零延迟）
//   · 房主：所有机器人、比赛计时、状态切换、最终判定；玩家掉线后接管其角色
//   · 伤害：开枪者一方判定命中（所见即所得），把伤害发给受害者的拥有者结算
//   · 涂墨：谁的子弹谁涂，每次涂墨（位置/半径/种子）广播给所有人照做 → 各端墨迹一致
//
// 非房主发出的包只到房主，房主再转发给其他人（星形拓扑）。
import * as THREE from 'three';
import { G, emit } from '../core/ctx.js';
import { PLAYER, MATCH, BOT_NAMES, WEAPON_ORDER, TEAM_PALETTES } from '../config.js';

const BROADCAST = new Set(['st', 'f', 'bm', 'th', 'sp', 'kill', 'spc', 'adopt']);
const INTERP = 0.1;        // 远端角色渲染延迟（秒）
const STATE_HZ = 20;

const F = { alive: 1, squid: 2, sub: 4, climb: 8, ground: 16, firing: 32, rolling: 64, special: 128, sj: 256, subAim: 512, invuln: 1024 };

export class NetSession {
  constructor(client) {
    this.client = client;
    this.me = client.id;
    this.match = null;
    this.byId = new Map();
    this.loaded = new Set();
    this.splatBuf = [];
    this.stateT = 0; this.splatT = 0; this.clockT = 0;
    this.hitAcc = new Map();
    this.mute = 0;
    this.handlers = new Set();
    client.onPacket = (d, from) => this._recv(d, from);
    this._wrapPaint();
  }

  get isHost() { return this.client.isHost; }
  get online() { return !this.client.closed; }
  on(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }

  // ------------------------------------------------------------------ lobby → match
  // 房主：根据房间成员生成 10 人名单（真人按所选队伍，空位由机器人补齐），发送开局包
  buildStart(settings) {
    const members = this.client.members;
    const teams = [members.filter((m) => m.team === 0).slice(0, MATCH.teamSize), members.filter((m) => m.team === 1).slice(0, MATCH.teamSize)];
    const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    const roster = [];
    let ni = 0;
    for (let t = 0; t < 2; t++) {
      const used = teams[t].map((m) => m.weapon);
      for (let s = 0; s < MATCH.teamSize; s++) {
        const m = teams[t][s];
        if (m) roster.push({ id: `a${t}${s}`, team: t, slot: s, name: m.name, weapon: m.weapon, owner: m.id, bot: false });
        else {
          const pool = WEAPON_ORDER.filter((w) => !used.includes(w));
          const weapon = pool.length ? pool[(Math.random() * pool.length) | 0] : WEAPON_ORDER[(Math.random() * 4) | 0];
          used.push(weapon);
          roster.push({ id: `a${t}${s}`, team: t, slot: s, name: names[ni++ % names.length], weapon, owner: this.me, bot: true });
        }
      }
    }
    return { t: 'start', mapId: settings.mapId, duration: settings.duration, difficulty: settings.difficulty, palette: (Math.random() * TEAM_PALETTES.length) | 0, roster };
  }

  // Reset readiness before either side starts asynchronous map loading, not at attach.
  prepare() {
    this.match = null; this.byId.clear(); this.loaded = new Set();
    this.splatBuf.length = 0; this.hitAcc.clear();
    this.stateT = this.splatT = this.clockT = 0;
  }

  // Match.setup 之后调用：记录每个角色的归属
  attach(match) {
    this.match = match;
    this.byId.clear();
    this.loaded.add(this.me);
    this._wrapPaint();
    this.splatBuf.length = 0;
    for (const a of match.actors) {
      this.byId.set(a.netId, a);
      if (!a.netAuth) a.remote = { buf: [], firing: false, rolling: false, charge: 0, subAim: false, lastAlive: true };
    }
  }
  detach() { this.match = null; this.byId.clear(); }

  markLoaded() { if (this.isHost) this.loaded.add(this.me); if (!this.isHost || this.client.serverRelays) this.send({ t: 'ld' }); }
  everyoneLoaded() { return this.client.members.every((m) => this.client.serverRelays ? m.loaded : this.loaded.has(m.id)); }

  // ------------------------------------------------------------------ transport
  send(d, to) { this.client.send(d, to); }

  _recv(d, from) {
    if (!d || typeof d.t !== 'string') return;
    // 房主转发
    if (this.isHost && !this.client.serverRelays && from !== this.me) {
      if (BROADCAST.has(d.t)) for (const m of this.client.targets) if (m.id !== from) this.client.send(d, m.id);
      if (d.t === 'hit') {
        const v = this.byId.get(d.v);
        if (v && v.owner !== this.me) { this.client.send(d, v.owner); return; }
      }
    }
    switch (d.t) {
      case 'leave': return this._onLeave(from);
      case 'ld': this.loaded.add(from); return;
      case 'st': return this._onState(d);
      case 'sp': return this._onSplats(d);
      case 'f': return this._onFire(d);
      case 'bm': return this._onBeam(d);
      case 'th': return this._onThrow(d);
      case 'hit': return this._onHit(d);
      case 'kill': return this._onKill(d);
      case 'spc': { const a = this.byId.get(d.a); if (a) emit('special:use', { actor: a, id: d.id }); return; }
      case 'adopt': return this._onAdopt(d);
      case 'ck': if (this.match && !this.isHost) this.match.time = d.time; return;
      case 'ms': if (this.match && !this.isHost) { this.match.time = d.time ?? this.match.time; if (this.match.state !== d.s) this.match.setState(d.s); } return;
      case 'res': if (this.match && !this.isHost) this._onResult(d); return;
    }
    for (const fn of this.handlers) fn(d, from);
  }

  // ------------------------------------------------------------------ per-frame
  update(dt) {
    const m = this.match;
    if (!m) return;
    this.stateT += dt; this.splatT += dt; this.clockT += dt;
    if (this.stateT >= 1 / STATE_HZ) {
      this.stateT = 0;
      const mine = m.actors.filter((a) => a.netAuth).map(packState);
      if (mine.length) this.send({ t: 'st', a: mine });
    }
    if (this.splatT >= 0.05) { this.splatT = 0; this._flushSplats(); this._flushHits(); }
    if (this.isHost && this.clockT >= 1 && m.state === 'playing') { this.clockT = 0; this.send({ t: 'ck', time: +m.time.toFixed(2) }); }
  }

  // 房主切换比赛阶段时广播
  hostState(s) { if (this.isHost) this.send({ t: 'ms', s, time: this.match ? +this.match.time.toFixed(2) : 0 }); }
  hostResult(result) {
    if (!this.isHost) return;
    const stats = this.match.actors.map((a) => [a.netId, Math.round(a.stats.turf), a.stats.splats, a.stats.deaths]);
    this.send({ t: 'res', cov: result.coverage, win: result.winner, stats });
  }
  _onResult(d) {
    const m = this.match;
    for (const [id, turf, splats, deaths] of d.stats || []) { const a = this.byId.get(id); if (a) Object.assign(a.stats, { turf, splats, deaths }); }
    m.time = 0;
    m.result = { coverage: d.cov, winner: d.win };
    m.setState('judge');
  }

  // ------------------------------------------------------------------ remote actors
  _onState(d) {
    const now = performance.now() / 1000;
    for (const s of d.a) {
      const a = this.byId.get(s[0]);
      if (!a || a.netAuth || !a.remote) continue;
      const r = a.remote;
      r.buf.push({ t: now, s });
      if (r.buf.length > 30) r.buf.shift();
    }
  }

  // 代替 actor.update：按缓冲插值，驱动动画
  remoteUpdate(a, dt) {
    const r = a.remote;
    if (!r.buf.length) { a.character.setVisible(false); return; }
    const t = performance.now() / 1000 - INTERP;
    let i = r.buf.length - 1;
    while (i > 0 && r.buf[i - 1].t > t) i--;
    const B = r.buf[i], A = r.buf[i - 1] || B;
    const k = B.t > A.t ? Math.min(1, Math.max(0, (t - A.t) / (B.t - A.t))) : 1;
    const sa = A.s, sb = B.s, last = r.buf[r.buf.length - 1].s;
    const flags = last[9];
    const alive = !!(flags & F.alive);
    if (!alive) {
      if (a.alive) a.splat(null, 'net');     // 丢了 kill 包时的兜底
      a.respawnTimer = Math.max(0, a.respawnTimer - dt);
      return;
    }
    if (!a.alive) {                          // 复活
      this.mute++; try { a.respawn(); } finally { this.mute--; }
      r.buf = r.buf.slice(-1);
      a.pos.set(last[1], last[2], last[3]);
    }
    // A render frame can run before the first snapshot. Restore the actor that
    // was hidden while waiting; otherwise it stays invisible until respawn.
    a.character.setVisible(true);
    const tele = Math.hypot(sb[1] - sa[1], sb[3] - sa[3]) > 5;
    const L = (x, y) => (tele ? y : x + (y - x) * k);
    a.pos.set(L(sa[1], sb[1]), L(sa[2], sb[2]), L(sa[3], sb[3]));
    a.vel.set(sb[4], sb[5], sb[6]);
    let dy = sb[7] - sa[7];
    dy = ((dy + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    a.yaw = sa[7] + dy * k;
    a.aimYaw = sb[8]; a.aimPitch = sb[10];
    const cp = Math.cos(a.aimPitch);
    a.aimDir.set(Math.sin(a.aimYaw) * cp, Math.sin(a.aimPitch), Math.cos(a.aimYaw) * cp);
    a.form = flags & F.squid ? 'squid' : 'kid';
    a.submerged = !!(flags & F.sub); a.climbing = !!(flags & F.climb); a.grounded = !!(flags & F.ground);
    a.invuln = flags & F.invuln ? 1 : 0;
    r.firing = !!(flags & F.firing); r.rolling = !!(flags & F.rolling); r.subAim = !!(flags & F.subAim);
    r.charge = last[11];
    a.hp = last[12]; a.ink = last[13]; a.special = last[14];
    a.stats.turf = last[15];
    a.specialActive = flags & F.special ? (a.specialActive || { id: a.weapon.special, t: 0, phase: 'net' }) : null;
    // 地面墨迹（脚步声/特效用）
    a._surface?.();
    a._finishFrame(dt);
  }

  // ------------------------------------------------------------------ paint
  _wrapPaint() {
    const paint = G.paint;
    if (paint._netWrapped) { paint._netSession = this; return; }
    const orig = paint.splat.bind(paint);
    paint._origSplat = orig;
    paint._netWrapped = true;
    paint._netSession = this;
    paint.splat = (c, r, team, opts = {}) => {
      const s = paint._netSession;
      if (!s || !s.match) return orig(c, r, team, opts);
      if (s.mute > 0 || (G.paintOwner && !G.paintOwner.netAuth)) return 0;
      const area = orig(c, r, team, opts);
      const st = opts.stretch;
      s.splatBuf.push([rd(c.x), rd(c.y), rd(c.z), rd(r), team, +(opts.seed ?? 0).toFixed(4),
        st ? rd(st.x) : 0, st ? rd(st.y) : 0, st ? rd(st.z) : 0, st ? +(opts.stretchAmt ?? 1).toFixed(2) : 0, opts.instant ? 1 : 0]);
      return area;
    };
  }
  _flushSplats() { if (this.splatBuf.length) { this.send({ t: 'sp', s: this.splatBuf }); this.splatBuf = []; } }
  _onSplats(d) {
    if (!this.match) return;
    const orig = G.paint._origSplat, c = _v, st = _v2;
    for (const s of d.s) {
      c.set(s[0], s[1], s[2]);
      const opts = { seed: s[5] };
      if (s[9]) { opts.stretch = st.set(s[6], s[7], s[8]); opts.stretchAmt = s[9]; }
      if (s[10]) opts.instant = true;
      orig(c, s[3], s[4], opts);
    }
  }
  // 在"非本机权威"的逻辑里运行 fn 时不涂墨（墨迹由拥有者广播过来）
  muted(owner, fn) {
    if (!owner || owner.netAuth) return fn();
    this.mute++;
    try { return fn(); } finally { this.mute--; }
  }

  // ------------------------------------------------------------------ fire replication
  onShots(a, shots) {
    this.send({ t: 'f', a: a.netId, p: shots.map((p) => ({
      type: p.type, life: p.life, straight: p.straight, radius: p.radius, damage: p.damage, dmgFar: p.dmgFar, size: p.size,
      trail: p.trail, trailEvery: p.trailEvery, trailRadius: p.trailRadius, grav: p.grav, drag: p.drag, seed: p.seed,
      pos: v3(p.pos), vel: v3(p.vel), start: v3(p.start),
    })) });
  }
  _onFire(d) { const a = this.byId.get(d.a); if (a && !a.netAuth && a.alive) G.projectiles.replayShots(a, d.p); }

  onBeam(a, m, dir, len, charge) { this.send({ t: 'bm', a: a.netId, m: v3(m), d: v3(dir), l: rd(len), c: +charge.toFixed(3) }); }
  _onBeam(d) { const a = this.byId.get(d.a); if (a && !a.netAuth) G.projectiles.replayBeam(a, _v.fromArray(d.m).clone(), _v2.fromArray(d.d).clone(), d.l, d.c); }

  onThrow(a, kind, pos, vel) { this.send({ t: 'th', a: a.netId, k: kind, p: v3(pos), v: v3(vel) }); }
  _onThrow(d) { const a = this.byId.get(d.a); if (a && !a.netAuth) G.projectiles.replayThrow(a, d.k, _v.fromArray(d.p).clone(), _v2.fromArray(d.v).clone()); }

  onSpecial(a, id) { if (a.netAuth) this.send({ t: 'spc', a: a.netId, id }); }

  // ------------------------------------------------------------------ damage / death
  // 攻击方权威：命中非本机角色时，把伤害发给它的拥有者
  sendHit(attacker, victim, dmg, weaponId) {
    const key = victim.netId + '|' + attacker.netId + '|' + weaponId;
    this.hitAcc.set(key, (this.hitAcc.get(key) || 0) + dmg);
    if (weaponId !== 'storm') this._flushHits();
  }
  _flushHits() {
    for (const [key, dmg] of this.hitAcc) {
      const [v, a, w] = key.split('|');
      const victim = this.byId.get(v);
      if (!victim) continue;
      const pkt = { t: 'hit', v, a, d: +dmg.toFixed(1), w };
      if (this.isHost) this.send(pkt, victim.owner); else this.send(pkt);
    }
    this.hitAcc.clear();
  }
  _onHit(d) {
    const v = this.byId.get(d.v), a = this.byId.get(d.a);
    if (!v || !a || !v.netAuth || !v.alive) return;
    const killed = v.damage(d.d, a, d.w);
    emit('hit', { attacker: a, victim: v, damage: d.d, killed, weaponId: d.w });
  }

  // 拥有者判定死亡后广播
  onSplatted(victim, attacker, cause) {
    if (!victim.netAuth) return;
    this.send({ t: 'kill', v: victim.netId, a: attacker ? attacker.netId : null, c: cause });
  }
  _onKill(d) {
    const v = this.byId.get(d.v);
    if (!v || v.netAuth || !v.alive) return;
    this.mute++;
    try { v.splat(d.a ? this.byId.get(d.a) : null, d.c); } finally { this.mute--; }
  }

  // ------------------------------------------------------------------ disconnects
  _onLeave(peerId) {
    for (const fn of this.handlers) fn({ t: 'peer-left' }, peerId);
    if (!this.match) return;
    if (peerId === this.client.room.host) { for (const fn of this.handlers) fn({ t: 'host-left' }, peerId); return; }
    if (!this.isHost) return;
    for (const a of this.match.actors) if (a.owner === peerId) {
      this._adopt(a, this.me);
      this.send({ t: 'adopt', a: a.netId, owner: this.me });
    }
  }
  _onAdopt(d) { const a = this.byId.get(d.a); if (a) this._adopt(a, d.owner); }
  _adopt(a, owner) {
    a.owner = owner;
    if (owner === this.me) {
      a.netAuth = true; a.remote = null; a.isBot = true;
      a.character.setVisible(a.alive);
      a.bot = this.match.makeBot(a);
      if (!a.alive) a.respawnTimer = Math.min(a.respawnTimer, 2);
    } else if (!a.remote) a.remote = { buf: [], firing: false, rolling: false, charge: 0, subAim: false };
  }

  close() {
    this._flushSplats();
    if (G.paint) G.paint._netSession = null;
    this.client.close();
  }
}

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const rd = (x) => Math.round(x * 1000) / 1000;
const v3 = (v) => [rd(v.x), rd(v.y), rd(v.z)];

function packState(a) {
  const wr = a.weaponRunner;
  const flags = (a.alive ? F.alive : 0) | (a.form === 'squid' ? F.squid : 0) | (a.submerged ? F.sub : 0) | (a.climbing ? F.climb : 0) |
    (a.grounded ? F.ground : 0) | (wr.firingPose() ? F.firing : 0) | (wr.rolling ? F.rolling : 0) | (a.specialActive ? F.special : 0) |
    (a.superJumpState ? F.sj : 0) | (wr.aimingSub ? F.subAim : 0) | (a.invuln > 0 ? F.invuln : 0);
  return [a.netId, rd(a.pos.x), rd(a.pos.y), rd(a.pos.z), +a.vel.x.toFixed(2), +a.vel.y.toFixed(2), +a.vel.z.toFixed(2),
    +a.yaw.toFixed(3), +a.aimYaw.toFixed(3), flags, +a.aimPitch.toFixed(3), +(wr.charge || 0).toFixed(2),
    Math.round(a.hp), Math.round(a.ink), Math.round(a.special), Math.round(a.stats.turf)];
}

export { PLAYER };
