/**
 * The scripts a project already declares, and what runs them.
 *
 * Every repository with a `package.json` carries its own list of things to run,
 * and Boite made the user retype one of them into a shortcut, per project, by
 * hand. The list is right there, it is the project's own answer to "how do I
 * start this", and it changes when the repository changes.
 *
 * Only the parsing lives here, with no store and no backend, because what
 * belongs in a test is which lockfile means which runner and which script names
 * are worth offering.
 */

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export interface ProjectScript {
  name: string;
  /** What the script itself says it does, for the row's second column. */
  body: string;
  /** The full command line, ready for a thread. */
  command: string;
}

/**
 * Lockfile to runner.
 *
 * In this order, because a repository can carry more than one: a `bun.lock`
 * beside a stale `package-lock.json` is a project that moved to bun and did not
 * delete the old file, and running npm there installs a second, different tree.
 */
const LOCKFILES: [string, PackageManager][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/** Which runner a folder's files say to use. npm when nothing says otherwise. */
export function detectManager(fileNames: readonly string[]): PackageManager {
  const present = new Set(fileNames);
  for (const [file, manager] of LOCKFILES) {
    if (present.has(file)) return manager;
  }
  return "npm";
}

/**
 * `npm` needs the `run`, the other three do not, and `npm start` is its own
 * verb. Spelled out rather than always writing `run`, because what ends up in
 * the thread's command line is what the user reads on the row and what a reload
 * replays.
 */
export function scriptCommand(manager: PackageManager, name: string): string {
  if (manager === "npm") return `npm run ${name}`;
  return `${manager} run ${name}`;
}

/**
 * The scripts worth offering, in the order the file declares them.
 *
 * File order, not alphabetical: a `package.json` is written by a person and the
 * first entries are the ones they meant to be first. Lifecycle hooks are left
 * out, since `prepare` and `postinstall` are things npm runs rather than things
 * anybody launches, and offering them is offering a way to break a checkout.
 */
const LIFECYCLE =
  /^(pre|post)?(install|pack|publish|prepare|prepublish|prepublishOnly|prepack|postpack|version)$/;

export function parsePackageScripts(
  raw: string,
  manager: PackageManager,
): ProjectScript[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A package.json mid-edit is not an error worth a toast: the list is simply
    // not available until it parses again.
    return [];
  }
  const scripts = (parsed as { scripts?: unknown })?.scripts;
  if (!scripts || typeof scripts !== "object") return [];
  const out: ProjectScript[] = [];
  for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof body !== "string") continue;
    if (LIFECYCLE.test(name)) continue;
    out.push({ name, body, command: scriptCommand(manager, name) });
  }
  return out;
}
