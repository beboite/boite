export const strings = {

  terminal: {
    title: 'Terminal',
    hide: 'Hide the terminal',
    close: 'Close the shell',
    resize: 'Resize the terminal',
    /** A tab, `Terminal 2`, named after its first shell as T3 Code does. */
    tab: 'Terminal {n}',
    tabs: 'Terminals',
    new: 'New terminal',
    splitRight: 'Split right',
    splitDown: 'Split down',
    closeTab: 'Close the tab',
    resizePanes: 'Resize the split',
    find: 'Find in the terminal',
    history: 'Recent commands',
    historySearch: 'Search the commands',
    historyEmpty: 'No command in this shell\'s history yet',
    historyNone: 'No command matches',
    historyOld: 'This machine runs an older Boite that cannot list them',
    historyLoading: 'Reading the history',
    /** Under the list: what the keys do with the command picked. */
    historyHint: 'Enter runs it, Shift+Enter puts it at the prompt',
    running: 'A command is running',
    /** `exit 1`: the status of the last command, which failed. */
    failed: 'The last command failed (exit {code})'
  }
} as const;
