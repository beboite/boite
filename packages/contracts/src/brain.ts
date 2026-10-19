/** A brain lives on the core's machine. Detected plugins are not installed by Boite. */
export interface BrainConfig {
  path: string | null;
  enabled: boolean;
  /** Pull only. An interval of 0 disables periodic pulls. Defaults to off. */
  autoPull?: { onStartup: boolean; intervalMinutes: number };
  /** Link the root AGENTS.md into user-level harness profiles on this machine. */
  globalInstructions?: boolean;
  /** Inject Boite's guide once per agent session, even without a brain. Defaults to on. */
  boiteGuide?: boolean;
}

export interface BrainLink {
  name: string;
  path: string;
  state: 'linked' | 'existing' | 'blocked';
  error: string | null;
}

export interface BrainEntry {
  kind: 'instructions' | 'skill' | 'plugin';
  path: string;
  name: string;
  description: string;
  error: string | null;
}

export interface BrainStatus {
  config: BrainConfig;
  entries: BrainEntry[];
  problems: string[];
  git: { branch: string | null; upstream: string | null; ahead: number; behind: number; dirty: boolean } | null;
  lastSync: number | null;
  links?: BrainLink[];
}

export interface BrainRpcMethods {
  'brain.status': { params: Record<string, never>; result: BrainStatus };
  'brain.configure': { params: BrainConfig; result: BrainStatus };
  /** Fetch, fast-forward and push existing commits. Never stage, stash, reset or force. */
  'brain.sync': { params: Record<string, never>; result: BrainStatus };
}

export interface BrainRpcEvents {
  /** Portable brain switches changed. The folder stays on its host. */
  'brain.configured': BrainConfig;
}
