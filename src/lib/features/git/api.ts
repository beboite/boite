import { invoke } from "@tauri-apps/api/core";

export interface RepoInfo {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface ChangeEntry {
  path: string;
  status: string;
  staged: boolean;
  conflicted: boolean;
}

export interface Commit {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  summary: string;
  refs: string[];
}

interface RawRepoInfo {
  is_repo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

interface RawCommit {
  sha: string;
  short_sha: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  summary: string;
  refs: string[];
}

export async function gitRepoInfo(path: string): Promise<RepoInfo> {
  const r = await invoke<RawRepoInfo>("git_repo_info", { path });
  return {
    isRepo: r.is_repo,
    branch: r.branch,
    upstream: r.upstream,
    ahead: r.ahead,
    behind: r.behind,
  };
}

export function gitStatus(path: string): Promise<ChangeEntry[]> {
  return invoke<ChangeEntry[]>("git_status", { path });
}

export async function gitLog(
  path: string,
  limit: number,
  skip: number,
): Promise<Commit[]> {
  const rows = await invoke<RawCommit[]>("git_log", { path, limit, skip });
  return rows.map((r) => ({
    sha: r.sha,
    shortSha: r.short_sha,
    parents: r.parents,
    author: r.author,
    email: r.email,
    time: r.time,
    summary: r.summary,
    refs: r.refs,
  }));
}

export function gitStage(path: string, files: string[]): Promise<void> {
  return invoke("git_stage", { path, files });
}

export function gitUnstage(path: string, files: string[]): Promise<void> {
  return invoke("git_unstage", { path, files });
}

export function gitDiscard(path: string, files: string[]): Promise<void> {
  return invoke("git_discard", { path, files });
}

export function gitCommit(path: string, message: string): Promise<string> {
  return invoke<string>("git_commit", { path, message });
}
