export const strings = {

  /** The tasks surface: the thread's activity, the agent's tasks, the project's todos. */
  tasks: {
    goalSection: 'Goal and loop',
    noActivity: 'No goal and no loop on this thread',
    nextRun: 'Next run {time}',
    iterations: '{count} iterations',
    agentSection: 'Agent tasks',
    todoSection: 'Project todos',
    noTodos: 'No todo on this project',
    addPlaceholder: 'Add a todo',
    add: 'Add',
    // The chip on a claimed card. Short enough to leave the card's own text
    // readable on a narrow panel; the whole sentence is its tooltip.
    awaiting: 'Awaiting you',
    awaitingHint: 'This card waits on your confirmation',
    markOpen: 'Move back to open',
    markClaimed: 'Mark it waiting on you',
    markDone: 'Confirm it is done',
    removeTodo: 'Remove this todo',
    collapse: 'Fold this section',
    expand: 'Unfold this section',
    /** The pull requests the agent asked Boite to watch (`boite pr watch`). */
    watchSection: 'Pull request watches',
    noWatches: 'No pull request watched',
    watchHint: 'Boite reads the pull request on GitHub about once a minute and wakes the agent when a check fails, the checks pass, a review or comment lands, the branch conflicts or it leaves the merge queue unmerged',
    watchNotRead: 'Not read yet',
    watchNoChecks: 'No checks',
    watchChecks: '{total} checks',
    watchRunning: '{count} running',
    watchFailed: '{count} failed',
    watchConflict: 'Conflicts with {base}',
    watchQueued: 'Merge queue, position {position}',
    watchRateLimited: 'GitHub rate limit, next read {time}',
    watchUnreachable: 'GitHub out of reach, next read {time}',
    stopWatch: 'Stop watching',
    stopWatchOf: 'Stop watching #{number}'
  }
} as const;
