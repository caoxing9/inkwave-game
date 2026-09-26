// Public signaling follows the transport-ship app: PeerJS Cloud + WebRTC, no TURN relay.
const STATE_BACKLOG = 16 * 1024;
const ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:global.stun.twilio.com:3478' }];
const PREFIX = 'inkwave-appjcivu396tfuzemb1-v1-';
const weapons = new Set(['shooter', 'roller', 'charger', 'blaster']);
const cleanName = v => String(v || '玩家').replace(/[^\p{L}\p{N}_ .-]/gu, '').trim().slice(0, 16) || '玩家';

export class PublicClient {
  static async create(name, weapon) { return this.open(true, '', name, weapon); }
  static async join(code, name, weapon) {
    if (!/^[A-F0-9]{6}$/i.test(code)) throw new Error('请输入 6 位房间码');
    return this.open(false, code.toUpperCase(), name, weapon);
  }
  static async open(host, code, name, weapon) {
    const c = new PublicClient(host, code, name, weapon);
    try { await c.open(); return c; } catch (e) { c.close(); throw e; }
  }
  constructor(host, code, name, weapon) {
    code ||= Array.from(crypto.getRandomValues(new Uint8Array(3)), x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    this.id = host ? PREFIX + code : PREFIX + crypto.randomUUID();
    this.profile = { id: this.id, name: cleanName(name), weapon: weapons.has(weapon) ? weapon : 'shooter', team: 0 };
    this.room = { code, host: PREFIX + code, members: host ? [this.profile] : [], settings: { mapId: 'tidewater', duration: 180, difficulty: 'normal' }, started: false, relayMembers: [] };
    this.channels = new Map(); this.latency = new Map(); this.lastPong = new Map(); this.pending = new Map();
    this.statePeers = new Map(); this.stateChannels = new Map(); this.statePending = new Map();
    this.stateSeq = new Map(); this.stateReceived = new Map(); this.signalChains = new Map();
    this.replacedStates = 0;
    this.stateTimer = setInterval(() => this.flushStates(), 16);
    this.closed = false;
    this.onPacket = () => {}; this.onRoom = () => {}; this.onStatus = () => {}; this.onError = () => {};
    this.unload = () => this.close(); addEventListener('pagehide', this.unload);
  }
  get isHost() { return this.id === this.room.host; }
  get code() { return this.room.code; }
  get members() { return this.room.members; }
  get targets() { return this.members.filter(m => m.id !== this.id && (this.isHost || m.id === this.room.host)); }
  connected(id) { return this.channels.get(id)?.open === true; }
  allConnected() { return this.targets.every(m => this.connected(m.id)); }
  status() { return this.targets.map(m => ({ id: m.id, name: m.name, via: this.connected(m.id) ? 'direct' : 'connecting', stage: '免费信令 · WebRTC 直连', ping: Date.now() - (this.lastPong.get(m.id) || 0) < 5000 ? this.latency.get(m.id) : undefined })); }
  open() {
    return new Promise((resolve, reject) => {
      this.resolve = resolve; this.reject = reject;
      this.deadline = setTimeout(() => this.fail('连接超时。请确认房主在线，或换到同一网络；免费直连模式不提供服务器中转。'), 30000);
      this.peer = new window.Peer(this.id, { host: '0.peerjs.com', port: 443, secure: true, path: '/', key: 'peerjs', debug: 0, config: { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:global.stun.twilio.com:3478' }] } });
      this.peer.on('open', () => {
        if (this.closed) return;
        if (this.isHost) this.ready();
        else this.bind(this.peer.connect(this.room.host, { reliable: true, serialization: 'json', metadata: { protocol: 'inkwave-v1', name: this.profile.name, weapon: this.profile.weapon } }), false);
      });
      this.peer.on('connection', c => { if (!this.isHost || c.metadata?.protocol !== 'inkwave-v1') c.close(); else this.bind(c, true); });
      this.peer.on('error', e => {
        const message = e.type === 'peer-unavailable' ? '找不到房间，请检查房间码，并确认房主仍在线。' : e.type === 'unavailable-id' ? '房间码已被占用，请重新创建。' : `联机连接失败（${e.type}），请重试或使用局域网版。`;
        if (this.reject) this.fail(message); else this.onError(message, false);
      });
      this.heartbeat = setInterval(() => {
        if (this.peer.disconnected && !this.peer.destroyed) { try { this.peer.reconnect(); } catch {} }
        this.send({ _iw: 'ping', at: Date.now() }); this.onStatus();
      }, 1500);
    });
  }
  ready() { clearTimeout(this.deadline); this.resolve?.(); this.resolve = null; this.reject = null; }
  fail(message) { this.reject?.(new Error(message)); this.reject = null; this.resolve = null; this.onError(message, true); this.close(); }
  bind(conn, incoming) {
    const id = conn.peer;
    if (this.channels.has(id)) { conn.close(); return; }
    this.channels.set(id, conn);
    conn.on('open', () => {
      if (this.closed) { conn.close(); return; }
      if (incoming) {
        if (this.room.started || this.members.length >= 10) {
          conn.send({ _iw: 'reject', message: this.room.started ? '对战已开始，请等下一局。' : '房间已满（10 人）。' });
          setTimeout(() => conn.close(), 500); return;
        }
        const a = this.members.filter(m => m.team === 0).length;
        this.room.members.push({ id, name: cleanName(conn.metadata.name), weapon: weapons.has(conn.metadata.weapon) ? conn.metadata.weapon : 'shooter', team: a <= this.members.length - a ? 0 : 1 });
        conn.send({ _iw: 'welcome', room: this.room }); this.broadcast();
        this.initState(id, true).catch(() => {});
      }
      this.onStatus();
    });
    conn.on('data', d => {
      if (!d || typeof d !== 'object' || this.closed) return;
      if (!this.isHost && id === this.room.host && ['welcome', 'room'].includes(d._iw)) {
        if (d.room?.host !== id || !Array.isArray(d.room.members) || !d.room.members.some(m => m.id === this.id)) return;
        this._applyRoom(d.room); if (d._iw === 'welcome') this.ready(); return;
      }
      if (!this.isHost && d._iw === 'reject') { this.fail(d.message); return; }
      if (!this.members.some(m => m.id === id)) return;
      if (d._iw === 'state-signal') {
        this.signalChains.set(id, (this.signalChains.get(id) || Promise.resolve()).then(() => this.stateSignal(id, d.signal)).catch(() => {})); return;
      }
      if (d.t === 'st') { this.receiveState(id, d); return; }
      if (d._iw === 'ping') { conn.send({ _iw: 'pong', at: d.at }); return; }
      if (d._iw === 'pong') { this.latency.set(id, Math.max(0, Date.now() - d.at)); this.lastPong.set(id, Date.now()); this.onStatus(); return; }
      if (d._iw === 'request' && this.isHost) {
        try { this.action(id, d.action, d.extra || {}); conn.send({ _iw: 'response', key: d.key, room: this.room }); }
        catch (e) { conn.send({ _iw: 'response', key: d.key, error: e.message }); }
        return;
      }
      if (d._iw === 'response' && !this.isHost) { const p = this.pending.get(d.key); if (p) { clearTimeout(p.timer); this.pending.delete(d.key); d.error ? p.reject(new Error(d.error)) : p.resolve({ room: d.room }); } return; }
      if (!d._iw) this.onPacket(d, id);
    });
    conn.on('error', () => this.onError('玩家连接异常，请检查网络。', false));
    conn.on('close', () => {
      this.channels.delete(id); this.statePeers.get(id)?.close(); this.statePeers.delete(id); this.stateChannels.delete(id); this.statePending.delete(id); if (this.closed) return;
      if (this.isHost) { this.room.members = this.members.filter(m => m.id !== id); this.broadcast(); this.onPacket({ t: 'leave' }, id); }
      else this.fail('房主已离开或连接中断，请重新加入房间。');
    });
  }
  async initState(id, offer = false) {
    if (this.statePeers.has(id)) return this.statePeers.get(id);
    const pc = new RTCPeerConnection({ iceServers: ICE });
    this.statePeers.set(id, pc);
    pc.onicecandidate = e => { if (e.candidate) this.send({ _iw: 'state-signal', signal: { candidate: e.candidate.toJSON() } }, id); };
    const bind = ch => {
      this.stateChannels.set(id, ch);
      ch.onmessage = e => { try { this.receiveState(id, JSON.parse(e.data)); } catch {} };
      ch.onopen = () => this.onStatus();
      ch.onclose = () => { if (this.stateChannels.get(id) === ch) this.stateChannels.delete(id); this.onStatus(); };
    };
    pc.ondatachannel = e => bind(e.channel);
    if (offer) {
      bind(pc.createDataChannel('inkwave-state', { ordered: false, maxRetransmits: 0 }));
      await pc.setLocalDescription(await pc.createOffer());
      this.send({ _iw: 'state-signal', signal: { type: 'offer', sdp: pc.localDescription.sdp } }, id);
    }
    return pc;
  }
  async stateSignal(id, signal) {
    if (this.closed || !signal || !this.connected(id)) return;
    const pc = await this.initState(id);
    if (signal.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate);
      else (pc.queuedIce ||= []).push(signal.candidate);
      return;
    }
    if (signal.type !== 'offer' && signal.type !== 'answer') return;
    await pc.setRemoteDescription(signal);
    for (const ice of pc.queuedIce || []) await pc.addIceCandidate(ice);
    pc.queuedIce = [];
    if (signal.type === 'offer') {
      await pc.setLocalDescription(await pc.createAnswer());
      this.send({ _iw: 'state-signal', signal: { type: 'answer', sdp: pc.localDescription.sdp } }, id);
    }
  }
  receiveState(id, data) {
    if (this.closed || !this.members.some(m => m.id === id) || data.t !== 'st' || !Array.isArray(data.a)) return;
    if (Number.isSafeInteger(data.q)) {
      if (data.q <= (this.stateReceived.get(id) || 0)) return;
      this.stateReceived.set(id, data.q);
    }
    this.onPacket(data, id);
  }
  flushStates() {
    if (this.closed) return;
    for (const [id, actors] of this.statePending) {
      if (!actors.size) continue;
      const fast = this.stateChannels.get(id), reliable = this.channels.get(id);
      const ch = fast?.readyState === 'open' ? fast : reliable?.open ? reliable : null;
      if (!ch || (ch.dataChannel?.bufferedAmount ?? ch.bufferedAmount ?? 0) > STATE_BACKLOG) continue;
      const q = (this.stateSeq.get(id) || 0) + 1;
      const packet = { t: 'st', a: [...actors.values()], q };
      try { ch.send(ch === fast ? JSON.stringify(packet) : packet); this.stateSeq.set(id, q); actors.clear(); } catch {}
    }
  }
  _applyRoom(room) { this.room = room; this.onRoom(room); this.onStatus(); }
  broadcast() { this.send({ _iw: 'room', room: this.room }); this.onRoom(this.room); this.onStatus(); }
  send(data, to) {
    if (this.closed) return;
    for (const m of this.targets) {
      if (to && to !== m.id) continue;
      if (data.t === 'st' && Array.isArray(data.a)) {
        const actors = this.statePending.get(m.id) || new Map();
        for (const pose of data.a) { if (actors.has(pose[0])) this.replacedStates++; actors.set(pose[0], pose); }
        this.statePending.set(m.id, actors);
        continue;
      }
      const c = this.channels.get(m.id);
      if (c?.open) { try { c.send(data); } catch {} }
    }
  }
  action(id, action, extra) {
    const me = this.members.find(m => m.id === id);
    if (!me) throw new Error('房间身份已失效');
    if (action === 'profile') {
      if (this.room.started) throw new Error('请在本局结束后更换配置');
      if ([0, 1].includes(extra.team)) {
        if (this.members.filter(m => m.id !== id && m.team === extra.team).length >= 5) throw new Error('该队伍已满（5 人）');
        me.team = extra.team;
      }
      if (weapons.has(extra.weapon)) me.weapon = extra.weapon;
      if (extra.name) me.name = cleanName(extra.name);
    } else if (['settings', 'start', 'end'].includes(action)) {
      if (id !== this.room.host) throw new Error('只有房主可以执行此操作');
      if (action === 'settings') {
        const s = extra.settings || {};
        if (['tidewater', 'kelpline', 'sunset'].includes(s.mapId)) this.room.settings.mapId = s.mapId;
        if ([90, 180].includes(s.duration)) this.room.settings.duration = s.duration;
        if (['easy', 'normal', 'hard'].includes(s.difficulty)) this.room.settings.difficulty = s.difficulty;
      } else {
        if (action === 'start' && !this.allConnected()) throw new Error('请等待所有玩家连接');
        this.room.started = action === 'start';
      }
    } else throw new Error('未知操作');
    this.broadcast(); return { room: this.room };
  }
  async request(action, extra = {}) {
    if (this.closed) throw new Error('房间连接已关闭');
    if (this.isHost) return this.action(this.id, action, extra);
    const key = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(key); reject(new Error('房主响应超时，请重试')); }, 8000);
      this.pending.set(key, { resolve, reject, timer }); this.send({ _iw: 'request', key, action, extra });
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.stateTimer); for (const pc of this.statePeers.values()) pc.close(); this.statePeers.clear(); this.statePending.clear(); clearTimeout(this.deadline); clearInterval(this.heartbeat); removeEventListener('pagehide', this.unload);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('连接已关闭')); }
    this.pending.clear(); for (const c of this.channels.values()) c.close(); this.peer?.destroy();
  }
}
