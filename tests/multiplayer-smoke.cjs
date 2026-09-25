const { chromium } = require('/usr/local/lib/node_modules/playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({executablePath:'/usr/local/bin/chromium',args:['--no-sandbox','--enable-unsafe-swiftshader']});
 try {
 const a = await browser.newPage(), b = await browser.newPage();
 for (const p of [a,b]) { await p.goto('http://127.0.0.1:3000/api/rooms'); await p.addScriptTag({url:'/game/vendor/peerjs.min.js'}); }
 const code = await a.evaluate(async()=>{const {PublicClient}=await import('/game/src/net/public.js');window.c=await PublicClient.create('房主','shooter');window.packets=[];c.onPacket=(d)=>packets.push(d);return c.code;});
 console.log('Public room',code);
 await b.evaluate(async(code)=>{const {PublicClient}=await import('/game/src/net/public.js');window.c=await PublicClient.join(code,'队友','roller');window.packets=[];c.onPacket=(d)=>packets.push(d);},code);
 await a.waitForFunction(()=>c.members.length===2 && c.allConnected());
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
