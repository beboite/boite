import { backendForPath } from "$lib/backend";

export interface RepoInfo {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  refsVersion: string | null;
  commitCount: number;
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
  return backendForPath(path).git.repoInfo(path);
}

export function gitFindRepos(path: string): Promise<string[]> {
  return backendForPath(path).git.findRepos(path);
}

export function gitStatus(path: string): Promise<ChangeEntry[]> {
  return backendForPath(path).git.status(path);
}

export function gitLog(
  path: string,
  limit: number,
  skip: number,
): Promise<Commit[]> {
  return backendForPath(path).git.log(path, limit, skip);
}

export function gitStage(path: string, files: string[]): Promise<void> {
  return backendForPath(path).git.stage(path, files);
}

export function gitUnstage(path: string, files: string[]): Promise<void> {
  return backendForPath(path).git.unstage(path, files);
}

export function gitDiscard(
  path: string,
  files: string[],
  untracked: string[],
): Promise<void> {
  return backendForPath(path).git.discard(path, files, untracked);
}

export function gitCommit(path: string, message: string): Promise<string> {
  return backendForPath(path).git.commit(path, message);
}

export function gitFetch(path: string): Promise<void> {
  return backendForPath(path).git.fetch(path);
}

export function gitPush(path: string): Promise<void> {
  return backendForPath(path).git.push(path);
}

export function gitPull(path: string): Promise<void> {
  return backendForPath(path).git.pull(path);
}

export function gitInit(path: string): Promise<void> {
  return backendForPath(path).git.init(path);
}
