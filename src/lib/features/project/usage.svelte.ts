import { backendForPath } from "$lib/backend";
import type { UsageReport } from "$lib/backend/types";
import { logger } from "$lib/shared/services/logger.svelte";
import type { Project } from "$lib/types";

/**
 * What a project's agents have spent, read once for everything that shows it.
 *
 * A scan walks every transcript the project has, so the number cannot be read
 * per card: the tokens calendar and the figures beside it are two views of one
 * answer, and two components asking for it separately would walk the same files
 * twice on every arrival.
 *
 * Nothing polls. The answer only moves while an agent is mid-turn, and the card
 * carries the refresh for when it has.
 */

/** A year, so the calendar has the same span the one it looks like has. */
export const USAGE_DAYS = 371;

export type UsageTotals = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
};

const ZERO_TOTALS: UsageTotals = {
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
  total: 0,
};

/**
 * A token count, short enough to sit in a card's right-hand column.
 *
 * It used to stop at M, and a project that has been worked on for a season
 * reads in the billions: cache reads alone put the total past 10^10, so the
 * figures column showed "24000M" and the headline "1200M" — a unit nobody
 * reads at a glance, in a column sized for five characters. B and T carry on
 * from there, and every step keeps three significant digits.
 *
 * One function rather than one per card: the calendar, the breakdown and the
 * per-model rows are three views of the same numbers, and they drifted apart
 * as two copies of the same body.
 *
 * Rounding happens after the unit is picked, so 999950 used to render "1000k"
 * and 999.6e9 "1000B". Those are the next unit, written with the wrong suffix.
 */
export function formatTokens(n: number): string {
  const step = (value: number, unit: string) =>
    `${value >= 100 ? value.toFixed(0) : value.toFixed(value >= 10 ? 1 : 2)}${unit}`;
  const fit = (value: number, unit: string, next: [number, string]) => {
    const text = step(value, unit);
    return text.startsWith("1000") ? step(n / next[0], next[1]) : text;
  };
  if (n >= 1e12) return step(n / 1e12, "T");
  if (n >= 1e9) return fit(n / 1e9, "B", [1e12, "T"]);
  if (n >= 1e6) return fit(n / 1e6, "M", [1e9, "B"]);
  if (n >= 1000) {
    const k = `${Math.round(n / 1000)}k`;
    return k === "1000k" ? step(n / 1e6, "M") : k;
  }
  return String(n);
}

const EMPTY: UsageReport = {
  models: [],
  days: [],
  sessions: 0,
  orchestratorTotal: 0,
  orchestratorSessions: 0,
  missing: [],
};

/** How long a scan stands for before arriving on the page asks again. Long
    enough that walking back and forth between two projects costs nothing,
    short enough that the number is about the session you are in. */
const STALE_MS = 120_000;

class ProjectUsageStore {
  #reports = $state<Record<string, UsageReport>>({});
  #loading = $state<Record<string, true>>({});
  #readAt: Record<string, number> = {};
  #cwdCount: Record<string, number> = {};

  /** Null until the first read for this project lands. */
  report(projectId: string): UsageReport | null {
    return this.#reports[projectId] ?? null;
  }

  loading(projectId: string): boolean {
    return this.#loading[projectId] === true;
  }

  /**
   * Models reduced once, so the headline and the figures card do not each walk
   * the same array and drift. Zero until a report has landed.
   */
  totals(projectId: string): UsageTotals {
    const acc = { ...ZERO_TOTALS };
    for (const m of this.#reports[projectId]?.models ?? []) {
      acc.input += m.input;
      acc.output += m.output;
      acc.cacheWrite += m.cacheWrite;
      acc.cacheRead += m.cacheRead;
      acc.total += m.total;
    }
    return acc;
  }

  /**
   * Reads the transcripts for these directories.
   *
   * The caller passes the directories rather than the project alone: since
   * worktree isolation a project's threads mostly run outside its folder, and
   * every store keys on the directory the agent ran in.
   */
  async load(project: Project, cwds: string[]) {
    if (this.#loading[project.id]) return;
    this.#loading[project.id] = true;
    try {
      this.#reports[project.id] = await backendForPath(project.cwd).session.usage(
        cwds,
        USAGE_DAYS,
      );
      // Only a finished walk is fresh. Stamping before the await treated a
      // failure, or a scan still in flight, as good for STALE_MS, and ensure()
      // would not ask again.
      this.#readAt[project.id] = Date.now();
      this.#cwdCount[project.id] = cwds.length;
    } catch (err) {
      delete this.#readAt[project.id];
      logger.warn("usage", `could not read transcripts for ${project.id}`, err);
      // The stores were not walked, so this holds no reading of them. The bare
      // EMPTY it used to hold is a machine that has spent nothing, which is a
      // fact, and a failed read is not that fact. Same shape a transport that
      // could not reach the boite hands back, so both draw the same.
      this.#reports[project.id] = { ...EMPTY, unreachable: true };
    } finally {
      delete this.#loading[project.id];
    }
  }

  /** Arriving on a project: reads it if nobody has, or if what is held is old
      enough to be about a different afternoon. A longer cwd list is a
      directory the last walk never saw, so it asks even when the stamp is
      still fresh. */
  ensure(project: Project, cwds: string[]) {
    const grew = cwds.length > (this.#cwdCount[project.id] ?? 0);
    const read = this.#readAt[project.id] ?? 0;
    if (!grew && this.#reports[project.id] && Date.now() - read < STALE_MS) return;
    void this.load(project, cwds);
  }
}

export const projectUsage = new ProjectUsageStore();
