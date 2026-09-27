import { PeerDiagnostics, randomClientId, traceConnection } from './peer-diagnostics.js';
// PeerJS Cloud configuration and bounded signaling recovery follow the transport-ship app.
const STATE_BACKLOG = 16 * 1024;
const ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:global.stun.twilio.com:3478' }];
const PREFIX = 'inkwave-appjcivu396tfuzemb1-v1-';
const weapons = new Set(['shooter', 'roller', 'charger', 'blaster']);
const cleanName = v => String(v || 'Player').replace(/[^\p{L}\p{N}_ .-]/gu, '').trim().slice(0, 16) || 'Player';

export class PublicClient {
  static async create(name, weapon, _server, progress) { return this.open(true, '', name, weapon, progress); }
  static async join(code, name, weapon, _server, _key, progress) {
    if (!/^[A-F0-9]{6}$/i.test(code)) throw new Error('Please enter a 6-character room code');
    return this.open(false, code.toUpperCase(), name, weapon, progress);
  }
  static async open(host, code, name, weapon, progress) {
    const c = new PublicClient(host, code, name, weapon, progress);
    try { await c.open(); return c; } catch (e) { c.close(); throw e; }
  }
  constructor(host, code, name, weapon, progress = () => {}) {
    this.debug = new PeerDiagnostics(); this.progress = progress;
    this.stages = new Map(); this.connectionTimers = new Set();
    this.signalingOpened = false; this.opened = false; this.reconnects = 0; this.lastReconnect = 0;
    code ||= Array.from(crypto.getRandomValues(new Uint8Array(3)), x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    this.id = host ? PREFIX + code : PREFIX + randomClientId();
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
  status() { return this.targets.map(m => ({ id: m.id, name: m.name, via: this.connected(m.id) ? 'direct' : 'connecting', stage: this.stages.get(m.id) || 'Waiting for public signaling exchange', ping: Date.now() - (this.lastPong.get(m.id) || 0) < 5000 ? this.latency.get(m.id) : undefined })); }
  stage(id, text) { this.stages.set(id,text); this.debug.log('connection',text,{peer:id===this.room.host?'host':'member'}); this.progress(text); this.onStatus(); }
  open() {
    return new Promise((resolve, reject) => {
      this.resolve = resolve; this.reject = reject;
      this.stage('server','Connecting to the public signaling server…');
      this.deadline = setTimeout(() => this.fail(this.signalingOpened ? 'Connected to public signaling, but could not reach the host directly. Make sure the host is online; you can switch to the same network and retry.' : 'Could not reach the public signaling server (0.peerjs.com) within 30 seconds. Check your network and retry, or export the connection log.'), 30000);
      this.peer = new window.Peer(this.id, { host: '0.peerjs.com', port: 443, secure: true, path: '/', key: 'peerjs', debug: 0, config: { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:global.stun.twilio.com:3478' }] } });
      this.peer.on('open', () => {
        if (this.closed) return;
        this.signalingOpened = true;
        this.stage('server','Public signaling connected');
        if (this.opened) return;
        if (this.isHost) this.ready();
        else {
          this.stage(this.room.host,'Signaling ready, contacting the host…');
          this.bind(this.peer.connect(this.room.host, { reliable: true, serialization: 'json', metadata: { protocol: 'inkwave-v1', name: this.profile.name, weapon: this.profile.weapon } }), false);
        }
      });
      this.peer.on('connection', c => { if (!this.isHost || c.metadata?.protocol !== 'inkwave-v1') c.close(); else this.bind(c, true); });
      this.peer.on('error', e => {
        if (this.closed) return;
        this.debug.log('signaling','Public signaling error',{type:e.type});
        const message = e.type === 'peer-unavailable' ? 'Room not found. Check the room code and make sure the host is still online.' : e.type === 'unavailable-id' ? 'That room code is already taken. Please create a new room.' : `Connection failed (${e.type}). Please retry or use the LAN version.`;
        if (this.reject) this.fail(message); else this.onError(message, false);
      });
      this.peer.on('disconnected', () => { if (!this.closed) this.stage('server','Signaling disconnected; existing direct connections continue. Retrying up to 3 times'); });
      this.heartbeat = setInterval(() => {
        if (this.peer.disconnected && !this.peer.destroyed && this.reconnects < 3 && Date.now()-this.lastReconnect >= 5000) {
          this.reconnects++;this.lastReconnect=Date.now();
          this.debug.log('signaling','Retrying public signaling',{attempt:this.reconnects});
          try { this.peer.reconnect(); } catch {}
        }
        this.send({ _iw: 'ping', at: Date.now() }); this.onStatus();
      }, 1500);
    });
  }
  ready() { this.opened = true; this.debug.log('room',this.isHost?'Room created':'Host accepted join');clearTimeout(this.deadline); this.resolve?.(); this.resolve = null; this.reject = null; }
  fail(message) { if(this.closed)return;this.debug.log('error',message);this.reject?.(new Error(message)); this.reject = null; this.resolve = null; this.close(); this.onError(message, true); }
  bind(conn, incoming) {
    const id = conn.peer;
    if (this.channels.has(id)) { conn.close(); return; }
    this.channels.set(id, conn);
    this.stage(id,incoming?'Received player connection request':'Checking direct path to player');
    traceConnection(conn.peerConnection,this.debug,'events');
    const deadline=setTimeout(()=>{
      this.connectionTimers.delete(deadline);
      if(this.closed||conn.open)return;
      this.stage(id,'Direct connection to player timed out; data channel did not open');
      if(!this.isHost)this.fail('Signaling exchanged, but the direct connection failed. Try the same network, or have both players export connection logs.');
      else conn.close();
    },30000);
    this.connectionTimers.add(deadline);
    conn.on('open', () => {
      clearTimeout(deadline);this.connectionTimers.delete(deadline);
      if (this.closed) { conn.close(); return; }
      this.stage(id,'WebRTC data channel connected');
      if (incoming) {
        if (this.room.started || this.members.length >= 10) {
          conn.send({ _iw: 'reject', message: this.room.started ? 'The match has already started. Please wait for the next one.' : 'The room is full (10 players).' });
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
    conn.on('error', () => this.onError('Player connection error. Please check your network.', false));
    conn.on('close', () => {
      clearTimeout(deadline);this.connectionTimers.delete(deadline);
      this.debug.log('webrtc','Data channel closed');
      this.channels.delete(id); this.statePeers.get(id)?.close(); this.statePeers.delete(id); this.stateChannels.delete(id); this.statePending.delete(id); if (this.closed) return;
      if (this.isHost) { this.room.members = this.members.filter(m => m.id !== id); this.broadcast(); this.onPacket({ t: 'leave' }, id); }
      else this.fail('The host left or the connection dropped. Please rejoin the room.');
    });
  }
  async initState(id, offer = false) {
    if (this.statePeers.has(id)) return this.statePeers.get(id);
    const pc = new RTCPeerConnection({ iceServers: ICE });
    this.statePeers.set(id, pc);
    traceConnection(pc,this.debug,'positions');
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
    if (!me) throw new Error('Your room session has expired');
    if (action === 'profile') {
      if (this.room.started) throw new Error('Change your loadout after this match ends');
      if ([0, 1].includes(extra.team)) {
        if (this.members.filter(m => m.id !== id && m.team === extra.team).length >= 5) throw new Error('That team is full (5 players)');
        me.team = extra.team;
      }
      if (weapons.has(extra.weapon)) me.weapon = extra.weapon;
      if (extra.name) me.name = cleanName(extra.name);
    } else if (['settings', 'start', 'end'].includes(action)) {
      if (id !== this.room.host) throw new Error('Only the host can do that');
      if (action === 'settings') {
        const s = extra.settings || {};
        if (['tidewater', 'kelpline', 'sunset'].includes(s.mapId)) this.room.settings.mapId = s.mapId;
        if ([90, 180].includes(s.duration)) this.room.settings.duration = s.duration;
        if (['easy', 'normal', 'hard'].includes(s.difficulty)) this.room.settings.difficulty = s.difficulty;
      } else {
        if (action === 'start' && !this.allConnected()) throw new Error('Wait for all players to connect');
        this.room.started = action === 'start';
      }
    } else throw new Error('Unknown action');
    this.broadcast(); return { room: this.room };
  }
  async request(action, extra = {}) {
    if (this.closed) throw new Error('Room connection closed');
    if (this.isHost) return this.action(this.id, action, extra);
    const key = randomClientId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(key); reject(new Error('The host did not respond. Please retry')); }, 8000);
      this.pending.set(key, { resolve, reject, timer }); this.send({ _iw: 'request', key, action, extra });
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true; for(const t of this.connectionTimers)clearTimeout(t);this.connectionTimers.clear(); clearInterval(this.stateTimer); for (const pc of this.statePeers.values()) pc.close(); this.statePeers.clear(); this.statePending.clear(); clearTimeout(this.deadline); clearInterval(this.heartbeat); removeEventListener('pagehide', this.unload);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Connection closed')); }
    this.pending.clear(); for (const c of this.channels.values()) c.close(); this.peer?.destroy();
    this.debug.log('session','Connection session closed');this.debug.flush();
  }
}
