import {validateStreamCapture,streamFailure} from './stdio-root-reference.ts';
import {validateAssignedStdout} from './stdout-write-reference.ts';
import {measureFencedRootReferences,type LiveArmInput,type LiveArmRecord,type LiveDependencies} from './live-root-reference.ts';
import {runFencedRootHarness,type HarnessDependencies} from './live-root-harness.ts';
import {validateActiveProof} from './live-fence-dispatch.ts';
import {byteLabels,parseByteReceipt,encodeByteReceipt,boundByteReceipt,byteArtifact} from './stdout-byte-fence.ts';
export function validateByteCapture(arm:LiveArmRecord,rows:ReturnType<LiveDependencies['rows']>):void {
 validateStreamCapture(arm,rows,{parse:parseByteReceipt,prefix:'byte',stdout:(arm,marker)=>validateAssignedStdout(arm,marker,'stdout-byte')});
}
export async function measureByteReferences(inputs:Record<'held'|'released',LiveArmInput>,deps:LiveDependencies){
 const r=await measureFencedRootReferences(inputs,deps,{label:k=>byteLabels[k==='held'?0:1],bound:boundByteReceipt,artifact:byteArtifact,validateProof:validateActiveProof,returned:validateByteCapture,strategy:'both-released'});
 if(r.outcome==='stdio-held-retained-closed-absent')r.outcome='silent-retained-byte-absent';
 if(r.outcome==='stdio-held-absent-closed-retained')r.outcome='silent-absent-byte-retained';
 return r;
}
export function runByteHarness<J extends {label:string;project:string;marker:string}>(jobs:J[],deps:HarnessDependencies<J>){
 return runFencedRootHarness(jobs,deps,{labels:byteLabels,parse:parseByteReceipt,bound:boundByteReceipt,encode:encodeByteReceipt,environment:['BOITE_STDOUT_BYTE_LABEL','BOITE_STDOUT_BYTE_DIRECTORY','BOITE_STDOUT_BYTE_NONCE'],measure:measureByteReferences,failure:(directory,label)=>streamFailure(directory,label,424),marker:job=>{if(typeof job.marker!=='string')throw Error('stdout byte reference: launch marker present');return job.marker;}});
}
