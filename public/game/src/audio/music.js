// INKWAVE — procedural music engine + shared Web Audio DSP core.
//
// Everything here is synthesized: no audio files. The DSP helpers (Voice builder `V`, envelopes, noise buffers,
// impulse responses, instrument voices) are exported so src/audio/audio.js can build its SFX with the same parts.
// All builders take any BaseAudioContext + destination node so they can be rendered through an OfflineAudioContext
// (see tools/audio-test.mjs).
//
//   import { music } from './music.js';
//   music.play('battle', { fade: 1 });   // 'title' | 'menu' | 'battle' | 'battle_final' | 'results_win' | 'results_lose' | null
//   music.setIntensity(0..1);            // adds / removes layers (drums drop to hats-only at low intensity)
//   music.stop(fade)
//
// audio.init() attaches the singleton to the real AudioContext's music bus (music._init(ctx, bus)).

/* ============================================================================================================
 * Shared DSP core
 * ==========================================================================================================*/

export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function mulberry32(a) {
  a = a >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const perCtx = new WeakMap();
function cache(ctx) {
  let m = perCtx.get(ctx);
  if (!m) { m = new Map(); perCtx.set(ctx, m); }
  return m;
}

// Seamlessly looping 2 s mono noise buffers: 'white' | 'pink' | 'brown'. RMS-normalised to ~0.3.
export function noiseBuffer(ctx, kind = 'white') {
  const c = cache(ctx);
  const key = 'noise:' + kind;
  let b = c.get(key);
  if (b) return b;
  const sr = ctx.sampleRate, len = Math.floor(sr * 2);
  b = ctx.createBuffer(1, len, sr);
  const d = b.getChannelData(0);
  const rnd = mulberry32(kind === 'white' ? 11 : kind === 'pink' ? 23 : 37);
  const w = new Float32Array(len);
  for (let i = 0; i < len; i++) w[i] = rnd() * 2 - 1;
  if (kind === 'white') d.set(w);
  else {
    // every IIR runs twice around the loop (warm-up pass, then the written pass) so its state at the end equals
    // its state at the start → the colored noise is exactly periodic and loops without a step
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < len; i++) {
        const x = w[i];
        let y;
        if (kind === 'pink') {
          b0 = 0.99886 * b0 + x * 0.0555179; b1 = 0.99332 * b1 + x * 0.0750759; b2 = 0.969 * b2 + x * 0.153852;
          b3 = 0.8665 * b3 + x * 0.3104856; b4 = 0.55 * b4 + x * 0.5329522; b5 = -0.7616 * b5 - x * 0.016898;
          y = b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362; b6 = x * 0.115926;
        } else { last = (last + 0.02 * x) / 1.02; y = last; }
        if (pass) d[i] = y;
      }
    }
    // DC-block (one-pole HPF ~25 Hz), also circular
    const a = Math.exp((-2 * Math.PI * 25) / sr);
    let y = 0, px = d[len - 1];
    const tmp = new Float32Array(len);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < len; i++) { const x = d[i]; y = a * (y + x - px); px = x; if (pass) tmp[i] = y; }
    }
    d.set(tmp);
  }
  let mean = 0;
  for (let i = 0; i < len; i++) mean += d[i];
  mean /= len;
  for (let i = 0; i < len; i++) d[i] -= mean;
  let ss = 0;
  for (let i = 0; i < len; i++) ss += d[i] * d[i];
  const g = 0.3 / Math.sqrt(ss / len);
  for (let i = 0; i < len; i++) d[i] *= g;
  c.set(key, b);
  return b;
}

// Stereo reverb impulse: early reflections + exponentially decaying, darkening diffuse tail.
export function makeImpulse(ctx, seconds = 1.6, decay = 3.2, opt = {}) {
  const sr = ctx.sampleRate, len = Math.max(1, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(2, len, sr);
  const pre = Math.floor((opt.pre ?? 0.01) * sr);
  const bright = opt.bright ?? 0.85, dark = opt.dark ?? 0.12;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const rnd = mulberry32((opt.seed ?? 71) + ch * 101);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const x = (i - pre) / (len - pre);
      const env = Math.exp(-x * decay * 2.3) * (1 - x) * Math.min(1, (i - pre) / (0.002 * sr));
      const a = dark + (bright - dark) * Math.exp(-x * 4);
      lp += ((rnd() * 2 - 1) - lp) * a;
      d[i] = lp * env;
    }
    // early reflections (plaza walls), different per ear
    const taps = opt.taps ?? [[0.011, 0.5], [0.019, 0.36], [0.027, 0.3], [0.041, 0.22], [0.058, 0.15]];
    for (const [tt, amp] of taps) {
      const i = pre + Math.floor((tt + (ch ? 0.0031 : 0)) * sr);
      if (i < len - 2) { d[i] += amp * (ch ? -1 : 1); d[i + 1] += amp * 0.4; }
    }
  }
  return buf;
}

// tanh drive curve (odd length so 0 maps exactly to 0)
const curves = new Map();
export function driveCurve(k) {
  const key = Math.round(k * 100);
  let c = curves.get(key);
  if (c) return c;
  const n = 2049;
  c = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / norm; }
  curves.set(key, c);
  return c;
}

// Pulse-wave PeriodicWave (duty 0..1), band-limited by construction.
export function pulseWave(ctx, duty = 0.25) {
  const c = cache(ctx), key = 'pulse:' + duty;
  let w = c.get(key);
  if (w) return w;
  const N = 48, re = new Float32Array(N + 1), im = new Float32Array(N + 1);
  for (let n = 1; n <= N; n++) {
    re[n] = Math.sin(2 * Math.PI * n * duty) / (n * Math.PI);
    im[n] = (1 - Math.cos(2 * Math.PI * n * duty)) / (n * Math.PI);
  }
  w = ctx.createPeriodicWave(re, im);
  c.set(key, w);
  return w;
}

// A decaying pulse train shape (for snare-roll amplitude modulation): sharp attack, exponential fall.
export function strokeWave(ctx, sharp = 7) {
  const c = cache(ctx), key = 'stroke:' + sharp;
  let w = c.get(key);
  if (w) return w;
  const N = 40, M = 2048, re = new Float32Array(N + 1), im = new Float32Array(N + 1);
  for (let n = 1; n <= N; n++) {
    let a = 0, b = 0;
    for (let i = 0; i < M; i++) {
      const ph = i / M, e = Math.exp(-ph * sharp) * Math.min(1, ph * 60);
      a += e * Math.cos(2 * Math.PI * n * ph); b += e * Math.sin(2 * Math.PI * n * ph);
    }
    re[n] = (2 * a) / M; im[n] = (2 * b) / M;
  }
  w = ctx.createPeriodicWave(re, im);
  c.set(key, w);
  return w;
}

const fmin = 1e-4;
// Envelopes. All start from 0 and end at exactly 0 (never click). Return the end time.
export function perc(p, t, a, peak, d) {
  peak = Math.max(peak, fmin);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.exponentialRampToValueAtTime(Math.max(peak * 0.001, 1e-6), t + a + d);
  p.linearRampToValueAtTime(0, t + a + d + 0.008);
  return t + a + d + 0.008;
}
export function ahr(p, t, a, peak, h, r) {
  peak = Math.max(peak, fmin);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.setValueAtTime(peak, t + a + h);
  p.exponentialRampToValueAtTime(Math.max(peak * 0.001, 1e-6), t + a + h + r);
  p.linearRampToValueAtTime(0, t + a + h + r + 0.008);
  return t + a + h + r + 0.008;
}
// gate = seconds from t until release starts.
export function adsr(p, t, a, d, s, peak, gate, r) {
  peak = Math.max(peak, fmin);
  const sus = Math.max(peak * s, 1e-5);
  const ta = t + a, tg = t + Math.max(gate, a + 0.002);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, ta);
  let v;
  if (tg < ta + d) { v = peak * Math.pow(sus / peak, (tg - ta) / d); p.exponentialRampToValueAtTime(v, tg); }
  else { v = sus; p.exponentialRampToValueAtTime(sus, ta + d); p.setValueAtTime(sus, tg); }
  p.exponentialRampToValueAtTime(Math.max(v * 0.001, 1e-6), tg + r);
  p.linearRampToValueAtTime(0, tg + r + 0.008);
  return tg + r + 0.008;
}
// Piecewise-linear envelope from [[dt, value], ...] (first point should be [0, 0], last value 0).
export function pts(p, t, list) {
  p.setValueAtTime(list[0][1], t + list[0][0]);
  for (let i = 1; i < list.length; i++) p.linearRampToValueAtTime(list[i][1], t + list[i][0]);
  return t + list[list.length - 1][0];
}
export function sweep(p, t, f0, f1, dur, lin) {
  p.setValueAtTime(f0, t);
  if (lin) p.linearRampToValueAtTime(f1, t + dur);
  else p.exponentialRampToValueAtTime(Math.max(f1, 1e-3), t + dur);
}

