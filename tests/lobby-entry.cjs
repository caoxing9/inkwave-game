const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium}=require('/usr/local/lib/node_modules/playwright');
(async()=>{
 const {readInvite,inviteUrl}=await import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync('public/game/src/net/invite.js')).toString('base64'));
 const url=q=>new URL('https://game.test/'+q);
 assert.equal(readInvite(url('?mode=public&room=ABCDEF&lobby=1')).mode,'public');
 assert.equal(readInvite(url('?server=example.com&room=ABCDEF&key=1234')).mode,'wss');
 assert.equal(readInvite(url('?mode=wss&room=ABCDEF')).mode,'wss');
 assert.equal(readInvite(url('#room=ABCDEF')).mode,'public');
 const fresh=inviteUrl(url('?mode=wss&room=OLD&server=old.test&key=1111#room=OLDER'),'public','NEW123');
 assert.equal(fresh.searchParams.get('room'),'NEW123');assert.equal(fresh.hash,'');assert(!fresh.searchParams.has('server'));assert(!fresh.searchParams.has('key'));
 const leave=inviteUrl(fresh,'public');assert(!leave.searchParams.has('room'));assert.equal(leave.searchParams.get('mode'),'public');
 const browser=await chromium.launch({executablePath:'/usr/local/bin/chromium',args:['--no-sandbox']});
 try{
  for(const [query,state,mode] of [['?mode=public&room=ABCDEF&lobby=1','pending','public'],['?server=example.com&room=ABCDEF&key=1234','pending','wss'],['?mode=wss','unknown','wss'],['','ready','wss'],['','pending','public'],['','unknown','public']]){
   const p=await browser.newPage();await p.route('**/api/multiplayer-status',r=>r.fulfill({json:{state}}));
   await p.goto('http://127.0.0.1:3000/api/rooms'+query);await p.setContent('<html><body></body></html>');
   await p.addScriptTag({type:'importmap',content:JSON.stringify({imports:{three:'/game/vendor/three/engine/three.module.js'}})});
   await p.evaluate(async()=>{const {Lobby}=await import('/game/src/net/lobby.js');window.lobby=new Lobby({api:{getProfile:()=>({name:'玩家'}),getLoadout:()=>({weapon:'shooter'}),setProfileName:()=>{},setLoadout:()=>{}},menus:{show:()=>{}}});await lobby.open();});
   assert.equal(await p.locator('#iwl-mode').inputValue(),mode);assert.equal(await p.locator('#iwl-server').isVisible(),mode==='wss');
   if(state==='unknown')assert((await p.locator('.iwl').innerText()).includes('无法确认'));
   if(query.includes('server=')){
    assert.equal(await p.locator('#iwl-code').inputValue(),'ABCDEF');
    await p.locator('#iwl-mode').selectOption('public');
    assert.equal(await p.locator('#iwl-server').isVisible(),false);assert.equal(await p.locator('#iwl-code').inputValue(),'');
    assert(!new URL(p.url()).searchParams.has('key'));assert(!new URL(p.url()).searchParams.has('room'));
   }
   await p.close();
  }
  // Actual NetSession: guest readiness arrives before host attach; a new paint system must be wrapped.
  const p=await browser.newPage();await p.goto('http://127.0.0.1:3000/api/rooms');await p.setContent('<html><body></body></html>');
  await p.addScriptTag({type:'importmap',content:JSON.stringify({imports:{three:'/game/vendor/three/engine/three.module.js'}})});
  const result=await p.evaluate(async()=>{
   const {G}=await import('/game/src/core/ctx.js'),{NetSession}=await import('/game/src/net/session.js');
   G.paint={splat:()=>1};const client={id:'h',isHost:true,members:[{id:'h'},{id:'g'}],send:()=>{}};
   const n=new NetSession(client);n.prepare();n._recv({t:'ld'},'g');G.paint={splat:()=>2};n.attach({actors:[]});n.markLoaded();
   G.paint.splat({x:1,y:0,z:2},1,0,{seed:1});return {ready:n.everyoneLoaded(),wrapped:G.paint._netSession===n,splats:n.splatBuf.length};
  });assert.deepEqual(result,{ready:true,wrapped:true,splats:1});
  console.log('PASS invite modes, capability states, hidden WSS fields, switching/clearing URLs, early loaded readiness and paint rebind');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
