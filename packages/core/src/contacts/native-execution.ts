import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join, isAbsolute, resolve} from 'node:path';
import {existsSync} from 'node:fs';
import type {Core} from '../core.ts';
import type {ProtectedExecutionInput} from '../execution-policy.ts';
import type {ProtectedDriverExecution} from '../drivers/protected.ts';
import type {AccessBinding} from './access-scopes.ts';
import {policyFile} from './file-policy.ts';
import {sharedExecutionProtection, sharedPermissionSupport} from './compute-policy.ts';
import type {PermissionMode} from '@boite/contracts';
import {refused} from '../errors.ts';
import {protectedTools} from '../protected-tools.ts';
import {computeGit, computeChangedFiles} from './compute-git.ts';

interface Installed {key: string; execution: ProtectedDriverExecution; changed: Map<string, string | null>}
/** One core-owned immutable capability for jobs, board goals and external correspondence. */
export class SharedNativeExecution {
  readonly #installed = new Map<string, Installed>();
  readonly #pending = new Map<string, Promise<void>>();
  readonly #core: Core;
  readonly #binding: (id: string) => AccessBinding | null;

  constructor(core: Core, binding: (id: string) => AccessBinding | null,
    private readonly check: (binding: AccessBinding) => void) {
    this.#core = core;
    this.#binding = binding;
    core.sharedProjects.registerPolicyListener(() => this.reconcile());
    core.sharedCompute.registerChanged(() => this.reconcile());
    core.bus.onCommitted((name) => {
      if (name === 'sharedProjects.changed' || name === 'thread.updated') this.reconcile();
    });
  }
  support(protocol: Parameters<typeof sharedExecutionProtection>[0], providerId?: string, mode?: PermissionMode) {
    if (mode && !sharedPermissionSupport(protocol, mode, providerId)) return {supported: false as const, reason: `execution.permissionMode: ${providerId ?? protocol} cannot enforce ${mode}`};
    return sharedExecutionProtection(protocol, this.#core.procs.protection.available, providerId);
  }
  context(id: string): ProtectedDriverExecution | undefined {
    if (!this.#binding(id) || this.#core.providers.require(this.#core.threads.require(id).providerId).protocol === 'echo') return;
    const execution = this.#installed.get(id)?.execution;
    if (!execution) throw refused('execution.thread: protected native preparation must precede provider control');
    execution.check(); return execution;
  }
  prepare(id: string): Promise<void> | undefined {
    const existing = this.#pending.get(id); if (existing) return existing;
    if (!this.#installed.has(id) && !this.#core.procs.protection.policy(id)
      && (!this.#binding(id) || this.#core.providers.require(this.#core.threads.require(id).providerId).protocol === 'echo')) return;
    const work = this.open(id).finally(() => this.#pending.delete(id));
    this.#pending.set(id, work); return work;
  }
  #input(id: string): ProtectedExecutionInput | null {
    const binding = this.#binding(id); if (!binding) return null;
    this.check(binding);
    const thread = this.#core.threads.require(id), protocol = this.#core.providers.require(thread.providerId).protocol;
    if (protocol === 'echo') return null;
    const support = this.support(protocol, thread.providerId, thread.permissionMode);
    if (!support.supported) throw refused(`execution.provider: ${support.reason}`);
    const records = [binding, ...(binding.additional ?? [])];
    const scopes = records.map(b => ({kind: b.compute ? 'job' as const : b.board ? 'board' as const : 'letter' as const,
      id: b.job.id ?? b.board?.claimId ?? `${b.job.sharedProjectId}:${id}`, associationId: b.job.sharedProjectId, grantRevision: b.job.grantRevision}));
    const now = Date.now();
    const grants = records.map(b => this.#core.sharedAccess.journal.overrides(b.job.sharedProjectId).filter(o =>
      o.root === b.checkoutPath && o.value.revokedAt === null && o.value.expiresAt > now
      && o.value.actions.includes('read') && o.revision === b.job.grantRevision
      && (o.value.jobId === null || o.value.jobId === b.job.id)));
    const readOverrides = grants[0]!.flatMap(o => {
      try {
        if (policyFile(binding.checkoutPath, o.value.path).identity !== o.identity) return [];
        // Every authority in the history grants this exact file. The earliest expiry wins.
        const matching = grants.map(grant => grant.find(p => p.identity === o.identity && p.value.path === o.value.path));
        if (matching.some(p => !p)) return [];
        return [{path: o.value.path, identity: o.identity, expiresAt: Math.min(...matching.map(p => p!.value.expiresAt))}];
      } catch { return []; }
    });
    const account = this.#core.accounts.require(thread.accountId);
    const environment = {...process.env, ...this.#core.accounts.accountEnv(account, this.#core.providers.require(thread.providerId))};
    const credentialFiles = Object.entries(environment).filter(([name, value]) => /credential|(?:auth|token|secret|api_?key).*file|^(?:CODEX_HOME|CLAUDE_CONFIG_DIR|AWS_CONFIG_FILE)$/i.test(name) && typeof value === 'string' && isAbsolute(value)).map(([, value]) => value!);
    const home = environment['HOME'] || homedir();
    const selectedPath = (name: string, fallback: string) => resolve(binding.checkoutPath, environment[name] || fallback);
    const piDirectory = environment['PI_CODING_AGENT_DIR'] || join(home, '.pi', 'agent');
    const providerCredentials = protocol === 'pi' ? [resolve(binding.checkoutPath, piDirectory === '~' ? home : piDirectory.startsWith('~/') ? join(home, piDirectory.slice(2)) : piDirectory)]
      : protocol === 'acp' && thread.providerId === 'opencode' ? [
        join(selectedPath('XDG_CONFIG_HOME', join(home, '.config')), 'opencode'),
        join(selectedPath('XDG_DATA_HOME', join(home, '.local', 'share')), 'opencode'),
        ...['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR'].flatMap(name => environment[name] ? [selectedPath(name, '')] : []),
      ] : protocol === 'muse' ? ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'].map(name =>
        join(selectedPath(name, join(home, name === 'XDG_CONFIG_HOME' ? '.config' : name === 'XDG_DATA_HOME' ? '.local/share' : '.local/state')), 'muse')) : [];
    return {scope: scopes[0]!, additionalScopes: scopes.slice(1), checkout: binding.checkoutPath,
      route: {providerId: thread.providerId, accountId: thread.accountId, permissionMode: thread.permissionMode, ...(binding.compute ? {profileId: binding.compute.job.profileId} : {})},
      credentialPaths: [...(account.isolationDir ? [account.isolationDir] : []), ...['.claude', '.codex', '.ssh', '.aws', '.config'].map(p => join(homedir(), p)), ...credentialFiles, ...providerCredentials],
      executables: [process.execPath], readOverrides, expiresAt: Number.MAX_SAFE_INTEGER};
  }
  private key(input: ProtectedExecutionInput, id: string): string { return createHash('sha256').update(JSON.stringify([input, this.#core.threads.require(id).contextMode?.tools ?? null])).digest('hex'); }
  private async open(id: string): Promise<void> {
    const input = this.#input(id), old = this.#installed.get(id);
    if (!input) {
      if (old) {
        this.#core.threads.releaseAgent(id);
        await this.#core.procs.protection.release(id);
        this.#installed.delete(id);
      }
      return;
    }
    const key = this.key(input, id);
    if (old?.key === key) {
      try {old.execution.check(); return;} catch { /* A stopped turn receives a newly admitted capability. */ }
    }
    if (old) {await this.#core.procs.protection.release(id); this.#installed.delete(id);}
    if (!old && this.#core.procs.protection.policy(id)) await this.#core.procs.protection.release(id);
    if (!old && this.#core.procs.liveCount(id)) await this.#core.procs.stopAndWait(id);
    // Host worktree Git can exit before its untraced Windows console leaves
    // the job. Drain it before the capability's idle-process admission gate.
    await this.#core.procs.waitForExit(id, undefined, {native: true});
    const changed = old?.changed ?? new Map<string, string | null>();
    const check = () => {
      this.#core.sharedCompute.assertTurn(id);
      const current = this.#input(id);
      if (!current || this.key(current, id) !== key) throw refused('execution.scope: captured host selection, claim, grant or read exception changed');
    };
    await this.#core.procs.protection.install(id, input, check);
    const execution = protectedTools(this.#core.procs, id, check, paths => {
      for (const path of paths) changed.set(path, existsSync(join(input.checkout, path)) ? policyFile(input.checkout, path).identity : null);
    }, async message => {
      execution.check();
      const binding = this.#binding(id);
      if (!binding?.compute || this.#core.procs.liveCount(id)) throw refused('execution.commit: requires an idle captured shared job');
      const git = (...args: string[]) => computeGit(this.#core, id, input.checkout, args);
      const worktree = this.#core.delegation.worktrees.get(id);
      if (!worktree || await git('symbolic-ref', '--short', 'HEAD') !== worktree.branch) throw refused('execution.commit: captured branch changed');
      const validate = () => {
        execution.check();
        for (const [path, identity] of changed) {
          if (identity === null ? existsSync(join(input.checkout, path)) : policyFile(input.checkout, path).identity !== identity) throw refused('execution.commit: validated output changed before commit');
        }
      };
      validate();
      await git('diff', '--cached', '--quiet', '--no-ext-diff', '--no-textconv');
      const paths = changed.size ? await computeChangedFiles(this.#core, id, input.checkout, [...changed.keys()]) : [];
      if (paths.length) {
        await git('--literal-pathspecs', 'add', '-A', '--', ...paths);
        validate();
        await git('-c', 'commit.gpgsign=false', 'commit', '-m', message);
        changed.clear();
      }
      return git('rev-parse', '--verify', 'HEAD^{commit}');
    }, this.#core.threads.require(id).contextMode?.tools == null);
    this.#installed.set(id, {key, execution, changed});
  }
  /** Synchronous durable changes close admission before asynchronous process cleanup. */
  reconcile(): void {
    for (const [id, entry] of this.#installed) {
      try {entry.execution.check();} catch {void this.#core.procs.protection.revoke(id).catch(() => {});}
    }
  }
}
