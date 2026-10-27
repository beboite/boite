import type {ProcRegistry} from './procs.ts';
import type {ProtectedDriverExecution} from './drivers/protected.ts';

/** Serial publication prevents two simultaneous tool batches from racing the same captured view. */
export function protectedTools(procs: ProcRegistry, id: string, check: () => void, changed: (paths: readonly string[]) => void, commit?: (message: string) => Promise<string>, toolsAllowed = true): ProtectedDriverExecution {
  const policy = procs.protection.policy(id);
  if (!policy) throw new Error('execution.thread: native capability required before tools');
  let queue: Promise<unknown> = Promise.resolve();
  const execution: ProtectedDriverExecution = {fingerprint: policy.fingerprint, toolsAllowed,
    check: () => {check(); procs.protection.assert(id);},
    execute: (command, args, cwd) => {
      const run = queue.then(async () => {
        execution.check();
        if (!toolsAllowed) throw new Error('execution.tool: the host context disables tools');
        const child = procs.spawn(id, command, args, {cwd: cwd ?? policy.checkout, agentRoot: false});
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text()]);
        await procs.waitForExit(id, [child.record.pid]);
        execution.check();
        changed(procs.protection.flush(id));
        return {code: code ?? -1, stdout, stderr};
      });
      queue = run.catch(() => {}); return run;
    }};
  if (commit) execution.commit = message => {
    const run = queue.then(() => {execution.check(); if (!toolsAllowed) throw new Error('execution.commit: the host context disables tools'); return commit(message);});
    queue = run.catch(() => {}); return run;
  };
  return execution;
}
