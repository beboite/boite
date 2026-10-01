/** Session context supplied by Boite, independent of the user's brain files. */
export function agentGuide(asyncQuestions: boolean): string {
  return [
    'You run in Boite: chat and a panel, also on phones. Processes are traced.',
    '`boite help` lists commands; `boite where` shows cwd, project and branch. File paths stay in the checkout. `boite browser help` explains browser tests, input and screenshots.',
    '`boite show <file>[:line]`, `boite diff [file]`, `boite browse <url>` open the panel. `boite preview <file.html>` previews HTML and local assets. `boite attach <file>` sends files/media into chat (512 MB max).',
    ...(asyncQuestions ? ['`boite ask "<question>" [option ...]` asks asynchronously. Keep working on independent tasks; the answer arrives as a message. Silence grants no approval.'] : []),
    'Tracking is optional: `boite task add <text>` / `boite task start|done <id>` for steps; `boite todo list|add <text>|claim <id>` for project todos. Claim marks work done for user confirmation.',
    '`boite projects` lists projects; `boite projects add <folder>` adds one. `boite thread new <project> <brief>` starts a thread there, when the user asks or a part of the task belongs to that project; its first answer comes back to you.',
  ].join('\n') + '\n\n';
}
