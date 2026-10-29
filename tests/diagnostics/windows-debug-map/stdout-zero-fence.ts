import {createHash} from 'node:crypto';
import {encodeStreamReceipt,parseStreamReceipt,type StdioReceipt,type StdoutZeroWrite} from './stdio-root-fence.ts';
import type {RootRequest} from './fault-root-reference.ts';
export const zeroLabels=['ASSIGNED-ZERO-SILENT','ASSIGNED-ZERO-WRITE'] as const;
export const isZeroLabel=(s:string)=>zeroLabels.some(v=>v===s);
export interface ZeroReceipt extends StdioReceipt {zero:StdoutZeroWrite}
export function encodeZeroReceipt(f:StdioReceipt):Buffer {return encodeStreamReceipt(f,'stdout-zero');}
export function parseZeroReceipt(b:Buffer):ZeroReceipt {return parseStreamReceipt(b,'stdout-zero') as ZeroReceipt;}
export function boundZeroReceipt(r:RootRequest,b:Buffer,now:number):ZeroReceipt {
 const f=parseZeroReceipt(b),map=(f.session?`\\Sessions\\${f.session}`:'')+`\\BaseNamedObjects\\boite.route.${f.helper}`;
 if(!isZeroLabel(r.label)||f.phase!==1||f.role!==(r.label===zeroLabels[0]?1:2)||f.helper!==r.helper.pid||f.helperCreated!==r.helper.created||f.root!==r.root.pid||f.rootCreated!==r.root.created||f.nonce!==r.nonce||f.compilerNonce!==r.compilerNonce||r.names.map!==map||f.at>now||now>=r.deadline||r.deadline>f.deadline||r.deadline>now+3000)throw Error('stdout zero fence: bound READY identity/role/deadline');
 return f;
}
export function zeroArtifact(bytes:Buffer){return {bytes:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),receipt:parseZeroReceipt(bytes)};}
