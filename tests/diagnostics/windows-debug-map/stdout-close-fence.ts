import {createHash} from 'node:crypto';
import {encodeStreamReceipt,parseStreamReceipt,type StdioReceipt} from './stdio-root-fence.ts';
import type {RootRequest} from './fault-root-reference.ts';
export const closeLabels=['ASSIGNED-PIPE-HELD','ASSIGNED-PIPE-CLOSED'] as const;
export const isCloseLabel=(s:string)=>closeLabels.some(v=>v===s);
export type CloseReceipt=StdioReceipt;
export function encodeCloseReceipt(f:StdioReceipt):Buffer {return encodeStreamReceipt(f,'stdout-close');}
export function parseCloseReceipt(b:Buffer):CloseReceipt {return parseStreamReceipt(b,'stdout-close') as CloseReceipt;}
export function boundCloseReceipt(r:RootRequest,b:Buffer,now:number):CloseReceipt {
 const f=parseCloseReceipt(b),map=(f.session?`\\Sessions\\${f.session}`:'')+`\\BaseNamedObjects\\boite.route.${f.helper}`;
 if(!isCloseLabel(r.label)||f.phase!==1||f.role!==(r.label===closeLabels[0]?1:2)||f.helper!==r.helper.pid||f.helperCreated!==r.helper.created||f.root!==r.root.pid||f.rootCreated!==r.root.created||f.nonce!==r.nonce||f.compilerNonce!==r.compilerNonce||r.names.map!==map||f.at>now||now>=r.deadline||r.deadline>f.deadline||r.deadline>now+3000)throw Error('stdout close fence: bound READY identity/role/deadline');
 return f;
}
export function closeArtifact(bytes:Buffer){return {bytes:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),receipt:parseCloseReceipt(bytes)};}
