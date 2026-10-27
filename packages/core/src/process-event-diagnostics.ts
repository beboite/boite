/** Host-only opt-in trace for completion-port/registry ordering. Never log
 * commands, environment, paths or credentials through this diagnostic. */
export function processEventDiagnostic(stage: string, data: Record<string, string | number | boolean | null>): void {
  if (process.env.BOITE_DIAGNOSE_JOB_EVENTS !== '1') return;
  try {
    console.error('WINDOWS_JOB_EVENT', JSON.stringify({stage, at: Date.now(), hostPid: process.pid, ...data}));
  } catch { /* Observability must not change process tracking or publication. */ }
}
