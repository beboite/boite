export const strings = {

  /** Moving a thread to another project: the menu entry, its project picker and the question about background work. */
  threadMove: {
    moveTo: 'Move to project',
    /** A project put away, in the picker: moving a thread there brings it back. */
    archivedProject: '{project} (archived)',
    noOtherProject: 'No other project',
    /** Why the entry is out while a sub-thread works: the parent's turn end is no time to move it. */
    stopFirst: 'A sub-thread is working; stop it before moving this thread',
    /** The confirm for a thread whose turn runs: the move waits for the turn to end. */
    runningTitle: 'Move when this turn ends',
    /** `{folder}` is the folder the thread leaves, `{project}` the one it goes to. */
    runningBody: 'The agent is working in {folder}. The thread moves to {project} when the current turn ends.',
    runningConfirm: 'Move after this turn',
    /** Same, when the agent also runs something in the background: stop it with the move, or keep it running. */
    runningBackgroundBody: 'The agent is working in {folder}. The thread moves to {project} when the current turn ends. Something it started keeps running in the background: stop it then, or keep it running there until the agent starts its next turn in {project}.',
    /** Under the thread's title in the sidebar and the header until the move happens. */
    pending: 'Moves to {project} after this turn',
    cancelMove: 'Cancel move',
    monitorsTitle: 'Monitors still running',
    backgroundTitle: 'Work still running in the background',
    /** `{folder}` is the folder the thread leaves, `{project}` the one it goes to. */
    backgroundBody: 'The agent still runs something in {folder}. Stop it now, or keep it running there until the agent starts its next turn in {project}.',
    stopMonitors: 'Stop monitors',
    stopWork: 'Stop it',
    keep: 'Keep them',
    /** Said by a project while a thread is dragged over it. */
    dropHere: 'Move the thread to {project}',
    /** Under the card a dragged row becomes, while no project would take it. */
    dragHint: 'Drop on another project'
  }
} as const;
