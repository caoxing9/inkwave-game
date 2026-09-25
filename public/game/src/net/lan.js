// 局域网联机连接层（配合 server.mjs 的 /api/rooms）。
//
// 拓扑：房主为中心的星形。房主与每个成员之间建一条 WebRTC 连接（两个 DataChannel：可靠有序的 'iw' 走事件，
// 不可靠无序的 'iw-state' 走高频状态快照）。SDP/ICE 通过服务器 poll 交换。15 秒内直连不上，自动切换为
// 服务器 HTTP 中转（延迟更高，但任何能打开网页的网络都能用）。
//
// 对外：LanClient.create/join → client；client.send(packet, to?)；client.onPacket / onRoom / onStatus / onError。
// 非房主发出的包只会到达房主；房主负责把需要广播的包转发给其他人（见 session.js）。

const ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:global.stun.twilio.com:3478' }];

const FORCE_RELAY = new URLSearchParams(location.search).has('relay');

export class RoomError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

export async function roomRequest(body) {
  let res;
  try {
    res = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(10000) });
  } catch { throw new RoomError('连不上房间服务器，请确认是用 node server.mjs 启动的', 0); }
  let data = {};
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok) throw new RoomError(data.error || `房间服务暂不可用（${res.status}）`, res.status);
  return data;
}

export async function serverAvailable() {
  try { const r = await fetch('/api/rooms', { cache: 'no-store', signal: AbortSignal.timeout(3000) }); return r.ok && (await r.json()).multiplayer === true; } catch { return false; }
}

export class LanClient {
  static async create(name, weapon) { return new LanClient(await roomRequest({ action: 'create', name, weapon })); }
  static async join(code, name, weapon) { return new LanClient(await roomRequest({ action: 'join', code, name, weapon })); }

  constructor({ room, id, token }) {
    this.room = room; this.id = id; this.token = token;
    this.peers = new Map();        // id → RTCPeerConnection
    this.ch = new Map();           // id → reliable channel
    this.stCh = new Map();         // id → state channel
    this.stage = new Map();        // id → 中文状态
    this.latency = new Map(); this.lastPong = new Map();
    this.relayUp = new Set();      // relay peers we have heard from
    this.pendingIce = new Map();
    this.chains = new Map();
    this.outgoing = []; this.nextPacket = 0; this.packetSeq = 0; this.seq = 0;
    this.closed = false; this.failures = 0; this.lastPing = 0;
    this.timers = new Set();
    this.onPacket = () => {}; this.onRoom = () => {}; this.onStatus = () => {}; this.onError = () => {};
    setTimeout(() => this._poll(), 0);
    // 关页面时立刻通知服务器（否则要等 10 秒心跳超时）
    this._unload = () => { try { navigator.sendBeacon('/api/rooms', new Blob([JSON.stringify({ action: 'leave', code: this.room.code, id: this.id, token: this.token })], { type: 'application/json' })); } catch { /* ignore */ } };
    addEventListener('pagehide', this._unload);
  }

  get isHost() { return this.id === this.room.host; }
  get code() { return this.room.code; }
  get members() { return this.room.members; }
  get targets() { return this.room.members.filter((m) => m.id !== this.id && (this.isHost || m.id === this.room.host)); }
  _isRelay(id) { return (this.room.relayMembers || []).includes(this.isHost ? id : this.id); }
  connected(id) { return this._isRelay(id) ? this.relayUp.has(id) : this.ch.get(id)?.readyState === 'open'; }
  allConnected() { return this.targets.every((m) => this.connected(m.id)); }

  status() {
    return this.targets.map((m) => ({
      id: m.id, name: m.name,
      via: this._isRelay(m.id) ? 'relay' : this.connected(m.id) ? 'direct' : 'connecting',
      stage: this.stage.get(m.id) || '等待交换连接信息',
      ping: Date.now() - (this.lastPong.get(m.id) || 0) < 5000 ? this.latency.get(m.id) : undefined,
    }));
  }

  request(action, extra = {}) { return roomRequest({ action, code: this.room.code, id: this.id, token: this.token, ...extra }); }

