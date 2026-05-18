export interface Project {
  id: string;
  name: string;
  cwd: string;
  icon: string | null;
  archived: boolean;
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
}

export type IconKey =
  | "claude"
  | "codex"
  | "gemini"
  | "cursor"
  | "copilot"
  | "opencode"
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
}

export type RightPanelTab = "git" | "explorer" | null;

export type View = "terminal" | "settings" | "editor";