// Voice builder: creates + tracks nodes for one note / one sound, disposes them when the last source ends.
export class V {
  constructor(ctx, out, t, rng) {
    this.ctx = ctx; this.out = out; this.t = t; this.rng = rng || Math.random;
    this.nodes = []; this.srcs = []; this.end = t; this.dead = false; this.endless = false;
    this.nyq = ctx.sampleRate * 0.5 - 200;
  }
  r(a = 0, b = 1) { return a + (b - a) * this.rng(); }
  pick(arr) { return arr[Math.floor(this.rng() * arr.length) % arr.length]; }
  gain(v = 0, to) {
    const g = this.ctx.createGain(); g.gain.value = v; this.nodes.push(g);
    if (to) g.connect(to);
    return g;
  }
  filter(type, f, Q = 0.707, to, gainDb) {
    const b = this.ctx.createBiquadFilter(); b.type = type;
    b.frequency.value = Math.min(Math.max(f, 10), this.nyq); b.Q.value = Q;
    if (gainDb !== undefined) b.gain.value = gainDb;
    this.nodes.push(b);
    if (to) b.connect(to);
    return b;
  }
  shaper(k, to) {
    const w = this.ctx.createWaveShaper(); w.curve = driveCurve(k); w.oversample = '2x'; this.nodes.push(w);
    if (to) w.connect(to);
    return w;
  }
  pan(p, to) {
    const n = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : this.ctx.createGain();
    if (n.pan) n.pan.value = Math.max(-1, Math.min(1, p));
    this.nodes.push(n);
    if (to) n.connect(to);
    return n;
  }
  delay(time, to, max = 1) {
    const d = this.ctx.createDelay(max); d.delayTime.value = time; this.nodes.push(d);
    if (to) d.connect(to);
    return d;
  }
  _src(s, t0, t1, to) {
    if (to) s.connect(to);
    s.start(Math.max(0, t0));
    if (t1 != null) { s._end = Math.max(t1, t0 + 0.002); s.stop(s._end); this.end = Math.max(this.end, s._end); }
    else { s._end = Infinity; this.endless = true; }
    this.srcs.push(s); this.nodes.push(s);
    return s;
  }
  osc(type, f, t0, t1, to) {
    const o = this.ctx.createOscillator();
    if (typeof type === 'string') o.type = type; else o.setPeriodicWave(type);
    o.frequency.value = Math.min(f, this.nyq);
    return this._src(o, t0, t1, to);
  }
  noise(kind, t0, t1, to, rate = 1) {
    const s = this.ctx.createBufferSource(); s.buffer = noiseBuffer(this.ctx, kind); s.loop = true;
    s.playbackRate.value = rate;
    if (to) s.connect(to);
    s.start(Math.max(0, t0), this.rng() * 1.9);
    if (t1 != null) { s._end = Math.max(t1, t0 + 0.002); s.stop(s._end); this.end = Math.max(this.end, s._end); }
    else { s._end = Infinity; this.endless = true; }
    this.srcs.push(s); this.nodes.push(s);
    return s;
  }
  buffer(buf, t0, t1, to, rate = 1, offset) {
    const s = this.ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate;
    if (to) s.connect(to);
    s.start(Math.max(0, t0), offset ?? this.rng() * buf.duration * 0.95);
    if (t1 != null) { s._end = Math.max(t1, t0 + 0.002); s.stop(s._end); this.end = Math.max(this.end, s._end); }
    else { s._end = Infinity; this.endless = true; }
    this.srcs.push(s); this.nodes.push(s);
    return s;
  }
  // LFO → param: returns { osc, depth(gain) }
  lfo(rate, depth, param, t0, t1, type = 'sine') {
    const g = this.gain(depth); g.connect(param);
    const o = this.osc(type, rate, t0, t1, g);
    return { osc: o, depth: g };
  }
  // ---- compound one-liners (times: `at` absolute, else `t` relative to this.t) ----
  tone(o) {
    const T = o.at ?? this.t + (o.t || 0);
    const g = this.gain(0, o.to || this.out);
    const end = o.h != null ? ahr(g.gain, T, o.a ?? 0.002, o.peak ?? 0.5, o.h, o.d ?? 0.1)
      : perc(g.gain, T, o.a ?? 0.002, o.peak ?? 0.5, o.d ?? 0.1);
    const x = this.osc(o.type || 'sine', o.f, T, end + 0.01, g);
    if (o.f1 != null) sweep(x.frequency, T, Math.min(o.f, this.nyq), Math.min(o.f1, this.nyq), o.sw ?? ((o.a ?? 0.002) + (o.d ?? 0.1)), o.lin);
    if (o.detune) x.detune.value = o.detune;
    return x;
  }
  nz(o) {
    const T = o.at ?? this.t + (o.t || 0);
    const g = this.gain(0, o.to || this.out);
    const ft = o.ft === undefined ? 'bandpass' : o.ft;
    const fl = ft ? this.filter(ft, o.f ?? 1000, o.q ?? 1, g) : null;
    const end = o.h != null ? ahr(g.gain, T, o.a ?? 0.001, o.peak ?? 0.5, o.h, o.d ?? 0.1)
      : perc(g.gain, T, o.a ?? 0.001, o.peak ?? 0.5, o.d ?? 0.1);
    this.noise(o.kind || 'white', T, end + 0.01, fl || g, o.rate || 1);
    if (fl && o.f1 != null) sweep(fl.frequency, T, Math.min(o.f, this.nyq), Math.min(o.f1, this.nyq), o.sw ?? ((o.a ?? 0.001) + (o.d ?? 0.1)), o.lin);
    return fl;
  }
  // bubble "plip": damped sine with rising pitch (Minnaert-style)
  bub(T, f, peak, d = 0.03, rise = 1.7, to) {
    return this.tone({ at: T, f, f1: f * rise, sw: d, a: 0.0012, d, peak, to });
  }
  // cleanup when the last finite source ends
  finish() {
    if (this.endless || !this.srcs.length) return this;
    let last = this.srcs[0];
    for (const s of this.srcs) if (s._end > last._end) last = s;
    last.onended = () => this.dispose();
    return this;
  }
  // stop every source at time `at` (the caller fades its output first)
  kill(at) {
    for (const s of this.srcs) {
      if (s._end > at) { try { s.stop(at); } catch (e) { /* already stopped */ } s._end = at; }
    }
    this.end = at; this.endless = false;
    this.finish();
  }
  dispose() {
    if (this.dead) return;
    this.dead = true;
    for (const n of this.nodes) { try { n.disconnect(); } catch (e) { /* ignore */ } }
    this.nodes.length = 0; this.srcs.length = 0;
    if (this.ondispose) this.ondispose();
  }
}

/* ============================================================================================================
 * Instruments (shared by music + SFX). Signature: (v, T, ..., vel, opts) — T absolute time; output → opts.to || v.out
 * ==========================================================================================================*/

export function kick(v, T, vel = 1, o = {}) {
  const to = o.to || v.out;
  const g = v.gain(0, to);
  const end = perc(g.gain, T, 0.0015, vel, o.d ?? 0.34);
  const x = v.osc('sine', o.f0 ?? 165, T, end + 0.01, g);
  sweep(x.frequency, T, o.f0 ?? 165, o.f1 ?? 46, o.sw ?? 0.085);
  // a touch of saturation on the body for weight
  v.tone({ at: T, type: 'triangle', f: (o.f0 ?? 165) * 0.9, f1: (o.f1 ?? 46), sw: 0.06, a: 0.001, d: 0.08, peak: vel * 0.18, to });
  v.nz({ at: T, ft: 'highpass', f: 1600, q: 0.7, a: 0.0006, d: 0.012, peak: vel * 0.32, to });
  return end;
}

export function snare(v, T, vel = 1, o = {}) {
  const to = o.to || v.out;
  v.tone({ at: T, type: 'triangle', f: o.f ?? 205, f1: (o.f ?? 205) * 0.82, sw: 0.05, a: 0.001, d: 0.11, peak: vel * 0.5, to });
  v.tone({ at: T, type: 'sine', f: 330, f1: 290, sw: 0.03, a: 0.001, d: 0.06, peak: vel * 0.22, to });
  v.nz({ at: T, ft: 'highpass', f: 1300, q: 0.8, a: 0.001, d: o.d ?? 0.19, peak: vel * 0.72, to });
  return v.nz({ at: T, ft: 'bandpass', f: 4200, q: 0.9, a: 0.001, d: 0.09, peak: vel * 0.32, to });
}

export function clap(v, T, vel = 1, o = {}) {
  const to = o.to || v.out;
  const g = v.gain(0, to);
  const bp = v.filter('bandpass', 1150, 1.1, g);
  const hp = v.filter('highpass', 600, 0.7, bp);
  const p = g.gain, pk = vel * 0.9;
  p.setValueAtTime(0, T);
  for (let k = 0; k < 3; k++) {
    const tk = T + k * 0.0105;
    p.linearRampToValueAtTime(pk, tk + 0.0008);
    p.linearRampToValueAtTime(pk * 0.12, tk + 0.0095);
  }
  const t3 = T + 0.0315;
  p.linearRampToValueAtTime(pk, t3 + 0.001);
  p.exponentialRampToValueAtTime(pk * 0.001, t3 + (o.d ?? 0.2));
  p.linearRampToValueAtTime(0, t3 + (o.d ?? 0.2) + 0.008);
  v.noise('white', T, t3 + (o.d ?? 0.2) + 0.02, hp);
}

