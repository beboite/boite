export const strings = {

  workflow: {
    activeOne: '1 workflow',
    activeMany: '{count} workflows',
    status: { running: 'Running', paused: 'Paused', done: 'Done', failed: 'Failed', stopped: 'Stopped' },
    stepStatus: { waiting: 'Waiting', running: 'Running', done: 'Done', failed: 'Failed', skipped: 'Skipped', stopped: 'Stopped' },
    steps: '{done}/{total} steps',
    phase: 'Phase {n}',
    pause: 'Pause',
    resume: 'Resume',
    stop: 'Stop',
    retry: 'Retry',
    stopTitle: 'Stop "{name}"?',
    stopBody: 'Running steps are stopped and the rest never starts. Finished steps keep their results.',
    forEach: 'One per item of {path}',
    after: 'After {steps}',
    condition: 'Only if {path}',
    task: 'Task',
    result: 'Result',
    output: 'Output',
    items: 'Executions',
    openThread: 'Open conversation',
    back: 'Back to the graph',
    close: 'Close details',
    notStarted: 'Not started yet.',
    skipped: 'Skipped: its condition did not hold.',
    card: 'Workflow',
    show: 'Show the workflow',
    tokens: '{tokens} tokens'
  }
} as const;
