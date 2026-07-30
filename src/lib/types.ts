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
  /**
   * Whether a new agent thread here opens its own detached worktree.
   *
   * Undefined or null follows `settings.threadWorktrees`, which is what every
   * project did before this existed. Only a project the user has had an opinion
   * about carries a boolean, so moving the app-wide default still moves the
   * ones nobody has touched.
   */
  worktrees?: boolean | null;
  origin?: WorkspaceOrigin;
}

export type ThreadStatus =
  | "idle"
  | "running"
  // Blocked on the user: a permission prompt, a plan to approve, any dialog the
  // agent put up. Deliberately not `ready`, which means the agent has nothing
  // left to do. This one has a turn in flight that only an answer will finish,
  // so it never auto-sleeps and it is worth a notification. Only claude declares
  // it, through its session registry.
  | "waiting"
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
   * all in the project folder. On by default: the heavy directories
   * (`node_modules`, `target`, …) are linked to the main checkout rather than
   * rebuilt, so a worktree costs its source tree and nothing else.
   */
  threadWorktrees: boolean;
  defaultShellId: string | null;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  uiScalePercent: number;
  projectOrder: string[];
  threadOrderByProject: Record<string, string[]>;
  /**
   * Scaffold wrapped around a todo before it reaches an agent. `{{id}}`,
   * `{{title}}`, `{{description}}` and `{{task}}` are substituted; the id is
   * what lets the agent report back through the MCP endpoint. `{{task}}`
   * predates the split and carries the title and the description together, so
   * a template written before there were two fields still hands over both.
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
  /**
   * Whether the fastpick menu is offered in the shortcut bar. Off hides it whatever the
   * machine has installed; on still hides it when fastpick is not there, since a menu whose
   * every entry fails is worse than no menu.
   */
  fastpickEnabled: boolean;
  /**
   * Tint a thread's agent icon with what is actually answering it. A fastpick thread keeps
   * the agent's own glyph, so without this nothing on screen tells a stock Claude apart
   * from a Claude pointed at another endpoint.
   */
  colorByModel: boolean;
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

/** One card of the per-project notepad. */
export interface TodoItem {
  id: string;
  projectId: string;
  /**
   * The one line the list shows. Stored in the `text` column, which is what it
   * was called back when a row held nothing else.
   */
  title: string;
  /**
   * Everything the title could not hold, read by opening the card. Null rather
   * than an empty string when there is none: the collapsed row wears a marker
   * for any card that has a body, and `""` would put one on a card with
   * nothing behind it.
   */
  description: string | null;
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

export type View = "terminal" | "settings" | "editor" | "project";

// Bottom-bar destinations in the phone layout. Independent of `View`: the
// terminal/editor/settings desktop views still drive the shared viewport and
// overlays, while `MobileTab` decides which page the bottom bar shows.
export type MobileTab = "files" | "git" | "terminal" | "projects" | "settings";
