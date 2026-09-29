interface JobWriter {
  setJobInfo(job: number, klass: number, buffer: Uint8Array): boolean;
}

export const CLASS_EXTENDED_LIMIT = 9;
export const CLASS_CPU_RATE_CONTROL = 15;
export const EXTENDED_LIMIT_SIZE = 144;
export const OFF_LIMIT_FLAGS = 16;
export const OFF_PRIORITY_CLASS = 56;
export const OFF_JOB_MEMORY_LIMIT = 120;
const JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200;
const JOB_OBJECT_LIMIT_PRIORITY_CLASS = 0x20;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const CPU_RATE_CONTROL_ENABLE = 0x1;
const CPU_RATE_CONTROL_HARD_CAP = 0x4;

export function applyCpuCap(api: JobWriter, job: number, percent: number): boolean {
  const buffer = new Uint8Array(8);
  // Zero and 100 lift a cap previously applied to this job.
  if (percent > 0 && percent < 100) {
    const view = new DataView(buffer.buffer);
    view.setUint32(0, CPU_RATE_CONTROL_ENABLE | CPU_RATE_CONTROL_HARD_CAP, true);
    view.setUint32(4, Math.max(1, Math.round(percent * 100)), true);
  }
  return api.setJobInfo(job, CLASS_CPU_RATE_CONTROL, buffer);
}

export function applyMemoryLimit(api: JobWriter, job: number, mb: number, priority = 0): boolean {
  const buffer = new Uint8Array(EXTENDED_LIMIT_SIZE);
  const view = new DataView(buffer.buffer);
  let flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (priority) {
    flags |= JOB_OBJECT_LIMIT_PRIORITY_CLASS;
    view.setUint32(OFF_PRIORITY_CLASS, priority, true);
  }
  // Windows rounds down to pages. A zero limit would refuse every allocation.
  if (mb > 0) {
    flags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
    view.setBigUint64(OFF_JOB_MEMORY_LIMIT, BigInt(Math.floor(mb * 1024 * 1024 / 4096) * 4096), true);
  }
  view.setUint32(OFF_LIMIT_FLAGS, flags, true);
  return api.setJobInfo(job, CLASS_EXTENDED_LIMIT, buffer);
}
