/**
 * The path arithmetic behind creating a project, kept apart from the API that
 * uses it so it can be tested without dragging the whole backend graph in.
 *
 * All of it is textual. These are paths the app stored or a caller typed, never
 * links to resolve — the machine that owns them does that when it is asked to
 * make the folder.
 */

/**
 * A folder name from a project name.
 *
 * Conservative on purpose: the name usually comes out of a conversation, so it
 * arrives with the spaces, accents and punctuation that were in the sentence,
 * and this ends up as a path segment on three operating systems. Never empty —
 * an empty segment would put the project at its own parent folder, which is
 * where every other project lives.
 */
export function folderNameFor(name: string): string {
  const slug = name
    .normalize("NFD")
    // Combining marks, so "é" becomes "e" rather than being dropped entirely.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "project";
}

/**
 * Joins a folder and a child, in the separator the parent already uses. A
 * Windows path stays backslashed and a POSIX one stays forward-slashed, which
 * matters because the result is shown to the user and compared against paths
 * they typed.
 */
export function joinPath(parent: string, child: string): string {
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return `${parent.replace(/[/\\]+$/, "")}${sep}${child}`;
}

/**
 * A path reduced to what two spellings of the same folder have in common:
 * separators, a trailing one, and case.
 *
 * Never stored and never handed back to the backend — lowercasing a path is
 * only safe as a key, and on Linux the folder it names may not exist. What it
 * is for is comparing paths that came from different places, which on Windows
 * means different spellings of one directory: the database keeps
 * `D:\repo\.boite\worktrees\x` because that is what `git worktree add` was
 * given, and `git worktree list --porcelain` answers `D:/repo/.boite/...`.
 * Compared raw, those two never match, and every comparison built on that
 * quietly reads as "different directory".
 */
export function pathKey(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Whether two paths name the same folder, separators and case aside. */
export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}
