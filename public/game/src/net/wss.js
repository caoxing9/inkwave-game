const DEFAULT_SERVER = 'socket-server.app.teable.cn:8443';
const MAX_PACKET = 48 * 1024;
const PONG_TIMEOUT = 6000;
export class WssClient {
  static server(value = DEFAULT_SERVER) {
    const u = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
    if (!['https:', 'wss:'].includes(u.protocol) || u.username || u.password) throw new Error('Please enter a valid secure server address');
    return u.host;
  }
  static async create(name, weapon, server) { return this.open({op:'create',name,weapon},server); }
  static async join(code, name, weapon, server, key) { return this.open({op:'join',room:code,name,weapon,key},server); }
  static async open(hello, server) { const c = new WssClient(server); try { await c.open(hello); return c; } catch(e) { c.close(); throw e; } }
  constructor(server) {
    this.server = WssClient.server(server); this.serverRelays = true; this.closed = false;
    this.room = { members: [], settings: {}, host: '' }; this.id = ''; this.pending = new Map(); this.states = new Map(); this.events = []; this.eventBytes = 0;
    this.onRoom = ()=>{}; this.onStatus = ()=>{}; this.onPacket = ()=>{}; this.onError = ()=>{};
    this.pendingPings=new Map();this.lastPongAt=0;
    this.eventBudget=180;this.byteBudget=800*1024;this.budgetAt=performance.now();
    this.unload = ()=>this.close(); addEventListener('pagehide',this.unload);
  }
  get isHost(){return this.id === this.room.host;}
  get code(){return this.room.code;}
  get members(){return this.room.members;}
  get targets(){return this.members.filter(m=>m.id!==this.id);}
  connected(){return !this.closed && this.ws?.readyState===WebSocket.OPEN;}
  allConnected(){return this.connected();}
  status(){return this.targets.map(m=>({id:m.id,name:m.name,via:'relay',stage:'WSS dedicated server',ping:this.rtt}));}
  open(hello){return new Promise((resolve,reject)=>{
    this.rejectOpen=reject;
    this.deadline=setTimeout(()=>this.fail('Timed out connecting to the server. Check your network and the server address.'),12000);
    this.ws=new WebSocket(`wss://${this.server}/ws`);
    this.ws.onopen=()=>this.ws.send(JSON.stringify({t:'hello',v:1,game:'inkwave',cap:10,...hello}));
    this.ws.onmessage=e=>{
      if(this.closed)return;
      let m;try{m=JSON.parse(e.data);}catch{return;}
      if(m.t==='welcome'){
        if(m.room?.game!=='inkwave'){this.fail('This server does not support INKWAVE yet. Please wait for a compatible version to be deployed.');return;}
        clearTimeout(this.deadline);this.id=m.me;this._applyRoom(m.room);this.rejectOpen=null;
        this.flushTimer=setInterval(()=>this.flush(),50);
        this.lastPongAt=performance.now();this.heartbeat();
        this.pingTimer=setInterval(()=>this.heartbeat(),1000);
        resolve();return;
      }
      if(m.t==='pong'){
        const sent=this.pendingPings.get(m.c);if(sent===undefined)return;
        this.pendingPings.delete(m.c);this.lastPongAt=performance.now();this.rtt=Math.max(0,this.lastPongAt-sent);
        for(const [key,at] of this.pendingPings)if(at<=sent)this.pendingPings.delete(key);
        this.rtt=Math.round(this.rtt);this.onStatus();return;
      }
      if(m.t==='room'){const room=m.room || m;this._applyRoom(room);return;}
      if(m.t==='iwack'){
        const p=this.pending.get(m.q);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.q);
        if(m.error)p.reject(new Error(m.error));else{this._applyRoom(m.room);p.resolve({room:this.room});}return;
      }
      if(m.t==='iw' && m.m===this.room.match?.id){this.onPacket(m.d,m.f);return;}
      if(m.t==='iwst' && m.m===this.room.match?.id){
        const groups=new Map();for(const row of m.rows||[]){const a=groups.get(row.f)||[];a.push(row.a);groups.set(row.f,a);}for(const [id,a] of groups)this.onPacket({t:'st',a},id);return;
      }
      if(m.t==='error' || m.t==='bye')this.fail(m.msg||m.reason||'The server rejected a game message. Please rejoin the room.');
    };
    this.ws.onerror=()=>{if(this.rejectOpen)this.fail('Could not connect to the WSS server. Check your network or wait for the service to come online.');};
    this.ws.onclose=()=>{if(!this.closed)this.fail('Lost connection to the server. You have left the match; please rejoin the room.');};
  });}
  heartbeat(){
    if(!this.connected())return;
    if(performance.now()-this.lastPongAt>=PONG_TIMEOUT){this.fail('Server heartbeat timed out. You have left the match; please rejoin the room.');return;}
    const c=Date.now();this.pendingPings.set(c,performance.now());this.enqueue({t:'ping',c,r:this.rtt??-1});
  }
  _applyRoom(raw){
    if(!raw || raw.game!=='inkwave'){this.fail('The server returned an incompatible game room.');return;}
    const previous=this.room;this.room={...raw,settings:raw.cfg||{},started:!!raw.match?.started,relayMembers:[]};
    // Membership updates are not leave events: only the reliable iw leave triggers adoption.
    this.onRoom(this.room);this.onStatus();
    if(previous.match && !raw.match){this.states.clear();if(raw.result?.reason)this.fail(`The match has ended: ${raw.result.reason}`);}
  }
  async request(op,d={}){
    if(!this.connected())throw new Error('Server connection lost');
    const q=crypto.randomUUID();return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(q);reject(new Error('The server did not respond'));},10000);
      this.pending.set(q,{resolve,reject,timer});this.enqueue({t:'iwreq',q,op,d});
    });
  }
  send(d,to){
    if(!this.connected()||!this.room.match)return;
    if(d.t==='st'){
      const key=to||'';const states=this.states.get(key)||new Map();for(const a of d.a||[])states.set(a[0],a);this.states.set(key,states);return;
    }
    if(d.t==='sp'){
      let batch=[];
      for(const s of d.s||[]){const next=[...batch,s];if(next.length>256||new TextEncoder().encode(JSON.stringify({t:'iw',m:this.room.match.id,to,d:{t:'sp',s:next}})).length>MAX_PACKET){if(batch.length)this.enqueue({t:'iw',m:this.room.match.id,to,d:{t:'sp',s:batch}});batch=[];}batch.push(s);}
      if(batch.length)this.enqueue({t:'iw',m:this.room.match.id,to,d:{t:'sp',s:batch}});return;
    }
    this.enqueue({t:'iw',m:this.room.match.id,to,d});
  }
  enqueue(m){
    if(!this.connected())return;
    const text=JSON.stringify(m), bytes=new TextEncoder().encode(text).length;
    if(bytes>MAX_PACKET || this.events.length>=384 || this.eventBytes+bytes>1024*1024){this.fail('Send queue congested or message too large. You have left the room; check your network and retry.');return;}
    this.events.push({text,bytes});this.eventBytes+=bytes;this.flushEvents();
  }
  refill(){const now=performance.now(),dt=(now-this.budgetAt)/1000;this.budgetAt=now;this.eventBudget=Math.min(180,this.eventBudget+dt*100);this.byteBudget=Math.min(800*1024,this.byteBudget+dt*400*1024);}
  flushEvents(){
    if(!this.connected())return;
    this.refill();
    while(this.events.length && this.ws.bufferedAmount<16384 && this.eventBudget>=1 && this.byteBudget>=this.events[0].bytes){const e=this.events.shift();this.eventBudget--;this.byteBudget-=e.bytes;this.eventBytes-=e.bytes;this.ws.send(e.text);}
  }
  flush(){
    this.flushEvents();if(!this.connected()||!this.room.match||this.events.length)return;
    for(const [to,actors] of this.states){if(this.ws.bufferedAmount>16384)break;if(!actors.size)continue;const text=JSON.stringify({t:'iw',m:this.room.match.id,to:to||undefined,d:{t:'st',a:[...actors.values()]}});const bytes=new TextEncoder().encode(text).length;if(bytes>MAX_PACKET){this.fail('Position message too large. You have left the room.');return;}if(bytes>this.byteBudget)break;this.byteBudget-=bytes;this.ws.send(text);actors.clear();}
    this.onStatus();
  }
  fail(message){if(this.closed)return;this.rejectOpen?.(new Error(message));this.rejectOpen=null;this.close();this.onError(message,true);}
  close(){if(this.closed)return;this.closed=true;this.rtt=undefined;this.pendingPings.clear();clearTimeout(this.deadline);clearInterval(this.flushTimer);clearInterval(this.pingTimer);removeEventListener('pagehide',this.unload);for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Connection closed'));}this.pending.clear();this.ws?.close();this.events=[];this.states.clear();}
}