  // ---------------------------------------------------------------- send / receive
  send(data, to) {
    if (this.closed) return;
    const state = data.t === 'st';
    let json = null;
    for (const m of this.targets) {
      if (to && m.id !== to) continue;
      if (this._isRelay(m.id)) {
        // 中转：状态快照只保留最新一条，事件不丢
        if (state) this.outgoing = this.outgoing.filter((p) => p.to !== m.id || p.data.t !== 'st');
        if (this.outgoing.length > 400) { this.outgoing = this.outgoing.filter((p) => p.data.t !== 'st'); if (this.outgoing.length > 400) continue; }
        this.outgoing.push({ id: ++this.nextPacket, to: m.id, data });
      } else {
        const c = (state ? this.stCh : this.ch).get(m.id) || this.ch.get(m.id);
        if (c?.readyState === 'open' && c.bufferedAmount < (state ? 64000 : 512000)) {
          try { c.send(json || (json = JSON.stringify(data))); } catch { /* channel closing */ }
        }
      }
    }
  }

  _receive(id, data) {
    if (!data || typeof data !== 'object' || !this.targets.some((m) => m.id === id)) return;
    if (this._isRelay(id)) this.relayUp.add(id);
    if (data.t === 'ping') { this.send({ t: 'pong', at: data.at }, id); return; }
    if (data.t === 'pong') { this.latency.set(id, Math.max(0, Date.now() - data.at)); this.lastPong.set(id, Date.now()); this.onStatus(); return; }
    this.onPacket(data, id);
  }

  // ---------------------------------------------------------------- WebRTC
  _later(fn, ms) { const t = setTimeout(() => { this.timers.delete(t); if (!this.closed) fn(); }, ms); this.timers.add(t); return t; }
  _stage(id, s) { this.stage.set(id, s); this.onStatus(); }

  _bind(id, c, state) {
    (state ? this.stCh : this.ch).set(id, c);
    c.onopen = () => { if (!state) { this._stage(id, 'WebRTC 直连成功'); this.send({ t: 'ping', at: Date.now() }, id); } };
    c.onclose = () => { (state ? this.stCh : this.ch).delete(id); if (!state && !this.closed && !this._isRelay(id)) this.fallback(id); };
    c.onmessage = (e) => { if (this._isRelay(id) || typeof e.data !== 'string') return; try { this._receive(id, JSON.parse(e.data)); } catch { /* bad packet */ } };
  }

  _signal(id, data) {
    const key = 'out:' + id;
    const next = (this.chains.get(key) || Promise.resolve())
      .then(() => (this.closed || this._isRelay(id) ? null : this.request('signal', { to: id, data })))
      .catch(() => this.fallback(id));
    this.chains.set(key, next);
    return next;
  }