export function hat(v, T, vel = 1, open = false, o = {}) {
  const to = o.to || v.out;
  const g = v.gain(0, to);
  const end = perc(g.gain, T, 0.0008, vel, open ? (o.d ?? 0.32) : (o.d ?? 0.045));
  const pk = v.filter('peaking', 10500, 1.2, g, 5);
  const hp = v.filter('highpass', open ? 6500 : 7500, 0.8, pk);
  v.noise('white', T, end + 0.01, hp);
  return g.gain;
}

export function crash(v, T, vel = 1, o = {}) {
  const to = o.to || v.out;
  v.nz({ at: T, ft: 'highpass', f: 4200, q: 0.6, a: 0.001, d: o.d ?? 1.6, peak: vel * 0.55, to });
  v.nz({ at: T, ft: 'bandpass', f: 7200, q: 0.9, a: 0.001, d: (o.d ?? 1.6) * 0.5, peak: vel * 0.35, to });
  // metallic shimmer partials
  const hp = v.filter('highpass', 3000, 0.7, to);
  for (const f of [3410, 4870, 6230]) v.tone({ at: T, type: 'square', f, a: 0.001, d: 0.5, peak: vel * 0.02, to: hp });
}

export function rim(v, T, vel = 1, o = {}) {
  const to = o.to || v.out;
  v.tone({ at: T, type: 'triangle', f: 1750, f1: 1500, sw: 0.02, a: 0.0005, d: 0.03, peak: vel * 0.45, to });
  v.nz({ at: T, ft: 'bandpass', f: 2600, q: 2, a: 0.0005, d: 0.02, peak: vel * 0.45, to });
}

export function shaker(v, T, vel = 1, o = {}) {
  v.nz({ at: T, ft: 'bandpass', f: 7000, q: 1.2, a: 0.006, d: 0.05, peak: vel * 0.5, to: o.to || v.out });
}

export function tom(v, T, f, vel = 1, o = {}) {
  const to = o.to || v.out;
  v.tone({ at: T, f: f * 1.5, f1: f, sw: 0.06, a: 0.001, d: o.d ?? 0.35, peak: vel * 0.8, to });
  v.nz({ at: T, ft: 'lowpass', f: 1800, q: 0.8, a: 0.001, d: 0.05, peak: vel * 0.25, to, kind: 'pink' });
}

export function bass(v, T, f, gate, vel = 1, o = {}) {
  const to = o.to || v.out, style = o.style || 'punk';
  const g = v.gain(0, to);
  if (style === 'funk') {
    const end = adsr(g.gain, T, 0.002, 0.22, 0.45, vel, gate, 0.05);
    const lp = v.filter('lowpass', 300, 7, g);
    sweep(lp.frequency, T, 2600 * (0.6 + 0.4 * vel), 330, 0.12);
    v.osc('square', f, T, end + 0.01, lp);
    const sg = v.gain(0.55, g); v.osc('sine', f, T, end + 0.01, sg);
    return end;
  }
  if (style === 'sub') {
    const end = adsr(g.gain, T, 0.008, 0.3, 0.75, vel, gate, 0.1);
    const lp = v.filter('lowpass', 900, 0.8, g);
    v.osc('sine', f, T, end + 0.01, lp);
    const h = v.gain(0.25, lp); v.osc('triangle', f * 2, T, end + 0.01, h);
    return end;
  }
  // punk: saw + detuned square through an enveloped resonant low-pass, then drive
  const end = adsr(g.gain, T, 0.003, 0.2, 0.72, vel, gate, 0.05);
  const sh = v.shaper(o.drive ?? 2.2, g);
  const pre = v.gain(0.55, sh);
  const lp = v.filter('lowpass', 200, 4.5, pre);
  lp.frequency.setValueAtTime(220, T);
  lp.frequency.exponentialRampToValueAtTime(700 + 1300 * vel, T + 0.012);
  lp.frequency.exponentialRampToValueAtTime(520, T + 0.22);
  v.osc('sawtooth', f, T, end + 0.01, lp);
  const sq = v.osc('square', f, T, end + 0.01, lp); sq.detune.value = -8;
  const sub = v.gain(0.6, g); v.osc('sine', f, T, end + 0.01, sub);
  return end;
}

export function guitar(v, T, fs, gate, vel = 1, o = {}) {
  const to = o.to || v.out;
  const g = v.gain(0, to);
  const end = adsr(g.gain, T, 0.003, 0.35, o.mute ? 0.25 : 0.7, vel, gate, o.mute ? 0.04 : 0.09);
  const hp = v.filter('highpass', 110, 0.7, g);
  const pk = v.filter('peaking', 1900, 1.1, hp, 4);
  const lp = v.filter('lowpass', o.mute ? 1500 : 3600, 0.9, pk);
  const sh = v.shaper(o.drive ?? 5.5, lp);
  const pre = v.gain(0.42 / Math.sqrt(fs.length), sh);
  for (const f of fs) for (const dt of [-7, 6]) { const x = v.osc('sawtooth', f, T, end + 0.01, pre); x.detune.value = dt; }
  return end;
}

// FM electric piano
export function keys(v, T, f, gate, vel = 1, o = {}) {
  const to = o.to || v.out;
  const g = v.gain(0, to);
  const end = adsr(g.gain, T, 0.003, 1.3, 0.3, vel, gate, o.r ?? 0.3);
  const car = v.osc('sine', f, T, end + 0.01, g);
  const mg = v.gain(0); mg.connect(car.frequency);
  v.osc('sine', f, T, end + 0.01, mg);
  mg.gain.setValueAtTime(f * (1.4 + 1.2 * vel), T);
  mg.gain.exponentialRampToValueAtTime(f * 0.18, T + 0.7);
  v.tone({ at: T, f: Math.min(f * 7, 9000), a: 0.001, d: 0.09, peak: vel * 0.07, to });
  return end;
}

export function pad(v, T, f, gate, vel = 1, o = {}) {
  const to = o.to || v.out;
  const g = v.gain(0, to);
  const end = adsr(g.gain, T, o.a ?? 0.25, 0.6, 0.8, vel, gate, o.r ?? 0.5);
  const lp = v.filter('lowpass', o.cut ?? 1500, 0.9, g);
  for (const dt of [-11, 10]) { const x = v.osc('sawtooth', f, T, end + 0.01, lp); x.detune.value = dt; }
  return end;
}

export function pluck(v, T, f, gate, vel = 1, o = {}) {
  const to = o.to || v.out;
  const g = v.gain(0, to);
  const end = perc(g.gain, T, 0.002, vel, o.d ?? 0.3);
  const lp = v.filter('lowpass', 1000, o.q ?? 4, g);
  sweep(lp.frequency, T, o.f0 ?? 5200, o.f1 ?? 520, o.fd ?? 0.16);
  v.osc(o.wave || 'sawtooth', f, T, end + 0.01, lp);
  if (o.sq) { const s = v.gain(0.5, lp); v.osc('square', f * 2, T, end + 0.01, s); }
  return end;
}

export function bell(v, T, f, vel = 1, o = {}) {
  const to = o.to || v.out;
  const d = o.d ?? 0.9;
  const g = v.gain(0, to);
  const end = perc(g.gain, T, 0.001, vel, d);
  const car = v.osc('sine', f, T, end + 0.01, g);
  const mg = v.gain(0); mg.connect(car.frequency);
  v.osc('sine', f * (o.ratio ?? 3.5), T, end + 0.01, mg);
  mg.gain.setValueAtTime(f * (o.index ?? 1.6), T);
  mg.gain.exponentialRampToValueAtTime(f * 0.05, T + d * 0.6);
  v.tone({ at: T, f: f * 2.01, a: 0.001, d: d * 0.4, peak: vel * 0.25, to });
  return end;
}

export function brass(v, T, f, gate, vel = 1, o = {}) {
  const to = o.to || v.out;
  const g = v.gain(0, to);
  const end = adsr(g.gain, T, o.a ?? 0.022, 0.3, 0.72, vel / 2.2, gate, o.r ?? 0.2);
  const lp = v.filter('lowpass', 400, 1.3, g);
  const fc = o.bright ?? 3000;
  lp.frequency.setValueAtTime(380, T);
  lp.frequency.exponentialRampToValueAtTime(fc, T + 0.05);
  lp.frequency.exponentialRampToValueAtTime(fc * 0.55, T + 0.35);
  for (const dt of [-9, 0, 9]) {
    const x = v.osc('sawtooth', f, T, end + 0.01, lp);
    x.detune.setValueAtTime(dt - 45, T); x.detune.linearRampToValueAtTime(dt, T + 0.05);
  }
  return end;
}

