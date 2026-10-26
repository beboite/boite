import {validateStreamCapture,streamFailure} from './stdio-root-reference.ts';
import {validateAssignedStdout} from './stdout-write-reference.ts';
import {measureFencedRootReferences,type LiveArmInput,type LiveArmRecord,type LiveDependencies} from './live-root-reference.ts';
import {runFencedRootHarness,type HarnessDependencies} from './live-root-harness.ts';
import {validateActiveProof} from './live-fence-dispatch.ts';
import {zeroLabels,parseZeroReceipt,encodeZeroReceipt,boundZeroReceipt,zeroArtifact} from './stdout-zero-fence.ts';
export function validateZeroCapture(arm:LiveArmRecord,rows:ReturnType<LiveDependencies['rows']>):void {
 validateStreamCapture(arm,rows,{parse:parseZeroReceipt,prefix:'zero',stdout:(arm,marker)=>validateAssignedStdout(arm,marker,'stdout-zero')});
}
export async function measureZeroReferences(inputs:Record<'held'|'released',LiveArmInput>,deps:LiveDependencies){
 const r=await measureFencedRootReferences(inputs,deps,{label:k=>zeroLabels[k==='held'?0:1],bound:boundZeroReceipt,artifact:zeroArtifact,validateProof:validateActiveProof,returned:validateZeroCapture,strategy:'both-released'});
 if(r.outcome==='stdio-held-retained-closed-absent')r.outcome='silent-retained-zero-absent';
 if(r.outcome==='stdio-held-absent-closed-retained')r.outcome='silent-absent-zero-retained';
 return r;
}
export function runZeroHarness<J extends {label:string;project:string;marker:string}>(jobs:J[],deps:HarnessDependencies<J>){
 return runFencedRootHarness(jobs,deps,{labels:zeroLabels,parse:parseZeroReceipt,bound:boundZeroReceipt,encode:encodeZeroReceipt,environment:['BOITE_STDOUT_ZERO_LABEL','BOITE_STDOUT_ZERO_DIRECTORY','BOITE_STDOUT_ZERO_NONCE'],measure:measureZeroReferences,failure:(directory,label)=>streamFailure(directory,label,424),marker:job=>{if(typeof job.marker!=='string')throw Error('stdout zero reference: launch marker present');return job.marker;}});
}
