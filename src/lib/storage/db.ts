import Database from "@tauri-apps/plugin-sql";
import type { Project, Settings, Thread } from "$lib/types";

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
    "SELECT id, name, cwd, icon, created_at FROM projects ORDER BY created_at ASC",
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    cwd: r.cwd,
    icon: r.icon,
  }));
}

export async function saveProject(project: Project): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT OR REPLACE INTO projects (id, name, cwd, default_cmd, default_args, icon, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [project.id, project.name, project.cwd, "", "[]", project.icon, Date.now()],
  );
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
  created_at: number;
}

export async function loadThreads(): Promise<Thread[]> {
  const db = await getDb();
  const rows = await db.select<ThreadRow[]>(
    "SELECT id, project_id, label, title, cmd, args, exit_code, session_id, icon_key, created_at FROM threads ORDER BY created_at ASC",
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
    status: "idle",
    exitCode: r.exit_code,
    createdAt: r.created_at,
  }));
}

export async function saveThread(thread: Thread): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT OR REPLACE INTO threads (id, project_id, label, title, cmd, args, exit_code, session_id, icon_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