// lead: 'pulse' | 'saw' | 'soft' (flute/whistle) | 'square'
export function lead(v, T, f, gate, vel = 1, o = {}) {
  const to = o.to || v.out, style = o.style || 'pulse';
  const g = v.gain(0, to);
  const soft = style === 'soft';
  const end = adsr(g.gain, T, soft ? 0.03 : 0.006, 0.18, soft ? 0.85 : 0.72, vel, gate, soft ? 0.14 : 0.1);
  const lp = v.filter('lowpass', soft ? 2600 : style === 'saw' ? 3000 : 3800, 1.1, g);
  const oscs = [];
  if (style === 'saw') { for (const dt of [-6, 6]) { const x = v.osc('sawtooth', f, T, end + 0.01, lp); x.detune.value = dt; oscs.push(x); } }
  else if (soft) {
    oscs.push(v.osc('triangle', f, T, end + 0.01, lp));
    const s2 = v.gain(0.35, lp); oscs.push(v.osc('sine', f * 2, T, end + 0.01, s2));
    v.nz({ at: T, ft: 'bandpass', f: Math.min(f * 2, 8000), q: 2, a: 0.02, d: Math.max(0.05, gate * 0.6), peak: vel * 0.06, to });
  } else if (style === 'square') oscs.push(v.osc('square', f, T, end + 0.01, lp));
  else oscs.push(v.osc(pulseWave(v.ctx, 0.25), f, T, end + 0.01, lp));
  if (o.glide) for (const x of oscs) sweep(x.frequency, T, o.glide, x.frequency.value, 0.045);
  if (gate > 0.18) {
    const lg = v.gain(0);
    lg.gain.setValueAtTime(0, T); lg.gain.linearRampToValueAtTime(o.vib ?? 14, T + Math.min(gate, 0.35));
    v.osc('sine', o.vibRate ?? 5.6, T, end + 0.01, lg);
    for (const x of oscs) lg.connect(x.detune);
  }
  return end;
}

export function riser(v, T, dur, vel = 1, o = {}) {
  const to = o.to || v.out;
  const g = v.gain(0, to);
  const bp = v.filter('bandpass', 400, 2.5, g);
  sweep(bp.frequency, T, 350, 7000, dur);
  pts(g.gain, T, [[0, 0], [dur * 0.9, vel], [dur, vel * 0.8], [dur + 0.02, 0]]);
  v.noise('white', T, T + dur + 0.05, bp);
  const tg = v.gain(0, to);
  pts(tg.gain, T, [[0, 0], [dur, vel * 0.08], [dur + 0.02, 0]]);
  const x = v.osc('sawtooth', 220, T, T + dur + 0.05, v.filter('lowpass', 3000, 1, tg));
  sweep(x.frequency, T, 180, 1400, dur);
}

/* ============================================================================================================
 * Song DSL
 *  - chords: one symbol per bar ('Em7', 'C5', 'Bb/D', 'C7sus4 C7' = two chords splitting the bar)
 *  - drums (16 chars / bar): k kick, s snare, c clap, h hats, x crash, p rim, sh shaker, t tom
 *      'X' accent · 'x' normal · 'g' ghost · hats: 'c' soft closed, 'o'/'O' open · '.' rest
 *  - bass (16 chars): R root, r ghost root, O octave, o ghost octave, 5 fifth, L fifth below, 3 third, 7 seventh,
 *      4 fourth, 6 sixth, b root-1, a root+2, n approach (next bar's root - 1), '-' hold, '.' rest
 *  - stabs (16 chars): X accent, x normal, m muted, '-' hold, '.' rest   (instrument = song.inst.chords)
 *  - lead / lead2 / riff phrases: "E5/2 G5/2 r/1 _/2 | ..."  (note/len-in-16ths, r rest, _ tie, ! accent, | bar check)
 *  - arp: { rate: 1|2 (16th|8th), pattern: 'up'|'down'|'updown', oct: 1..3, lo: midi }
 * ==========================================================================================================*/

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const QUAL = {
  '': [0, 4, 7], m: [0, 3, 7], 5: [0, 7], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11], 9: [0, 4, 7, 10, 14], m9: [0, 3, 7, 10, 14], maj9: [0, 4, 7, 11, 14], add9: [0, 4, 7, 14],
  sus2: [0, 2, 7], sus4: [0, 5, 7], '7sus4': [0, 5, 7, 10], dim: [0, 3, 6], m7b5: [0, 3, 6, 10], aug: [0, 4, 8],
};
function pcOf(s) { return (PC[s[0]] + (s[1] === '#' ? 1 : s[1] === 'b' ? -1 : 0) + 12) % 12; }
export function parseNote(s) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(s);
  if (!m) return null;
  return 12 * (+m[3] + 1) + PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
const chordCache = new Map();
export function parseChord(sym) {
  let c = chordCache.get(sym);
  if (c) return c;
  const m = /^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(sym);
  if (!m) throw new Error('bad chord ' + sym);
  const root = pcOf(m[1]);
  const iv = QUAL[m[2]];
  if (!iv) throw new Error('bad chord quality ' + sym);
  c = { sym, root, iv, bass: m[3] ? pcOf(m[3]) : root };
  chordCache.set(sym, c);
  return c;
}
function inRange(pc, lo) { let n = lo + ((pc - lo) % 12 + 12) % 12; return n; }
// close voicing of chord tones within [lo, lo+maxSpan)
function voice(ch, lo, hi) {
  const r = inRange(ch.root, lo);
  const out = [];
  for (const i of ch.iv) { let n = r + i; while (n > hi) n -= 12; if (!out.includes(n)) out.push(n); }
  return out.sort((a, b) => a - b);
}
function powerChord(ch, lo) { const r = inRange(ch.root, lo); return [r, r + 7, r + 12]; }
function harmBelow(m, ch) {
  for (let d = 3; d <= 9; d++) {
    const pc = (((m - d) % 12) + 12) % 12;
    if (ch.iv.some((i) => (ch.root + i) % 12 === pc)) return m - d;
  }
  return m - 12;
}

