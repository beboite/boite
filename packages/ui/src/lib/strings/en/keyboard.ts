export const strings = {

  /** The Keyboard settings page: the table, the file, and the commands the palette has no word for. */
  keyboard: {
    heading: 'Shortcuts',
    intro: 'Click a shortcut, then press the keys you want instead. It applies at once on this machine.',
    search: 'Filter commands',
    groups: { general: 'General', surfaces: 'Side panel', thread: 'Thread and composer', jump: 'Go to a thread', theme: 'Theme', terminal: 'Terminal' },
    record: 'Press the keys',
    change: 'Change the shortcut',
    reset: 'Back to the default',
    resetAll: 'Reset all',
    clear: 'Remove the shortcut',
    conflict: '{chord} already runs "{command}". Move it here?',
    replace: 'Move it here',
    needsModifier: 'Hold Ctrl, Alt or Win with the key. A key alone, or with Shift only, is typing.',
    noMatch: 'No command matches.',
    file: 'Shortcuts file',
    openFile: 'Open the file',
    copyPath: 'Copy the path',
    openFailed: 'Could not open the file: {reason}',
    fileHint:
      'Command ids to chords such as "mod+shift+k", or null to take a key away. mod is Ctrl here and Cmd on a Mac. Entries you leave out keep their default.',
    id: 'Id',
    none: 'Not set',
    custom: 'changed',
    problems: 'Refused',
    problemsHint: 'These lines of the file were not applied. Fix them and save.',
    commands: {
      palette: 'Open the command palette',
      browser: 'Open the browser surface',
      changes: 'Open the changes surface',
      files: 'Open the file tree',
      tasks: 'Open the tasks surface',
      closeSurface: 'Close the active surface',
      stash: 'Stash the composer text, or take it back',
      sendAndDraft: 'Send and open a new draft',
      pin: 'Pin or unpin this thread',
      reopenThread: 'Reopen the thread archived last',
      copyAnswer: 'Copy the last answer',
      find: 'Find in this thread, or pick a new thread\'s project',
      terminalNew: 'New terminal',
      terminalSplit: 'Split the terminal right',
      terminalSplitVertical: 'Split the terminal down',
      terminalClose: 'Close the terminal',
      terminalFind: 'Find in the terminal',
      terminalHistory: 'Recent commands of the shell',
      terminalPreviousCommand: 'Go to the previous command',
      terminalNextCommand: 'Go to the next command',
      /** `Go to thread 3`: the third row of the sidebar, as drawn. */
      thread: 'Go to thread {n}'
    }
  }
} as const;
