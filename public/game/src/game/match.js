// Match: turf-war rules, lifecycle (intro → countdown → play → time's up → judge → results), team setup.
import * as THREE from 'three';
import { G, emit, on, clamp } from '../core/ctx.js';
import { MATCH, PLAYER, WEAPON_ORDER, BOT_NAMES, TEAM_NAMES } from '../config.js';
import { Actor } from './actor.js';
import { BotBrain } from './bots.js';
import { PlayerController } from './player.js';

const _v = new THREE.Vector3();

export class Match {
  constructor(opts) {
    this.opts = opts;
    this.net = opts.net || null;   // NetSession when online
    // { duration, difficulty, attract, playerName, weapon, CharacterClass, input, rig }
    this.attract = !!opts.attract;
    this.duration = opts.duration || MATCH.defaultDuration;
    this.time = this.duration;
    this.state = 'init';
    this.stateT = 0;
    this.actors = [];
    this.controller = null;
    this.result = null;
    this.paused = false;
    this.lastMinuteFired = false;
    this.lastCount = 99;
    this.events = [];
  }

  playing() { return this.state === 'playing' && !this.paused; }
  canRespawn() { return this.state === 'playing'; }

  setup() {
    const o = this.opts;
    const CharacterClass = o.CharacterClass;
    // weapons: each team gets a balanced mix
    const pickTeam = (first) => {
      const pool = [...WEAPON_ORDER];
      const out = [];
      if (first) { out.push(first); pool.splice(pool.indexOf(first), 1); }
      while (out.length < MATCH.teamSize) {
        if (!pool.length) pool.push(...WEAPON_ORDER);
        out.push(pool.splice((Math.random() * pool.length) | 0, 1)[0]);
      }
      return out;
    };
    const names = shuffle([...BOT_NAMES]);
    let ni = 0;
    // online: the host's roster decides every slot (owner = peer that simulates it)
    if (o.net && o.roster) {
      const me = o.net.me;
      for (const r of o.roster) {
        const mine = r.owner === me;
        const isLocal = mine && !r.bot;
        const a = new Actor({ team: r.team, slot: r.slot, weapon: r.weapon, isLocal, isBot: r.bot && mine, name: r.name,
          style: { hair: r.slot % 4, skin: (r.slot * 3 + r.team) % 4 }, CharacterClass });
        a.netId = r.id; a.owner = r.owner; a.netAuth = mine;
        G.scene.add(a.character.root);
        if (r.bot && mine) a.bot = new BotBrain(a, o.difficulty);
        this.actors.push(a);
      }
    }
    for (let team = 0; team < 2 && !(o.net && o.roster); team++) {
      const weapons = pickTeam(team === 0 && !this.attract ? o.weapon : null);
      for (let s = 0; s < MATCH.teamSize; s++) {
        const isLocal = team === 0 && s === 0 && !this.attract;
        const a = new Actor({
          team, slot: s, weapon: weapons[s], isLocal, isBot: !isLocal,
          name: isLocal ? (o.playerName || 'You') : names[ni++ % names.length],
          style: { hair: (Math.random() * 4) | 0, skin: (Math.random() * 4) | 0 }, CharacterClass,
        });
        if (isLocal && o.style) { /* reserved for future customisation */ }
        G.scene.add(a.character.root);
        if (!isLocal || o.autopilot) a.bot = new BotBrain(a, o.difficulty);
        this.actors.push(a);
      }
    }
    G.actors = this.actors;
    this.local = this.actors.find((a) => a.isLocal) || null;
    G.local = this.local;
    if (this.local && !o.autopilot) this.controller = new PlayerController(this.local, o.rig, o.input);
    // initial placement on the spawn decks (standing, no drop)
    for (const a of this.actors) {
      const pad = G.level.spawnPads[a.team];
      const ang = (a.slot / MATCH.teamSize) * Math.PI * 2 + 0.6;
      _v.set(pad.x + Math.cos(ang) * 1.2, pad.y, pad.z + Math.sin(ang) * 1.2);
      a.spawnAt(_v, a.team === 0 ? 0 : Math.PI);
      a.invuln = 0;
      if (a.bot) { a.bot.aimYaw = a.yaw; a.bot.aimPitch = 0; }
    }
    this.unsubs = [
      on('splatted', (e) => this._onSplatted(e)),
    ];
  }

