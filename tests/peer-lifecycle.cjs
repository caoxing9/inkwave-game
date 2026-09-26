const assert=require('node:assert/strict');
const {chromium}=require('/usr/local/lib/node_modules/playwright');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/local/bin/chromium',args:['--no-sandbox']});
 try {
  const page=await browser.newPage();await page.goto('http://127.0.0.1:3000/api/rooms');
  const r=await page.evaluate(async()=>{
   // Deterministic signaling lifecycle tests; real network tests run separately.
   class E {constructor(){this.handlers={};}on(t,f){(this.handlers[t]||=[]).push(f);}emit(t,d){for(const f of this.handlers[t]||[])f(d);}}
   class Conn extends E {constructor(id){super();this.peer=id;this.open=false;this.metadata={};}send(){}close(){this.open=false;this.emit('close');}}
   class Peer extends E {constructor(){super();this.calls=0;this.retries=0;Peer.last=this;}connect(id){this.calls++;return this.conn=new Conn(id);}reconnect(){this.retries++;}destroy(){this.destroyed=true;}}
   window.Peer=Peer;
   const intervals=[],timeouts=[];const si=window.setInterval,st=window.setTimeout;
   window.setInterval=(f,ms)=>{if(ms===1500)intervals.push(f);return si(f,ms);};
   window.setTimeout=(f,ms)=>{if(ms===30000)timeouts.push(f);return st(f,ms);};
   const {PublicClient}=await import('/game/src/net/public.js');
   const progress=[];const host=new PublicClient(true,'','test','shooter',s=>progress.push(s));let error='';
   const open=host.open().catch(e=>{error=e.message;});timeouts[0]();await open;
   const signalTimeout=error.includes('公共信令服务器')&&host.closed;
   const guest=new PublicClient(false,'ABCDEF','test','shooter');const joined=guest.open();const peer=Peer.last;
   peer.emit('open');peer.conn.open=true;peer.conn.emit('data',{_iw:'welcome',room:{...guest.room,members:[{id:guest.room.host,team:0},{id:guest.id,team:1}]}});await joined;
   peer.emit('disconnected');peer.emit('open');const noDuplicate=peer.calls===1;
   const now=Date.now;let clock=100000;Date.now=()=>clock;peer.disconnected=true;
   for(let i=0;i<12;i++){clock+=6000;intervals.at(-1)();}Date.now=now;
   const bounded=peer.retries===3;guest.close();
   const failed=new PublicClient(false,'ABCDEF','test','shooter');let directError='';const attempt=failed.open().catch(e=>directError=e.message);Peer.last.emit('open');timeouts.at(-1)();await attempt;
   const directTimeout=directError.includes('直连失败')&&failed.closed;
   window.setInterval=si;window.setTimeout=st;
   const {PeerDiagnostics}=await import('/game/src/net/peer-diagnostics.js');
   const logs=PeerDiagnostics.history();return {signalTimeout,noDuplicate,bounded,directTimeout,progress:progress.length>0,logsSaved:logs.length>0};
  });
  assert.deepEqual(r,{signalTimeout:true,noDuplicate:true,bounded:true,directTimeout:true,progress:true,logsSaved:true});
  console.log('PASS deterministic Peer timeout phases, no duplicate on signal reconnect, 3-attempt cap and local diagnostics');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
