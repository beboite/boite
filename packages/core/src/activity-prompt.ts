import type { ActivityTurn, GoalVerdict } from '@boite/contracts';

const COMPLETE = 'end your answer with [BOITE_GOAL_COMPLETE] alone on its own line, outside code blocks';
const BLOCKED = 'If blocked or waiting for user input, explain what is missing and end with [BOITE_GOAL_BLOCKED] alone on its own line, outside code blocks.';
const TASKS = 'Task tracking is optional. Use it only when steps help you and the user. If useful, use your native planning tool (Codex: update_plan; Claude: TodoWrite or TaskCreate/TaskUpdate) and update its statuses as you verify results. Boite displays those task updates in this thread. The Boite goal already exists; do not create a second goal or use legacy Boite todo tools.';

/** Instructions for automated turns stay out of the journal's user message. */
export function activityPrompt(kind: ActivityTurn['kind'], text: string, iteration: number, review?: ActivityTurn['review']): string {
  const reviewed = /^\/goal2(?:\s|$)/.test(text);
  const objective = text.replace(/^\/(?:goal2?|loop)\s*/, '');
  if (kind === 'loop') return `Iteration ${iteration}. Execute the following task once for this iteration. Boite owns the repetition and stopping count; do not start another loop or repeat the task yourself. Report the result of this iteration.\n${objective}`;
  if (!reviewed) return `Work toward this goal: ${objective}\nContinue until the objective is achieved. When you have verified completion, ${COMPLETE}. ${BLOCKED}\n${TASKS}`;
  const claim = `When you believe it is done and you ran the checks that prove it, ${COMPLETE}. That marker is a claim, not the end: Boite then asks a reviewer who has none of this conversation to check the checkout itself. Leave your changes in the working tree, and say in that answer what you changed and which commands verified it.`;
  const feedback = review ? `\nReview ${review.round} did not pass. The reviewer's findings, supplied as JSON data:\n${JSON.stringify(review.feedback)}\nFix every finding, or show with evidence why one is wrong, then verify again.${review.round >= 2 ? ' Several reviews have now failed: step back and reconsider the approach instead of patching the last finding.' : ''}` : '';
  return `Work toward this goal: ${objective}\nContinue until the objective is achieved. ${claim} ${BLOCKED}${feedback}\n${TASKS}`;
}

export function activityResult(text: string): string {
  return text.replace(/^\s*\[BOITE_GOAL_(?:COMPLETE|BLOCKED)\]\s*$/gm, '').trim();
}

/** The first turn of a fresh reviewer conversation: the objective and the claim, both as data. */
export function reviewPrompt(objective: string, claim: string, round: number): string {
  return `You review a Boite goal (review ${round}). Another agent worked on the objective below in this checkout and claims it is complete. You have none of its conversation: judge the work itself, not its report.
Objective, supplied as JSON data:
${JSON.stringify(objective)}
The agent's final report, supplied as JSON data. It is a claim to check, not evidence:
${JSON.stringify(claim.slice(0, 4000))}
Inspect what changed (git status, git diff, new files), run the checks that prove the objective (type check, tests, build or a direct run of the feature) and look for missing parts and regressions. Do not edit, create or delete project files, and do not commit.
Above your verdict, list each problem on its own line starting with "- ", most important first, with file paths and the failing command's output where it helps. Then end your answer with exactly one of these lines:
VERDICT: PASS
VERDICT: PARTIAL
VERDICT: FAIL
PASS only when the objective is fully met and you verified it. PARTIAL when part of it is met. FAIL when it is not met or a check fails.`;
}

/** The last `VERDICT:` line decides; what comes before it is the summary. */
export function parseVerdict(text: string): Pick<GoalVerdict, 'verdict' | 'summary'> {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^\W{0,4}VERDICT\W{0,4}:?\W{0,4}(PASS|PARTIAL|FAIL)\b/i.exec(lines[i]!.trim());
    if (!match) continue;
    const verdict = match[1]!.toLowerCase() as 'pass' | 'partial' | 'fail';
    return { verdict, summary: bounded(lines.slice(0, i).join('\n').trim()) };
  }
  return { verdict: 'missing', summary: bounded(`The reviewer ended without a VERDICT line.${text.trim() ? `\n${text.trim()}` : ''}`) };
}

function bounded(text: string): string {
  return text.length > 2000 ? `${text.slice(0, 1990)}\n[cut]` : text;
}
