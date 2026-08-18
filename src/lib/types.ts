import type { Keybinding } from "$lib/shared/keyboard/types";

export type { Keybinding };

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

/** A thread is either the user's own or one an agent spawned to work for it. */
export type DelegationMode = "normal" | "delegation";

/** Where a delegation is in its life: queued, working, done, or broken. */
export type DelegationStatus = "pending" | "running" | "completed" | "failed";

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
  /**
   * When this thread was put away as finished, or null while it is live.
   *
   * Server-side rather than in this device's localStorage: a phone and a laptop
   * showing two different sidebars for the same boite is the list disagreeing
   * with itself. A timestamp rather than a flag, so "put away in March" is
   * answerable without a second column.
   */
  settledAt?: number | null;
  /** Parent thread ID when spawned as a delegation. */
  parentThreadId?: string | null;
  /** Whether this is a normal thread or a delegation sub-thread. */
  delegationMode?: DelegationMode;
  /** Lifecycle status for delegation threads. */
  delegationStatus?: DelegationStatus | null;
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
  | "pi"
  | "muse"
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
  /**
   * Global keyboard rules, `{key, command, when}`, last match winning.
   *
   * They live in this blob rather than in a `keybindings.json` beside the app
   * because the blob is the one store both front doors already read, so a phone
   * on the PWA gets the same keyboard as the desktop and no new bus capability
   * is needed to carry it.
   */
  keybindings: Keybinding[];
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
  /**
   * True once the user has picked a layout themselves.
   *
   * `mobileLayout` used to be guessed once on first run and written straight to
   * localStorage, which made the guess indistinguishable from a choice. A
   * coarse-pointer tablet wider than the threshold was then stuck on the PC
   * layout for good, with no soft-keyboard button, no CLI key bar and the IME
   * handling that exists to dodge the Gboard duplication bug switched off. While
   * this is false the layout keeps following the form factor.
   */
  layoutPinned: boolean;
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
  /**
   * Answer yes for the user on the MCP calls that would otherwise wait for
   * them: moving a terminal into another project, creating one, opening a
   * terminal somewhere else.
   *
   * Off by default, and read by the endpoint out of this blob on every call
   * rather than at launch, so turning it off stops the next request instead of
   * the next session. What it does not change is the record: the request is
   * still opened and still journalled, it is just answered without anybody
   * being asked.
   */
  mcpYolo: boolean;
  idleTimeoutMinutes: number;
  idleAutocloseByIcon: Record<string, boolean>;
  confirmCloseThread: boolean;
  /**
   * Which of git, files and todo the side panel is showing, or null when it is
   * closed.
   *
   * These three describe the project you are on rather than a document you are
   * working in, so they share one column and one width instead of each taking
   * a slice of the layout: picking a tab changes what the panel holds and never
   * where anything is. A panel that has to sit beside one particular terminal
   * is detached into a pane from the panel's own header, which is the case the
   * column cannot serve.
   *
   * This field is the last choice made, and it answers for a project that has
   * never been on screen and for being on no project at all. What a project
   * remembers is in `rightPanelByProject`.
   */
  rightPanel: RightPanelTab;
  /**
   * What each project had open, keyed by project id.
   *
   * One column for the whole window meant a repository with nothing to commit
   * still opened on git because the last project had, and closing it there lost
   * it for the project that wanted it. The panels describe a project, so which
   * one is up is the project's own answer.
   */
  rightPanelByProject: Record<string, RightPanelTab>;
  rightPanelWidth: number;
  gitSplitFraction: number;
  gitAutoFetch: boolean;
  gitAutoFetchSeconds: number;
  mobileLayout: boolean;
  motionMode: MotionMode;
  themeMode: ThemeMode;
  /**
   * The family each surface is set in, or null for the stack the app ships.
   *
   * One family name, never a stack: `theme/fonts.ts` rebuilds the stack around
   * it, so a machine that later loses the chosen face falls through to what the
   * app ships today rather than to what it shipped the day the row was written.
   */
  uiFontFamily: string | null;
  terminalFontFamily: string | null;
  /**
   * How much bigger the terminals are than the rest of the app, in percent.
   *
   * Rides on top of the UI scale rather than replacing it: growing an agent's
   * output without growing every box around it is the one thing the zoom slider
   * cannot do, since it is a root font size and a canvas inherits no rem.
   */
  terminalFontScalePercent: number;
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
  /**
   * Which of the two sidebar designs the thread rows are drawn in.
   *
   * They answer the same question in opposite registers, so this is a choice
   * rather than a feature flag. `classic` rings the agent's logo, which is
   * legible once you look at it and silent at rest. `signal` puts the state on a
   * 2px rail down the card's left edge and sweeps it while an agent is working,
   * which is catchable out of the corner of an eye and stays out of the row's
   * own space. `features/thread/threadVisual.ts` decides what either draws.
   */
  sidebarDesign: SidebarDesign;
  /**
   * Whether the agent's own logo is drawn on the row at all.
   *
   * Off, the glyph carries a mark for what the thread is doing instead — one per
   * state, never an empty slot — and hovering the row brings the logo back. The
   * classic design has one thing to put in the glyph and ignores this.
   */
  sidebarHarnessLogos: boolean;
  /**
   * Experiment: replace the side panel's three tabs with one anchored info box
   * over the terminals: current branch, the todo an agent claimed, the last
   * commit, and up to ten of them on hover. Off draws the classic column.
   */
  experimentInfoBox: boolean;
  /**
   * Where that box sits on every terminal. One value for the window, not per
   * thread: a drag on any pane is the next pane's position too.
   */
  infoBoxAnchor: InfoBoxAnchor;
  /**
   * Whether the box is folded to its header. Same scope as the anchor.
   */
  infoBoxCollapsed: boolean;
  /**
   * Experiment: let the sidebar order itself instead of following the dragged
   * order. Arming it moves nothing on its own — `smartSortBy` starts at
   * `manual`, so the rows hold still until an order is actually picked.
   */
  experimentSmartSort: boolean;
  /**
   * Experiment: a whip over the whole window, thrown from a titlebar button.
   * Purely cosmetic — it cracks, it makes a noise, and it reaches no terminal:
   * no interrupt, no keystroke, no prompt.
   */
  experimentWhip: boolean;
  /**
   * Which noise the whip makes. Only read while `experimentWhip` is on, and
   * `synth` is the default: the sample is a file the window downloads, and it
   * only downloads once somebody has actually asked for it.
   */
  whipSound: WhipSound;
  smartSortBy: SmartSortBy;
  smartSortDirection: SortDirection;
}

