import { backend } from "$lib/backend";
import type { Project, Settings, Thread } from "$lib/types";
import { redactArgs } from "$lib/shared/utils/redact";

export function loadProjects(): Promise<Project[]> {
  return backend().db.loadProjects();
}

export function saveProject(project: Project): Promise<void> {
  return backend().db.saveProject(project);
}

export function setProjectArchived(id: string, archived: boolean): Promise<void> {
  return backend().db.setProjectArchived(id, archived);
}

export function deleteProject(id: string): Promise<void> {
  return backend().db.deleteProject(id);
}

export function loadThreads(): Promise<Thread[]> {
  return backend().db.loadThreads();
}

// Redaction is transport-agnostic: scrub secret-looking args before they ever
// leave the client, whether they land in local SQLite or get shipped to a
// remote server.
export function saveThread(thread: Thread): Promise<void> {
  const { args, redacted } = redactArgs(thread.args);
  if (redacted) {
    console.warn(
      `[boite] redacted secret-looking args for thread ${thread.id} (${thread.label}) before persisting`,
    );
    return backend().db.saveThread({ ...thread, args });
  }
  return backend().db.saveThread(thread);
}

export function updateThreadTitle(id: string, title: string | null): Promise<void> {
  return backend().db.updateThreadTitle(id, title);
}

export function deleteThread(id: string): Promise<void> {
  return backend().db.deleteThread(id);
}

export function loadSettings(): Promise<Partial<Settings>> {
  return backend().db.loadSettings();
}

export function saveSettings(settings: Settings): Promise<void> {
  return backend().db.saveSettings(settings);
}
