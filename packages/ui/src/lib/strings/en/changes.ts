export const strings = {

  /** The changes surface: `git status` of the thread's working directory. */
  changes: {
    clean: 'Working tree clean',
    noBranch: 'No branch',
    ahead: '{count} ahead',
    behind: '{count} behind',
    count: '{count} changed',
    oneCount: '1 changed',
    staged: 'Staged',
    stagedShort: 'S',
    binary: 'Binary file, nothing to show line by line',
    truncated: 'This file was cut short: the diff below is not the whole file.',
    pick: 'Pick a file to see its diff',
    loading: 'Reading the working tree',
    renamedFrom: 'Renamed from {path}',
    /** A narrow panel shows the list or one diff: the way back, and the steps between files. */
    backToList: 'All changes',
    previousFile: 'Previous file',
    nextFile: 'Next file',
    position: '{index} of {count}',
    status: {
      added: 'Added',
      modified: 'Modified',
      deleted: 'Deleted',
      renamed: 'Renamed',
      copied: 'Copied',
      untracked: 'Untracked',
      conflict: 'Conflict'
    }
  }
} as const;
