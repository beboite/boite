import Database from "@tauri-apps/plugin-sql";
import type { Project } from "./store.svelte";
import type { Settings } from "./settings.svelte";

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
  default_cmd: string;
  default_args: string;
  icon: string | null;
  created_at: number;
}

export async function loadProjects(): Promise<Project[]> {
  const db = await getDb();
  const rows = await db.select<ProjectRow[]>(
    "SELECT id, name, cwd, default_cmd, default_args, icon, created_at FROM projects ORDER BY created_at ASC",
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    cwd: r.cwd,
    defaultCmd: r.default_cmd,
    defaultArgs: JSON.parse(r.default_args) as string[],
    icon: r.icon,
  }));
}

export async function saveProject(project: Project): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT OR REPLACE INTO projects (id, name, cwd, default_cmd, default_args, icon, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      project.id,
      project.name,
      project.cwd,
      project.defaultCmd,
      JSON.stringify(project.defaultArgs),
      project.icon,
      Date.now(),
    ],
  );
}

export async function deleteProject(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM projects WHERE id = ?", [id]);
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
