import {randomUUID} from 'node:crypto';
import {processEventDiagnostic} from './process-event-diagnostics.ts';
import {assertExecutionPolicy, captureExecutionPolicy, type ExecutionPolicy, type ProtectedExecutionInput} from './execution-policy.ts';
import type {NativeExecutionBoundary, NativeExecutionSession, ProtectedLaunch, ProtectionRunner} from './platform/protected.ts';

// Record only the fixed field prefix, never paths or other error values.
const refusalField = (error: unknown): string | null => error instanceof Error
  ? /^execution\.[a-zA-Z.]+(?=:)/.exec(error.message)?.[0] ?? null : null;

interface Lease {
  policy: ExecutionPolicy;
  session: NativeExecutionSession | null;
  threads: Set<string>;
  helpers: Set<string>;
  check(): void;
  closed: boolean;
  timer?: ReturnType<typeof setTimeout>;
  stopping?: Promise<void>;
  opening?: Promise<NativeExecutionSession>;
  controlId?: string;
}

/** Host-owned capabilities. Revoked bindings stay closed until the host explicitly releases them. */
export class ExecutionProtections {
  private readonly bindings = new Map<string, Lease>();
  private readonly refused = new Set<string>();
  constructor(private readonly boundary: NativeExecutionBoundary | undefined,
    private readonly runner: (threadId: string, ...args: Parameters<ProtectionRunner>) => ReturnType<ProtectionRunner>,
    private readonly stop: (id: string) => Promise<void>,
    private readonly live: (id: string) => number) {}

  policy(threadId: string): ExecutionPolicy | null { return this.bindings.get(threadId)?.policy ?? null; }
  controlScope(threadId: string): string | null { return this.bindings.get(threadId)?.controlId ?? null; }
  get available(): boolean { return !!this.boundary && (this.boundary.available?.() ?? false); }
  assert(threadId: string, capabilityId?: string): void {
    const lease = this.bindings.get(threadId);
    // A stale tool may not revoke the replacement bound to the same thread.
    if (capabilityId !== undefined && lease?.policy.capabilityId !== capabilityId) throw new Error('execution.scope: captured capability was replaced');
    if (!lease) throw new Error('execution.thread: expected an installed capability');
    try {this.check(lease);} catch (error) {
      processEventDiagnostic('protection.assert-refused', {threadId, capabilityId: lease.policy.capabilityId, closed: lease.closed, field: refusalField(error)});
      void this.revoke(threadId).catch(() => {}); throw error;
    }
  }
  /** Trusted provider control and fixed core Git operations, never model-supplied commands. */
  control(threadId: string): string {
    const lease = this.bindings.get(threadId);
    if (!lease) throw new Error('execution.thread: expected an installed capability');
    this.check(lease);
    const id = lease.controlId ??= protectionProbeThread(); lease.helpers.add(id); return id;
  }

  async install(threadId: string, input: ProtectedExecutionInput, check: () => void): Promise<ExecutionPolicy> {
    if (this.bindings.has(threadId) || this.refused.has(threadId) || this.live(threadId)) throw new Error('execution.thread: protection must precede its first process; release the old binding before replacement');
    this.refused.add(threadId);
    const policy = captureExecutionPolicy(input);
    // Bind before the first await: concurrent launches must fail closed while the native probe runs.
    const lease: Lease = {policy, check, threads: new Set([threadId]), helpers: new Set(), closed: false, session: null};
    this.bindings.set(threadId, lease);
    this.refused.delete(threadId);
    try {
      this.check(lease);
      if (!this.boundary) throw new Error('execution.platform: no native protected execution boundary on this host');
      lease.opening = this.boundary.open(policy, async (...args) => {
        this.check(lease);
        const helper = protectionProbeThread();
        lease.helpers.add(helper);
        try { return await this.runner(helper, ...args); } finally { lease.helpers.delete(helper); }
      });
      const session = await lease.opening;
      if (lease.closed) { await session.close(); throw new Error('execution.scope: revoked during native preparation'); }
      lease.session = session;
      this.check(lease);
      this.expire(lease);
      return policy;
    } catch (error) { await this.revoke(threadId); throw error; }
  }

  inherit(parent: string, child: string): void {
    const lease = this.bindings.get(parent);
    if (!lease) throw new Error('execution.parent: expected an installed protection capability');
    this.check(lease);
    if (this.bindings.has(child) || this.refused.has(child) || this.live(child)) throw new Error('execution.child: protection must precede its first process');
    lease.threads.add(child);
    this.bindings.set(child, lease);
  }

