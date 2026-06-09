import { invoke } from "@tauri-apps/api/core";

export interface RepoInfo {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  refsVersion: string | null;
}

export interface ChangeEntry {
  path: string;
  status: string;
  staged: boolean;
  conflicted: boolean;
  origPath: string | null;
}

export interface Commit {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  summary: string;
  additions: number;
  deletions: number;
  refs: string[];
  localOnly: boolean;
  remoteOnly: boolean;
}

export function gitRepoInfo(path: string): Promise<RepoInfo> {
  return invoke<RepoInfo>("git_repo_info", { path });
}

export function gitStatus(path: string): Promise<ChangeEntry[]> {
  return invoke<ChangeEntry[]>("git_status", { path });
}

export function gitLog(
  path: string,
  limit: number,
  skip: number,
): Promise<Commit[]> {
  return invoke<Commit[]>("git_log", { path, limit, skip });
}

export function gitStage(path: string, files: string[]): Promise<void> {
  return invoke("git_stage", { path, files });
}

export function gitUnstage(path: string, files: string[]): Promise<void> {
  return invoke("git_unstage", { path, files });
}

export function gitDiscard(
  path: string,
  files: string[],
  untracked: string[],
): Promise<void> {
  return invoke("git_discard", { path, files, untracked });
}

export function gitCommit(path: string, message: string): Promise<string> {
  return invoke<string>("git_commit", { path, message });
}

export function gitFetch(path: string): Promise<void> {
  return invoke("git_fetch", { path });
}

export function gitPush(path: string): Promise<void> {
  return invoke("git_push", { path });
}

export function gitPull(path: string): Promise<void> {
  return invoke("git_pull", { path });
}

export function gitInit(path: string): Promise<void> {
  return invoke("git_init", { path });
}
