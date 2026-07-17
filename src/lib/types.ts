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
  sessionId: string | null;
  status: ThreadStatus;
  exitCode: number | null;
  createdAt: number;
  autoSlept?: boolean;
  keepAwake?: boolean;
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
  | "terminal"
  | null;

export interface Shortcut {
  id: string;
  label: string;
  command: string;
  iconKey?: IconKey;
}

export interface Settings {
  shortcuts: Shortcut[];
  powershellNewline: boolean;
  powershellNoProfile: boolean;
  defaultShellId: string | null;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  uiScalePercent: number;
  projectOrder: string[];
  threadOrderByProject: Record<string, string[]>;
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
}

// Animation preference: "system" follows prefers-reduced-motion, "on"/"off"
// override the OS either way.
export type MotionMode = "system" | "on" | "off";

export type RightPanelTab = "git" | "explorer" | null;

export type View = "terminal" | "settings" | "editor";

// Bottom-bar destinations in the phone layout. Independent of `View`: the
// terminal/editor/settings desktop views still drive the shared viewport and
// overlays, while `MobileTab` decides which page the bottom bar shows.
export type MobileTab = "files" | "git" | "terminal" | "projects" | "settings";
