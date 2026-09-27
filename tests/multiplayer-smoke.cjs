const { chromium } = require('/usr/local/lib/node_modules/playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({executablePath:'/usr/local/bin/chromium',args:['--no-sandbox','--enable-unsafe-swiftshader']});
 try {
 const a = await browser.newPage(), b = await browser.newPage();
 for (const p of [a,b]) { await p.goto('http://127.0.0.1:3000/api/rooms'); await p.addScriptTag({url:'/game/vendor/peerjs.min.js'}); }
 const code = await a.evaluate(async()=>{const {PublicClient}=await import('/game/src/net/public.js');window.c=await PublicClient.create('Host','shooter');window.packets=[];c.onPacket=(d)=>packets.push(d);return c.code;});
 console.log('Public room',code);
 await b.evaluate(async(code)=>{const {PublicClient}=await import('/game/src/net/public.js');window.c=await PublicClient.join(code,'Teammate','roller');window.packets=[];c.onPacket=(d)=>packets.push(d);},code);
 await a.waitForFunction(()=>c.members.length===2 && c.allConnected());
 await a.waitForFunction(()=>[...c.stateChannels.values()].some(ch=>ch.readyState==='open'),null,{timeout:30000});
 await b.waitForFunction(()=>[...c.stateChannels.values()].some(ch=>ch.readyState==='open'),null,{timeout:30000});
 assert.deepEqual(await a.evaluate(()=>{const ch=[...c.stateChannels.values()][0];return [ch.ordered,ch.maxRetransmits];}),[false,0]);
 const backlog = await a.evaluate(()=>{
   const id=c.targets[0].id, ch=c.stateChannels.get(id);
   Object.defineProperty(ch,'bufferedAmount',{configurable:true,get:()=>100000});
   for(let n=0;n<100;n++) c.send({t:'st',a:[['actor1',n]]});
   c.send({t:'st',a:[['actor2',777]]}); c.flushStates();
   c.send({t:'critical-event',value:73});
   return [...c.statePending.get(id).values()];
 });
 assert.deepEqual(backlog,[['actor1',99],['actor2',777]]);
 await b.waitForFunction(()=>packets.some(p=>p.t==='critical-event' && p.value===73));
 await a.evaluate(()=>{delete [...c.stateChannels.values()][0].bufferedAmount;c.flushStates();});
 await b.waitForFunction(()=>packets.some(p=>p.t==='st' && p.a.some(a=>a[0]==='actor1' && a[1]===99) && p.a.some(a=>a[0]==='actor2' && a[1]===777)));
 assert.equal(await b.evaluate(()=>{const count=packets.length;const q=c.stateReceived.get(c.room.host);c.receiveState(c.room.host,{t:'st',q:q-1,a:[['actor1',0]]});return packets.length===count;}),true);
 console.log('PASS independent unordered/no-retry state channel, latest-only per actor, events during state congestion, stale packet rejection');
 await b.evaluate(()=>c.request('profile',{weapon:'charger'}));
 await a.waitForFunction(()=>c.members[1].weapon==='charger');
 await a.evaluate(()=>c.request('settings',{settings:{duration:90,mapId:'kelpline'}}));
 await b.waitForFunction(()=>c.room.settings.duration===90 && c.room.settings.mapId==='kelpline');
 await a.evaluate(async()=>{await c.request('start');c.send({t:'test',value:42});});
 await b.waitForFunction(()=>c.room.started && packets.some(d=>d.value===42));
 assert.equal(await b.evaluate(async()=>{try{await c.request('end');return false;}catch{return true;}}),true);
 await a.evaluate(()=>c.request('end'));
 await b.waitForFunction(()=>!c.room.started);
 await b.evaluate(()=>c.close()); await a.waitForFunction(()=>c.members.length===1); await a.evaluate(()=>c.close());
 console.log('PASS public signaling, two-peer WebRTC, settings, profile, packets, host permissions, rematch, leave');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
