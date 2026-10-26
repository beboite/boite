import {validateStreamCapture,streamFailure} from './stdio-root-reference.ts';
import {measureFencedRootReferences,type LiveArmInput,type LiveArmRecord,type LiveDependencies} from './live-root-reference.ts';
import {runFencedRootHarness,type HarnessDependencies} from './live-root-harness.ts';
import {validateActiveProof} from './live-fence-dispatch.ts';
import {stdoutLabels,parseStdoutReceipt,encodeStdoutReceipt,boundStdoutReceipt,stdoutArtifact} from './stdout-write-fence.ts';
function check(v:unknown,s:string):asserts v {if(!v)throw Error('stdout write reference: '+s);}
/** The inherited child output remains part of the capture. Reconstruct its
 * complete three-generation transcript from the exact job marker and PID chain;
 * no arbitrary prefix, extra line or suffix is ignored. */
export function validateAssignedStdout(arm:LiveArmRecord,barrier:string,experiment:'stdout-write'|'stdout-zero'|'stdout-byte'|'stdout-close'='stdout-write'):void {
 const h=arm.helper!,marker=arm.stdoutMarker,r=arm.request;
 check(typeof marker==='string'&&marker.startsWith('TASK_ROUTE_ANCHOR-FAULT-'+r.label+'_')&&/^TASK_ROUTE_[A-Z-]+_[a-f0-9]{32}$/.test(marker)&&marker.length<=96,'exact launch marker');
 const close=experiment==='stdout-close',zero=experiment==='stdout-zero',byte=experiment==='stdout-byte';check(experiment==='stdout-write'||zero||byte||close,'explicit transcript experiment');
 check(close?['ASSIGNED-PIPE-HELD','ASSIGNED-PIPE-CLOSED'].includes(r.label):byte?['ASSIGNED-BYTE-SILENT','ASSIGNED-BYTE-WRITE'].includes(r.label):zero?['ASSIGNED-ZERO-SILENT','ASSIGNED-ZERO-WRITE'].includes(r.label):stdoutLabels.some(l=>l===r.label),'selected transcript labels');
 const write=experiment==='stdout-write'&&r.label===stdoutLabels[1],suffix=byte&&r.label==='ASSIGNED-BYTE-WRITE'?'!':'',prefixName=close?'close':byte?'byte':zero?'zero':'stdout';
 check(!suffix||h.out.endsWith(suffix),'exact raw one-byte stdout suffix');
 const prefix=write?h.out.slice(0,-barrier.length-2):suffix?h.out.slice(0,-1):h.out;
 check(write?h.out===prefix+barrier+'\r\n'&&!prefix.includes(prefixName+'-fence '):!h.out.includes(prefixName+'-fence '),'only WRITE emits one final stdout barrier');
 const escaped=marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const starts=[...prefix.matchAll(new RegExp('^inspect-start='+escaped+'\\.generation-([0-2]) pid=([1-9]\\d*)\\r$','gm'))];
 check(starts.length===3&&starts.every((s,i)=>Number(s[1])===i),'three original inspect generations');
 const pids=starts.map(s=>Number(s[2]));
 check(pids[0]===r.root.pid&&new Set([...pids,r.helper.pid]).size===4&&pids.every(p=>p<=0xffffffff),'exact root and distinct child chain');
 const expected:string[]=[];
 for(let depth=0;depth<3;depth++){
  const label=marker+'.generation-'+depth;
  const status=prefix.match(new RegExp('^'+escaped+'\\.generation-'+depth+' debug-object-query=(0xc0000353|0xc0000022) handle=0000000000000000\\r$','m'));
  check(status,'no host debug authority');
  expected.push(`inspect-start=${label} pid=${pids[depth]}`,`${label} appcontainer=1 in-job=1 routing=${depth===0?1:0} bytes=${depth===0?Buffer.byteLength(marker):0} open-error=${depth===0?0:5} marker=${depth===0?marker:''}`,`${label} ambient-denial=5`,`${label} debug-object-query=${status[1]} handle=0000000000000000`,`${label} host-debug-control=0 known=1`);
  if(depth<2){
   expected.push(`${label} child-created=1 pid=${pids[depth+1]} error=0`);
   const close=`retirement-child-closed pid=${pids[depth]} depth=${depth} child=${pids[depth+1]} thread=1 process=1`;
   check(h.err.split(/\r?\n/).filter(l=>l===close).length===1,'actual child stream/process chain cleanup');
  }
 }
 for(let depth=2;depth>=0;depth--)expected.push(`${marker}.generation-${depth} inspect-exit=1 child-exit=${depth===2?0:1} forced=0`);
 check(prefix===expected.join('\r\n')+'\r\n','exact original stdout prefix');
 arm.stdoutPrefix=prefix;
}
export function validateStdoutCapture(arm:LiveArmRecord,rows:ReturnType<LiveDependencies['rows']>):void {
 validateStreamCapture(arm,rows,{parse:parseStdoutReceipt,prefix:'stdout',stdout:validateAssignedStdout});
}
export async function measureStdoutReferences(inputs:Record<'held'|'released',LiveArmInput>,deps:LiveDependencies){
 const r=await measureFencedRootReferences(inputs,deps,{label:k=>stdoutLabels[k==='held'?0:1],bound:boundStdoutReceipt,artifact:stdoutArtifact,validateProof:validateActiveProof,returned:validateStdoutCapture,strategy:'both-released'});
 if(r.outcome==='stdio-held-retained-closed-absent')r.outcome='silent-retained-write-absent';
 if(r.outcome==='stdio-held-absent-closed-retained')r.outcome='silent-absent-write-retained';
 return r;
}
export function runStdoutHarness<J extends {label:string;project:string;marker:string}>(jobs:J[],deps:HarnessDependencies<J>){
 return runFencedRootHarness(jobs,deps,{labels:stdoutLabels,parse:parseStdoutReceipt,bound:boundStdoutReceipt,encode:encodeStdoutReceipt,environment:['BOITE_STDOUT_WRITE_LABEL','BOITE_STDOUT_WRITE_DIRECTORY','BOITE_STDOUT_WRITE_NONCE'],measure:measureStdoutReferences,failure:streamFailure,marker:job=>{check(typeof job.marker==='string','launch marker present');return job.marker;}});
}
