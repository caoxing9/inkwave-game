// Adapted from the transport-ship application's local connection diagnostics.
// No SDP, ICE addresses, credentials or game payloads are recorded.
const KEY = 'inkwave-peer-diagnostics-v1';
export const randomClientId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(v=>v.toString(16).padStart(2,'0')).join('');
export class PeerDiagnostics {
  constructor(){this.report={version:1,session:randomClientId(),startedAt:new Date().toISOString(),events:[]};}
  log(phase,event,detail={}){
    this.report.events.push({at:new Date().toISOString(),phase,event,detail});
    if(this.report.events.length>400)this.report.events.shift();
    if(!this.timer)this.timer=setTimeout(()=>this.flush(),1000);
  }
  flush(){
    clearTimeout(this.timer);this.timer=null;
    try{const history=PeerDiagnostics.history().filter(r=>r.session!==this.report.session&&Date.now()-Date.parse(r.startedAt)<7*86400000);localStorage.setItem(KEY,JSON.stringify([...history,this.report].slice(-5)));}catch{}
  }
  static history(){try{const r=JSON.parse(localStorage.getItem(KEY)||'[]');return Array.isArray(r)?r:[];}catch{return [];}}
  static download(){const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),sessions:this.history()},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='inkwave-peer-diagnostics.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
export function traceConnection(pc,log,label){
  if(!pc)return;
  pc.addEventListener('icegatheringstatechange',()=>log.log('ice','Gathering connection paths',{channel:label,state:pc.iceGatheringState}));
  pc.addEventListener('iceconnectionstatechange',()=>log.log('ice','Checking direct path',{channel:label,state:pc.iceConnectionState}));
  pc.addEventListener('connectionstatechange',()=>log.log('webrtc','Data connection state',{channel:label,state:pc.connectionState}));
  pc.addEventListener('icecandidateerror',e=>log.log('ice','STUN request failed',{channel:label,code:e.errorCode}));
  pc.addEventListener('icecandidate',e=>{if(e.candidate)log.log('ice','Found path',{channel:label,type:e.candidate.type,protocol:e.candidate.protocol});});
}
