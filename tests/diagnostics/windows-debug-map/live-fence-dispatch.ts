import {isLiveLabel,boundLiveReceipt,authorizeLiveFence,validateLiveProof,authorizeLiveContext,validateLiveProofContext,type LiveProof} from './live-root-fence.ts';
import {isStdioLabel,boundStdioReceipt} from './stdio-root-fence.ts';
import type {RootRequest,RootOwned} from './fault-root-reference.ts';
import type {LedgerRow,Membership} from './target-topology.ts';
export const isActiveLiveLabel=(s:string)=>isLiveLabel(s)||isStdioLabel(s);
export function boundActiveReceipt(r:RootRequest,b:Buffer,now:number){
 if(isStdioLabel(r.label))return boundStdioReceipt(r,b,now);
 if(isLiveLabel(r.label))return boundLiveReceipt(r,b,now);
 throw Error('live admission: unknown label');
}
export function authorizeActiveFence(r:RootRequest,root:RootOwned,helper:RootOwned|undefined,b:Buffer,rows:(LedgerRow&Partial<Membership>)[],now:number):LiveProof {
 if(isStdioLabel(r.label)){boundStdioReceipt(r,b,now);return authorizeLiveContext(r,root,helper,b,rows,now);}
 if(isLiveLabel(r.label))return authorizeLiveFence(r,root,helper,b,rows,now);
 throw Error('live admission: unknown label');
}
export function validateActiveProof(r:RootRequest,value:unknown,now:number):asserts value is LiveProof {
 if(isStdioLabel(r.label)){validateLiveProofContext(r,value,now);boundStdioReceipt(r,Buffer.from(value.ready,'base64'),value.at);return;}
 if(isLiveLabel(r.label)){validateLiveProof(r,value,now);return;}
 throw Error('live admission: unknown label');
}