  launch(threadId: string, command: string, args: string[], opts: {cwd?: string; extraPipes?: number; showWindow?: boolean}): ProtectedLaunch | null {
    if (this.refused.has(threadId)) throw new Error('execution.scope: protection descriptor was refused; release required');
    const lease = this.bindings.get(threadId);
    if (!lease) return null;
    let phase = 'authority';
    try {
      this.check(lease);
      phase = 'descriptors';
      if (!lease.session) throw new Error('execution.platform: native protection is not ready');
      if (opts.extraPipes || opts.showWindow) throw new Error('execution.descriptors: protected tools accept only controlled stdin/stdout/stderr pipes and hidden execution');
      phase = 'native-launch';
      return lease.session.launch(command, args, opts.cwd ?? lease.policy.checkout);
    } catch (error) {
      processEventDiagnostic('protection.launch-refused', {threadId, capabilityId: lease.policy.capabilityId, phase, field: refusalField(error)});
      void this.revoke(threadId).catch(() => {}); throw error;
    }
  }

  assertTerminal(threadId: string): void {
    if (this.bindings.has(threadId) || this.refused.has(threadId)) throw new Error('execution.terminal: protected tools require controlled standard pipes');
  }

  /** Native membership can outlive root exit and its completion-port packet. */
  async publish(threadId: string, capabilityId: string): Promise<readonly string[]> {
    this.assert(threadId, capabilityId);
    const lease = this.bindings.get(threadId)!;
    const deadline = Date.now() + 5000;
    while ([...lease.threads].some(id => this.live(id) > 0) && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 25));
      this.assert(threadId, capabilityId);
    }
    this.assert(threadId, capabilityId);
    // The deadline ends the wait, never the guard: occupied/unknown jobs
    // still refuse and revoke through the synchronous publication gate.
    return this.flush(threadId);
  }

  flush(threadId: string): readonly string[] {
    const lease = this.bindings.get(threadId);
    if (!lease) throw new Error('execution.thread: expected an installed capability');
    let phase = 'authority';
    try {
      this.check(lease);
      phase = 'processes';
      if ([...lease.threads].some(id => {
        const count = this.live(id);
        processEventDiagnostic('protection.flush-membership', {threadId: id, capabilityId: lease.policy.capabilityId, count});
        return count > 0;
      })) throw new Error('execution.processes: tools must exit before publishing project edits');
      phase = 'session';
      if (!lease.session) throw new Error('execution.platform: native protection is not ready');
      phase = 'publish';
      const changed = lease.session.flush() ?? [];
      phase = 'authority-after-publish';
      this.check(lease);
      return changed;
    } catch (error) {
      processEventDiagnostic('protection.flush-refused', {threadId, capabilityId: lease.policy.capabilityId, phase, field: refusalField(error)});
      void this.revoke(threadId).catch(() => {}); throw error;
    }
  }

  revoke(threadId: string): Promise<void> {
    const lease = this.bindings.get(threadId);
    if (!lease) return Promise.resolve();
    if (lease.stopping) return lease.stopping;
    processEventDiagnostic('protection.revoke', {threadId, capabilityId: lease.policy.capabilityId, scopeId: lease.policy.scope.id,
      controlId: lease.controlId ?? null, threads: lease.threads.size, helpers: lease.helpers.size});
    lease.closed = true;
    clearTimeout(lease.timer);
    lease.stopping = Promise.allSettled([...lease.threads, ...lease.helpers].map(id => Promise.resolve().then(() => this.stop(id)))).then(async results => {
      const errors: unknown[] = results.filter(r => r.status === 'rejected').map(r => r.reason);
      const session = lease.session ?? await lease.opening?.catch(() => null);
      try {await session?.close(); lease.session = null;} catch (error) {errors.push(error);}
      if (errors.length) throw new AggregateError(errors, 'execution.cleanup: protected stop or session cleanup failed');
    });
    const stopping = lease.stopping;
    void stopping.catch(() => {if (lease.stopping === stopping) lease.stopping = undefined;});
    return stopping;
  }

  async release(threadId: string): Promise<void> {
    const lease = this.bindings.get(threadId);
    await this.revoke(threadId);
    if (this.bindings.get(threadId) !== lease) return;
    this.refused.delete(threadId);
    if (lease) for (const id of lease.threads) if (this.bindings.get(id) === lease) this.bindings.delete(id);
  }

  async close(): Promise<void> {
    const settled = await Promise.allSettled([...this.bindings.keys()].map(id => this.release(id)));
    const errors = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Failed to close protected execution sessions');
    this.refused.clear();
  }

  private check(lease: Lease): void {
    if (lease.closed) throw new Error('execution.scope: captured authority was revoked');
    assertExecutionPolicy(lease.policy);
    lease.check();
  }

  private expire(lease: Lease): void {
    lease.timer = setTimeout(() => {
      if (Date.now() >= lease.policy.expiresAt) {
        processEventDiagnostic('protection.expired', {capabilityId: lease.policy.capabilityId});
        void this.revoke([...lease.threads][0]!).catch(() => {});
      }
      else this.expire(lease);
    }, Math.min(lease.policy.expiresAt - Date.now(), 2_147_483_647));
    lease.timer.unref();
  }
}

/** Unpredictable, host-only trace scope for the native prerequisite command. */
export const protectionProbeThread = (): string => `protection-probe-${randomUUID()}`;
