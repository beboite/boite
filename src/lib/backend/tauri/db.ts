import { invoke } from "./ipc";
import type { Project, Settings, Thread, TodoItem } from "$lib/types";
import type { DbApi, WorkspaceMeta, WorkspaceMetaApi } from "../types";

// No SQL here, and that is the change. This file used to hold eight statements
// against tauri-plugin-sql while the server held fifteen hand-written Rust arms
// over the same tables — one schema, two readers, nothing checking that they
// agreed. They had already stopped agreeing: a whole-row REPLACE built from a
// stale snapshot could put `running` back on a thread whose process had ended,
// which the server had refused to do for as long as it had existed.
//
// Both sides are `boite_core::command::records` now. The shaping that used to
// live here — the args JSON, the status normalisation, the `text` column that
// is called `title` on the wire — is in the row types in `boite_core::model`,
// applied once for both hosts.
//
// tauri-plugin-sql stays loaded: the schema is still its ledger, and its
// migrations are what the Rust side attaches to. It is no longer a way for the
// webview to reach the tables.

export const tauriDb: DbApi = {
  loadProjects(): Promise<Project[]> {
    return invoke("records_project_list");
  },

  async saveProject(project: Project): Promise<void> {
    await invoke("records_project_create", { params: { project } });
  },

  async setProjectArchived(id: string, archived: boolean): Promise<void> {
    await invoke("records_project_archive", { params: { id, archived } });
  },

  async deleteProject(id: string): Promise<void> {
    await invoke("records_project_delete", { params: { id } });
  },

  loadThreads(): Promise<Thread[]> {
    return invoke("records_thread_list");
  },

  async saveThread(thread: Thread): Promise<void> {
    await invoke("records_thread_create", { params: { thread } });
  },

  // Still column-targeted, and still for the same reason: title bursts are
  // flushed on a delay, so a whole-row write built from a snapshot taken before
  // the burst would undo a session-id capture or an exit status that landed in
  // between. The difference is that the row write now refuses that anyway.
  async updateThreadTitle(id: string, title: string | null): Promise<void> {
    await invoke("records_thread_update", { params: { threadId: id, title } });
  },

  async markThreadStarted(id: string): Promise<void> {
    await invoke("records_thread_started", { params: { threadId: id } });
  },

  async setThreadAgeing(id, status, patch): Promise<void> {
    await invoke("records_thread_age", {
      params: { threadId: id, status, ...patch },
    });
  },

  async setPinnedOrder(ids: string[]): Promise<void> {
    await invoke("records_thread_pin_order", { params: { ids } });
  },

  async deleteThread(id: string): Promise<void> {
    // The key row and the key file go with it, inside the one command. There
    // used to be three calls here, and the third was allowed to fail quietly.
    await invoke("records_thread_delete", { params: { threadId: id } });
  },

  loadSettings(): Promise<Partial<Settings>> {
    return invoke("records_settings_get");
  },

  async saveSettings(settings: Settings): Promise<void> {
    await invoke("records_settings_set", { params: { settings } });
  },

  loadTodos(): Promise<TodoItem[]> {
    return invoke("records_todo_list");
  },

  async saveTodo(todo: TodoItem): Promise<void> {
    await invoke("records_todo_save", { params: { todo } });
  },

  async deleteTodo(id: string): Promise<void> {
    await invoke("records_todo_delete", { params: { todoId: id } });
  },
};

// Naming and colouring a boite used to be remote-only, and not because a
// desktop could not do it: the rows were behind a WebSocket method with no twin
// on this side. The bus answers for both now, so the asymmetry cost six lines
// to remove and would have cost a hand-written SQL pair to keep.
//
// The set answers with what was stored rather than what was sent, so a colour
// the bus dropped does not show up as taken.
export const tauriWorkspaceMeta: WorkspaceMetaApi = {
  get(): Promise<WorkspaceMeta> {
    return invoke("records_workspace_info");
  },

  async set(patch: Partial<WorkspaceMeta>): Promise<WorkspaceMeta> {
    await invoke("records_workspace_set_info", { params: patch });
    return invoke("records_workspace_info");
  },
};
