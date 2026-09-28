/**
 * The plan an agent hands over before it starts editing: Claude's
 * `ExitPlanMode` call carries it whole as markdown in `input.plan`.
 */

/** The tool call's plan, or null when this call is not one or carries no text. */
export function planOf(name: string, input: unknown): string | null {
  if (name !== 'ExitPlanMode' || typeof input !== 'object' || input === null) return null;
  const plan = (input as Record<string, unknown>)['plan'];
  return typeof plan === 'string' && plan.trim().length > 0 ? plan : null;
}

/** The plan's first heading, else its first line, cut to a readable title. */
export function planTitle(plan: string): string {
  const lines = plan.split('\n').map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => /^#{1,6}\s/.test(line));
  return (heading ?? lines[0] ?? '').replace(/^#{1,6}\s+/, '').replace(/[*_`]/g, '').trim().slice(0, 80);
}

/**
 * `plan-<title>.md`, ASCII and lowercase so it reads the same on every file
 * system, with `-2`, `-3` and so on past the names already in `taken`.
 */
export function planFileName(plan: string, taken: Iterable<string> = []): string {
  const slug = planTitle(plan)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  const base = slug ? `plan-${slug}` : 'plan';
  const used = new Set([...taken].map((name) => name.toLowerCase()));
  let name = `${base}.md`;
  for (let n = 2; used.has(name); n++) name = `${base}-${n}.md`;
  return name;
}
