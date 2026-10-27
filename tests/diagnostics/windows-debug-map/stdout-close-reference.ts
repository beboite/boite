import {validateStreamCapture,streamFailure} from './stdio-root-reference.ts';
import {validateAssignedStdout} from './stdout-write-reference.ts';
import {measureFencedRootReferences,type LiveArmInput,type LiveArmRecord,type LiveDependencies} from './live-root-reference.ts';
import {runFencedRootHarness,type HarnessDependencies} from './live-root-harness.ts';
import {validateActiveProof} from './live-fence-dispatch.ts';
import {closeLabels,parseCloseReceipt,encodeCloseReceipt,boundCloseReceipt,closeArtifact} from './stdout-close-fence.ts';
export function validateCloseCapture(arm:LiveArmRecord,rows:ReturnType<LiveDependencies['rows']>):void {
 validateStreamCapture(arm,rows,{parse:parseCloseReceipt,prefix:'close',stdout:(arm,marker)=>validateAssignedStdout(arm,marker,'stdout-close')});
}
export async function measureCloseReferences(inputs:Record<'held'|'released',LiveArmInput>,deps:LiveDependencies){
 const r=await measureFencedRootReferences(inputs,deps,{label:k=>closeLabels[k==='held'?0:1],bound:boundCloseReceipt,artifact:closeArtifact,validateProof:validateActiveProof,returned:validateCloseCapture,strategy:'both-released'});
 return r;
}
export function runCloseHarness<J extends {label:string;project:string;marker:string}>(jobs:J[],deps:HarnessDependencies<J>){
 return runFencedRootHarness(jobs,deps,{labels:closeLabels,parse:parseCloseReceipt,bound:boundCloseReceipt,encode:encodeCloseReceipt,environment:['BOITE_STDOUT_CLOSE_LABEL','BOITE_STDOUT_CLOSE_DIRECTORY','BOITE_STDOUT_CLOSE_NONCE'],measure:measureCloseReferences,failure:(directory,label)=>streamFailure(directory,label,400),marker:job=>{if(typeof job.marker!=='string')throw Error('stdout close reference: launch marker present');return job.marker;}});
}