function parsePhrase(str, warn, label) {
  const ev = [];
  let pos = 0, lastNote = null;
  for (const tok of str.trim().split(/\s+/)) {
    if (tok === '|') { if (pos % 16) warn.push(`${label}: bar line at step ${pos} (not a bar boundary)`); continue; }
    const m = /^(r|_|[A-G][#b]?-?\d)\/(\d+)(!?)$/.exec(tok);
    if (!m) { warn.push(`${label}: bad token '${tok}'`); continue; }
    const len = +m[2];
    if (m[1] === 'r') lastNote = null;
    else if (m[1] === '_') { if (lastNote) lastNote.len += len; }
    else { lastNote = { s: pos, len, m: parseNote(m[1]), acc: !!m[3] }; ev.push(lastNote); }
    pos += len;
  }
  if (pos % 16) warn.push(`${label}: phrase length ${pos} steps is not whole bars`);
  return { ev, len: pos };
}

const DRUMS = [['k', 'kick'], ['s', 'snare'], ['c', 'clap'], ['h', 'hat'], ['x', 'crash'], ['p', 'rim'], ['sh', 'shaker'], ['t', 'tom']];
function patFor(src, b, nbars, fill) {
  if (fill !== undefined && b === nbars - 1) return fill;
  if (src == null) return null;
  return typeof src === 'string' ? src : src[b % src.length];
}
const VEL = { X: 1, O: 1, x: 0.8, o: 0.8, c: 0.55, g: 0.35, m: 0.6, r: 0.45 };

export function compileSong(def) {
  const warn = [];
  const bars = [];
  const secStart = {};
  // phrases per section
  const phr = {};
  for (const [name, sec] of Object.entries(def.sections)) {
    phr[name] = {};
    for (const k of ['lead', 'lead2', 'riff']) if (sec[k]) phr[name][k] = parsePhrase(sec[k], warn, `${def.name}.${name}.${k}`);
  }
  def.order.forEach((secName, oi) => {
    const sec = def.sections[secName];
    if (!sec) { warn.push('missing section ' + secName); return; }
    if (!(oi in secStart)) secStart[oi] = bars.length;
    const nb = sec.bars;
    const chordRow = (b) => {
      const syms = (sec.chords ? sec.chords[b % sec.chords.length] : 'C').split(/\s+/);
      return syms.map((s, i) => ({ ch: parseChord(s), s0: Math.floor((i * 16) / syms.length), s1: Math.floor(((i + 1) * 16) / syms.length) }));
    };
    for (let b = 0; b < nb; b++) {
      const ev = Array.from({ length: 16 }, () => []);
      const row = chordRow(b);
      const nextRow = b + 1 < nb ? chordRow(b + 1) : (() => {
        const ns = def.sections[def.order[oi + 1] ?? def.order[def.loopFrom ?? 0]];
        const sym = ns?.chords ? ns.chords[0].split(/\s+/)[0] : row[0].ch.sym;
        return [{ ch: parseChord(sym), s0: 0, s1: 16 }];
      })();
      const chordAt = (s) => (row.find((r) => s >= r.s0 && s < r.s1) || row[0]).ch;
      // drums
      for (const [k, inst] of DRUMS) {
        const p = patFor(sec.drums?.[k], b, nb, sec.fills?.[k]);
        if (!p) continue;
        if (p.length !== 16) warn.push(`${def.name}.${secName}.${k} bar ${b}: pattern length ${p.length}`);
        for (let s = 0; s < 16; s++) {
          const ch = p[s];
          if (ch === '.' || ch === undefined || ch === '-') continue;
          const e = { i: inst, v: VEL[ch] ?? 0.8 };
          if (inst === 'hat') { e.open = ch === 'o' || ch === 'O'; }
          if (inst === 'tom') e.m = 45 + (s % 3) * 4;
          ev[s].push(e);
        }
      }
      // bass
      const bp = patFor(sec.bass, b, nb, sec.fills?.bass);
      if (bp) {
        if (bp.length !== 16) warn.push(`${def.name}.${secName}.bass bar ${b}: pattern length ${bp.length}`);
        const lo = def.bassLo ?? 28;
        for (let s = 0; s < 16; s++) {
          const c = bp[s];
          if (c === '.' || c === '-') continue;
          const ch = chordAt(s);
          const r = inRange(ch.bass, lo);
          const third = ch.iv.includes(3) ? 3 : ch.iv.includes(4) ? 4 : 7;
          const sev = ch.iv.includes(11) ? 11 : 10;
          let m;
          switch (c) {
            case 'R': case 'r': m = r; break;
            case 'O': case 'o': m = r + 12; break;
            case '5': m = r + 7; break;
            case 'L': m = r - 5; break;
            case '3': m = r + third; break;
            case '7': m = r + sev; break;
            case '4': m = r + 5; break;
            case '6': m = r + 9; break;
            case 'b': m = r - 1; break;
            case 'a': m = r + 2; break;
            case 'n': { const nr = inRange(nextRow[0].ch.bass, lo); m = nr - 1; if (m - r > 7) m -= 12; break; }
            default: warn.push(`${def.name}.${secName}.bass: bad token ${c}`); continue;
          }
          let len = 1;
          while (s + len < 16 && bp[s + len] === '-') len++;
          ev[s].push({ i: 'bass', m, len, v: c === 'r' || c === 'o' ? 0.5 : 0.85 + (s % 4 === 0 ? 0.15 : 0) });
        }
      }
      // chord stabs
      const sp = patFor(sec.stabs, b, nb, sec.fills?.stabs);
      if (sp) {
        if (sp.length !== 16) warn.push(`${def.name}.${secName}.stabs bar ${b}: pattern length ${sp.length}`);
        for (let s = 0; s < 16; s++) {
          const c = sp[s];
          if (c === '.' || c === '-') continue;
          let len = 1;
          while (s + len < 16 && sp[s + len] === '-') len++;
          const ch = chordAt(s);
          const ms = def.inst.chords === 'guitar' ? powerChord(ch, def.guitarLo ?? 40) : voice(ch, def.keysLo ?? 55, (def.keysLo ?? 55) + 19);
          ev[s].push({ i: 'chords', ms, len, v: VEL[c] ?? 0.8, mute: c === 'm' });
        }
      }
      // pad: one sustained chord per chord segment
      if (sec.pad) for (const seg of row) ev[seg.s0].push({ i: 'pad', ms: voice(seg.ch, def.padLo ?? 52, (def.padLo ?? 52) + 20), len: seg.s1 - seg.s0, v: 0.8 });
      // arp
      if (sec.arp) {
        const a = sec.arp, rate = a.rate || 1;
        for (let s = 0; s < 16; s += rate) {
          const ch = chordAt(s);
          const tones = voice(ch, a.lo ?? 64, (a.lo ?? 64) + 11);
          let seq = [];
          for (let o = 0; o < (a.oct || 1); o++) for (const t of tones) seq.push(t + 12 * o);
          if (a.pattern === 'down') seq.reverse();
          else if (a.pattern === 'updown') seq = seq.concat(seq.slice(1, -1).reverse());
          const idx = Math.floor((b * 16 + s) / rate) % seq.length;
          ev[s].push({ i: 'arp', m: seq[idx], len: rate, v: s % 4 === 0 ? 0.95 : 0.7 });
        }
      }
      // phrases
      for (const k of ['lead', 'lead2', 'riff']) {
        const ph = phr[secName][k];
        if (!ph || !ph.len) continue;
        const from = b * 16, to = from + 16;
        for (let base = Math.floor(from / ph.len) * ph.len; base < to; base += ph.len) {
          for (const n of ph.ev) {
            const at = base + n.s;
            if (at >= from && at < to) {
              ev[at - from].push({ i: k, m: n.m, len: n.len, v: n.acc ? 1 : 0.85 });
              // harmony layer: nearest chord tone 3..9 semitones below the melody
              if (k === 'lead' && sec.harmony) ev[at - from].push({ i: 'lead2', m: harmBelow(n.m, chordAt(at - from)), len: n.len, v: 0.8 });
            }
          }
        }
      }
      // fx
      if (sec.crash && b === 0) ev[0].push({ i: 'crash', v: 0.75 });
      if (sec.riser && b === nb - (sec.riser | 0 || 1)) ev[0].push({ i: 'riser', len: 16 * (sec.riser | 0 || 1), v: 0.9 });
      bars.push({ sec: secName, bar: b, ev, chords: row.map((r) => r.ch.sym) });
    }
  });
  return { ...def, bars, loopFrom: secStart[def.loopFrom ?? 0] ?? 0, warnings: warn };
}

/* ============================================================================================================
 * Songs (original compositions)
 * ==========================================================================================================*/

const BATTLE_A_LEAD =
  'B4/2 E5/2 r/1 E5/1 G5/2 F#5/2 E5/2 D5/2 B4/2 | E5/3 G5/3 B5/2 A5/2 G5/2 E5/4 | r/2 A4/1 C5/1 E5/2 A5/2 G5/2 E5/2 C5/2 D5/2 | D#5/3 F#5/3 A5/2 B5/6 r/2 | ' +
  'B4/2 E5/2 r/1 E5/1 G5/2 F#5/2 E5/2 D5/2 B4/2 | E5/3 G5/3 B5/2 A5/2 G5/2 E5/4 | r/2 A4/1 C5/1 E5/2 A5/2 G5/2 E5/2 C5/2 D5/2 | F#5/2 E5/2 D#5/2 B4/2 D#5/4 F#5/4';
const BATTLE_B_LEAD =
  'G5/4 E5/2 G5/2 A5/4 G5/4 | F#5/4 D5/2 F#5/2 A5/6 r/2 | B5/3 A5/3 F#5/2 D5/4 F#5/4 | G5/6 F#5/2 E5/8 | ' +
  'G5/4 E5/2 G5/2 C6/4 B5/4 | A5/4 F#5/2 A5/2 D6/6 r/2 | E6/4 D6/4 B5/4 A5/4 | A5/2 G5/2 F#5/2 D#5/2 F#5/8';
const TITLE_RIFF = 'D3/2 r/1 D3/1 F3/2 D3/1 G3/2 Ab3/1 G3/2 F3/2 D3/2 | C4/2 D4/2 r/2 A3/1 C4/1 D4/4 r/2 F3/2';
const TITLE_LEAD =
  'D5/2 F5/2 G5/3 F5/1 D5/2 C5/2 Bb4/4 | D5/2 F5/2 Bb5/4 A5/2 F5/2 D5/2 C5/2 | C5/4 A4/2 C5/2 F5/4 E5/4 | E5/3 C#5/3 A4/2 G5/4 E5/4 | ' +
  'D5/2 F5/2 G5/3 F5/1 D5/2 C5/2 Bb4/4 | D5/2 F5/2 Bb5/4 A5/2 F5/2 D5/2 C5/2 | C5/4 A4/2 C5/2 F5/4 E5/4 | A4/2 C#5/2 E5/2 G5/2 A5/8';
const MENU_A_LEAD =
  'A5/3 G5/1 F5/2 E5/2 F5/4 r/4 | E5/2 G5/2 C6/3 D6/1 C6/2 A5/2 r/4 | D6/3 C6/1 A5/2 F5/2 A5/4 G5/4 | F5/2 G5/2 Bb5/4 A5/2 G5/2 E5/4 | ' +
  'A5/3 G5/1 F5/2 E5/2 F5/4 r/4 | E5/2 G5/2 C6/3 D6/1 C6/2 A5/2 r/4 | D6/3 C6/1 A5/2 F5/2 A5/2 C6/2 Bb5/2 G5/2 | G5/4 F5/4 E5/8';
const MENU_B_LEAD =
  'F5/2 A5/2 C6/2 A5/2 G5/4 F5/4 | D5/2 F5/2 Bb5/3 A5/1 G5/4 r/4 | F5/2 A5/2 D6/4 C6/2 A5/2 F5/4 | E5/4 G5/4 Bb5/4 A5/4 | ' +
  'F5/2 A5/2 C6/2 A5/2 G5/4 F5/4 | D5/2 F5/2 Bb5/3 A5/1 G5/4 r/4 | F5/2 A5/2 D6/4 E5/2 G5/2 Bb5/4 | A5/12 r/4';
const WIN_LEAD =
  'D5/2 G5/2 B5/2 A5/2 G5/4 D5/4 | E5/2 G5/2 B5/2 D6/2 B5/8 | C6/3 B5/1 G5/2 E5/2 G5/4 D5/4 | F#5/2 A5/2 D6/4 C6/2 A5/2 F#5/4 | ' +
  'D5/2 G5/2 B5/2 A5/2 G5/4 D5/4 | F#5/2 B5/2 D6/2 F#6/2 D6/8 | E6/3 D6/1 B5/2 G5/2 C6/4 B5/4 | A5/4 G5/4 A5/2 B5/2 A5/2 F#5/2';
const LOSE_LEAD =
  'E5/6 D5/2 C5/4 B4/4 | C5/6 A4/2 C5/4 E5/4 | F5/6 E5/2 D5/4 C5/4 | B4/8 G#4/8 | ' +
  'E5/6 D5/2 C5/4 B4/4 | C5/6 A4/2 C5/4 E5/4 | F5/4 A5/4 G5/4 F5/4 | E5/12 r/4';

export const SONGS = {
  title: {
    name: 'Splash Attitude', bpm: 128, swing: 0.05, key: 'D minor', pump: 0.22,
    inst: { bass: 'punk', chords: 'guitar', lead: 'saw', arp: 'pluck' }, riffBass: true,
    sections: {
      intro: {
        bars: 4, chords: ['Dm'], riff: TITLE_RIFF, riser: 1,
        drums: {
          k: ['................', '................', 'X.......X.......', 'X.......X.......'],
          h: ['................', '................', 'x.c.x.c.x.c.x.c.', 'x.c.x.c.x.c.x.c.'],
          s: ['................', '................', '................', 'x.x.x.x.xxxxXXXX'],
        },
      },
      A: {
        bars: 8, crash: true, chords: ['Dm'], riff: TITLE_RIFF,
        drums: { k: 'X.....x.X.x.....', s: '....X.......X...', c: '....x.......x...', h: 'x.c.x.c.x.c.x.oc' },
        fills: { s: '....X.......X.xx' },
      },
      B: {
        bars: 8, crash: true, chords: ['Gm7', 'Bb', 'F/A', 'A7'], pad: true, lead: TITLE_LEAD,
        drums: { k: 'X.....x.X.x...x.', s: '....X.......X...', c: '....x.......x...', h: 'x.o.x.o.x.o.x.o.' },
        bass: 'R.RR..O.R.RR..5n',
        stabs: 'X--.x-..X--.x-x.',
      },
      break: {
        bars: 4, chords: ['Dm', 'Bb', 'C', 'A7'], pad: true, riser: 1,
        drums: { k: 'X.......X.......', h: 'x.x.x.x.x.x.x.x.' }, fills: { s: 'x.x.x.x.xxxxXXXX' },
        bass: 'R-------R---5---',
        arp: { rate: 1, pattern: 'updown', oct: 2, lo: 62 },
      },
    },
    order: ['intro', 'A', 'B', 'A', 'break', 'B'], loopFrom: 1,
  },

  menu: {
    name: 'Harbor Lounge', bpm: 105, swing: 0.16, key: 'F major', pump: 0,
    inst: { bass: 'funk', chords: 'keys', lead: 'soft', arp: 'pluck' }, keysLo: 57, bassLo: 31,
    mix: { kick: 0.5, snare: 0.3, hats: 0.14, bass: 0.38, chords: 0.32, pad: 0.07, lead: 0.26, arp: 0.08 },
    sections: {
      intro: { bars: 2, chords: ['Fmaj7', 'C7sus4'], stabs: ['X-------------..', 'X-------x-----..'], drums: { sh: '..x...x...x...x.' } },
      A: {
        bars: 8, chords: ['Fmaj7', 'Am7', 'Bbmaj7', 'C7sus4 C7'], lead: MENU_A_LEAD,
        drums: { k: 'X......x..X.....', s: '....x.......x...', p: '..........g....g', h: 'x.c.x.c.x.c.x.cc', sh: 'xcxcxcxcxcxcxcxc' },
        bass: ['R..r.R5.O..R.53.', 'R..r.R5.O..R.5.n'],
        stabs: 'X--..x-..x--.x-.',
      },
      B: {
        bars: 8, chords: ['Dm7', 'Gm7', 'Bbmaj7', 'C9', 'Dm7', 'Gm7', 'Bbmaj7 C7', 'Fmaj7'], lead: MENU_B_LEAD, pad: true,
        drums: { k: 'X......x..X..x..', s: '....x.......x...', h: 'x.o.x.c.x.o.x.cc', sh: 'xcxcxcxcxcxcxcxc' },
        bass: 'R..r.R5.O..R.5.n',
        stabs: 'X--..x-..x--.x-.',
      },
    },
    order: ['intro', 'A', 'B', 'A'], loopFrom: 1,
  },

  battle: {
    name: 'Turf Riot', bpm: 150, swing: 0, key: 'E minor', pump: 0.28,
    inst: { bass: 'punk', chords: 'guitar', lead: 'pulse', lead2: 'saw', arp: 'pluck' },
    sections: {
      intro: {
        bars: 2, chords: ['E5', 'C5 D5'], riser: 1,
        drums: { k: ['X...............', 'X.......X.......'], s: ['................', 'x.x.x.x.xxxxXXXX'], x: ['X...............', '................'] },
        bass: ['R---------------', 'R-------R-------'],
        stabs: ['X---------------', 'X-------X-------'],
      },
      A: {
        bars: 8, crash: true, chords: ['Em7', 'Cmaj7', 'Am7', 'B7'], lead: BATTLE_A_LEAD,
        drums: { k: 'X..x..x.X.....x.', s: '....X.....g.X..g', h: 'x.c.x.c.x.c.x.oc' },
        fills: { s: '....X.....g.X.xx' },
        bass: ['R.RO.RR.5.RO.R7.', 'R.RO.RR.5.RO.5On'],
        stabs: 'X-.x..x-.x..x-.x',
        arp: { rate: 1, pattern: 'up', oct: 1, lo: 64 },
      },
      B: {
        bars: 8, crash: true, chords: ['C', 'D', 'Bm', 'Em', 'C', 'D', 'B7sus4', 'B7'], lead: BATTLE_B_LEAD, pad: true,
        drums: { k: 'X...x...X...x...', s: '....X.......X...', c: '....x.......x...', h: 'x.o.x.o.x.o.x.o.' },
        fills: { s: '....X.......X.xx', k: 'X...x...X...x.x.' },
        bass: 'R.R.O.R.R.R.O.Rn',
        stabs: 'X-x-x-x-X-x-x-x-',
        arp: { rate: 2, pattern: 'updown', oct: 2, lo: 64 },
      },
      break: {
        bars: 4, chords: ['Am7', 'Bm7', 'Cmaj7', 'D'], pad: true, riser: 1,
        drums: { k: 'X.........x.....', s: '........X.......', h: 'x.c.x.c.x.c.x.c.' },
        fills: { s: 'x.x.x.x.xxxxXXXX', k: 'X...X...X...X...' },
        bass: 'R-----R-5-----O-',
        arp: { rate: 1, pattern: 'updown', oct: 2, lo: 60 },
      },
    },
    order: ['intro', 'A', 'B', 'A', 'break', 'B'], loopFrom: 1,
  },

  battle_final: {
    name: 'Final Splash', bpm: 150, swing: 0, key: 'E minor', pump: 0.32,
    inst: { bass: 'punk', chords: 'guitar', lead: 'pulse', lead2: 'saw', arp: 'pluck' },
    mix: { hats: 0.17, lead2: 0.16 },
    sections: {
      lift: {
        bars: 1, chords: ['B5'], riser: 1,
        drums: { k: 'X...X...X...X...', s: 'x.x.x.x.xxxxXXXX' },
        bass: 'R-----R-----R-R-',
        stabs: 'X-----X-----X-X-',
      },
      F1: {
        bars: 8, crash: true, chords: ['C', 'D', 'Bm', 'Em', 'C', 'D', 'B7sus4', 'B7'], lead: BATTLE_B_LEAD, harmony: true,
        drums: { k: 'X...x...X...x...', s: '....X.......X...', c: '....x.......x...', h: 'xcxcxcxcxcxcxcxc' },
        fills: { s: '....X.....x.X.xx' },
        bass: 'RrOrRrOrRrOrRrOn',
        stabs: 'X-x-x-x-X-x-x-xx',
        arp: { rate: 1, pattern: 'up', oct: 2, lo: 64 },
      },
      F2: {
        bars: 8, crash: true, chords: ['Em7', 'Cmaj7', 'Am7', 'B7'], lead: BATTLE_A_LEAD, harmony: true,
        drums: { k: 'X..x..x.X..x..x.', s: '....X.......X...', c: '....x.......x...', h: 'xcxcxcxoxcxcxcxo' },
        bass: 'R.ROR.RO5.5OR.On',
        stabs: 'X-.x..x-.x..x-.x',
        arp: { rate: 1, pattern: 'updown', oct: 2, lo: 64 },
      },
      build: {
        bars: 4, chords: ['C', 'D', 'Em', 'B7'], riser: 4, lead: 'G5/8 E5/8 | A5/8 F#5/8 | B5/8 G5/8 | D#6/4 B5/4 F#5/4 A5/4',
        drums: {
          k: 'X...X...X...X...', h: 'xcxcxcxcxcxcxcxc',
          s: ['....X.......X...', 'x...x...x...x...', 'x.x.x.x.x.x.x.x.', 'xxxxxxxxXXXXXXXX'],
        },
        bass: 'R.R.R.R.R.R.R.R.',
        stabs: 'X-x-x-x-X-x-x-x-',
      },
    },
    order: ['lift', 'F1', 'F2', 'build'], loopFrom: 1,
  },

  results_win: {
    name: 'Fresh Victory', bpm: 124, swing: 0, key: 'G major', pump: 0.18,
    inst: { bass: 'funk', chords: 'pluck', lead: 'bell', arp: 'pluck' }, keysLo: 59, bassLo: 31,
    mix: { lead: 0.22, chords: 0.2, arp: 0.08, hats: 0.16 },
    sections: {
      A: {
        bars: 8, crash: true, chords: ['G', 'Em7', 'Cadd9', 'D', 'G', 'Bm7', 'Cadd9', 'Am7 D'], lead: WIN_LEAD,
        drums: { k: 'X...x...X...x...', c: '....x.......x...', h: 'c.o.c.o.c.o.c.o.', sh: 'xcxcxcxcxcxcxcxc' },
        bass: 'R.O.R.O.5.O.R.On',
        stabs: '..x...x...x...x.',
        arp: { rate: 2, pattern: 'up', oct: 2, lo: 67 },
      },
    },
    order: ['A'], loopFrom: 0,
  },

  results_lose: {
    name: 'Next Time', bpm: 84, swing: 0.1, key: 'A minor', pump: 0,
    inst: { bass: 'sub', chords: 'keys', lead: 'soft' }, keysLo: 55,
    mix: { kick: 0.42, hats: 0.1, bass: 0.4, chords: 0.36, lead: 0.22 },
    sections: {
      A: {
        bars: 8, chords: ['Am7', 'Fmaj7', 'Dm7', 'Esus4 E7', 'Am7', 'Fmaj7', 'Dm9', 'E7sus4 E7'], lead: LOSE_LEAD,
        drums: { k: 'X.........x.....', p: '........x.......', h: 'c.c.c.c.c.c.c.c.' },
        bass: 'R-------..R-5---',
        stabs: 'X-------..x-----',
      },
    },
    order: ['A'], loopFrom: 0,
  },
};

/* ============================================================================================================
 * Sequencer
 * ==========================================================================================================*/

const GROUPS = ['kick', 'snare', 'hats', 'bass', 'chords', 'pad', 'arp', 'lead', 'lead2', 'fx'];
const GROUP_OF = {
  kick: 'kick', snare: 'snare', clap: 'snare', tom: 'snare', hat: 'hats', rim: 'hats', shaker: 'hats', crash: 'fx', riser: 'fx',
  bass: 'bass', chords: 'chords', riff: 'chords', pad: 'pad', arp: 'arp', lead: 'lead', lead2: 'lead2',
};
const MIX = { kick: 0.6, snare: 0.5, hats: 0.22, bass: 0.36, chords: 0.3, pad: 0.1, arp: 0.1, lead: 0.28, lead2: 0.13, fx: 0.22 };
const SEND_DLY = { lead: 0.26, lead2: 0.2, arp: 0.2 };
const SEND_REV = { snare: 0.16, lead: 0.14, lead2: 0.14, pad: 0.35, chords: 0.07, arp: 0.2, fx: 0.25, hats: 0.04 };
const PUMPED = { chords: true, pad: true, arp: true };
// intensity → layer weight (smoothstep lo..hi). At 0 only hats remain; drums/lead come in above ~0.4.
const LAYERS = {
  hats: [0, 0.02], bass: [0.08, 0.28], pad: [0.12, 0.32], arp: [0.28, 0.48], chords: [0.32, 0.52], kick: [0.38, 0.52],
  fx: [0.38, 0.55], snare: [0.48, 0.62], lead: [0.62, 0.78], lead2: [0.8, 0.95],
};
const smooth = (a, b, x) => {
  if (b <= a) return x >= a ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const compiled = new Map();
export function getSong(id) {
  let s = compiled.get(id);
  if (!s) {
    const def = SONGS[id];
    if (!def) return null;
    s = compileSong({ ...def, id });
    if (s.warnings.length && typeof console !== 'undefined') console.warn('[music] ' + id + ':', s.warnings.join('; '));
    compiled.set(id, s);
  }
  return s;
}

class Player {
  constructor(eng, id, t0, opts = {}) {
    const ctx = (this.ctx = eng.ctx);
    this.eng = eng; this.id = id;
    const song = (this.song = getSong(id));
    this.stepDur = 60 / song.bpm / 4; this.barDur = this.stepDur * 16;
    this.t0 = t0; this.n = 0; this.step = 0;
    this.bar = Math.max(0, Math.min(opts.startBar ?? 0, song.bars.length - 1));
    this.stopAt = Infinity; this.disposed = false;
    this.rng = mulberry32(opts.seed ?? ((Math.random() * 2 ** 31) | 0));
    this.fades = [ctx.createGain(), ctx.createGain(), ctx.createGain()];
    this.fades[0].connect(eng.mix); this.fades[1].connect(eng.dlyIn); this.fades[2].connect(eng.revIn);
    for (const f of this.fades) f.gain.value = 0;
    this.pumpG = ctx.createGain(); this.pumpG.connect(this.fades[0]);
    this.mix = { ...MIX, ...song.mix }; this.layers = { ...LAYERS, ...song.layers };
    this.groups = {}; this.extra = [];
    for (const g of GROUPS) {
      const n = ctx.createGain();
      n.gain.value = this.mix[g] * this.weight(g, eng.intensity);
      n.connect(PUMPED[g] && song.pump ? this.pumpG : this.fades[0]);
      const sd = (song.sendDly ?? SEND_DLY)[g], sr = (song.sendRev ?? SEND_REV)[g];
      if (sd) { const s = ctx.createGain(); s.gain.value = sd; n.connect(s); s.connect(this.fades[1]); this.extra.push(s); }
      if (sr) { const s = ctx.createGain(); s.gain.value = sr; n.connect(s); s.connect(this.fades[2]); this.extra.push(s); }
      this.groups[g] = n;
    }
    this.openHat = null;
  }
  weight(g, x) { const l = this.layers[g]; return l ? smooth(l[0], l[1], x) : 1; }
  setIntensity(x, now) {
    for (const g of GROUPS) this.groups[g].gain.setTargetAtTime(this.mix[g] * this.weight(g, x), now, 0.35);
  }
  // fade level is tracked in JS (linear segments) so a fade-out always starts from the exact current value
  fadeAt(t) { const f = this.fadeSeg; if (!f) return 0; if (t <= f.t0) return f.v0; if (t >= f.t1) return f.v1; return f.v0 + ((f.v1 - f.v0) * (t - f.t0)) / (f.t1 - f.t0); }
  fadeIn(t, dur) {
    dur = Math.max(0.005, dur);
    for (const f of this.fades) { f.gain.setValueAtTime(0, t); f.gain.linearRampToValueAtTime(1, t + dur); }
    this.fadeSeg = { t0: t, v0: 0, t1: t + dur, v1: 1 };
  }
  fadeOut(t, dur) {
    dur = Math.max(0.01, dur);
    const v = this.fadeAt(t);
    for (const f of this.fades) { f.gain.cancelScheduledValues(t); f.gain.setValueAtTime(v, t); f.gain.linearRampToValueAtTime(0, t + dur); }
    this.fadeSeg = { t0: t, v0: v, t1: t + dur, v1: 0 };
    this.stopAt = Math.min(this.stopAt, t + dur + 0.02);
  }
  nextBarTime(after) {
    const k = Math.max(0, Math.ceil((after - this.t0) / this.barDur - 1e-6));
    return this.t0 + k * this.barDur;
  }
  advance() {
    this.n++; this.step++;
    if (this.step >= 16) { this.step = 0; this.bar++; if (this.bar >= this.song.bars.length) this.bar = this.song.loopFrom; }
  }
  pump(until, now) {
    if (this.disposed) return;
    // timer starved (background tab): skip ahead on the grid instead of firing a pile-up
    while (this.t0 + this.n * this.stepDur < now - 0.03 && this.t0 + this.n * this.stepDur < this.stopAt) this.advance();
    for (;;) {
      const t = this.t0 + this.n * this.stepDur;
      if (t >= until || t >= this.stopAt) break;
      const tt = t + (this.step & 1 ? (this.song.swing || 0) * this.stepDur : 0);
      const evs = this.song.bars[this.bar].ev[this.step];
      for (let i = 0; i < evs.length; i++) this.fire(evs[i], tt);
      this.advance();
    }
  }
  pumpDuck(T) {
    const p = this.pumpG.gain, d = this.song.pump;
    p.setTargetAtTime(1 - d, T, 0.004);
    p.setTargetAtTime(1, T + 0.03, 0.075);
  }
  fire(e, T) {
    const g = GROUP_OF[e.i];
    if (this.weight(g, this.eng.intensity) < 0.02) {
      if (e.i === 'riff' && this.song.riffBass && this.weight('bass', this.eng.intensity) > 0.02) {
        const v2 = new V(this.ctx, this.groups.bass, T, this.rng);
        bass(v2, T, mtof(e.m) / 2, e.len * this.stepDur * 0.85, e.v, { style: this.song.inst.bass });
        v2.finish();
      }
      return;
    }
    const song = this.song, sd = this.stepDur;
    const vel = e.v * (0.93 + 0.12 * this.rng());
    const v = new V(this.ctx, this.groups[g], T, this.rng);
    switch (e.i) {
      case 'kick': kick(v, T, vel); if (song.pump) this.pumpDuck(T); break;
      case 'snare': snare(v, T, vel); break;
      case 'clap': clap(v, T, vel); break;
      case 'tom': tom(v, T, mtof(e.m), vel); break;
      case 'rim': rim(v, T, vel); break;
      case 'shaker': shaker(v, T, vel); break;
      case 'crash': crash(v, T, vel); break;
      case 'hat': {
        if (this.openHat && this.openHat.t < T && this.openHat.p.cancelAndHoldAtTime) {
          this.openHat.p.cancelAndHoldAtTime(T); this.openHat.p.setTargetAtTime(0, T, 0.012);
        }
        this.openHat = null;
        const p = hat(v, T, vel, e.open);
        if (e.open) this.openHat = { p, t: T };
        break;
      }
      case 'riser': riser(v, T, e.len * sd, vel); break;
      case 'bass': bass(v, T, mtof(e.m), e.len * sd * (song.bassGate ?? 0.82), vel, { style: song.inst.bass }); break;
      case 'riff': {
        const f = mtof(e.m);
        guitar(v, T, [f, f * 1.4983, f * 2], e.len * sd * 0.85, vel);
        if (song.riffBass && this.weight('bass', this.eng.intensity) > 0.02) {
          const v2 = new V(this.ctx, this.groups.bass, T, this.rng);
          bass(v2, T, f / 2, e.len * sd * 0.85, vel, { style: song.inst.bass });
          v2.finish();
        }
        break;
      }
      case 'chords': {
        const gate = e.len * sd * 0.9, inst = song.inst.chords, n = e.ms.length;
        if (inst === 'guitar') guitar(v, T, e.ms.map(mtof), gate, vel, { mute: e.mute });
        else {
          const nv = vel / Math.sqrt(n);
          for (const m of e.ms) {
            if (inst === 'keys') keys(v, T, mtof(m), gate, nv * 0.7);
            else if (inst === 'brass') brass(v, T, mtof(m), gate, nv * 0.7);
            else pluck(v, T, mtof(m), gate, nv * 0.7, { d: 0.28, f0: 3800, f1: 700, q: 2 });
          }
        }
        break;
      }
      case 'pad': { const nv = vel / Math.sqrt(e.ms.length); for (const m of e.ms) pad(v, T, mtof(m), e.len * sd, nv * 0.6); break; }
      case 'arp': pluck(v, T, mtof(e.m), e.len * sd, vel * 0.6, { d: 0.2 }); break;
      case 'lead': case 'lead2': {
        const style = e.i === 'lead' ? song.inst.lead : (song.inst.lead2 || 'saw');
        const gate = e.len * sd * 0.92;
        if (style === 'bell') bell(v, T, mtof(e.m), vel * 0.8, { d: Math.min(1.4, 0.35 + gate) });
        else lead(v, T, mtof(e.m), gate, vel * 0.7, { style });
        break;
      }
    }
    v.finish();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const n of [...this.fades, this.pumpG, ...this.extra, ...Object.values(this.groups)]) { try { n.disconnect(); } catch (e) { /* */ } }
  }
}

const LOOKAHEAD = 0.16, TICK_MS = 25;

export class MusicEngine {
  constructor() {
    this.ctx = null; this.players = []; this.current = null; this.intensity = 1; this._want = undefined;
  }
  get track() { return this.current ? this.current.id : null; }
  get tracks() { return Object.keys(SONGS); }
  now() { return this.offline ? this.vnow : this.ctx.currentTime; }

  // dest = the music bus (audio.js). opt.offline → no timer; drive with advance(t).
  _init(ctx, dest, opt = {}) {
    if (this.ctx) return this;
    this.ctx = ctx; this.offline = !!opt.offline; this.vnow = 0;
    const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    this.mix = g(1);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 30; hp.Q.value = 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 10; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.2;
    this.out = g(opt.level ?? 0.42);   // music bus sits ~−14 LUFS at full volume, under the SFX
    this.mix.connect(hp); hp.connect(comp); comp.connect(this.out); this.out.connect(dest);
    // ping-pong delay (dotted 8th, set per track)
    this.dlyIn = g(1);
    const dhp = ctx.createBiquadFilter(); dhp.type = 'highpass'; dhp.frequency.value = 350;
    const dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 3400;
    this.dA = ctx.createDelay(2); this.dB = ctx.createDelay(2);
    this.dA.delayTime.value = this.dB.delayTime.value = 0.3;
    const fbA = g(0.36), fbB = g(0.36), dOut = g(0.55);
    const pl = ctx.createStereoPanner(), pr = ctx.createStereoPanner(); pl.pan.value = -0.75; pr.pan.value = 0.75;
    this.dlyIn.connect(dhp); dhp.connect(dlp); dlp.connect(this.dA);
    this.dA.connect(pl); this.dA.connect(fbA); fbA.connect(this.dB);
    this.dB.connect(pr); this.dB.connect(fbB); fbB.connect(this.dA);
    pl.connect(dOut); pr.connect(dOut); dOut.connect(this.mix);
    // reverb
    this.revIn = g(1);
    const conv = ctx.createConvolver(); conv.buffer = makeImpulse(ctx, 2.2, 2.4, { seed: 5, bright: 0.7, dark: 0.08 });
    const rOut = g(0.5);
    this.revIn.connect(conv); conv.connect(rOut); rOut.connect(this.mix);
    this._nodes = [this.mix, hp, comp, this.out, this.dlyIn, dhp, dlp, this.dA, this.dB, fbA, fbB, dOut, pl, pr, this.revIn, conv, rOut];
    if (!this.offline) this._startTimer();
    const w = this._want; this._want = undefined;
    if (w !== undefined) this.play(w.track, w.opts);
    return this;
  }

  _startTimer() {
    const tick = () => this._tick();
    try {
      const src = 'let id=0;onmessage=(e)=>{clearInterval(id);if(e.data>0)id=setInterval(()=>postMessage(0),e.data)}';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      this.worker = new Worker(url);
      this.worker.onmessage = tick;
      this.worker.onerror = () => { this.worker = null; if (!this.timer) this.timer = setInterval(tick, TICK_MS); };
      this.worker.postMessage(TICK_MS);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      this.timer = setInterval(tick, TICK_MS);
    }
  }

  _tick() {
    if (!this.ctx || !this.players.length) return;
    const now = this.now();
    for (const p of this.players) p.pump(now + LOOKAHEAD, now);
    for (let i = this.players.length - 1; i >= 0; i--) {
      const p = this.players[i];
      if (p.stopAt + 4 < now) { p.dispose(); this.players.splice(i, 1); }
    }
  }

  // offline driving (tests): move the virtual clock and schedule
  advance(t) { this.vnow = t; this._tick(); }

  play(track, opts = {}) {
    const fade = Math.max(0, opts.fade ?? 1.0);
    if (track != null && !SONGS[track]) { console.warn('[music] unknown track', track); return; }
    if (!this.ctx) { this._want = { track, opts }; return; }
    const cur = this.current;
    if (cur && cur.id === track) return;
    const now = this.now();
    if (track == null) { if (cur) cur.fadeOut(now, Math.max(0.03, fade)); this.current = null; return; }
    const song = getSong(track);
    let t0 = now + 0.06, sync = false;
    if (cur && fade > 0 && cur.song.bpm === song.bpm) { t0 = cur.nextBarTime(now + 0.12); sync = true; }
    const p = new Player(this, track, t0, opts);
    this.players.push(p);
    const beat = 60 / song.bpm;
    this.dA.delayTime.setTargetAtTime(beat * 0.75, t0, 0.05); this.dB.delayTime.setTargetAtTime(beat * 0.75, t0, 0.05);
    if (cur) {
      if (sync) {
        // beat-matched escalation: old track plays to the bar line with a riser, new one lands on the downbeat
        cur.fadeOut(t0, Math.min(0.25, fade));
        p.fadeIn(t0, 0.008);
        const span = t0 - now;
        if (span > 0.3) { const v = new V(this.ctx, cur.groups.fx, now + 0.02, p.rng); riser(v, now + 0.02, span - 0.03, 1); v.finish(); }
      } else {
        cur.fadeOut(now, Math.max(0.03, fade));
        p.fadeIn(t0, fade > 0 ? fade * 0.5 : 0.01);
      }
    } else p.fadeIn(t0, 0.01);
    this.current = p;
    this._tick();
  }

  setIntensity(x) {
    this.intensity = Math.min(1, Math.max(0, +x || 0));
    if (!this.ctx) return;
    const now = this.now();
    for (const p of this.players) p.setIntensity(this.intensity, now);
  }

  stop(fade = 1) { this.play(null, { fade }); }

  dispose() {
    for (const p of this.players) p.dispose();
    this.players.length = 0; this.current = null;
    if (this.worker) { this.worker.postMessage(0); this.worker.terminate(); this.worker = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const n of this._nodes || []) { try { n.disconnect(); } catch (e) { /* */ } }
    this.ctx = null;
  }
}

export const TRACKS = Object.fromEntries(Object.entries(SONGS).map(([id, s]) => [id, {
  name: s.name, bpm: s.bpm, key: s.key,
  structure: s.order.map((k) => `${k}(${s.sections[k].bars})`).join(' → ') + `, loops from ${s.order[s.loopFrom ?? 0]}`,
}]));

export const music = new MusicEngine();
