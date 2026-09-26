const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/local/bin/chromium',args:['--no-sandbox']});
 try {
  const p=await browser.newPage();await p.goto('http://127.0.0.1:3000/api/rooms');await p.setContent('<html><body></body></html>');
  await p.addScriptTag({type:'importmap',content:JSON.stringify({imports:{three:'/game/vendor/three/engine/three.module.js'}})});
  const result=await p.evaluate(async()=>{
   const THREE=await import('three');const {NetSession}=await import('/game/src/net/session.js');const {G}=await import('/game/src/core/ctx.js');
   G.paint={splat:()=>0};
   const client={id:'guest',isHost:false,room:{host:'host'},members:[],send:()=>{}};const session=new NetSession(client);
   const a={netId:'a00',netAuth:false,alive:true,remote:{buf:[]},character:{visible:true,setVisible(v){this.visible=v;}},pos:new THREE.Vector3(),vel:new THREE.Vector3(),aimDir:new THREE.Vector3(),weapon:{},stats:{},_finishFrame(){},splat(){this.alive=false;this.character.setVisible(false);},respawn(){this.alive=true;this.character.setVisible(true);}};
   session.byId.set(a.netId,a);session.remoteUpdate(a,1/60);const initiallyHidden=!a.character.visible;
   const state=['a00',1,2,3,0,0,0,0,0,1,0,0,100,100,0,0];session._onState({a:[state]});session.remoteUpdate(a,1/60);const visibleAfterFirstPacket=a.character.visible;
   session._onState({a:[[...state.slice(0,9),0,...state.slice(10)]]});session.remoteUpdate(a,1/60);const hiddenWhenDead=!a.character.visible;
   session._onState({a:[state]});session.remoteUpdate(a,1/60);return {initiallyHidden,visibleAfterFirstPacket,hiddenWhenDead,visibleAfterRespawn:a.character.visible};
  });
  assert.deepEqual(result,{initiallyHidden:true,visibleAfterFirstPacket:true,hiddenWhenDead:true,visibleAfterRespawn:true});
  console.log('PASS initial remote visibility, death and respawn');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
