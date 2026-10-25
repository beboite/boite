import type {ProcRegistry} from './procs.ts';
import type {ProtectionRunner} from './platform/protected.ts';

/** Prerequisite helpers are traced, cancellable and receive no ambient account environment. */
export function protectionRunner(procs: Pick<ProcRegistry, 'spawnPiped' | 'killTree'>): (threadId: string, ...args: Parameters<ProtectionRunner>) => ReturnType<ProtectionRunner> {
  return async (threadId, command, args, cwd, env) => {
    const minimal = process.platform === 'win32'
      ? {SystemRoot: process.env['SystemRoot'], PATH: `${process.env['SystemRoot']}\\System32`} : {PATH: '/usr/bin:/bin'};
    const child = procs.spawnPiped(threadId, command, args, {cwd, env: env ?? minimal, agentRoot: false});
    child.proc.stdin.end();
    // This bounds a broken feature probe, never a model run or its project command.
    const timer = setTimeout(() => procs.killTree(threadId), 10000);
    timer.unref();
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text()]);
      return {code, stdout, stderr};
    } finally { clearTimeout(timer); }
  };
}
