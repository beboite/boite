export interface SpawnOptions {
  /** Bounded normal-priority initialization, ended explicitly when the agent is ready. */
  startup?: boolean;
  /** Direct spawns are agent roots unless the caller identifies a tool process. */
  agentRoot?: boolean;
  cwd?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  /**
   * `spawn` only: this many more pipes, the child's descriptors 3, 4 and on,
   * whose ends this process holds in `fds`. The agent browser speaks the
   * DevTools protocol over two of them instead of a port anyone could reach.
   */
  extraPipes?: number;
  /**
   * `spawn` only: let the child show its windows; Windows applies `windowsHide`
   * to a GUI program's first window too. The focus and audio guards then leave
   * the thread's processes, its job's included, alone: they are the user's app.
   */
  showWindow?: boolean;
}
