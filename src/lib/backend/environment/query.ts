import type { Backend, UsageReport, WorkspaceHit } from "../types";
import type { Thread } from "$lib/types";
import { workspace } from "../active.svelte";
import { hasTauri } from "../env";
import { device } from "$lib/features/settings/device.svelte";
import { environments } from "./registry.svelte";
import { environmentLabel } from "./merge";
import type { SyncStatus } from "./supervisor";

export { environmentLabel, mergeUsageReports } from "./merge";

/**
 * One place to ask a question of every environment that is up.
 *
 * The active workspace is in here beside the registry's environments, because
 * the whole point is that a caller stops caring which one is on screen: the
 * palette, the usage view and the thread list ask the same question of all of
 * them and label the answers.
 */
export interface ConnectedEnvironment {
  /** `local` for this device, otherwise the boite's registration id. */
  id: string;
  label: string;
  color: string | null;
  backend: Backend;
  sync: SyncStatus;
  /** Whether this is the workspace currently on screen. */
  active: boolean;
}

export interface EnvSearchHit extends WorkspaceHit {
  envId: string;
  envLabel: string;
}

export interface EnvUsage {
  envId: string;
  envLabel: string;
  report: UsageReport;
}

/** A thread on another machine, as it looked the last time it answered. */
export interface EnvThread {
  envId: string;
  envLabel: string;
  envColor: string | null;
  thread: Thread;
}

export function connectedEnvironments(): ConnectedEnvironment[] {
  const out: ConnectedEnvironment[] = [];
  if (hasTauri()) {
    out.push({
      id: "local",
      label: "Local",
      color: null,
      backend: workspace.local(),
      // This device's rows are read straight off SQLite, so there is no
      // projection to be behind: it is either loaded or the app is not up.
      sync: "live",
      active: !workspace.isRemote,
    });
  }
  const activeRemote = workspace.remoteBackend;
  if (activeRemote && workspace.connection === "connected") {
    out.push({
      id: workspace.activeBoiteId ?? "remote",
      label: environmentLabel(workspace.info.name, workspace.remoteUrl ?? ""),
      color: workspace.info.color,
      backend: activeRemote,
      sync: "live",
      active: true,
    });
  }
  for (const runtime of environments.queryable) {
    const backend = runtime.backend;
    if (!backend) continue;
    out.push({
      id: runtime.id,
      label: environmentLabel(runtime.info.name, runtime.url),
      color: runtime.info.color,
      backend,
      sync: runtime.sync,
      active: false,
    });
  }
  return out;
}

export interface EnvResult<T> {
  env: ConnectedEnvironment;
  value: T | null;
  error: string | null;
}

/**
 * Ask every connected environment the same thing.
 *
 * Never rejects and never lets one environment cost another its answer: a boite
 * that has just gone down while the question was in flight comes back as an
 * error beside the hits the others found, which is the only useful shape for a
 * palette that is drawing results as they arrive.
 */
export async function fanOut<T>(
  fn: (env: ConnectedEnvironment) => Promise<T>,
  envs: ConnectedEnvironment[] = connectedEnvironments(),
): Promise<EnvResult<T>[]> {
  return Promise.all(
    envs.map(async (env): Promise<EnvResult<T>> => {
      try {
        return { env, value: await fn(env), error: null };
      } catch (err) {
        return { env, value: null, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}

/**
 * The journal, the todos and the transcripts of every connected environment.
 *
 * An environment whose backend has no `search` is skipped rather than counted
 * as having found nothing, so a desktop with no local search command does not
 * make the whole answer look empty.
 */
export async function searchEnvironments(
  q: string,
  limit = 20,
): Promise<EnvSearchHit[]> {
  const query = q.trim();
  if (!query) return [];
  const results = await fanOut(async (env) => {
    const search = env.backend.search;
    if (!search) return [] as WorkspaceHit[];
    return search.query(query, limit);
  });
  const out: EnvSearchHit[] = [];
  for (const { env, value } of results) {
    for (const hit of value ?? []) {
      out.push({ ...hit, envId: env.id, envLabel: env.label });
    }
  }
  return out;
}

/**
 * What every connected environment's agents have spent.
 *
 * The directories are asked for per environment because they are that machine's
 * paths: a Windows desktop and a Linux boite share none of them, and handing
 * one machine's cwds to the other reads a year of nothing.
 */
export async function usageAcrossEnvironments(
  days: number,
  cwdsFor: (env: ConnectedEnvironment) => string[],
): Promise<EnvUsage[]> {
  const results = await fanOut(async (env) => {
    const cwds = cwdsFor(env);
    if (cwds.length === 0) return null;
    return env.backend.session.usage(cwds, days);
  });
  const out: EnvUsage[] = [];
  for (const { env, value } of results) {
    if (!value) continue;
    out.push({ envId: env.id, envLabel: env.label, report: value });
  }
  return out;
}

/**
 * Threads living on environments other than the one on screen, with the state
 * each of them last reported.
 *
 * Read off the registry's projections rather than asked for: the server pushes
 * status as a control event, so a machine that is up already told this device
 * what its agents are doing and a poll would only ask again.
 */
export function otherEnvironmentThreads(): EnvThread[] {
  const out: EnvThread[] = [];
  for (const runtime of environments.runtimes) {
    const entry = device.getBoite(runtime.id);
    const label = environmentLabel(runtime.info.name || entry?.name, runtime.url);
    for (const thread of runtime.threads) {
      out.push({
        envId: runtime.id,
        envLabel: label,
        envColor: runtime.info.color || entry?.color || null,
        thread,
      });
    }
  }
  return out;
}
