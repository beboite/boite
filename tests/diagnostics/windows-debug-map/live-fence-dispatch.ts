import {isCloseLabel,boundCloseReceipt} from './stdout-close-fence.ts';
import {isByteLabel,boundByteReceipt} from './stdout-byte-fence.ts';
import {isZeroLabel,boundZeroReceipt} from './stdout-zero-fence.ts';
import {isStdoutLabel,boundStdoutReceipt} from './stdout-write-fence.ts';
import {isLiveLabel,boundLiveReceipt,authorizeLiveFence,validateLiveProof,authorizeLiveContext,validateLiveProofContext,type LiveProof} from './live-root-fence.ts';
import {isStdioLabel,boundStdioReceipt} from './stdio-root-fence.ts';
import type {RootRequest,RootOwned} from './fault-root-reference.ts';
import type {LedgerRow,Membership} from './target-topology.ts';
export const isActiveLiveLabel=(s:string)=>isCloseLabel(s)||isByteLabel(s)||isLiveLabel(s)||isStdioLabel(s)||isStdoutLabel(s)||isZeroLabel(s);
export function boundActiveReceipt(r:RootRequest,b:Buffer,now:number){
 if(isCloseLabel(r.label))return boundCloseReceipt(r,b,now);
 if(isByteLabel(r.label))return boundByteReceipt(r,b,now);
 if(isZeroLabel(r.label))return boundZeroReceipt(r,b,now);
 if(isStdoutLabel(r.label))return boundStdoutReceipt(r,b,now);
 if(isStdioLabel(r.label))return boundStdioReceipt(r,b,now);
 if(isLiveLabel(r.label))return boundLiveReceipt(r,b,now);
 throw Error('live admission: unknown label');
}
export function authorizeActiveFence(r:RootRequest,root:RootOwned,helper:RootOwned|undefined,b:Buffer,rows:(LedgerRow&Partial<Membership>)[],now:number):LiveProof {
 if(isCloseLabel(r.label)){boundCloseReceipt(r,b,now);return authorizeLiveContext(r,root,helper,b,rows,now);}
 if(isByteLabel(r.label)){boundByteReceipt(r,b,now);return authorizeLiveContext(r,root,helper,b,rows,now);}
 if(isZeroLabel(r.label)){boundZeroReceipt(r,b,now);return authorizeLiveContext(r,root,helper,b,rows,now);}
 if(isStdoutLabel(r.label)){boundStdoutReceipt(r,b,now);return authorizeLiveContext(r,root,helper,b,rows,now);}
 if(isStdioLabel(r.label)){boundStdioReceipt(r,b,now);return authorizeLiveContext(r,root,helper,b,rows,now);}
 if(isLiveLabel(r.label))return authorizeLiveFence(r,root,helper,b,rows,now);
 throw Error('live admission: unknown label');
}
export function validateActiveProof(r:RootRequest,value:unknown,now:number):asserts value is LiveProof {
 if(isCloseLabel(r.label)){validateLiveProofContext(r,value,now);boundCloseReceipt(r,Buffer.from(value.ready,'base64'),value.at);return;}
 if(isByteLabel(r.label)){validateLiveProofContext(r,value,now);boundByteReceipt(r,Buffer.from(value.ready,'base64'),value.at);return;}
 if(isZeroLabel(r.label)){validateLiveProofContext(r,value,now);boundZeroReceipt(r,Buffer.from(value.ready,'base64'),value.at);return;}
 if(isStdoutLabel(r.label)){validateLiveProofContext(r,value,now);boundStdoutReceipt(r,Buffer.from(value.ready,'base64'),value.at);return;}
 if(isStdioLabel(r.label)){validateLiveProofContext(r,value,now);boundStdioReceipt(r,Buffer.from(value.ready,'base64'),value.at);return;}
 if(isLiveLabel(r.label)){validateLiveProof(r,value,now);return;}
 throw Error('live admission: unknown label');
}
