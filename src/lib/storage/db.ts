import Database from "@tauri-apps/plugin-sql";
import type { Project, Settings, Thread } from "$lib/types";
import { redactArgs } from "$lib/shared/utils/redact";

let dbPromise: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:boite.db");
  }
  return dbPromise;
}

interface ProjectRow {
  id: string;
  name: string;
  cwd: string;
  icon: string | null;
  archived: number;
  created_at: number;
}

function safeParseArgs(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export async function loadProjects(): Promise<Project[]> {
  const db = await getDb();
  const rows = await db.select<ProjectRow[]>(
    "SELECT id, name, cwd, icon, archived, created_at FROM projects ORDER BY created_at ASC",
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    cwd: r.cwd,
    icon: r.icon,
    archived: r.archived === 1,
  }));
}

export async function saveProject(project: Project): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT OR REPLACE INTO projects (id, name, cwd, default_cmd, default_args, icon, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      project.id,
      project.name,
      project.cwd,
      "",
      "[]",
      project.icon,
      project.archived ? 1 : 0,
      Date.now(),
    ],
  );
}

export async function setProjectArchived(id: string, archived: boolean): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE projects SET archived = ? WHERE id = ?", [
    archived ? 1 : 0,
    id,
  ]);
}

export async function deleteProject(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM projects WHERE id = ?", [id]);
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
  auto_slept: number | null;
  created_at: number;
}

const TERMINAL_STATUSES: Thread["status"][] = ["done", "exited", "error", "stopped"];

function normalizeStatus(raw: string | null): Thread["status"] {
  if (!raw) return "idle";
  if ((TERMINAL_STATUSES as string[]).includes(raw)) return raw as Thread["status"];
  return "idle";
}

export async function loadThreads(): Promise<Thread[]> {
  const db = await getDb();
  const rows = await db.select<ThreadRow[]>(
    "SELECT id, project_id, label, title, cmd, args, exit_code, session_id, icon_key, status, auto_slept, created_at FROM threads ORDER BY created_at ASC",
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
    autoSlept: r.auto_slept === 1,
  }));
}

export async function saveThread(thread: Thread): Promise<void> {
  const db = await getDb();
  const { args: safeArgs, redacted } = redactArgs(thread.args);
  if (redacted) {
    console.warn(
      `[boite] redacted secret-looking args for thread ${thread.id} (${thread.label}) before persisting`,
    );
  }
  await db.execute(
    "INSERT OR REPLACE INTO threads (id, project_id, label, title, cmd, args, exit_code, session_id, icon_key, status, auto_slept, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      thread.id,
      thread.projectId,
      thread.label,
      thread.title,
      thread.cmd,
      JSON.stringify(safeArgs),
      thread.exitCode,
      thread.sessionId,
      thread.iconKey,
      thread.status,
      thread.autoSlept ? 1 : 0,
      thread.createdAt,
    ],
  );
}

export async function deleteThread(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM threads WHERE id = ?", [id]);
}

interface SettingsRow {
  value: string;
}

export async function loadSettings(): Promise<Partial<Settings>> {
  const db = await getDb();
  const rows = await db.select<SettingsRow[]>(
    "SELECT value FROM settings WHERE key = ?",
    ["main"],
  );
  if (rows.length === 0) return {};
  try {
    return JSON.parse(rows[0].value) as Partial<Settings>;
  } catch {
    return {};
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    ["main", JSON.stringify(settings)],
  );
}