  makeBot(a) { return new BotBrain(a, this.opts.difficulty); }

  start() {
    this.setState(this.attract ? 'playing' : 'intro');
  }

  setState(s) {
    this.state = s; this.stateT = 0;
    emit('match:state', { state: s, match: this });
  }

  dispose() {
    for (const a of this.actors) { G.scene.remove(a.character.root); a.weaponRunner.reset(); a.character.dispose?.(); }
    this.unsubs?.forEach((u) => u());
    G.actors = [];
    G.local = null;
  }

  _onSplatted({ victim, attacker, cause }) {
    this.events.push({ t: this.duration - this.time, victim, attacker, cause });
  }

  update(dt) {
    if (this.paused) return;
    this.stateT += dt;
    switch (this.state) {
      case 'intro':
        // online: never start simulation before every remaining member has loaded.
        if (this.net) { if (this.net.isHost && this.stateT > 4.2 && this.net.everyoneLoaded()) { this.setState('playing'); this.net.hostState('playing'); } }
        else if (this.stateT > 4.2) this.setState('playing');
        break;
      case 'playing': {
        this.time -= dt;
        if (!this.attract) {
          if (!this.lastMinuteFired && this.time <= 60 && this.duration > 60) { this.lastMinuteFired = true; emit('match:oneminute', {}); }
          const c = Math.ceil(this.time);
          if (this.time <= MATCH.finalCountdown && c !== this.lastCount && c > 0) { this.lastCount = c; emit('match:count', { n: c }); }
        }
        if (this.time <= 0) {
          this.time = 0;
          if (!this.net || this.net.isHost) { this.setState('finish'); this.net?.hostState('finish'); }
        }
        break;
      }
      case 'finish':
        if (this.stateT > 2.6 && (!this.net || this.net.isHost)) this._judge();
        break;
    }
    // actors (the local controller runs once per rendered frame via updateController)
    const live = this.state === 'playing';
    for (const a of this.actors) {
      if (a.bot) {
        if (live) a.bot.update(dt);
        else { a.intent.move.set(0, 0, 0); a.intent.fire = a.intent.squid = a.intent.sub = a.intent.jump = a.intent.special = false; }
      }
    }
    for (const a of this.actors) { if (a.remote) this.net.remoteUpdate(a, dt); else a.update(dt); }
    this.net?.update(dt);
    // soft push between actors
    for (let i = 0; i < this.actors.length; i++) for (let j = i + 1; j < this.actors.length; j++) {
      const a = this.actors[i], b = this.actors[j];
      if (!a.alive || !b.alive || (a.remote && b.remote)) continue;
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z, dy = b.pos.y - a.pos.y;
      const d2 = dx * dx + dz * dz;
      const r = PLAYER.radius * 1.7;
      if (d2 < r * r && Math.abs(dy) < 1.2 && d2 > 1e-5) {
        const d = Math.sqrt(d2), push = (r - d) * 0.5;
        if (!a.remote) { a.pos.x -= (dx / d) * push; a.pos.z -= (dz / d) * push; }
        if (!b.remote) { b.pos.x += (dx / d) * push; b.pos.z += (dz / d) * push; }
      }
    }
  }

  updateController(dt) {
    if (!this.controller) return;
    this.controller.enabled = this.state === 'playing' && !this.paused && !this.netMenu && this.local.alive;
    this.controller.update(dt);
  }

  _judge() {
    const cov = G.paint.coverage();
    const win = cov[0] === cov[1] ? (Math.random() < 0.5 ? 0 : 1) : cov[0] > cov[1] ? 0 : 1;
    this.result = { coverage: cov, winner: win };
    this.net?.hostResult(this.result);
    this.setState('judge');
  }

  teamSummary() {
    // your own team is always listed first (left side of the HUD)
    const mine = this.local ? this.local.team : 0;
    return [mine, 1 - mine].map((t) => ({
      color: G.teamHex[t],
      players: this.actors.filter((a) => a.team === t).map((a) => ({
        name: a.name, weapon: a.weaponId, alive: a.alive, respawn: a.alive ? 0 : Math.max(0, a.respawnTimer), specialReady: a.specialReady(), isSelf: a.isLocal,
      })),
    }));
  }
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }
