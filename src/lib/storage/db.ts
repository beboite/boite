import { backend, backendFor } from "$lib/backend";
import { logger } from "$lib/shared/services/logger.svelte";
import type { Project, Settings, Thread, WorkspaceOrigin } from "$lib/types";
import { redactArgs } from "$lib/shared/utils/redact";

// The origin tag is a client-side routing concern: strip it before a row hits
// a store (each backend only ever persists its own rows).
function untagProject(project: Project): Project {
  const { origin: _origin, ...rest } = project;
  return rest;
}

function untagThread(thread: Thread): Thread {
  const { origin: _origin, ...rest } = thread;
  return rest;
}

export function loadProjects(): Promise<Project[]> {
  return backend().db.loadProjects();
}

export function saveProject(project: Project): Promise<void> {
  return backendFor(project.origin).db.saveProject(untagProject(project));
}

export function setProjectArchived(
  id: string,
  archived: boolean,
  origin?: WorkspaceOrigin,
): Promise<void> {
  return backendFor(origin).db.setProjectArchived(id, archived);
}

export function deleteProject(id: string, origin?: WorkspaceOrigin): Promise<void> {
  return backendFor(origin).db.deleteProject(id);
}

export function loadThreads(): Promise<Thread[]> {
  return backend().db.loadThreads();
}

// Redaction is transport-agnostic: scrub secret-looking args before they ever
// leave the client, whether they land in local SQLite or get shipped to a
// remote server.
export function saveThread(thread: Thread): Promise<void> {
  const db = backendFor(thread.origin).db;
  const { args, redacted } = redactArgs(thread.args);
  if (redacted) {
    logger.warn(
      "db",
      `redacted secret-looking args for thread ${thread.id} (${thread.label}) before persisting`,
    );
    return db.saveThread(untagThread({ ...thread, args }));
  }
  return db.saveThread(untagThread(thread));
}

export function updateThreadTitle(
  id: string,
  title: string | null,
  origin?: WorkspaceOrigin,
): Promise<void> {
  return backendFor(origin).db.updateThreadTitle(id, title);
}

export function markThreadStarted(id: string, origin?: WorkspaceOrigin): Promise<void> {
  return backendFor(origin).db.markThreadStarted(id);
}

export function deleteThread(id: string, origin?: WorkspaceOrigin): Promise<void> {
  return backendFor(origin).db.deleteThread(id);
}

export function loadSettings(): Promise<Partial<Settings>> {
  return backend().db.loadSettings();
}

export function saveSettings(settings: Settings): Promise<void> {
  return backend().db.saveSettings(settings);
}

