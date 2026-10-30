import type { SharedComputeJob } from '@boite/contracts';
import type { TestCore } from './harness.ts';

const terminal = new Set<SharedComputeJob['status']>(['done', 'failed', 'cancelled', 'revoked', 'uncertain']);

/** Observe the durable job without spending peer reads or imposing a second test deadline. */
export function waitForComputeJob(h: TestCore, id: string, statuses: readonly SharedComputeJob['status'][]): Promise<SharedComputeJob> {
  return new Promise(resolve => {
    const check = () => {
      const job = h.core.sharedCompute.journal.get(id, 'source')?.job ?? h.core.sharedCompute.journal.get(id, 'host')?.job;
      if (job && (statuses.includes(job.status) || terminal.has(job.status))) {off(); resolve(job);}
    };
    const off = h.core.sharedCompute.registerChanged(job => {if (job.id === id) check();});
    // Admission or completion may already have happened before the subscription.
    check();
  });
}
