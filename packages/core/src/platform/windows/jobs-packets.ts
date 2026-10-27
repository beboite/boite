/**
 * What the jobs Worker does with one completion packet, with nothing native in
 * it. Every agent process sits in its thread job and in the global job, both on
 * the same port, so each start and exit is queued twice. The thread's packet
 * is the one the trace reads; of the global job's, only the budget alert
 * matters to the core.
 */

/** JOB_OBJECT_MSG_NEW_PROCESS. */
export const MSG_NEW_PROCESS = 6;
/** JOB_OBJECT_MSG_JOB_MEMORY_LIMIT. */
export const MSG_JOB_MEMORY_LIMIT = 10;

/**
 * `drop`: nothing is posted. `open`: a handle on the new process is opened
 * before the packet is posted. `post`: the packet is posted as it came.
 */
export type PacketAction = 'drop' | 'open' | 'post';

export function jobPacketAction(message: number, key: number, pid: number, globalKey: number): PacketAction {
  if (key === globalKey) return message === MSG_JOB_MEMORY_LIMIT ? 'post' : 'drop';
  return message === MSG_NEW_PROCESS && pid > 0 ? 'open' : 'post';
}

/** Membership reconciliation when the completion-port Worker cannot run. */
export function listJobPids(api: {queryJobInfo(job: number, klass: number, buffer: Uint8Array): boolean}, job: number): Set<number> | null {
  const capacity = 256;
  const buffer = new Uint8Array(8 + capacity * 8);
  if (!api.queryJobInfo(job, 3 /* JobObjectBasicProcessIdList */, buffer)) return null;
  const view = new DataView(buffer.buffer);
  const count = Math.min(view.getUint32(4, true), capacity);
  const pids = new Set<number>();
  for (let index = 0; index < count; index += 1) pids.add(Number(view.getBigUint64(8 + index * 8, true)));
  return pids;
}
