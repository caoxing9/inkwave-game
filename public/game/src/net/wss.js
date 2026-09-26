const DEFAULT_SERVER = 'socket-server.app.teable.cn:8443';
const MAX_PACKET = 48 * 1024;
export class WssClient {
  static server(value = DEFAULT_SERVER) {
    const u = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
    if (!['https:', 'wss:'].includes(u.protocol) || u.username || u.password) throw new Error('请输入有效的安全服务器地址');
    return u.host;
  }
  static async create(name, weapon, server) { return this.open({op:'create',name,weapon},server); }
  static async join(code, name, weapon, server, key) { return this.open({op:'join',room:code,name,weapon,key},server); }
  static async open(hello, server) { const c = new WssClient(server); try { await c.open(hello); return c; } catch(e) { c.close(); throw e; } }
  constructor(server) {
    this.server = WssClient.server(server); this.serverRelays = true; this.closed = false;
    this.room = { members: [], settings: {}, host: '' }; this.id = ''; this.pending = new Map(); this.states = new Map(); this.events = []; this.eventBytes = 0;
    this.onRoom = ()=>{}; this.onStatus = ()=>{}; this.onPacket = ()=>{}; this.onError = ()=>{};
    this.eventBudget=180;this.byteBudget=800*1024;this.budgetAt=performance.now();
    this.unload = ()=>this.close(); addEventListener('pagehide',this.unload);
  }
  get isHost(){return this.id === this.room.host;}
  get code(){return this.room.code;}
  get members(){return this.room.members;}
  get targets(){return this.members.filter(m=>m.id!==this.id);}
  connected(){return !this.closed && this.ws?.readyState===WebSocket.OPEN;}
  allConnected(){return this.connected();}
  status(){return this.targets.map(m=>({id:m.id,name:m.name,via:'relay',stage:'WSS 专用服务器',ping:this.rtt}));}
  open(hello){return new Promise((resolve,reject)=>{
    this.rejectOpen=reject;
    this.deadline=setTimeout(()=>this.fail('连接服务器超时，请检查网络和服务器地址。'),12000);
    this.ws=new WebSocket(`wss://${this.server}/ws`);
    this.ws.onopen=()=>this.ws.send(JSON.stringify({t:'hello',v:1,game:'inkwave',cap:10,...hello}));
    this.ws.onmessage=e=>{
      let m;try{m=JSON.parse(e.data);}catch{return;}
      if(m.t==='welcome'){
        if(m.room?.game!=='inkwave'){this.fail('服务器尚未支持墨浪，请等待兼容版本部署。');return;}
        clearTimeout(this.deadline);this.id=m.me;this._applyRoom(m.room);this.rejectOpen=null;
        this.flushTimer=setInterval(()=>this.flush(),50);
        this.pingTimer=setInterval(()=>{if(this.connected())this.enqueue({t:'ping',c:Date.now(),r:this.rtt??-1});},1000);
        resolve();return;
      }
      if(m.t==='pong'){this.rtt=Math.max(0,Date.now()-Number(m.c));this.onStatus();return;}
      if(m.t==='room'){const room=m.room || m;this._applyRoom(room);return;}
      if(m.t==='iwack'){
        const p=this.pending.get(m.q);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.q);
        if(m.error)p.reject(new Error(m.error));else{this._applyRoom(m.room);p.resolve({room:this.room});}return;
      }
      if(m.t==='iw' && m.m===this.room.match?.id){this.onPacket(m.d,m.f);return;}
      if(m.t==='iwst' && m.m===this.room.match?.id){
        const groups=new Map();for(const row of m.rows||[]){const a=groups.get(row.f)||[];a.push(row.a);groups.set(row.f,a);}for(const [id,a] of groups)this.onPacket({t:'st',a},id);return;
      }
      if(m.t==='error' || m.t==='bye'){const msg=m.msg||m.reason||'服务器关闭了连接';if(m.fatal||m.t==='bye')this.fail(msg);else this.onError(msg,false);}
    };
    this.ws.onerror=()=>{if(this.rejectOpen)this.fail('无法连接 WSS 服务器，请检查网络或等待服务上线。');};
    this.ws.onclose=()=>{if(!this.closed)this.fail('与服务器连接中断，本局已退出，请重新加入房间。');};
  });}
  _applyRoom(raw){
    if(!raw || raw.game!=='inkwave'){this.fail('服务器返回不兼容的游戏房间。');return;}
    const previous=this.room;this.room={...raw,settings:raw.cfg||{},started:!!raw.match?.started,relayMembers:[]};
    for(const m of previous.members||[])if(!raw.members.some(n=>n.id===m.id))this.onPacket({t:'leave'},m.id);
    this.onRoom(this.room);this.onStatus();
    if(previous.match && !raw.match){this.states.clear();if(raw.result?.reason)this.onError(`本局已结束：${raw.result.reason}`,true);}
  }
  async request(op,d={}){
    if(!this.connected())throw new Error('服务器连接已断开');
    const q=crypto.randomUUID();return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(q);reject(new Error('服务器响应超时'));},10000);
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
    if(bytes>MAX_PACKET || this.events.length>=384 || this.eventBytes+bytes>1024*1024){this.fail('发送队列拥堵或消息过大，已退出房间，请检查网络后重试。');return;}
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
    for(const [to,actors] of this.states){if(this.ws.bufferedAmount>16384)break;if(!actors.size)continue;const text=JSON.stringify({t:'iw',m:this.room.match.id,to:to||undefined,d:{t:'st',a:[...actors.values()]}});const bytes=new TextEncoder().encode(text).length;if(bytes>MAX_PACKET){this.fail('位置消息过大，已退出房间。');return;}if(bytes>this.byteBudget)break;this.byteBudget-=bytes;this.ws.send(text);actors.clear();}
    this.onStatus();
  }
  fail(message){this.rejectOpen?.(new Error(message));this.rejectOpen=null;this.close();this.onError(message,true);}
  close(){if(this.closed)return;this.closed=true;clearTimeout(this.deadline);clearInterval(this.flushTimer);clearInterval(this.pingTimer);removeEventListener('pagehide',this.unload);for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('连接已关闭'));}this.pending.clear();this.ws?.close();this.events=[];this.states.clear();}
}
