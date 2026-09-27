const assert = require('node:assert/strict');
const fs = require('node:fs');
(async()=>{
 global.location={origin:'https://test.example'};global.addEventListener=()=>{};global.removeEventListener=()=>{};
 class Socket {
  static OPEN=1;static instances=[];
  constructor(){this.readyState=1;this.bufferedAmount=0;this.sent=[];Socket.instances.push(this);queueMicrotask(()=>this.onopen());}
  send(s){this.sent.push(JSON.parse(s));}
  message(m){this.onmessage({data:JSON.stringify(m)});}
  close(){this.readyState=3;this.onclose?.();}
 }
 global.WebSocket=Socket;
 const {WssClient}=await import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync('public/game/src/net/wss.js','utf8')).toString('base64'));
 const members=Array.from({length:10},(_,i)=>({id:'p'+i,name:'Player'+i,team:i%2,weapon:'shooter',loaded:true}));
 const room={game:'inkwave',code:'ABCDEF',key:'1234',host:'p0',members,cfg:{mapId:'tidewater',duration:90,difficulty:'normal'},match:null};
 const clients=[];
 for(let i=0;i<10;i++){
  const opening=i===0?WssClient.create('Player0','shooter'):WssClient.join('ABCDEF','Player'+i,'shooter',undefined,'1234');
  const ws=Socket.instances.at(-1);await Promise.resolve();assert.equal(ws.sent[0].cap,10);assert.equal(ws.sent[0].game,'inkwave');
  ws.message({t:'welcome',me:'p'+i,room});clients.push(await opening);
 }
 const host=clients[0];const start={t:'start',roster:[]};const starting=host.request('start',{packet:start});const req=host.ws.sent.at(-1);assert.deepEqual(req.d.packet,start);
 const running={...room,match:{id:'match1',started:true,host:'p0'}};
 host.ws.message({t:'iwack',q:req.q,room:running});await starting;
 for(const c of clients.slice(1))c.ws.message({t:'room',room:running});
 const received=[];clients[1].onPacket=(d,from)=>received.push({d,from});
 clients[1].ws.message({t:'iwst',m:'match1',rows:[{f:'p0',a:['a00',1]},{f:'p0',a:['a02',2]},{f:'p2',a:['a04',3]}]});assert.equal(received.length,2);assert.equal(received[0].d.a.length,2);
 host.ws.bufferedAmount=20000;
 for(let n=0;n<100;n++)host.send({t:'st',a:[['a00',n]]});
 assert.equal(host.states.get('').size,1);host.ws.bufferedAmount=0;host.flush();assert.equal(host.ws.sent.at(-1).d.a[0][1],99);
 const before=host.ws.sent.length;host.send({t:'sp',s:Array.from({length:600},()=>[1,2,3,1,0,0,0])});
 const splats=host.ws.sent.slice(before);assert.equal(splats.length,3);assert.equal(splats.reduce((n,p)=>n+p.d.s.length,0),600);assert(splats.every(p=>p.d.s.length<=256&&Buffer.byteLength(JSON.stringify(p))<=49152));
 const leaves=[];host.onPacket=(d,from)=>{if(d.t==='leave')leaves.push(from);};
 host.ws.message({t:'iw',m:'match1',f:'p2',d:{t:'leave'}});
 host.ws.message({t:'room',room:{...running,members:members.filter(m=>m.id!=='p2')}});
 assert.deepEqual(leaves,['p2']);
 const retry=clients[3];const denied=retry.request('profile',{team:0});const q=retry.ws.sent.at(-1).q;
 retry.ws.message({t:'iwack',q,code:'team_full',error:'Team full'});await assert.rejects(denied,/Team full/);assert(!retry.closed);
 const again=retry.request('profile',{weapon:'roller'});retry.ws.message({t:'iwack',q:retry.ws.sent.at(-1).q,room:running});await again;assert(!retry.closed);
 for(const [index,code] of [[4,'packet_size'],[5,'actor_owner'],[6,'stale_match']]){
  const c=clients[index];let failures=0;c.onError=(_,fatal)=>{assert(fatal);failures++;};
  c.ws.message({t:'error',code,msg:'Game message rejected'});assert(c.closed);assert.equal(failures,1);
  c.ws.message({t:'error',code,msg:'Duplicate error'});assert.equal(failures,1);
 }
 const heartbeat=clients[7];const ping=heartbeat.ws.sent.find(p=>p.t==='ping');
 heartbeat.ws.message({t:'pong',c:ping.c});assert(Number.isFinite(heartbeat.rtt));
 heartbeat.lastPongAt=performance.now()-6100;
 heartbeat.ws.message({t:'pong',c:ping.c}); // Replay must not revive the clock.
 heartbeat.ws.message({t:'room',room:running}); // Other messages do not replace a pong.
 let timeout='';heartbeat.onError=(msg,fatal)=>{assert(fatal);timeout=msg;};heartbeat.heartbeat();
 assert(heartbeat.closed);assert.match(timeout,/heartbeat timed out/);assert.equal(heartbeat.rtt,undefined);
 const hostGone=clients[8];let ended=false;hostGone.onError=(_,fatal)=>ended=fatal;
 hostGone.ws.message({t:'room',room:{...running,match:null,result:{reason:'Host left'}}});assert(ended&&hostGone.closed);
 console.log('PASS single reliable leave, retryable iwack, fatal game errors, pong timeout/replay protection, host termination');
 let fatal=false;clients[2].onError=(_,f)=>fatal=f;clients[2].ws.close();assert(fatal&&clients[2].closed);
 for(const c of clients)c.close();
 const bad=WssClient.create('test','shooter');Socket.instances.at(-1).message({t:'welcome',me:'bad',room:{...room,game:'ship'}});await assert.rejects(bad,/does not support INKWAVE/);
 const post=async body=>{const r=await fetch('http://127.0.0.1:3000/api/rooms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 const h=await post({action:'create',name:'Ten-player test'});assert.equal(h.status,200);const code=h.data.room.code;
 try {
  for(let i=1;i<10;i++){const r=await post({action:'join',code,name:'Player'+i});assert.equal(r.status,200);if(i===9){assert.equal(r.data.room.members.filter(m=>m.team===0).length,5);assert.equal(r.data.room.members.filter(m=>m.team===1).length,5);}}
  assert.equal((await post({action:'join',code,name:'Eleventh player'})).status,409);
  assert.equal((await post({action:'profile',code,id:h.data.id,token:h.data.token,team:1})).status,409);
 } finally {await post({action:'leave',code,id:h.data.id,token:h.data.token});}
 console.log('PASS mocked WSS protocol for 10 seats, atomic start, state grouping/coalescing, splat splitting, disconnect, old-server rejection; real local API 10 seats, 11th rejection and 5-player team cap');
})().catch(e=>{console.error(e);process.exit(1)});
