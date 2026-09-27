const { chromium } = require('/usr/local/lib/node_modules/playwright');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/local/bin/chromium',args:['--no-sandbox']});
 try {
 const a=await browser.newPage(),b=await browser.newPage();
 for(const p of [a,b])await p.goto('http://127.0.0.1:3000/api/rooms?relay=1');
 const code=await a.evaluate(async()=>{const {LanClient}=await import('/game/src/net/lan.js');window.c=await LanClient.create('Host','shooter');return c.code});
 await b.evaluate(async code=>{const {LanClient}=await import('/game/src/net/lan.js');window.c=await LanClient.join(code,'Teammate','roller');window.packets=[];c.onPacket=d=>packets.push(d)},code);
 await a.waitForFunction(()=>c.targets.length===1 && c.allConnected());
 await a.evaluate(()=>c.send({t:'relay-test',value:42}));
 await b.waitForFunction(()=>packets.some(d=>d.value===42));
 await b.evaluate(()=>c.close());await a.evaluate(()=>c.close());
 console.log('PASS local server rooms and forced HTTP relay');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
