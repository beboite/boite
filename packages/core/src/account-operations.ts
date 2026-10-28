import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountId, ProviderId, ThreadId } from '@boite/contracts';
import type { Core } from './core.ts';
import type { ProbeContext } from './drivers/types.ts';
import { messageOf, refused } from './errors.ts';
import { removeDir } from './fs-retry.ts';

/** After an operation's processes stop, a descendant that outlived them may hold their pipes: cleanup waits this long, no longer. */
const CLOSE_GRACE_MS = 1000;

/** One account-scoped operation in flight, as its account sees it. */
export interface AccountOperation {
  /** The synthetic thread its processes are traced and stopped under. */
  readonly owner: ThreadId;
  /** An empty directory of its own, made on the first call and removed when the operation closes. */
  scratch(prefix: string): string;
  /** Starts a process under `owner` while the account still admits work, holding the provider's install lease until it exits. */
  spawnChild: ProbeContext['spawnChild'];
  killTree(): void;
  /**
   * Stops what still runs under `owner`, waits for it, then for its pipes
   * (bounded) and removes `scratch`. Idempotent and never rejects, so the
   * read it served can answer; a stop that failed keeps the operation open
   * for the account, whose removal then refuses.
   */
  close(): Promise<void>;
}

interface Open {
  owner: ThreadId;
  closed: Promise<void>;
  /** Why its processes could not be stopped, when they could not: the account is not drained. */
  failure: unknown;
}

/**
 * Every process an account runs outside a turn and a login: the connection
 * check, model discovery, quota reads and resets. One owner admits them, so
 * that removing the account can close admission, stop each one and wait for
 * it before the directory and the credentials go. A new kind of account work
 * opens an operation here; removal then covers it without a list to keep.
 */
export class AccountOperations {
  readonly #open = new Map<AccountId, Set<Open>>();

  constructor(private readonly core: Core) {}

  /**
   * Opens an operation for the account under the process owner `owner`. It
   * refuses an account that is unknown or being removed, and each spawn checks
   * that again, so work that awaited something meanwhile starts nothing.
   */
  open(accountId: AccountId, providerId: ProviderId, owner: ThreadId, log: (message: string) => void): AccountOperation {
    this.core.accounts.require(accountId);
    const { core } = this;
    let scratch: string | null = null;
    const exits: Promise<void>[] = [];
    let resolveClosed!: () => void;
    const entry: Open = { owner, closed: new Promise<void>((resolve) => { resolveClosed = resolve; }), failure: null };
    const set = this.#open.get(accountId) ?? new Set<Open>();
    set.add(entry);
    this.#open.set(accountId, set);
    let closing: Promise<void> | null = null;
    const close = async (): Promise<void> => {
      try {
        await core.procs.stopAndWait(owner).catch((error: unknown) => {
          entry.failure = error;
          log(messageOf(error));
        });
        // Only once its processes stopped: a descendant that outlived them may hold the pipes, and is not waited for.
        if (entry.failure === null) await bounded(Promise.all(exits), () => log(`process pipes did not close within ${CLOSE_GRACE_MS} ms`));
        if (scratch !== null) await removeDir(scratch, log);
      } finally {
        if (entry.failure === null) this.#forget(accountId, entry);
        resolveClosed();
      }
    };
    return {
      owner,
      scratch: (prefix) => (scratch ??= mkdtempSync(join(tmpdir(), prefix))),
      spawnChild: (cmd, args, opts) => {
        core.accounts.require(accountId);
        if (closing !== null) throw new Error(`${owner} is closing`);
        const child = core.procs.spawnChild(owner, cmd, args, opts);
        exits.push(new Promise<void>((resolve) => {
          child.once('close', () => resolve());
          child.once('error', () => resolve());
        }));
        // The child runs the executable a turn would: a managed install under it stays.
        const installs = core.providers.installs;
        installs.acquire(providerId);
        let released = false;
        const drop = (): void => {
          if (released) return;
          released = true;
          installs.release(providerId);
        };
        child.once('exit', drop);
        child.once('error', drop);
        return child;
      },
      killTree: () => { core.procs.killTree(owner); },
      close: () => (closing ??= close()),
    };
  }

  /**
   * Stops every operation of the account and waits until each has closed. The
   * caller has already closed admission (`accounts.require` refuses), so the
   * work that notices its process died cannot start another. An operation
   * whose processes could not be stopped is asked again; if they still do not
   * stop, the account is not drained and this refuses, naming them.
   */
  async drain(accountId: AccountId): Promise<void> {
    const open = [...(this.#open.get(accountId) ?? [])];
    for (const entry of open) this.core.procs.killTree(entry.owner);
    await Promise.all(open.map((entry) => entry.closed));
    for (const entry of open) {
      if (entry.failure === null) continue;
      try {
        await this.core.procs.stopAndWait(entry.owner);
        entry.failure = null;
        this.#forget(accountId, entry);
      } catch (error) {
        entry.failure = error;
        throw refused(`processes of ${entry.owner} did not stop (${messageOf(error)}); the account stays until they do`, { accountId, owner: entry.owner });
      }
    }
  }

  #forget(accountId: AccountId, entry: Open): void {
    const set = this.#open.get(accountId);
    if (set === undefined) return;
    set.delete(entry);
    if (set.size === 0) this.#open.delete(accountId);
  }
}

async function bounded(work: Promise<unknown>, late: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(() => { late(); resolve(); }, CLOSE_GRACE_MS); })]);
  } finally {
    clearTimeout(timer);
  }
}