  async _peer(id, offer) {
    if (this.peers.has(id)) return this.peers.get(id);
    // ?relay=1 强制走服务器中转（网络禁止点对点时，或测试用）
    if (typeof RTCPeerConnection === 'undefined' || FORCE_RELAY) { this.fallback(id); return null; }
    this._stage(id, '正在交换网络地址');
    this._later(() => { if (!this.connected(id)) this.fallback(id); }, 15000);
    const pc = new RTCPeerConnection({ iceServers: ICE });
    this.peers.set(id, pc);
    pc.ondatachannel = (e) => this._bind(id, e.channel, e.channel.label === 'iw-state');
    pc.onicecandidate = (e) => { if (e.candidate) this._signal(id, { type: 'candidate', candidate: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => {
      if (this.closed || this._isRelay(id)) return;
      if (pc.connectionState === 'failed') this.fallback(id);
      else if (pc.connectionState === 'connecting') this._stage(id, '正在检测直连路径');
      else if (pc.connectionState === 'disconnected') { this._stage(id, '直连中断，正在恢复'); this._later(() => { if (pc.connectionState === 'disconnected') this.fallback(id); }, 5000); }
    };
    if (offer) {
      this._bind(id, pc.createDataChannel('iw', { ordered: true }), false);
      this._bind(id, pc.createDataChannel('iw-state', { ordered: false, maxRetransmits: 0 }), true);
      await pc.setLocalDescription(await pc.createOffer());
      await this._signal(id, { type: 'offer', sdp: pc.localDescription.sdp });
    }
    return pc;
  }

  async _onSignal(id, data) {
    if (this.closed || this._isRelay(id) || !this.targets.some((m) => m.id === id)) return;
    const pc = await this._peer(id, false);
    if (!pc) return;
    if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else this.pendingIce.set(id, [...(this.pendingIce.get(id) || []), data.candidate]);
      return;
    }
    if (data.type === 'offer' && !this.isHost) {
      await pc.setRemoteDescription(data);
      for (const c of this.pendingIce.get(id) || []) await pc.addIceCandidate(c);
      this.pendingIce.delete(id);
      await pc.setLocalDescription(await pc.createAnswer());
      await this._signal(id, { type: 'answer', sdp: pc.localDescription.sdp });
    } else if (data.type === 'answer' && this.isHost && pc.signalingState === 'have-local-offer') {
      await pc.setRemoteDescription(data);
      for (const c of this.pendingIce.get(id) || []) await pc.addIceCandidate(c);
      this.pendingIce.delete(id);
    }
  }

  async fallback(id) {
    this._fb = this._fb || new Set();
    for (const m of this.targets.filter((x) => !id || x.id === id)) {
      if (this.closed || this._isRelay(m.id) || this._fb.has(m.id)) continue;
      this._fb.add(m.id);
      this._stage(m.id, '直连未建立，正在切换服务器中转');
      try { const d = await this.request('fallback', { to: m.id }); this._applyRoom(d.room); }
      catch (e) { this._stage(m.id, '中转连接失败'); this.onError(e.message); }
      finally { this._fb.delete(m.id); }
    }
  }

  _applyRoom(room) {
    const before = new Set(this.room.members.map((m) => m.id));
    this.room = room;
    for (const [id, pc] of this.peers) if (!room.members.some((m) => m.id === id)) {
      pc.onconnectionstatechange = null; const c = this.ch.get(id); if (c) c.onclose = null;
      pc.close(); this.peers.delete(id); this.ch.delete(id); this.stCh.delete(id);
      this.onPacket({ t: 'leave' }, id);
    }
    for (const id of before) if (!room.members.some((m) => m.id === id) && !this.peers.has(id) && this.relayUp.has(id)) { this.relayUp.delete(id); this.onPacket({ t: 'leave' }, id); }
    for (const m of this.targets) if (this._isRelay(m.id) && this.peers.has(m.id)) {
      this.peers.get(m.id).close(); this.peers.delete(m.id);
      this._stage(m.id, '服务器中转 · 延迟高于直连');
      this.send({ t: 'ping', at: Date.now() }, m.id);
    } else if (this._isRelay(m.id) && !this.stage.get(m.id)?.startsWith('服务器中转')) this._stage(m.id, '服务器中转 · 延迟高于直连');
    this.onRoom(room);
  }

  async _poll() {
    if (this.closed) return;
    const batch = []; let size = 0;
    for (const p of this.outgoing) { size += JSON.stringify(p).length; if (size > 60000 || batch.length >= 64) break; batch.push(p); }
    try {
      const d = await this.request('poll', { since: this.seq, packetSince: this.packetSeq, packets: batch });
      if (this.closed) return;
      this.failures = 0;
      const sent = new Set(batch.map((p) => p.id));
      this.outgoing = this.outgoing.filter((p) => !sent.has(p.id));
      this._applyRoom(d.room);
      if (this.isHost) for (const m of this.targets) if (!this._isRelay(m.id) && !this.peers.has(m.id)) this._peer(m.id, true).catch(() => this.fallback(m.id));
      if (FORCE_RELAY) for (const m of this.targets) if (!this._isRelay(m.id)) this.fallback(m.id);
      if (!this.isHost && this.targets.length && !this._hostTimer) this._hostTimer = this._later(() => { if (!this.connected(this.room.host)) this.fallback(this.room.host); }, 15000);
      for (const s of d.signals) {
        const key = 'in:' + s.from;
        this.chains.set(key, (this.chains.get(key) || Promise.resolve()).then(() => this._onSignal(s.from, s.data)).catch(() => this.fallback(s.from)));
      }
      this.seq = d.seq;
      for (const p of d.packets || []) if (this._isRelay(this.isHost ? p.from : this.id)) this._receive(p.from, p.data);
      this.packetSeq = d.packetSeq ?? this.packetSeq;
      if (Date.now() - this.lastPing >= 1000) { this.lastPing = Date.now(); this.send({ t: 'ping', at: this.lastPing }); }
    } catch (e) {
      if (this.closed) return;
      if (e.status === 403 || e.status === 404) { this._shutdown(); this.onError(e.message, true); return; }
      if (++this.failures === 3) this.onError('房间服务器暂时连不上，正在重试…');
    }
    const relaying = this.targets.some((m) => this._isRelay(m.id));
    if (!this.closed) this._pollT = setTimeout(() => this._poll(), relaying ? 60 : 700);
  }

  _shutdown() {
    this.closed = true; clearTimeout(this._pollT);
    for (const t of this.timers) clearTimeout(t);
    for (const pc of this.peers.values()) pc.close();
  }
  close() { if (this.closed) return; removeEventListener('pagehide', this._unload); this._shutdown(); this.request('leave').catch(() => {}); }
}
