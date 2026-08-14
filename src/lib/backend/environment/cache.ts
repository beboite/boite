import type { Project, Thread } from "$lib/types";

/**
 * The last projection an environment answered with, kept so a boot that starts
 * offline can still say what is on the other machine.
 *
 * Device-scoped like the registration it belongs to, and dropped by the same
 * call that forgets the environment: rows describing a boite this device can no
 * longer open are worse than no rows at all.
 */
export interface EnvProjection {
  threads: Thread[];
  projects: Project[];
  at: number;
}

const PREFIX = "boite.env.";

function key(id: string): string {
  return `${PREFIX}${id}.rows`;
}

function hasStorage(): boolean {
  return typeof localStorage !== "undefined";
}

export function readProjection(id: string): EnvProjection | null {
  if (!hasStorage()) return null;
  try {
    const raw = localStorage.getItem(key(id));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<EnvProjection>;
    if (!Array.isArray(p.threads) || !Array.isArray(p.projects)) return null;
    return { threads: p.threads, projects: p.projects, at: typeof p.at === "number" ? p.at : 0 };
  } catch {
    return null;
  }
}

export function writeProjection(id: string, p: Omit<EnvProjection, "at">): void {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(key(id), JSON.stringify({ ...p, at: Date.now() }));
  } catch {
    // A full quota costs the cache, never the connection.
  }
}

export function forgetProjection(id: string): void {
  if (!hasStorage()) return;
  try {
    localStorage.removeItem(key(id));
  } catch {
    // nothing to forget
  }
}

/** Every cache key this device holds for environments, for a sweep. */
export function projectionKeys(): string[] {
  if (!hasStorage()) return [];
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(PREFIX)) out.push(k);
  }
  return out;
}
