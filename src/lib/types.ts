export interface Project {
  id: string;
  name: string;
  cwd: string;
  icon: string | null;
}

export type ThreadStatus =
  | "idle"
  | "running"
  | "ready"
  | "done"
  | "exited"
  | "error";

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
}

export type View = "terminal" | "settings";
