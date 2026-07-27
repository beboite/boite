// Which transport owns an entity in dynamic mode: the local desktop backend or
// the connected boite. Runtime-only tag — never persisted (each store only
// holds its own rows) and stripped before any RPC. Undefined outside dynamic
// mode, where a single backend owns everything.
export type WorkspaceOrigin = "local" | "remote";

export interface Project {
  id: string;
  name: string;
  cwd: string;
  icon: string | null;
  archived: boolean;
  // Nested repo the git panel operates on when cwd itself is not a repo
  // (parent folder opened, actual repos live one level down). Null = cwd.
  gitRoot?: string | null;
  origin?: WorkspaceOrigin;
}

export type ThreadStatus =
  | "idle"
  | "running"
  | "ready"
  | "done"
  | "exited"
  | "error"
  | "stopped";

export interface Thread {
  id: string;
  projectId: string;
  ptyId: string | null;
  label: string;
  title: string | null;
  cmd: string;
  args: string[];
  iconKey: IconKey;
  /** Hex color (`#rrggbb`) inherited from the shortcut that launched it. */
  iconColor?: string | null;
  sessionId: string | null;
  status: ThreadStatus;
  exitCode: number | null;
  createdAt: number;
  autoSlept?: boolean;
  keepAwake?: boolean;
  // Directory this thread actually lives in, when it is not the project's own.
  // A process lives in a folder, a project does not, so the git panel, the
  // explorer, the PTY and the Claude session lookup all resolve through
  // `threadCwd()` rather than reading `project.cwd` directly.
  worktreePath?: string | null;
  origin?: WorkspaceOrigin;
}

export type IconKey =
  | "claude"
  | "codex"
  | "antigravity"
  | "cursor"
  | "copilot"
  | "opencode"
  | "grok"
  | "hermes"
  | "bun"
  | "terminal"
  | null;

export interface Shortcut {
  id: string;
  label: string;
  command: string;
  iconKey?: IconKey;
  /** Hex color (`#rrggbb`) overriding the brand glyph's own color. */
  iconColor?: string | null;
}

export type LocaleSetting = "system" | "en" | "fr";

export interface Settings {
  shortcuts: Shortcut[];
  // Preset shortcut ids already backfilled once. Without this, deleting a
  // late-added preset would see it re-seeded on every launch.
  seededPresets: string[];
  powershellNewline: boolean;
  powershellNoProfile: boolean;
  /**
   * Give every agent thread its own detached worktree instead of running them
   * all in the project folder. Off by default: a fresh worktree has no
   * `node_modules` and no build cache, so it needs a setup step before an
   * agent can run the project's own tests in it.
   */
  threadWorktrees: boolean;
  defaultShellId: string | null;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  uiScalePercent: number;
  projectOrder: string[];
  threadOrderByProject: Record<string, string[]>;
  /**
   * Scaffold wrapped around a todo before it reaches an agent. `{{task}}` and
   * `{{id}}` are substituted; the id is what lets the agent report back through
   * the MCP endpoint.
   */
  todoPromptTemplate: string;
  /**
   * Whether Boite points the agents it launches at the todo endpoint. On by
   * default: the access is scoped to the launching thread's own project, and
   * the point of the panel is that an agent can use it.
   */
  agentTodoAccess: boolean;
  idleTimeoutMinutes: number;
  idleAutocloseByIcon: Record<string, boolean>;
  confirmCloseThread: boolean;
  rightPanel: RightPanelTab;
  rightPanelWidth: number;
  gitSplitFraction: number;
  gitAutoFetch: boolean;
  gitAutoFetchSeconds: number;
  mobileLayout: boolean;
  motionMode: MotionMode;
  locale: LocaleSetting;
  setupCompleted?: boolean;
}

// Animation preference: "system" follows prefers-reduced-motion, "on"/"off"
// override the OS either way.
export type MotionMode = "system" | "on" | "off";


export type RightPanelTab = "git" | "explorer" | "todo" | null;

/**
 * Where a todo stands. `claimed` exists because an agent that can tick its own
 * boxes will tick them: when one reports a task finished it lands here with its
 * summary, and only a human moves it to `done`. Without that split the list
 * would record what the model asserted rather than what was verified.
 */
export type TodoState = "open" | "claimed" | "done";

/** One line of the per-project notepad. */
export interface TodoItem {
  id: string;
  projectId: string;
  text: string;
  state: TodoState;
  /** What the agent said it did, set when it moves the item to `claimed`. */
  note: string | null;
  /**
   * The commit the agent says the work landed in. Stored as reported and never
   * trusted on its own: the panel resolves it against the repository, so a sha
   * git cannot find is shown as unknown rather than as done.
   */
  commitSha: string | null;
  /**
   * The agent that claimed it, as an icon key. Set only when Boite launched the
   * terminal it was claimed from — an agent wired through a credentials file
   * names a project and no thread, so it stays anonymous.
   */
  claimedBy: IconKey;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export type View = "terminal" | "settings" | "editor";

// Bottom-bar destinations in the phone layout. Independent of `View`: the
// terminal/editor/settings desktop views still drive the shared viewport and
// overlays, while `MobileTab` decides which page the bottom bar shows.
export type MobileTab = "files" | "git" | "terminal" | "projects" | "settings";
