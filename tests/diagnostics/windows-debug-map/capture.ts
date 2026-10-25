import type {ProcRegistry, SpawnedPipedProcess} from '../../../packages/core/src/procs.ts';

export interface Captured {pid: number; code: number | null; out: string; err: string; timedOut: boolean}

/** Bound this diagnostic only. Terminate exclusively the registry id we spawned. */
export async function capture(procs: ProcRegistry, id: string, child: SpawnedPipedProcess, milliseconds: number): Promise<Captured> {
  child.proc.stdin.end();
  const result: Captured = {pid: child.record.pid, code: null, out: '', err: '', timedOut: false};
  const stdout = child.proc.stdout.getReader(), stderr = child.proc.stderr.getReader();
  async function collect(reader: typeof stdout, field: 'out' | 'err') {
    const decoder = new TextDecoder();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      result[field] += decoder.decode(next.value, {stream: true});
    }
    result[field] += decoder.decode();
  }
  const completed = Promise.all([child.exited.then(code => {result.code = code;}), collect(stdout, 'out'), collect(stderr, 'err')]);
  const observed = completed.then(() => 'complete' as const);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<'deadline'>(resolve => {timer = setTimeout(() => resolve('deadline'), milliseconds);});
    if (await Promise.race([observed, deadline]) === 'deadline') {
      result.timedOut = true; procs.killTree(id);
      // A stalled pipe cancellation must not turn the watchdog into another
      // unbounded wait. Timeout remains a failure with partial output retained.
      const cleanup = Promise.allSettled([stdout.cancel(), stderr.cancel(), procs.waitForExit(id)]);
      await Promise.race([cleanup, new Promise<void>(resolve => {timer = setTimeout(resolve, 6000);})]);
    }
    return result;
  } finally {clearTimeout(timer);}
}
