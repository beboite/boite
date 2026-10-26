import {createHash} from 'node:crypto';
import type {RootRequest} from './fault-root-reference.ts';
export const stdioLabels=['ASSIGNED-STDIO-HELD','ASSIGNED-STDIO-CLOSED'] as const;
export const isStdioLabel=(s:string)=>stdioLabels.some(v=>v===s);
export interface StdioStream {original:string;crt:string;fd:number;type:number;flushAttempted:number;flushResult:number;closeAttempted:number;closeResult:number;invalid:number;invalidError:number;closeAt:number}
export interface StdoutZeroWrite {attempted:number;result:number;transferred:number;error:number;at:number}
export interface StdioReceipt {zero?:StdoutZeroWrite;version:number;phase:number;role:number;result:number;helper:number;root:number;helperCreated:string;rootCreated:string;ready:number;deadline:number;rootDeadline:number;at:number;nonce:string;compilerNonce:string;acquired:number;closed:number;error:number;session:number;cleanup:number;streams:StdioStream[]}
function check(v:unknown,s:string):asserts v {if(!v)throw Error('stdio root fence: '+s);}
export type StreamExperiment='stdio'|'stdout-write'|'stdout-zero'|'stdout-byte'|'stdout-close';
export function encodeStdioReceipt(f:StdioReceipt):Buffer {return encodeStreamReceipt(f,'stdio');}
export function encodeStreamReceipt(f:StdioReceipt,experiment:StreamExperiment):Buffer {
 check(experiment==='stdio'||experiment==='stdout-write'||experiment==='stdout-zero'||experiment==='stdout-byte'||experiment==='stdout-close','explicit stream experiment');
 if(experiment==='stdout-close')check(!f.zero,'no write payload');
 const size=(experiment==='stdout-zero'||experiment==='stdout-byte')?424:400,magic=experiment==='stdout-close'?0x53434631:experiment==='stdio'?0x53524631:experiment==='stdout-write'?0x53574631:experiment==='stdout-zero'?0x5a574631:0x42574631;
 const b=Buffer.alloc(size);[magic,f.version,size,f.phase,f.role,f.result,f.helper,f.root].forEach((v,i)=>b.writeUInt32LE(v,4*i));
 [f.helperCreated,f.rootCreated,f.ready,f.deadline,f.rootDeadline,f.at].forEach((v,i)=>b.writeBigUInt64LE(BigInt(v),32+i*8));
 b.write(f.nonce,80,64,'utf16le');b.write(f.compilerNonce,146,64,'utf16le');
 [f.acquired,f.closed,f.error,f.session,f.cleanup].forEach((v,i)=>b.writeUInt32LE(v,212+4*i));
 f.streams.forEach((s,i)=>{const o=232+i*56;b.writeBigUInt64LE(BigInt(s.original),o);b.writeBigUInt64LE(BigInt(s.crt),o+8);
 [s.fd,s.type,s.flushAttempted,s.flushResult,s.closeAttempted,s.closeResult,s.invalid,s.invalidError].forEach((v,j)=>b.writeInt32LE(v,o+16+j*4));b.writeBigUInt64LE(BigInt(s.closeAt),o+48);});
 if(experiment==='stdout-zero'||experiment==='stdout-byte'){check(f.zero,experiment==='stdout-zero'?'zero-write evidence present':'byte-write evidence present');[f.zero.attempted,f.zero.result,f.zero.transferred,f.zero.error].forEach((v,i)=>b.writeUInt32LE(v,400+4*i));b.writeBigUInt64LE(BigInt(f.zero.at),416);}return b;
}
export function parseStdioReceipt(b:Buffer):StdioReceipt {return parseStreamReceipt(b,'stdio');}
export function parseStreamReceipt(b:Buffer,experiment:StreamExperiment):StdioReceipt {
 check(experiment==='stdio'||experiment==='stdout-write'||experiment==='stdout-zero'||experiment==='stdout-byte'||experiment==='stdout-close','explicit stream experiment');
 const size=(experiment==='stdout-zero'||experiment==='stdout-byte')?424:400,magic=experiment==='stdout-close'?0x53434631:experiment==='stdio'?0x53524631:experiment==='stdout-write'?0x53574631:experiment==='stdout-zero'?0x5a574631:0x42574631;
 check(b.length===size&&b.readUInt32LE(0)===magic&&b.readUInt32LE(8)===size,'distinct fixed receipt');
 const num=(o:number)=>{const n=Number(b.readBigUInt64LE(o));check(Number.isSafeInteger(n),'safe native integer');return n;};
 const f:StdioReceipt={version:b.readUInt32LE(4),phase:b.readUInt32LE(12),role:b.readUInt32LE(16),result:b.readUInt32LE(20),helper:b.readUInt32LE(24),root:b.readUInt32LE(28),helperCreated:String(b.readBigUInt64LE(32)),rootCreated:String(b.readBigUInt64LE(40)),ready:num(48),deadline:num(56),rootDeadline:num(64),at:num(72),nonce:b.toString('utf16le',80,144),compilerNonce:b.toString('utf16le',146,210),acquired:b.readUInt32LE(212),closed:b.readUInt32LE(216),error:b.readUInt32LE(220),session:b.readUInt32LE(224),cleanup:b.readUInt32LE(228),streams:[]};
 for(let i=0;i<3;i++){const o=232+i*56;f.streams.push({original:String(b.readBigUInt64LE(o)),crt:String(b.readBigUInt64LE(o+8)),fd:b.readInt32LE(o+16),type:b.readInt32LE(o+20),flushAttempted:b.readInt32LE(o+24),flushResult:b.readInt32LE(o+28),closeAttempted:b.readInt32LE(o+32),closeResult:b.readInt32LE(o+36),invalid:b.readInt32LE(o+40),invalidError:b.readInt32LE(o+44),closeAt:num(o+48)});}
 check(f.version===1&&[1,2,3].includes(f.phase)&&[1,2].includes(f.role)&&f.result===125&&f.helper>0&&f.root>0&&f.helper!==f.root&&BigInt(f.helperCreated)>0n&&BigInt(f.rootCreated)>0n,'receipt context');
 check(b.readUInt16LE(144)===0&&b.readUInt16LE(210)===0&&f.cleanup===511&&/^[a-f0-9]{32}$/.test(f.nonce)&&/^[a-f0-9]{32}$/.test(f.compilerNonce),'nonces/cleanup');
 check(f.ready>0&&f.ready<=f.at&&f.at<f.deadline&&f.deadline<=f.ready+3000&&f.deadline<=f.rootDeadline&&f.error===0&&f.acquired===f.closed&&f.acquired===(f.phase===3?3:1),'bounded balanced file publication');
 check(new Set(f.streams.map(s=>s.original)).size===3,'distinct original streams');
 f.streams.forEach((s,i)=>{
  check(BigInt(s.original)>0n&&BigInt(s.original)<0xffffffffffffffffn&&s.crt===s.original&&s.fd===i&&s.type===3,'exact original CRT pipe mapping');
  check(s.flushAttempted===(i?1:0)&&s.flushResult===0,'successful output-only flush');
  const closes=f.role===2&&(experiment==='stdio'||(experiment==='stdout-close'&&i===1));
  check(s.closeResult===0&&s.closeAttempted===(closes?1:0)&&s.invalid===(closes?1:0)&&s.invalidError===(closes?6:0)&&
   (closes?s.closeAt>=f.ready&&s.closeAt<=f.at:s.closeAt===0),'actual CRT owner closure and immediate invalidity');
 });
 if(experiment==='stdio'&&f.role===2)check(f.streams[0]!.closeAt<=f.streams[1]!.closeAt&&f.streams[1]!.closeAt<=f.streams[2]!.closeAt,'stderr closes last');
 if(experiment==='stdout-zero'||experiment==='stdout-byte'){
  const z=f.zero={attempted:b.readUInt32LE(400),result:b.readUInt32LE(404),transferred:b.readUInt32LE(408),error:b.readUInt32LE(412),at:num(416)};
  check(f.role===1?Object.values(z).every(v=>v===0):z.attempted===1&&z.result===1&&z.transferred===(experiment==='stdout-byte'?1:0)&&z.error===0&&z.at>=f.ready&&z.at<=f.at,experiment==='stdout-zero'?'actual bounded zero-byte write':'actual bounded one-byte write');
 }
 return f;
}
export function boundStdioReceipt(r:RootRequest,b:Buffer,now:number):StdioReceipt {
 const f=parseStdioReceipt(b);check(isStdioLabel(r.label)&&f.phase===1&&f.role===(r.label.endsWith('-HELD')?1:2)&&f.helper===r.helper.pid&&f.helperCreated===r.helper.created&&f.root===r.root.pid&&f.rootCreated===r.root.created&&f.nonce===r.nonce&&f.compilerNonce===r.compilerNonce,'bound ready');
 const map=(f.session?`\\Sessions\\${f.session}`:'')+`\\BaseNamedObjects\\boite.route.${f.helper}`;check(r.names.map===map,'session name');
 check(f.at<=now&&now<r.deadline&&r.deadline<=f.deadline&&r.deadline<=now+3000,'bound deadline');return f;
}
export function stdioArtifact(bytes:Buffer){return {bytes:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),receipt:parseStdioReceipt(bytes)};}
