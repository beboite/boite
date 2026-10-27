import {createHash} from 'node:crypto';
import {encodeStreamReceipt,parseStreamReceipt,type StdioReceipt,type StdoutZeroWrite} from './stdio-root-fence.ts';
import type {RootRequest} from './fault-root-reference.ts';
export const byteLabels=['ASSIGNED-BYTE-SILENT','ASSIGNED-BYTE-WRITE'] as const;
export const isByteLabel=(s:string)=>byteLabels.some(v=>v===s);
export interface ByteReceipt extends StdioReceipt {zero:StdoutZeroWrite}
export function encodeByteReceipt(f:StdioReceipt):Buffer {return encodeStreamReceipt(f,'stdout-byte');}
export function parseByteReceipt(b:Buffer):ByteReceipt {return parseStreamReceipt(b,'stdout-byte') as ByteReceipt;}
export function boundByteReceipt(r:RootRequest,b:Buffer,now:number):ByteReceipt {
 const f=parseByteReceipt(b),map=(f.session?`\\Sessions\\${f.session}`:'')+`\\BaseNamedObjects\\boite.route.${f.helper}`;
 if(!isByteLabel(r.label)||f.phase!==1||f.role!==(r.label===byteLabels[0]?1:2)||f.helper!==r.helper.pid||f.helperCreated!==r.helper.created||f.root!==r.root.pid||f.rootCreated!==r.root.created||f.nonce!==r.nonce||f.compilerNonce!==r.compilerNonce||r.names.map!==map||f.at>now||now>=r.deadline||r.deadline>f.deadline||r.deadline>now+3000)throw Error('stdout byte fence: bound READY identity/role/deadline');
 return f;
}
export function byteArtifact(bytes:Buffer){return {bytes:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),receipt:parseByteReceipt(bytes)};}
