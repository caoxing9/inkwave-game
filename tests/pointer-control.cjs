const {chromium}=require('/usr/local/lib/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const b=await chromium.launch({executablePath:'/usr/local/bin/chromium',args:['--no-sandbox']});
 try {
  const p=await b.newPage({viewport:{width:900,height:600}});await p.goto('http://127.0.0.1:3000/api/rooms');
  await p.setContent('<html><head><link rel="stylesheet" href="/game/styles/lobby.css"></head><body><canvas width="900" height="600"></canvas></body></html>');
  await p.evaluate(async()=>{
   const {Input}=await import('/game/src/core/input.js');const {ControlGate}=await import('/game/src/core/control-gate.js');const {G}=await import('/game/src/core/ctx.js');
   G.mode='match';window.game={input:new Input(document.querySelector('canvas')),match:{state:'playing',local:{alive:true}},menus:{current:null}};
   window.gate=new ControlGate(game);game.input.onLockChange=()=>gate.update();window.unlocks=0;game.input.onUnlock=()=>unlocks++;
   window.originalLock=game.input.canvas.requestPointerLock.bind(game.input.canvas);
   game.input.canvas.requestPointerLock=()=>Promise.reject(new DOMException('Test browser denial','NotAllowedError'));gate.update();
  });
  await p.locator('#iw-control-enter').click();
  await p.getByText(/browser has not allowed mouse control/).waitFor();assert.equal(await p.locator('#iw-control-enter').isEnabled(),true);
  assert.equal(await p.evaluate(()=>game.input.mouse.left),false);assert.equal(await p.evaluate(()=>unlocks),0);
  await p.evaluate(()=>{game.input.canvas.requestPointerLock=originalLock;});await p.locator('#iw-control-enter').click();
  await p.waitForFunction(()=>document.pointerLockElement===game.input.canvas&&game.input.locked);assert.equal(await p.locator('#iw-control-enter').isVisible(),false);
  await p.mouse.down();assert.equal(await p.evaluate(()=>game.input.mouse.left),true);await p.mouse.up();assert.equal(await p.evaluate(()=>game.input.mouse.left),false);
  await p.mouse.down();await p.evaluate(()=>document.exitPointerLock());await p.waitForFunction(()=>!game.input.locked);assert.equal(await p.evaluate(()=>game.input.mouse.left),false);assert.equal(await p.evaluate(()=>unlocks),1);await p.mouse.up();
  await p.evaluate(()=>{game.menus.current='pause';gate.update();});assert.equal(await p.locator('#iw-control-enter').isVisible(),false);
  await p.evaluate(()=>{game.menus.current=null;game.input.pad={};game.input.lastDevice='pad';gate.update();});assert.equal(await p.locator('#iw-control-enter').isVisible(),false);
  await p.evaluate(()=>{game.input.pad=null;game.input.lastDevice='kbm';gate.update();});assert.equal(await p.locator('#iw-control-enter').isVisible(),true);
  console.log('PASS pointer-lock denial/retry, trusted click capture, real mouse press/release, unlock clears shots, pause and gamepad compatibility');
 }finally{await b.close();}
})().catch(e=>{console.error(e);process.exit(1)});
