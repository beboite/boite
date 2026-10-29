import {expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import type {SharedComputeJob} from '@boite/contracts';
import {createSharedCompute, SharedComputeJournal, type ComputeRecord} from '../src/contacts/compute-journal.ts';

test('peer flush keeps ordered host fences and pending source cancellations across status changes', () => {
  const db=new Database(':memory:');createSharedCompute(db);
  const journal=new SharedComputeJournal(db);
  const project=(id:string)=>({ownerCoreId:id,coreId:id,projectId:'project'});
  const statuses:SharedComputeJob['status'][]=['queued','running','waiting','uncertain','done','failed','cancelled','revoked'];
  const records:ComputeRecord[]=[];
  try {
    for(const role of ['host','source'] as const) for(const peer of ['a','b']) for(const status of statuses) for(const cancel of [false,true]) {
      const id=`${role}-${peer}-${status}-${cancel}`;
      const source={project:project(role==='host'?peer:'self'),threadId:'thread',address:{coreId:role==='host'?peer:'self',threadId:'thread'}};
      const host=project(role==='source'?peer:'self');
      const record:ComputeRecord={role,repository:'example.invalid/fixture',fingerprint:id,
        input:{requestId:id,host,profileId:'conversation',task:'Fixture',baseCommit:'a'.repeat(40)},
        job:{id,revision:1,sharedProjectId:'association',requestId:id,source,host,worker:null,grantRevision:1,profileId:'conversation',providerId:'echo',model:null,effort:null,permissionMode:'default',status,claimId:null,result:null,error:null,createdAt:1,updatedAt:1},
        ...(cancel?{cancelRequest:id}:{})};
      records.push(record);journal.put(record);
    }
    const expected=(peer:string,role:ComputeRecord['role'])=>records.filter(r=>r.role===role&&(role==='host'?r.job.source.project.ownerCoreId:r.job.host.ownerCoreId)===peer&&(role==='host'||!['done','failed','cancelled','revoked'].includes(r.job.status)||r.cancelRequest));
    for(const peer of ['a','b']) for(const role of ['host','source'] as const) expect(journal.forPeer(peer,role)).toEqual(expected(peer,role));
    const finished=records.find(r=>r.role==='source'&&r.job.status==='running'&&!r.cancelRequest)!;
    finished.job.status='done';journal.put(finished);
    expect(journal.forPeer('a','source')).toEqual(expected('a','source'));
    finished.cancelRequest='retry-stop';journal.put(finished);
    expect(journal.forPeer('a','source')).toEqual(expected('a','source'));
    expect(journal.get(finished.job.id,'source')?.cancelRequest).toBe('retry-stop');
    expect(journal.all()).toHaveLength(records.length);
    expect(journal.forPeer('unknown','host')).toEqual([]);
    expect(journal.forPeer('unknown','source')).toEqual([]);
  } finally {db.close();}
});
