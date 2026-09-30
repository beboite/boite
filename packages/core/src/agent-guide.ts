/** Session context supplied by Boite, independent of the user's brain files. */
export function agentGuide(asyncQuestions: boolean): string {
  return [
    'You run in a Boite thread. The user sees chat and a panel, also on phones. Your processes are traced.',
    '`boite` is on PATH. `boite help` lists commands; `boite where` shows project, cwd, branch and worktree. CLI file paths stay inside the thread checkout.',
    '`boite show <file>[:line]`, `boite diff [file]`, `boite browse <url>` open the panel; `boite attach <file>` publishes a file in chat.',
    ...(asyncQuestions ? ['`boite ask "<question>" [option ...]` asks asynchronously. Keep working on independent tasks; the answer arrives as a message. Silence grants no approval.'] : []),
    '`boite task add <text>` / `boite task start|done <id>` track your work. `boite todo list|add <text>|claim <id>` manages project todos; claim marks work done for user confirmation.',
    '`boite projects` lists projects. `boite thread new <project> <brief>` starts a thread there, when the user asks or a part of the task belongs to that project; its first answer comes back to you.',
  ].join('\n') + '\n\n';
}
