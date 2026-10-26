import {parseRootRequest,type RootRequest,type RootOwned,type RootCustody,type RootClose} from './fault-root-reference.ts';
import {boundActiveReceipt as boundLiveReceipt,isActiveLiveLabel as isLiveLabel} from './live-fence-dispatch.ts';
import type {LedgerRow,Membership} from './target-topology.ts';
type Rows=(LedgerRow&Partial<Membership>&{wallMs?:number;error?:number;stage?:string})[];
type CapturedCustody=RootCustody&{pid:number;created:string;exitCode:number};
export interface LiveDrainProof {root:CapturedCustody;helper:CapturedCustody;ready:string;startedAt:number;close:RootClose;removed:true;at:number}
export interface LiveDrainDependencies {
 compiler:string;compilerNonce:string;now():number;current(pid:number):RootOwned|undefined;
 ready(r:RootRequest):Buffer;rows():Rows;retire(x:RootOwned,helper:RootOwned):RootClose|undefined;removed(pid:number):boolean;
}
function check(v:unknown,s:string):asserts v {if(!v)throw Error('live harness drain: '+s);}
const sameJob=(a:Partial<RootCustody>,b:RootCustody)=>(['owner','threadId','threadJob','jobKey','globalJob','nestingRefused'] as const).every(k=>a[k]===b[k]);
function validCustody(x:RootCustody):void {check([x.id,x.owner].every(s=>typeof s==='string'&&s.length>0&&s.length<200)&&/^[1-9]\d*$/.test(x.threadJob)&&/^(0|[1-9]\d*)$/.test(x.globalJob)&&Number.isSafeInteger(x.jobKey)&&x.jobKey>0&&typeof x.nestingRefused==='boolean','captured custody fields');}
function acquisition(x:CapturedCustody,rows:Rows):void {check(rows.some(v=>['acquired','transfer-received'].includes(v.event)&&v.role==='harness-main'&&v.id===x.id&&v.owner===x.owner&&v.pid===x.pid&&v.incarnation===x.created),'captured acquisition');}
function custody(x:RootOwned):CapturedCustody {return {owner:x.owner,id:x.id,threadId:x.threadId,threadJob:x.threadJob,jobKey:x.jobKey,globalJob:x.globalJob,nestingRefused:x.nestingRefused,pid:x.pid,created:x.created,exitCode:x.exitCode!};}
function captured(x:RootOwned|undefined,p:RootRequest['root'],code:number,r:RootRequest):asserts x is RootOwned {
 check(x&&x.role==='harness-main'&&x.pid===p.pid&&x.created===p.created&&x.exitCode===code&&x.complete&&!x.closeFailed&&x.stage==='tracked'&&Number.isSafeInteger(x.handle)&&x.handle>0,'exact captured harness identity');
 check(x.threadId==='lpac-ANCHOR-FAULT-'+r.label,'exact fixture job');
 validCustody(x);
}
function membership(r:RootRequest,root:RootCustody,rows:Rows):void {
 check(!rows.some(v=>v.event==='incomplete'),'complete trace');
 for(const p of [r.root,r.helper])check(rows.some(v=>v.event==='owned-membership'&&v.role==='harness-main'&&v.pid===p.pid&&v.created===p.created&&v.threadMember===1&&sameJob(v as Membership,root)),'exact owned memberships');
}
/** Discharge only this owner's terminal captured root. Admission is separate
 * from launcher custody and never waits for the helper's job to become empty. */