/**
 * What the smart-sort experiment orders the sidebar by.
 *
 * `manual` is the dragged order and the state the toggle arms into. `activity`
 * follows the threads: a project ranks by its most recently active one, and the
 * threads inside it rank the same way. `alphabetical` reads the project names
 * and leaves each project's threads where the user dragged them.
 */
export type SmartSortBy = "manual" | "activity" | "alphabetical";

/**
 * What the whip cracks with.
 *
 * `synth` is the WebAudio burst `crack.ts` builds, which costs no asset and
 * varies on its own. `sampled` is six cracks in `static/sounds/whip-cracks.mp3`,
 * fetched on the first crack after it is picked and never before: a mode nobody
 * selects costs the same nothing it did before this existed. `meme` is the
 * name a row written before the sprite still carries; it plays the same file.
 */
export type WhipSound = "synth" | "sampled" | "meme";

export type SortDirection = "asc" | "desc";

/**
 * The eight docks the info box can snap to: four corners and the midpoint of
 * each edge. Mid-top and mid-bottom are `top-center` / `bottom-center`.
 */
export type InfoBoxAnchor =
  | "top-left"
  | "top-center"
  | "top-right"
  | "mid-left"
  | "mid-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

/**
 * The sidebar's two thread-row designs.
 *
 * A string rather than the `sidebarThreadGlow` boolean it replaces: the boolean
 * was named after one design's decoration, so a third design or a renamed second
 * one could not be spelled at all. `SettingsStore` migrates the old key.
 */
export type SidebarDesign = "classic" | "glow";

// Animation preference: "system" follows prefers-reduced-motion, "on"/"off"
// override the OS either way.
export type MotionMode = "system" | "on" | "off";

/**
 * A palette the window can actually draw in.
 *
 * The two acrylics are a scheme plus an OS material, not a third and fourth
 * tone: `acrylic-black` is the dark ramp made translucent, `acrylic-white` the
 * light one. `theme/themes.ts` is the registry, `app.css` holds what each id
 * paints, and neither is allowed to know an id the other does not.
 */
export type ThemeId =
  | "dark"
  | "light"
  | "midnight"
  | "acrylic-black"
  | "acrylic-white";

/**
 * What the user picked, which is one more thing than a palette: "system"
 * follows prefers-color-scheme and every other value overrides the OS.
 *
 * A palette rather than a boolean, for the same reason `SidebarDesign` is:
 * a `darkMode: boolean` cannot spell "follow the OS" and cannot be extended to
 * a third palette without renaming every call site. `theme/appearance.ts`
 * resolves it.
 */
export type ThemeMode = "system" | ThemeId;

/**
 * Which tab the side panel is on, or null when it is closed.
 *
 * The same three names as `PanelKind` in the pane tree, and deliberately so: a
 * panel is the same panel whether it is docked in the column or detached into a
 * pane, and the detach button hands one straight to the other.
 */
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
export type MobileTab =
  | "files"
  | "git"
  | "terminal"
  | "todo"
  | "projects"
  | "settings";
