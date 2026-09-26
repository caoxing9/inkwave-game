const {chromium}=require('/usr/local/lib/node_modules/playwright');
const assert=require('node:assert/strict');
const base=process.env.GAME_BASE_URL||'http://127.0.0.1:3000';
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/local/bin/chromium',args:['--no-sandbox','--enable-unsafe-swiftshader']});
 const report={origin:base,checks:[],transport:'real PeerJS Cloud / WebRTC',input:'trusted Playwright mouse events; no injected fire intent',scene:'original scene, software GPU, simulation stepped'};
 try {
  const pages=[],frames=[];
  for(let i=0;i<2;i++){
   const context=await browser.newContext({viewport:{width:960,height:640}});
   await context.addInitScript(()=>localStorage.setItem('inkwave.settings',JSON.stringify({quality:'low',shadows:false,bloom:false})));
   const p=await context.newPage();pages.push(p);
   await p.goto(`${base}/?mode=public&lobby=1`);
   await p.waitForSelector('iframe');let f;while(!(f=p.frames().find(f=>f.url().includes('/game/index.html'))))await p.waitForTimeout(50);
   frames.push(f);await f.waitForFunction(()=>window.__inkwave?.debug,null,{timeout:240000});await f.evaluate(()=>__inkwave.debug.freeze());
   await f.locator('#iwl-create').waitFor();await f.locator('#iwl-name').fill(i?'射击客人':'射击房主');
   if(!i){await f.locator('#iwl-create').click();await f.locator('#iwl-start').waitFor({timeout:45000});report.room=await f.evaluate(()=>__inkwave.lobby.client.code);console.log('HOST',report.room);}
   else{await f.locator('#iwl-code').fill(report.room);await f.locator('#iwl-join').click();await f.waitForFunction(()=>__inkwave.lobby.inRoom);}
  }
  await frames[0].waitForFunction(()=>__inkwave.lobby.client.members.length===2&&__inkwave.lobby.client.allConnected());
  // A remote start must work after the guest's join click activation has expired.
  await pages[1].waitForTimeout(6100);await pages[0].bringToFront();await frames[0].locator('#iwl-start').click();
  for(const f of frames)await f.waitForFunction(()=>__G.mode==='match'&&__G.actors.length===10,null,{timeout:60000});
  await frames[0].waitForFunction(()=>__inkwave.lobby.session.everyoneLoaded());
  for(const f of frames)await f.evaluate(()=>{
   __inkwave.debug.freezeBots();const net=__inkwave.lobby.session;
   window.shotsSent=0;window.shotsReceived=0;
   const send=net.onShots.bind(net);net.onShots=(a,s)=>{if(a.isLocal)shotsSent+=s.length;return send(a,s);};
   const recv=net._onFire.bind(net);net._onFire=d=>{shotsReceived+=d.p.length;return recv(d);};
  });
  await frames[0].evaluate(()=>{__inkwave.match.stateT=4.3;__inkwave.match.update(1/60);});
  await frames[1].waitForFunction(()=>__inkwave.match.state==='playing');
  report.checks.push('two real peers in 10-role playing match after expired guest user activation');
  async function shoot(index){
   const p=pages[index],f=frames[index],other=frames[1-index];await p.bringToFront();
   // Step the game's UI normally; the software GPU test keeps the render loop frozen.
   await f.evaluate(()=>{__inkwave.controlGate?.update();});
   if(await f.locator('#iw-control-enter').isVisible())await f.locator('#iw-control-enter').click();
   else if(await f.evaluate(()=>!!__inkwave.menus.current&&!!__inkwave.match.netMenu)){
    await f.getByText('继续',{exact:true}).first().click();
   }else await f.locator('#app canvas').click({position:{x:400,y:300}});
   await f.waitForFunction(()=>document.pointerLockElement===__inkwave.input.canvas,null,{timeout:5000});
   const before=await f.evaluate(()=>({sent:shotsSent,ink:__G.local.ink}));const receivedBefore=await other.evaluate(()=>shotsReceived);
   await p.mouse.down({button:'left'});
   await f.evaluate(()=>{
    for(let i=0;i<20;i++){__inkwave.match.updateController(1/60);__inkwave.match.update(1/60);__inkwave.input.endFrame();}
   });
   await p.mouse.up({button:'left'});
   const after=await f.evaluate(()=>({sent:shotsSent,ink:__G.local.ink,fire:__G.local.intent.fire,locked:__inkwave.input.locked}));
   assert(after.sent>before.sent,JSON.stringify({before,after}));assert(after.ink<before.ink);
   await other.waitForFunction(n=>shotsReceived>n,receivedBefore);
   await f.evaluate(()=>{__inkwave.match.updateController(1/60);});assert.equal(await f.evaluate(()=>__G.local.intent.fire),false);
   report.checks.push(`${index?'guest':'host'} real left click locks mouse, fires projectiles, consumes ink and reaches other peer; release stops firing`);
  }
  // The guest is the important asynchronous-start case.
  await shoot(1);
  // Return from Esc through the original pause-menu flow, and shoot again.
  await frames[1].evaluate(()=>document.exitPointerLock());
  await frames[1].waitForFunction(()=>__inkwave.match.netMenu===true);
  await frames[1].evaluate(()=>{__inkwave.controlGate?.update();});
  const pauseText=await frames[1].locator('body').innerText();console.log('PAUSE_MENU',pauseText.slice(-500));
  const resume=frames[1].locator('button').filter({hasText:/^(继续|继续游戏|RESUME)$/i}).first();
  await resume.click();await frames[1].waitForFunction(()=>!__inkwave.match.netMenu);
  await shoot(1);
  // Avoid losing the host's input on background focus for this side's firing assertion.
  await pages[0].bringToFront();
  if(await frames[0].evaluate(()=>!!__inkwave.match.netMenu)){
   const resumeHost=frames[0].locator('button').filter({hasText:/^(继续|继续游戏|RESUME)$/i}).first();await resumeHost.click();
  }
  await shoot(0);
  for(const f of frames)await f.evaluate(()=>__inkwave.lobby.leave());report.success=true;console.log(JSON.stringify(report,null,2));
 }finally{require('node:fs').writeFileSync('/tmp/inkwave-shooting-result.json',JSON.stringify(report,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
