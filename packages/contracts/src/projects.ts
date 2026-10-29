import type { ProjectId, Timestamp } from './ids';

// ---------------------------------------------------------------------------
// Projects and threads.
// ---------------------------------------------------------------------------

/** Maximum UTF-16 code units in a renamed display name, keeping journal entries and broadcasts bounded. */
export const PROJECT_NAME_MAX = 1024;

export interface Project {
  id: ProjectId;
  name: string;
  path: string;
  createdAt: Timestamp;
  /** Precheck Worktree in new drafts. An absent value means off; existing drafts keep their choice. */
  worktreeDefault?: boolean;
  /** Automatically hide a quiescent worktree conversation after its exact PR merges. Missing means enabled. */
  autoArchiveMergedPr?: boolean;
  /**
   * Remove a worktree the core created once every thread in it is archived or
   * done and its work is settled: the exact head merged in a PR, or nothing
   * missing from every other branch. Absent from a core older than this field;
   * otherwise true unless the owner turned it off.
   */
  autoRemoveWorktrees?: boolean;
  /**
   * The folder holds a `.git`, read on every answer rather than stored: the
   * test `threads.create.worktree` applies. Absent before the core's first
   * check of the folder answers, and from a core older than this field: a
   * client offers worktrees only on `true`.
   */
  repository?: boolean;
  /**
   * `drafts` on the one project `projects.drafts` made in the machine's
   * Documents folder, read from the path on every answer like `repository`.
   * A thread started there without a `cwd` gets a folder of its own inside it.
   * Absent on every other project and from a core older than this field.
   */
  kind?: 'drafts';
  /**
   * Put away with `projects.archive`: out of the sidebar, its threads and their
   * processes left as they were. A new thread in it brings it back. Absent when
   * false and from a core older than this field.
   */
  archived?: boolean;
  /**
   * How many of its own threads are archived, sub-threads left out, counted on
   * every answer; `project.updated` carries the new count when one is archived
   * or restored. Absent when none and from a core older than this field.
   */
  archivedThreads?: number;
  /**
   * How many of `archivedThreads` are done: marked done or archived after
   * their PR merged (`doneAt` set). The rest were archived by hand to be
   * picked up later. Absent when none and from a core older than this field.
   */
  doneThreads?: number;
  /**
   * The project's folder is gone from the disk: deleted, moved or renamed
   * since it was added. Read on every answer like `repository`, and
   * `project.updated` follows when it changes. A thread cannot start there
   * until the folder is back; removing the project still works. Absent while
   * the folder is there, while the disk gave no clear answer (a share whose
   * host sleeps) and from a core older than this field.
   */
  missing?: boolean;
  /**
   * What the sidebar draws in place of the project's initial, detected from
   * its folder after it was added and on `projects.refreshIcon`, never while a
   * list is answered. An `image` carries only its version: the bytes come
   * from `projects.icon`, once per version, so a list stays a few bytes per
   * project. Absent when nothing was found, before the first detection and
   * from a core older than this field.
   */
  icon?: ProjectIcon;
}

/**
 * The stacks a project can be recognised by when its folder holds no logo,
 * each drawn by the UI as a small mark. A core only ever names one of these.
 */
export const TECH_ICON_IDS = [
  'unity', 'unreal', 'godot', 'flutter', 'dart', 'electron', 'next', 'nuxt', 'svelte', 'angular',
  'react', 'android', 'swift', 'rust', 'go', 'python', 'dotnet', 'java', 'cpp', 'node',
] as const;
export type TechIconId = (typeof TECH_ICON_IDS)[number];

export type ProjectIcon =
  /** A logo, favicon or app icon read from the folder; `version` changes with its bytes. */
  | { kind: 'image'; version: string }
  /** No image, but the folder reads as this stack. */
  | { kind: 'tech'; id: TechIconId };

export interface ProjectsRpcMethods {
  /** Owner-only merged-PR visibility policy; absent defaults to enabled. Disabling reveals automatically hidden roots, retaining manual archives. */
  'projects.setAutoArchiveMergedPr': { params: { projectId: ProjectId; enabled: boolean }; result: Project };
  /** Owner-only automatic worktree removal policy; absent defaults to enabled. Turning it off stops future removals only. */
  'projects.setAutoRemoveWorktrees': { params: { projectId: ProjectId; enabled: boolean }; result: Project };

  'projects.list': { params: Record<string, never>; result: Project[] };
  'projects.add': { params: { path: string; name?: string }; result: Project };
  /** Change a project's display name without moving its folder. Trimmed names hold 1 to PROJECT_NAME_MAX code units. Paired devices may rename too. Refused for the system drafts project. */
  'projects.rename': { params: { projectId: ProjectId; name: string }; result: Project };
  /** Owner-only folder navigation on the machine running this core. */
  'projects.browse': {
    params: { path?: string };
    result: { path: string; parent: string | null; directories: { name: string; path: string }[] };
  };
  'projects.remove': { params: { projectId: ProjectId }; result: { ok: true } };
  /**
   * Put a project away, or bring it back with `archived: false`. Nothing else
   * changes: its threads keep their state and a running one keeps running.
   * Refused on the drafts project, which a thread with no folder lands in.
   */
  'projects.archive': { params: { projectId: ProjectId; archived?: boolean }; result: Project };
  /** Owner only. Persist a project's default for new drafts and broadcast project.updated. Enabling requires a Git repository. */
  'projects.setWorktreeDefault': { params: { projectId: ProjectId; enabled: boolean }; result: Project };
  /**
   * The image of a project whose `icon.kind` is `image`, as a `data:` URL for
   * an `<img>` (an SVG drawn that way runs no script and loads nothing), at
   * most 256 KB before encoding. Read from the journal, not the folder. Refused
   * with `field: 'projectId'` for a project whose icon is not an image.
   */
  'projects.icon': { params: { projectId: ProjectId }; result: { version: string; dataUrl: string } };
  /**
   * Detects the project's icon again from its folder, stores it and answers
   * the project; `project.updated` follows when the icon changed. Owner only:
   * it reads the disk.
   */
  'projects.refreshIcon': { params: { projectId: ProjectId }; result: Project };
  /**
   * The drafts project: `Boite` in the Documents folder of the machine running
   * this core, or `BOITE_DRAFTS_DIR` when set. The folder and the project are
   * made on the first call and returned as they are on every later one, so a
   * client can ask for it right before its first send.
   */
  'projects.drafts': { params: Record<string, never>; result: Project };
  /**
   * The files of a project a mention can name, ranked on the query: relative
   * paths with `/` separators, `.git`, `node_modules` and what the root
   * `.gitignore` names by plain name left out. `total` is the number of
   * matches, `files` the first `limit` of them (50 unless asked otherwise, 200
   * at most), and `capped` says the walk stopped at the file cap, so a match
   * may be missing.
   */
  'projects.files': {
    params: { projectId: ProjectId; query: string; limit?: number };
    result: { files: string[]; total: number; capped: boolean };
  };
}

export interface ProjectsRpcEvents {
  /** A project `projects.add` created. A known path returns its project without one. */
  'project.added': Project;
  /** A project `projects.remove` deleted, after the `thread.removed` of each of its threads. */
  'project.removed': { projectId: ProjectId };
  /** A project renamed, archived or restored, one whose count of archived threads moved, or one whose icon changed. */
  'project.updated': Project;
}
