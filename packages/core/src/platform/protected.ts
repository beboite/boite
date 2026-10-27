import type {ExecutionPolicy} from '../execution-policy.ts';

export interface ProtectedLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}
/** Helpers use the same process registry as tools, never an independent native launcher. */
export type ProtectionRunner = (command: string, args: string[], cwd: string, env?: Record<string, string | undefined>) => Promise<{code: number; stdout: string; stderr: string}>;

export interface NativeExecutionSession {
  launch(command: string, args: string[], cwd: string): ProtectedLaunch;
  /** Publish only validated project edits, after all namespace roots exited and authority was rechecked. */
  flush(): readonly string[] | void;
  close(): void | Promise<void>;
}

export interface NativeExecutionBoundary {
  available?(): boolean;
  /** Opens a private filesystem and verifies a real sandbox launch; failure never falls back. */
  open(policy: ExecutionPolicy, run: ProtectionRunner): Promise<NativeExecutionSession>;
}
