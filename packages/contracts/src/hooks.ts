import type { AccountId, ProviderId, ThreadId, Timestamp } from './ids';
import type { ProviderHookSource } from './providers';

/**
 * What one hook run came to. `skipped` is a hook the agent has but will not
 * run, Codex's untrusted or modified ones.
 */
export type HookOutcome = 'ok' | 'blocked' | 'failed' | 'stopped' | 'skipped';

/** One hook run that did not simply pass. The core keeps the newest ones in memory, since it started. */
export interface HookRun {
  at: Timestamp;
  providerId: ProviderId;
  accountId: AccountId | null;
  threadId: ThreadId | null;
  /** The agent's own name for the event: `PreToolUse`, `userPromptSubmit`. */
  event: string;
  /** What the agent calls the hook, `PreToolUse:Bash`, or the file it comes from. */
  name: string;
  outcome: Exclude<HookOutcome, 'ok'>;
  /** What the hook or the agent said about it, at most 500 characters. */
  message: string | null;
}

/** One place the agent reads the user's hooks from, as Settings shows it. */
export interface HookSourceState {
  /** The path read, the home directory written `~`. */
  path: string;
  format: ProviderHookSource['format'];
  /** Hooks (`events`) or modules (`modules`) found there. Null when the path does not exist. */
  count: number | null;
  /** Why it could not be read, null when it was. */
  error: string | null;
}

/** An account with a directory of its own, and what it does not get from the provider's own profile. */
export interface HookShareState {
  accountId: AccountId;
  label: string;
  problems: { path: string; message: string }[];
}

export interface ProviderHooks {
  providerId: ProviderId;
  name: string;
  /** `capabilities.hooks`: the agent runs the hooks the user configured for it. */
  runsHooks: boolean;
  /** Boite sees each run (Claude, Codex); for the others only the configuration is known. */
  reports: boolean;
  sources: HookSourceState[];
  accounts: HookShareState[];
  /** Since `HooksStatus.since`. */
  runs: number;
  blocked: number;
  failed: number;
  skipped: number;
}

export interface HooksStatus {
  /** When this core started counting. */
  since: Timestamp;
  /** Every provider available on this core's machine. */
  providers: ProviderHooks[];
  /** Newest first, at most 50. */
  recent: HookRun[];
}

export interface HooksRpcMethods {
  /** Where each agent reads the user's hooks, what separate accounts miss of them, and the runs that did not pass. */
  'hooks.status': { params: Record<string, never>; result: HooksStatus };
}

export interface HooksRpcEvents {
  /** A hook blocked, failed, stopped a turn or was skipped: `hooks.status` has it. Runs that passed only count. */
  'hooks.changed': { at: Timestamp };
}