export class LiveRootDrainer {
 private consumed=new Set<string>();
 constructor(private deps:LiveDrainDependencies){}
 drain(value:RootRequest):LiveDrainProof {
  const r=parseRootRequest(JSON.stringify(value),this.deps.now());
  check(isLiveLabel(r.label)&&r.phase==='held'&&r.compiler===this.deps.compiler&&r.compilerNonce===this.deps.compilerNonce,'active live context');
  const key=r.label+':'+r.nonce;check(!this.consumed.has(key),'consumed operation');this.consumed.add(key);
  const bytes=this.deps.ready(r),startedAt=this.deps.now();boundLiveReceipt(r,bytes,startedAt);
  const root=this.deps.current(r.root.pid),helper=this.deps.current(r.helper.pid);
  captured(root,r.root,125,r);captured(helper,r.helper,259,r);
  const rows=this.deps.rows();check(root.id!==helper.id&&sameJob(root,helper),'same harness job');membership(r,root,rows);
  acquisition(custody(root),rows);acquisition(custody(helper),rows);
  check(!rows.some(v=>v.event==='close-result'&&[root.id,helper.id].includes(v.id!)),'unclosed captured references');
  // Re-read the captured values and private bytes immediately before invoking
  // original reportExit. A failed check never touches an undecidable handle.
  const exact=this.deps.current(r.root.pid),live=this.deps.current(r.helper.pid);
  captured(exact,r.root,125,r);captured(live,r.helper,259,r);
  check(JSON.stringify(exact)===JSON.stringify(root)&&JSON.stringify(live)===JSON.stringify(helper),'custody changed before reportExit');
  const current=this.deps.ready(r);check(current.equals(bytes),'READY changed before reportExit');boundLiveReceipt(r,current,this.deps.now());
  const close=this.deps.retire(exact,live);check(close&&this.deps.removed(r.root.pid),'original reportExit and slot removal');
  const proof:LiveDrainProof={root:custody(root),helper:custody(helper),ready:bytes.toString('base64'),startedAt,close,removed:true,at:this.deps.now()};
  validateLiveDrain(r,proof,bytes,this.deps.rows(),this.deps.now());return proof;
 }
}
/** Independently bind the serializable owner proof to exact ledger closure,
 * private READY and the original shared deadline before baseline observers. */
export function validateLiveDrain(r:RootRequest,p:LiveDrainProof,ready:Buffer,rows:Rows,now:number):void {
 check(p&&Object.keys(p).sort().join()===['root','helper','ready','startedAt','close','removed','at'].sort().join(),'proof fields');
 check(p.ready===ready.toString('base64')&&p.removed===true&&Number.isSafeInteger(p.startedAt)&&Number.isSafeInteger(p.at)&&p.startedAt<=p.at&&p.at<=now&&now<r.deadline,'proof order/deadline');
 boundLiveReceipt(r,ready,p.startedAt);boundLiveReceipt(r,ready,now);
 for(const [x,identity,code] of [[p.root,r.root,125],[p.helper,r.helper,259]] as const){
  check(x&&Object.keys(x).sort().join()===['owner','id','threadId','threadJob','jobKey','globalJob','nestingRefused','pid','created','exitCode'].sort().join(),'custody fields');
  check(x.pid===identity.pid&&x.created===identity.created&&x.exitCode===code&&x.threadId==='lpac-ANCHOR-FAULT-'+r.label,'proof captured identity');validCustody(x);acquisition(x,rows);
 }
 check(p.root.id!==p.helper.id&&sameJob(p.root,p.helper),'proof same job');membership(r,p.root,rows);
 check(!rows.some(v=>v.event==='close-result'&&v.id===p.helper.id),'helper still held');
 const closed=rows.filter(v=>v.event==='close-result'&&v.id===p.root.id),c=closed[0],proof=p.close;
 check(proof&&Object.keys(proof).sort().join()===['id','success','error','wallMs'].sort().join()&&proof.id===p.root.id&&proof.success&&proof.error===0&&Number.isSafeInteger(proof.wallMs),'unique close proof');
 check(closed.length===1&&c&&c.role==='harness-main'&&c.owner===p.root.owner&&c.pid===r.root.pid&&c.incarnation===r.root.created&&c.stage==='tracked'&&c.success&&c.error===0&&Number.isSafeInteger(c.wallMs)&&c.wallMs!>=p.startedAt&&c.wallMs!<=proof.wallMs&&proof.wallMs<=p.at,'actual owner closure');
}
