import {createHash} from 'node:crypto';
import {encodeStreamReceipt,parseStreamReceipt,type StdioReceipt} from './stdio-root-fence.ts';
import type {RootRequest} from './fault-root-reference.ts';
export const stdoutLabels=['ASSIGNED-STDOUT-SILENT','ASSIGNED-STDOUT-WRITE'] as const;
export const isStdoutLabel=(s:string)=>stdoutLabels.some(v=>v===s);
export function encodeStdoutReceipt(f:StdioReceipt):Buffer {return encodeStreamReceipt(f,'stdout-write');}
export function parseStdoutReceipt(b:Buffer):StdioReceipt {return parseStreamReceipt(b,'stdout-write');}
export function boundStdoutReceipt(r:RootRequest,b:Buffer,now:number):StdioReceipt {
 const f=parseStdoutReceipt(b),map=(f.session?`\\Sessions\\${f.session}`:'')+`\\BaseNamedObjects\\boite.route.${f.helper}`;
 if(!isStdoutLabel(r.label)||f.phase!==1||f.role!==(r.label===stdoutLabels[0]?1:2)||f.helper!==r.helper.pid||f.helperCreated!==r.helper.created||f.root!==r.root.pid||f.rootCreated!==r.root.created||f.nonce!==r.nonce||f.compilerNonce!==r.compilerNonce||r.names.map!==map||f.at>now||now>=r.deadline||r.deadline>f.deadline||r.deadline>now+3000)throw Error('stdout root fence: bound READY identity/role/deadline');
 return f;
}
export function stdoutArtifact(bytes:Buffer){return {bytes:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),receipt:parseStdoutReceipt(bytes)};}
