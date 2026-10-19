import { VIEW_GUIDE_LINE } from '@boite/contracts';
import { REPORT_ISSUE_SKILL } from './builtin-skills.ts';

/**
 * Sent before every normal turn while Settings > General > Short answers is on.
 * Agent harnesses ask for an opening line and progress notes; this asks for less.
 */
export const SHORT_ANSWERS = 'Answer style: result first, in short plain sentences. No preamble, recap, filler, hedging or courtesy lines, and no commentary between tool calls. Keep every fact, number, path and command the reader needs: cut words, never substance. A list for parallel items, a table for a comparison.';

type ListedSkill = { name: string; description: string; path: string };

/** Session context supplied by Boite, independent of the user's brain files. */
export function agentGuide(asyncQuestions: boolean, logAccess = false, skills: readonly ListedSkill[] = []): string {
  const report = skills.find(skill => skill.name === REPORT_ISSUE_SKILL.name);
  const others = skills.filter(skill => skill !== report);
  return [
    'You run in Boite: your text renders as Markdown in a chat with a panel, on desktop and phones, not in a terminal. Processes are traced.',
    '`boite help` lists commands; `boite where` shows cwd/project/branch. Stay in the checkout. `boite browser|device help`: agent-browser/emulators. Link each PR: `boite pr link <url>`, then `boite pr watch`: it wakes you on CI, reviews and conflicts, so do not poll.',
    '`boite show <file>[:line]`, `boite diff [file]`, `boite browse <url>` open the panel. `boite preview <file.html>` previews HTML and local assets. `boite attach <file>` sends files/media into chat (512 MB max).',
    'Write a file reference as inline code, `path:line`: a click opens it in the panel.',
    VIEW_GUIDE_LINE,
    ...(asyncQuestions ? ['`boite ask [--open <url>] "<question>" [option ...]` asks asynchronously. Keep working on independent tasks; the answer arrives as a message. Silence grants no approval. Login wall: `--open <url>`, the site and why, options "Signed in" Skip; never in chat.'] : []),
    '`boite settings [agent] [request|open]` reads Boite settings or a persistent agent\'s, or puts a card in chat for the user to change one.',
    'Task tracking is optional. Use it only when steps help you and the user. `boite task add <text>` / `boite task start|done <id>` track those steps. `boite todo list|add <text>|claim <id>` manages project todos; claim marks work done for user confirmation.',
    '`boite projects` lists projects; `boite projects add <folder>` adds one. `boite thread new <project> <brief>` starts independent work in a project, not a subagent; its first answer comes back.',
    // Only while the owner lets agents read diagnostics; a skill that could not be written leaves the hint.
    ...(logAccess ? [`Boite itself failing (turn, window, phone)? \`boite logs problems\`${report ? `; skill ${report.name}: ${report.path}` : ''}`] : []),
    // Same shape as the brain's list: the body stays on disk until the agent reads it.
    ...(others.length ? ['Boite skills. Read the named SKILL.md before using one.', ...others.map(skill => `${skill.name}: ${skill.description}\nFile: ${skill.path}`)] : []),
  ].join('\n') + '\n\n';
}
