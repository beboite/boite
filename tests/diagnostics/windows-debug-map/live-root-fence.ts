import {createHash} from 'node:crypto';
import type {RootRequest,RootOwned,RootCustody} from './fault-root-reference.ts';
import type {LedgerRow,Membership} from './target-topology.ts';
export interface LiveReceipt {version:number;phase:number;role:number;session:number;cleanup:number;result:number;helper:number;root:number;helperCreated:string;rootCreated:string;ready:number;deadline:number;rootDeadline:number;at:number;nonce:string;compilerNonce:string;acquired:number;closed:number;error:number}
export interface LiveProof {helper:RootCustody&{pid:number;created:string;exitCode:259};at:number;ready:string}
export const liveLabels=['ASSIGNED-LIVE-HELD','ASSIGNED-LIVE-RELEASED'] as const;
export const isLiveLabel=(label:string)=>liveLabels.some(x=>x===label);
function check(v:unknown,message:string):asserts v {if(!v)throw Error('live root fence: '+message);}
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
export function encodeLiveReceipt(f:LiveReceipt):Buffer {
 const b=Buffer.alloc(232);[0x4c524631,f.version,232,f.phase,f.role,f.result,f.helper,f.root].forEach((v,i)=>b.writeUInt32LE(v,i*4));
 [f.helperCreated,f.rootCreated,f.ready,f.deadline,f.rootDeadline,f.at].forEach((v,i)=>b.writeBigUInt64LE(BigInt(v),32+i*8));
 b.write(f.nonce,80,64,'utf16le');b.write(f.compilerNonce,146,64,'utf16le');
 [f.acquired,f.closed,f.error,f.session,f.cleanup].forEach((v,i)=>b.writeUInt32LE(v,212+i*4));return b;
}
export function parseLiveReceipt(b:Buffer):LiveReceipt {
 check(b.length===232&&b.readUInt32LE(0)===0x4c524631&&b.readUInt32LE(8)===232,'fixed receipt');
 check(b.readUInt16LE(144)===0&&b.readUInt16LE(210)===0&&b.readUInt32LE(228)===511,'reserved bytes');
 const time=(off:number)=>{const n=Number(b.readBigUInt64LE(off));check(Number.isSafeInteger(n)&&n>0,'time');return n;};
 const f:LiveReceipt={version:b.readUInt32LE(4),phase:b.readUInt32LE(12),role:b.readUInt32LE(16),session:b.readUInt32LE(224),cleanup:b.readUInt32LE(228),result:b.readUInt32LE(20),helper:b.readUInt32LE(24),root:b.readUInt32LE(28),helperCreated:String(b.readBigUInt64LE(32)),rootCreated:String(b.readBigUInt64LE(40)),ready:time(48),deadline:time(56),rootDeadline:time(64),at:time(72),nonce:b.toString('utf16le',80,144),compilerNonce:b.toString('utf16le',146,210),acquired:b.readUInt32LE(212),closed:b.readUInt32LE(216),error:b.readUInt32LE(220)};
 check(f.version===1&&[1,2,3].includes(f.phase)&&[1,2].includes(f.role)&&f.result===125&&f.helper>0&&f.root>0&&f.helper!==f.root&&BigInt(f.helperCreated)>0n&&BigInt(f.rootCreated)>0n,'receipt context');
 check(/^[a-f0-9]{32}$/.test(f.nonce)&&/^[a-f0-9]{32}$/.test(f.compilerNonce),'receipt nonces');
 check(f.ready<=f.at&&f.at<f.deadline&&f.deadline<=f.ready+3000&&f.deadline<=f.rootDeadline&&f.acquired===f.closed&&f.error===0,'receipt deadline/cleanup');
 check(f.phase!==1||(f.at===f.ready&&f.acquired===0),'ready receipt');
 check(f.phase!==3||f.acquired===2,'return receipt');return f;
}
export function boundLiveReceipt(r:RootRequest,b:Buffer,now:number):LiveReceipt {
 const f=parseLiveReceipt(b);
 check(isLiveLabel(r.label)&&f.phase===1&&f.role===(r.label.endsWith('-HELD')?1:2)&&f.helper===r.helper.pid&&f.helperCreated===r.helper.created&&f.root===r.root.pid&&f.rootCreated===r.root.created&&f.nonce===r.nonce&&f.compilerNonce===r.compilerNonce,'bound ready');
 const map=(f.session?`\\Sessions\\${f.session}`:'')+`\\BaseNamedObjects\\boite.route.${f.helper}`;check(r.names.map===map,'exact native session name');
 check(f.ready<=now&&now<r.deadline&&r.deadline<=f.deadline&&r.deadline<=now+3000,'bound deadline');return f;
}
export function authorizeLiveFence(r:RootRequest,root:RootOwned,helper:RootOwned|undefined,b:Buffer,rows:(LedgerRow&Partial<Membership>)[],now:number):LiveProof {
 boundLiveReceipt(r,b,now);return authorizeLiveContext(r,root,helper,b,rows,now);
}
export function authorizeLiveContext(r:RootRequest,root:RootOwned,helper:RootOwned|undefined,b:Buffer,rows:(LedgerRow&Partial<Membership>)[],now:number):LiveProof {
 check(helper&&helper.role==='launcher-main'&&helper.pid===r.helper.pid&&helper.created===r.helper.created&&helper.exitCode===259&&helper.complete&&!helper.closeFailed&&helper.stage==='tracked'&&Number.isSafeInteger(helper.handle)&&helper.handle>0&&helper.id!==root.id,'exact live captured helper');
 check(root.pid===r.root.pid&&root.created===r.root.created&&root.exitCode===125&&root.complete&&!root.closeFailed&&root.stage==='tracked','terminal root');
 for(const k of ['owner','threadId','threadJob','jobKey','globalJob','nestingRefused'] as const)check(helper[k]===root[k],'same helper ancestor job');
 check(!rows.some(v=>v.event==='incomplete'),'complete trace');
 for(const p of [r.helper,r.root])check(rows.some(v=>v.event==='owned-membership'&&v.role==='launcher-main'&&v.pid===p.pid&&v.created===p.created&&v.threadMember===1&&(['owner','threadId','threadJob','jobKey','globalJob','nestingRefused'] as const).every(k=>v[k]===root[k])),'owned memberships');
 return {helper:{owner:helper.owner,id:helper.id,threadId:helper.threadId,threadJob:helper.threadJob,jobKey:helper.jobKey,globalJob:helper.globalJob,nestingRefused:helper.nestingRefused,pid:helper.pid,created:helper.created,exitCode:259},at:now,ready:b.toString('base64')};
}
export function validateLiveProof(r:RootRequest,value:unknown,now:number):asserts value is LiveProof {
 validateLiveProofContext(r,value,now);boundLiveReceipt(r,Buffer.from(value.ready,'base64'),value.at);
}
export function validateLiveProofContext(r:RootRequest,value:unknown,now:number):asserts value is LiveProof {
 const v=value as LiveProof;check(v&&Object.keys(v).sort().join()===['helper','at','ready'].sort().join()&&typeof v.ready==='string'&&Number.isSafeInteger(v.at)&&v.at<=now,'live proof fields');
 const bytes=Buffer.from(v.ready,'base64');check(bytes.toString('base64')===v.ready,'canonical receipt');
 const h=v.helper;check(h&&Object.keys(h).sort().join()===['owner','id','threadId','threadJob','jobKey','globalJob','nestingRefused','pid','created','exitCode'].sort().join()&&h.pid===r.helper.pid&&h.created===r.helper.created&&h.exitCode===259&&h.threadId==='native-'+r.compiler&&[h.owner,h.id].every(s=>typeof s==='string'&&s.length>0&&s.length<200)&&/^[1-9]\d*$/.test(h.threadJob)&&/^(0|[1-9]\d*)$/.test(h.globalJob)&&Number.isSafeInteger(h.jobKey)&&h.jobKey>0&&typeof h.nestingRefused==='boolean','live proof identity');
}
export function receiptArtifact(bytes:Buffer){return {bytes:bytes.toString('base64'),sha256:hash(bytes),receipt:parseLiveReceipt(bytes)};}
