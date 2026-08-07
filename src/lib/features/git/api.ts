import { backendForPath } from "$lib/backend";
import type { CommitStateAnswer } from "$lib/backend/types";

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

export interface BranchInfo {
  name: string;
  current: boolean;
}

/** What the repository can say about a sha someone else named. */
export interface CommitState {
  known: boolean;
  pushed: boolean;
  short: string;
  subject: string | null;
  branch: string | null;
}

export interface PullRequest {
  number: number;
  state: string;
  url: string;
}

/**
 * What asking `gh` about a branch came to. "No pull request" and "could not
 * ask" are not the same thing to whoever reads the row, so they are not the
 * same value here: `unavailable` is no gh and no GitHub remote — nothing to
 * report and nothing to fix — while `failed` is a gh that answered and refused.
 */
export type PrLookup =
  | { kind: "unavailable" }
  | { kind: "notFound" }
  | { kind: "found"; pr: PullRequest }
  | { kind: "failed"; auth: boolean; detail: string };

export interface BranchChangeResult {
  stashed: boolean;
}

export function gitRepoInfo(path: string): Promise<RepoInfo> {
  return backendForPath(path).git.repoInfo(path);
}

/**
 * The transport's whole answer, `unreachable` included. Annotated
 * `Promise<CommitState>` this compiled against every backend and narrowed the
 * flag off on the way out, so the one caller that has to tell "git said no"
 * apart from "nobody asked git" never saw which of the two it had.
 */
export function gitCommitState(
  path: string,
  sha: string,
): Promise<CommitStateAnswer> {
  return backendForPath(path).git.commitState(path, sha);
}

export function gitPullRequest(path: string, branch: string): Promise<PrLookup> {
  return backendForPath(path).git.pullRequest(path, branch);
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

export function gitBranches(path: string): Promise<BranchInfo[]> {
  return backendForPath(path).git.branches(path);
}

export function gitSwitchBranch(
  path: string,
  name: string,
  create: boolean,
  stash: boolean,
): Promise<BranchChangeResult> {
  return backendForPath(path).git.switchBranch(path, name, create, stash);
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
