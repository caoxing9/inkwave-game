const { chromium } = require('/usr/local/lib/node_modules/playwright');
const assert = require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/local/bin/chromium',args:['--no-sandbox','--enable-unsafe-swiftshader']});
 const errors=[];const report={transport:'real PeerJS Cloud + real WebRTC',scene:'original game, low quality, simulation stepped for software GPU',checks:[]};
 try {
  const pages=[];
  for(let i=0;i<2;i++){
   const context=await browser.newContext({viewport:{width:960,height:640}});
   await context.addInitScript(()=>localStorage.setItem('inkwave.settings',JSON.stringify({quality:'low',shadows:false,bloom:false})));
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));pages.push(page);
  }
  const frames=[];
  // Load one full scene at a time to avoid two shader compilers exhausting the software GPU.
  await pages[0].goto('http://127.0.0.1:3000/?mode=public&lobby=1');
  let frame;
  while(!(frame=pages[0].frames().find(f=>f.url().includes('/game/index.html'))))await pages[0].waitForTimeout(100);
  frames.push(frame);
  await frame.waitForFunction(()=>window.__inkwave?.debug,null,{timeout:240000});
  await frame.evaluate(()=>__inkwave.debug.freeze());
  await frame.locator('#iwl-create').waitFor();assert.equal(await frame.locator('#iwl-mode').inputValue(),'public');
  assert.equal(await frame.locator('#iwl-server').isVisible(),false);
  await frame.locator('#iwl-name').fill('场景房主');await frame.locator('#iwl-create').click();
  await frame.locator('#iwl-start').waitFor({timeout:45000});
  const code=await frame.evaluate(()=>__inkwave.lobby.client.code);
  const invite=await frame.locator('.iwl-head code').innerText();assert.equal(new URL(invite).searchParams.get('mode'),'public');assert.equal(new URL(invite).searchParams.get('room'),code);
  await pages[0].waitForFunction(code=>new URL(location.href).searchParams.get('room')===code,code);
  console.log('HOST_READY',code,invite);
  await pages[1].goto(invite);
  while(!(frame=pages[1].frames().find(f=>f.url().includes('/game/index.html'))))await pages[1].waitForTimeout(100);
  frames.push(frame);await frame.waitForFunction(()=>window.__inkwave?.debug,null,{timeout:240000});await frame.evaluate(()=>__inkwave.debug.freeze());
  await frame.locator('#iwl-join').waitFor();assert.equal(await frame.locator('#iwl-code').inputValue(),code);assert.equal(await frame.locator('#iwl-mode').inputValue(),'public');
  await frame.locator('#iwl-name').fill('场景客人');await frame.locator('#iwl-join').click();
  await frames[0].waitForFunction(()=>__inkwave.lobby.client.members.length===2&&__inkwave.lobby.client.allConnected(),null,{timeout:45000});
  report.checks.push('real share URL opens prefilled public lobby; two browsers joined');console.log('TWO_JOINED');
  // Deliberately delay host map attachment: guest ld must survive host attach.
  await frames[0].evaluate(()=>{const net=__inkwave.lobby.session;window.preparePaint=__G.paint;const start=__inkwave.startMatch.bind(__inkwave);__inkwave.startMatch=async o=>{await new Promise(r=>setTimeout(r,1500));return start(o);};});
  // Run the first remote render tick before any network snapshot can arrive.
  for(const f of frames)await f.evaluate(()=>{
    const net=__inkwave.lobby.session,attach=net.attach.bind(net);
    net.attach=m=>{attach(m);for(const a of m.actors)if(a.remote)net.remoteUpdate(a,1/60);};
  });
  await frames[0].locator('#iwl-start').click();
  for(const f of frames)await f.waitForFunction(()=>__G.mode==='match'&&__G.actors.length===10,null,{timeout:60000});
  await frames[0].waitForFunction(()=>__inkwave.lobby.session.everyoneLoaded(),null,{timeout:10000});
  const roster=await frames[0].evaluate(()=>__G.actors.map(a=>({id:a.netId,team:a.team,owner:a.owner,bot:a.isBot})));
  assert.equal(roster.filter(a=>a.team===0).length,5);assert.equal(roster.filter(a=>a.team===1).length,5);assert.equal(roster.filter(a=>a.bot).length,8);
  report.checks.push('10 roles, 5v5, 2 players + 8 bots; early guest load readiness preserved');
  await frames[0].evaluate(()=>{__inkwave.debug.freezeBots();__inkwave.match.stateT=4.3;__inkwave.match.update(1/60);});
  await frames[1].waitForFunction(()=>__inkwave.match.state==='playing');
  report.checks.push('host starts only when both scenes loaded; guest receives playing');
  const local=await frames[0].evaluate(()=>{const a=__G.local;a.pos.x+=0.75;__inkwave.lobby.session.update(0.06);return {id:a.netId,x:a.pos.x};});
  await frames[1].waitForFunction(({id,x})=>{const a=__inkwave.lobby.session.byId.get(id);return a.remote.buf.some(b=>Math.abs(b.s[1]-x)<0.002);},local);
  assert.equal(await frames[1].evaluate(id=>{const net=__inkwave.lobby.session,a=net.byId.get(id);net.remoteUpdate(a,1/60);return a.character.root.visible;},local.id),true);
  report.checks.push('actual scene actor position received and initially hidden character visible again');
  await frames[1].evaluate(()=>{window.splatsReceived=0;const net=__inkwave.lobby.session;const orig=net._onSplats.bind(net);net._onSplats=d=>{splatsReceived+=d.s.length;return orig(d);};});
  await frames[0].evaluate(()=>{const a=__G.local;__G.paint.splat(a.pos.clone(),0.5,a.team,{seed:0.125});__inkwave.lobby.session._flushSplats();});
  await frames[1].waitForFunction(()=>splatsReceived>0);assert.equal(await frames[1].evaluate(()=>splatsReceived),1);
  report.checks.push('actual scene paint reaches guest exactly once');
  await frames[1].evaluate(()=>__inkwave.lobby.leave());
  await frames[0].waitForFunction(()=>__inkwave.lobby.client.members.length===1);
  await frames[0].evaluate(()=>__inkwave.lobby.leave());
  for(const p of pages)await p.waitForFunction(()=>!new URL(location.href).searchParams.has('room')&&new URL(location.href).searchParams.get('mode')==='public');
  report.checks.push('leave clears room/key in outer URL and retains mode');
  assert.deepEqual(errors,[]);report.success=true;console.log(JSON.stringify(report,null,2));
 }finally{require('node:fs').writeFileSync('/tmp/inkwave-public-scene-result.json',JSON.stringify({...report,errors},null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
