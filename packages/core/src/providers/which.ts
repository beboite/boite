/**
 * `Bun.which` scans every PATH directory, with every PATHEXT extension on
 * Windows: about 0.8 ms a name on an NVMe disk with a warm cache, far more on a
 * slow disk after boot. A providers listing asks for the same few names each
 * time, and the core lists twice before it listens (the registry loading, then
 * the default accounts), then again for every client that boots. An answer is
 * kept for two seconds, and dropped at once when something may have moved a
 * program: a reload, an install, an agent update. Like `Bun.which` without
 * options, this searches the PATH the core started with.
 */
const KEEP_MS = 2_000;
const answers = new Map<string, { found: string | null; at: number }>();

export function which(name: string, now = Date.now()): string | null {
  const known = answers.get(name);
  if (known !== undefined && now - known.at < KEEP_MS) return known.found;
  const found = Bun.which(name);
  answers.set(name, { found, at: now });
  return found;
}

export function forgetWhich(): void {
  answers.clear();
}
