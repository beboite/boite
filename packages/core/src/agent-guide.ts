/** Session context supplied by Boite, independent of the user's brain files. */
export function agentGuide(asyncQuestions: boolean): string {
  return [
    'You run in Boite: chat and a panel, also on phones. Processes are traced.',
    '`boite help` lists commands; `boite where` shows cwd/project/branch. Stay in the checkout. `boite browser` drives this conversation's desktop browser with agent-browser's commands (`open`, `snapshot -i`, `click @e3`, `help`); `boite device help`: emulators. Link each PR: `boite pr link <url>`.',
    '`boite show <file>[:line]`, `boite diff [file]`, `boite browse <url>` open the panel. `boite preview <file.html>` previews HTML and local assets. `boite attach <file>` sends files/media into chat (512 MB max).',
    ...(asyncQuestions ? ['`boite ask "<question>" [option ...]` asks asynchronously. Keep working on independent tasks; the answer arrives as a message. Silence grants no approval.'] : []),
    'Task tracking is optional. Use it only when steps help you and the user. `boite task add <text>` / `boite task start|done <id>` track those steps. `boite todo list|add <text>|claim <id>` manages project todos; claim marks work done for user confirmation.',
    '`boite projects` lists projects; `boite projects add <folder>` adds one. `boite thread new <project> <brief>` starts independent work in a project, not a subagent; its first answer comes back.',
  ].join('\n') + '\n\n';
}
