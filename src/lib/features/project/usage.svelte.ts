import { backendForPath } from "$lib/backend";
import type { UsageReport } from "$lib/backend/types";
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
 */
export function formatTokens(n: number): string {
  const step = (value: number, unit: string) =>
    `${value >= 100 ? value.toFixed(0) : value.toFixed(value >= 10 ? 1 : 2)}${unit}`;
  if (n >= 1e12) return step(n / 1e12, "T");
  if (n >= 1e9) return step(n / 1e9, "B");
  if (n >= 1e6) return step(n / 1e6, "M");
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

const EMPTY: UsageReport = { models: [], days: [], sessions: 0, missing: [] };

/** How long a scan stands for before arriving on the page asks again. Long
    enough that walking back and forth between two projects costs nothing,
    short enough that the number is about the session you are in. */
const STALE_MS = 120_000;

class ProjectUsageStore {
  #reports = $state<Record<string, UsageReport>>({});
  #loading = $state<Record<string, true>>({});
  #readAt: Record<string, number> = {};

  /** Null until the first read for this project lands. */
  report(projectId: string): UsageReport | null {
    return this.#reports[projectId] ?? null;
  }

  loading(projectId: string): boolean {
    return this.#loading[projectId] === true;
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
    this.#readAt[project.id] = Date.now();
    try {
      this.#reports[project.id] = await backendForPath(project.cwd).session.usage(
        cwds,
        USAGE_DAYS,
      );
    } catch {
      // Nothing to say that an empty card does not already say: the stores are
      // read-only files that either parse or do not.
      this.#reports[project.id] = EMPTY;
    } finally {
      delete this.#loading[project.id];
    }
  }

  /** Arriving on a project: reads it if nobody has, or if what is held is old
      enough to be about a different afternoon. */
  ensure(project: Project, cwds: string[]) {
    const read = this.#readAt[project.id] ?? 0;
    if (this.#reports[project.id] && Date.now() - read < STALE_MS) return;
    void this.load(project, cwds);
  }
}

export const projectUsage = new ProjectUsageStore();
