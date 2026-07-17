import Database from "@tauri-apps/plugin-sql";
import type { Project, Settings, Thread } from "$lib/types";
import type { DbApi } from "../types";

let db: Database | null = null;

// The DB is preloaded Rust-side (plugins.sql.preload in tauri.conf.json), so
// the webview never needs the sql:allow-load permission — `load` could open
// or create SQLite files anywhere on disk.
function getDb(): Database {
  if (!db) {
    db = Database.get("sqlite:boite.db");
  }
  return db;
}

interface ProjectRow {
  id: string;
  name: string;
  cwd: string;
  icon: string | null;
  archived: number;
  git_root: string | null;
  created_at: number;
}

interface ThreadRow {
  id: string;
  project_id: string;
  label: string;
  title: string | null;
  cmd: string;
  args: string;
  exit_code: number | null;
  session_id: string | null;
  icon_key: string | null;
  status: string | null;
  keep_awake: number;
  created_at: number;
}

interface SettingsRow {
  value: string;
}

function safeParseArgs(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

const TERMINAL_STATUSES: Thread["status"][] = ["done", "exited", "error", "stopped"];

function normalizeStatus(raw: string | null): Thread["status"] {
  if (!raw) return "idle";
  if ((TERMINAL_STATUSES as string[]).includes(raw)) return raw as Thread["status"];
  return "idle";
}

export const tauriDb: DbApi = {
  async loadProjects(): Promise<Project[]> {
    const rows = await getDb().select<ProjectRow[]>(
      "SELECT id, name, cwd, icon, archived, git_root, created_at FROM projects ORDER BY created_at ASC",
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      cwd: r.cwd,
      icon: r.icon,
      archived: r.archived === 1,
      gitRoot: r.git_root,
    }));
  },

  async saveProject(project: Project): Promise<void> {
    await getDb().execute(
      "INSERT OR REPLACE INTO projects (id, name, cwd, default_cmd, default_args, icon, archived, git_root, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        project.id,
        project.name,
        project.cwd,
        "",
        "[]",
        project.icon,
        project.archived ? 1 : 0,
        project.gitRoot ?? null,
        Date.now(),
      ],
    );
  },

  async setProjectArchived(id: string, archived: boolean): Promise<void> {
    await getDb().execute("UPDATE projects SET archived = ? WHERE id = ?", [
      archived ? 1 : 0,
      id,
    ]);
  },

  async deleteProject(id: string): Promise<void> {
    await getDb().execute("DELETE FROM projects WHERE id = ?", [id]);
  },

  async loadThreads(): Promise<Thread[]> {
    const rows = await getDb().select<ThreadRow[]>(
      "SELECT id, project_id, label, title, cmd, args, exit_code, session_id, icon_key, status, keep_awake, created_at FROM threads ORDER BY created_at ASC",
    );
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      ptyId: null,
      label: r.label,
      title: r.title,
      cmd: r.cmd,
      args: safeParseArgs(r.args),
      iconKey: (r.icon_key ?? null) as Thread["iconKey"],
      sessionId: r.session_id,
      status: normalizeStatus(r.status),
      exitCode: r.exit_code,
      createdAt: r.created_at,
      autoSlept: false,
      keepAwake: r.keep_awake === 1,
    }));
  },

  async saveThread(thread: Thread): Promise<void> {
    await getDb().execute(
      "INSERT OR REPLACE INTO threads (id, project_id, label, title, cmd, args, exit_code, session_id, icon_key, status, keep_awake, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        thread.id,
        thread.projectId,
        thread.label,
        thread.title,
        thread.cmd,
        JSON.stringify(thread.args),
        thread.exitCode,
        thread.sessionId,
        thread.iconKey,
        thread.status,
        thread.keepAwake ? 1 : 0,
        thread.createdAt,
      ],
    );
  },

  // Column-targeted on purpose: title bursts are flushed on a delay, and a
  // whole-row REPLACE built from a stale snapshot would overwrite concurrent
  // writes (sessionId capture, keepAwake, exit status) with old values.
  async updateThreadTitle(id: string, title: string | null): Promise<void> {
    await getDb().execute("UPDATE threads SET title = ? WHERE id = ?", [title, id]);
  },

  async deleteThread(id: string): Promise<void> {
    await getDb().execute("DELETE FROM threads WHERE id = ?", [id]);
  },

  async loadSettings(): Promise<Partial<Settings>> {
    const rows = await getDb().select<SettingsRow[]>(
      "SELECT value FROM settings WHERE key = ?",
      ["main"],
    );
    if (rows.length === 0) return {};
    try {
      return JSON.parse(rows[0].value) as Partial<Settings>;
    } catch {
      return {};
    }
  },

  async saveSettings(settings: Settings): Promise<void> {
    await getDb().execute(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      ["main", JSON.stringify(settings)],
    );
  },
};
