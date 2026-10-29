import {existsSync,readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {validateFaultNativeEvidence} from './fault-root-reference.ts';
import {validateAssignedFailure} from './matched-root-reference.ts';
import {measureFencedRootReferences,type LiveArmInput,type LiveArmRecord,type LiveDependencies} from './live-root-reference.ts';
import {runFencedRootHarness,type HarnessDependencies} from './live-root-harness.ts';
import {validateActiveProof} from './live-fence-dispatch.ts';
import {stdioLabels,parseStdioReceipt,encodeStdioReceipt,boundStdioReceipt,stdioArtifact,type StdioReceipt} from './stdio-root-fence.ts';
function check(v:unknown,s:string):asserts v {if(!v)throw Error('stdio root reference: '+s);}
export function validateStdioCapture(arm:LiveArmRecord,rows:ReturnType<LiveDependencies['rows']>):void {
 validateStreamCapture(arm,rows,{parse:parseStdioReceipt,prefix:'stdio',stdout:(arm,marker)=>{const text=arm.helper!.out;check(text.endsWith(marker+'\r\n')&&text.split(/\r?\n/).filter(l=>l===marker).length===1,'no output after original stream barrier');}});
}
export function validateStreamCapture(arm:LiveArmRecord,rows:ReturnType<LiveDependencies['rows']>,protocol:{parse(b:Buffer):StdioReceipt;prefix:string;stdout(arm:LiveArmRecord,marker:string):void}):void {
 const r=arm.request,h=arm.helper!,ready=protocol.parse(Buffer.from(arm.ready.bytes,'base64')),ret=protocol.parse(Buffer.from(arm.returned!.bytes,'base64'));
 check(Number.isSafeInteger(arm.captureFinishedAt)&&arm.captureFinishedAt!<r.deadline,'actual captured return before original deadline');
 const release=arm.helperRelease!,released=protocol.parse(Buffer.from(release.receipt.bytes,'base64'));
 validateAssignedFailure({request:r,helper:h,postHelper:arm.postHelper,priorCleanupPassed:arm.priorCleanupPassed!});
 validateFaultNativeEvidence(r,arm.held!.sample!,`pid=${h.pid} exit=${h.code} timedOut=${h.timedOut}\n${h.out}\n${h.err}`,rows);
 check(arm.priorCleanupPassed===false,'original fatal cleanup stays false');
 check(ret.phase===3&&JSON.stringify({...ret,phase:1,at:ready.at,acquired:1,closed:1})===JSON.stringify(ready),'exact native RETURN');
 check(released.phase===2&&JSON.stringify({...released,phase:1,at:ready.at})===JSON.stringify(ready)&&release.publishStartedAt===released.at&&release.publishFinishedAt>=released.at&&ret.at>=released.at&&ret.at<=arm.captureFinishedAt!,'ordered private release/RETURN');
 const marker=`${protocol.prefix}-fence barrier label=${r.label} nonce=${r.nonce} helper=${r.helper.pid} helper-created=${r.helper.created} root=${r.root.pid} created=${r.root.created} ready=${ready.ready} deadline=${ready.deadline}`;
 protocol.stdout(arm,marker);
 for(const text of [h.err])check(text.endsWith(marker+'\r\n')&&text.split(/\r?\n/).filter(l=>l===marker).length===1,'no output after original stream barrier');
 const lines=h.err.split(/\r?\n/),barrier=lines.indexOf(marker);
 for(const required of [...['root-thread','root-process','job','link','map','retire-named-map','twin-unused-map','twin-attached-open','twin-unused-open'].map(slot=>`cleanup close=${slot} closed=1 error=0`),...[0,1,2].map(i=>`stream-cleanup index=${i} success=1 error=0`),...['station-restore','desktop','station'].map(action=>`window-cleanup action=${action} success=1 error=0`)])
  check(lines.filter(l=>l===required).length===1&&lines.indexOf(required)<barrier,'successful cleanup before stdio barrier');
 for(const prefix of ['caller snapshot=after ',`cleanup retired-open phase=final status=0x00000000 absent=0 closed=1 error=0 path=${r.names.retired}`,'execution.windows.routing.cleanup.final-map: native call failed (13); no unprotected fallback'])
  check(lines.some((line,i)=>i<barrier&&line.startsWith(prefix)),'original final failure precedes stdio barrier');
 check(!h.err.includes('live-fence '),'separate native fence');
}
export function measureStdioRootReferences(inputs:Record<'held'|'released',LiveArmInput>,deps:LiveDependencies){
 return measureFencedRootReferences(inputs,deps,{label:k=>stdioLabels[k==='held'?0:1],bound:boundStdioReceipt,artifact:stdioArtifact,validateProof:validateActiveProof,returned:validateStdioCapture,strategy:'both-released'});
}
export function streamFailure(directory:string,label:string,frameSize=400):unknown {
 const file=join(directory,label+'.failed.bin');if(!existsSync(file))return undefined;
 const size=statSync(file).size;if(size>4096)return {label,file,size,error:'oversized native failure receipt'};
 const bytes=readFileSync(file);return {label,file,size,bytes:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),phase:bytes.length===frameSize?bytes.readUInt32LE(12):null,error:bytes.length===frameSize?bytes.readUInt32LE(220):null};
}
export function runStdioRootHarness<J extends {label:string;project:string}>(jobs:J[],deps:HarnessDependencies<J>){
 return runFencedRootHarness(jobs,deps,{labels:stdioLabels,parse:parseStdioReceipt,bound:boundStdioReceipt,encode:encodeStdioReceipt,environment:['BOITE_STDIO_ROOT_LABEL','BOITE_STDIO_ROOT_DIRECTORY','BOITE_STDIO_ROOT_NONCE'],measure:measureStdioRootReferences,failure:streamFailure});
}
