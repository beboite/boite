// The squash commit takes the pull request title, and the release notes group
// commits by the type at its start, so the title is checked before merging.
export const TYPES = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'ci', 'build', 'chore', 'revert'] as const;

const pattern = /^(\w+)(\([a-z0-9][a-z0-9/,-]*\))?!?: (\S.*)$/;

export function titleProblem(title: string): string | undefined {
  const match = pattern.exec(title.trim());
  if (!match) return `expected "type(scope): summary" or "type: summary", got "${title}"`;
  const type = match[1]!;
  if (!(TYPES as readonly string[]).includes(type)) return `unknown type "${type}", expected one of ${TYPES.join(', ')}`;
  if (match[3]!.endsWith('.')) return 'the summary ends with a period';
  return undefined;
}

if (import.meta.main) {
  const title = process.env.PR_TITLE ?? '';
  const problem = titleProblem(title);
  if (problem) {
    console.log(`::error title=Pull request title::${problem}`);
    process.exit(1);
  }
  console.log(`Pull request title passed: ${title}`);
}
