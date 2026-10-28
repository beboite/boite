export const strings = {

  sidebar: {
    doneThreads: 'Done',
    /** Archived by hand to pick up later; done threads have their own group. */
    archivedGroup: 'Archived',
    workingThreads: 'Working',
    projectWorkingThreads: '{project}: {count} working',
    projectDoneThreads: '{project}: {count} done',
    projectArchivedThreads: '{project}: {count} archived',
    /** The fold under the list for projects with no open conversation, and what choosing one does. */
    idleProjects: 'Idle projects',
    /** The section on top of the Projects view: projects whose every conversation is at work, so nothing there waits on the user. */
    workingProjects: 'Working',
    workingProjectsHint: 'Every conversation in these projects is at work. A project moves down once one needs you.',
    /** The section under the open projects: nothing open, conversations archived to pick up again. */
    laterProjects: 'Set aside',
    laterProjectsHint: 'Conversations you archived to pick up later, in projects with nothing else open.',
    idleProjectsHint: 'Nothing to do here: no open or set-aside conversation. Choose one to start a thread.',
    groupingOptions: 'Display options',
    /** The sidebar's top switch between the thread list and the Bots page. */
    surface: 'Threads or bots',
    threads: 'Threads',
    agents: 'Bots',
    /** The count beside Threads or Bots in that switch: what works now, and whether something there needs the user. */
    surfaceWorking: '{count} at work',
    surfaceWaiting: '{count} at work, something needs you',
    surfaceSubagentsOne: 'and 1 subagent',
    surfaceSubagentsMany: 'and {count} subagents',
    /** The two ways the display options can list threads. */
    projectsView: 'Projects',
    recentView: 'Recent',
    /** The display options panel: its sections, and the short names its rows use under them. */
    displayView: 'View',
    displayOrder: 'Project order',
    displayGroup: 'Group',
    groupWorkingRow: 'Working threads',
    groupIdleRow: 'Idle projects',
    customOrderShort: 'Custom',
    autoArchiveMergedPrHint: 'A worktree conversation leaves the list for Done once its branch is merged. Its history stays. Applies to this project.',
    autoRemoveWorktreesHint: 'An hour after every conversation in a worktree is done or archived, Boite deletes the worktree if nothing would be lost: its last commit is on another branch, or a merged pull request has that exact commit. A merged branch goes too. Uncommitted changes always stay. Applies to this project.',
    noActiveProjects: 'No conversations need attention.',
    markDone: 'Mark done',
    doneToast: 'Marked "{title}" done',
    doneLoadFailed: 'Some completed threads could not be loaded.',
    /** The pull request under a done or archived conversation, which opens it on the forge. */
    prMerged: '#{number} merged',
    prClosed: '#{number} closed',
    prOpen: '#{number} open',
    reopenThread: 'Move to Recent',
    reopenNamedThread: 'Move "{title}" to Recent',
    doneNotice: 'This thread is done. Move it to Recent to continue.',
    /** Above the composer, or the done notice, of a thread whose worktree Boite removed. */
    contactHold: {
      title: 'Contact mail holds this thread',
      body: 'Its history holds messages from {contacts}, sent outside a shared project. Boite cannot bound what that mail asks, so it refuses every turn here.',
      trust: 'Trust this history',
      trustTip: 'The agent then runs with its usual tools and reads that mail like the rest of its history.',
      ownerOnly: 'Trust it from the computer that runs this Boite.'
    },
    worktreeGone: {
      title: 'Worktree removed',
      merged: 'Boite removed this thread\'s worktree {when}, after #{number} was merged.',
      clean: 'Boite removed this thread\'s worktree {when}: every commit in it was already on another branch.',
      branchDeleted: 'Branch {branch} was deleted.',
      branchKept: 'Branch {branch} is still there.',
      archived: 'Moved to Recent, this thread has no folder to work in.',
      live: 'A new message here has no folder to run in. Start a new thread to keep working.'
    },
    allProjects: 'All projects',
    filterProject: 'Filter by project',
    recentOrder: 'Recent activity',
    customOrder: 'Custom order',
    moveProjectUp: 'Move project up',
    moveProjectDown: 'Move project down',
    search: 'Search threads',
    newThread: 'New thread',
    newThreadIn: 'New thread in {project}',
    addProject: 'Add a project',
    noProjects: 'No project yet.',
    noThreads: 'No thread yet.',
    noMatch: 'Nothing matches.',
    unread: 'Unread',
    collapse: 'Hide sidebar',
    expand: 'Show sidebar',
    resize: 'Resize the sidebar, double-click to reset',
    settings: 'Settings',
    projectMenu: 'Project actions',
    copyPath: 'Copy path',
    manageProject: 'Manage project',
    renameProject: 'Rename project',
    projectName: 'Project name',
    worktreeDefault: 'Worktree by default',
    autoArchiveMergedPr: 'Hide merged PR conversations',
    autoRemoveWorktrees: 'Remove settled worktrees',
    backToProjectMenu: 'Back',
    viewArchivedThreads: 'View archived threads',
    importSession: 'Import a Claude Code session',
    /** Out of the list, not out of Boite: its threads keep running and a new one brings it back. */
    archiveProject: 'Archive project',
    refreshIcon: 'Refresh icon',
    projectArchivedToast: 'Archived {project}',
    archivedProjects: 'Archived projects',
    restoreProject: 'Restore',
    restoreAndStart: 'Restore {project} and start a thread',
    removeProject: 'Remove from Boite',
    /** On a project whose folder was deleted, moved or renamed outside Boite. */
    projectMissing: 'Folder not found',
    projectMissingBody: 'The folder {path} does not exist any more: it was deleted, moved or renamed. Put it back to keep working here, or remove the project from Boite.',
    projectMissingCheck: 'Check again',
    removeProjectTitle: 'Remove {project} from Boite?',
    removeProjectBody: 'Its threads go with it. Files on disk stay where they are.',
    remove: 'Remove',
    threadMenu: 'Thread actions',
    /** A pencil on a thread's row: something typed in its box and not sent. */
    unsentDraft: 'Unsent draft',
    retitle: 'Regenerate title',
    retitling: 'Writing a title',
    /** What a row shows in place of its time while the agent works or has news. */
    state: {
      working: 'Working',
      workingFor: 'Working for {elapsed}',
      waiting: 'Needs you',
      error: 'Failed',
      done: 'Done',
      queued: 'Queued',
      /** The turn ended, the agent waits on the agents it delegated to: their results wake it. */
      delegating: 'Sub-agents',
      delegatingOne: 'Waiting on 1 sub-agent',
      delegatingMany: 'Waiting on {count} sub-agents',
      /** The chip a parent's row carries while its delegated agents work, in every state. */
      subagentsOne: '1 sub-agent at work',
      subagentsMany: '{count} sub-agents at work',
      /** The chip's own words, its count written out: the full sentence stays in its title. */
      /** The same chip once a sub-agent asks the user something: the parent reads Needs you. */
      subagentsAskingOne: '1 sub-agent needs you',
      subagentsAskingMany: '{count} sub-agents need you',
      /** The turn ended, the agent still watches something: a monitor it left going. */
      monitoring: 'Monitoring',
      monitoringFor: 'Monitoring for {elapsed}',
      /** The turn ended, the agent still runs a shell, a subagent or a workflow. */
      background: 'In background',
      backgroundFor: 'In background for {elapsed}',
      /** The turn ended, Boite watches pull requests for the agent and wakes it when they need it. */
      watching: 'Watching PR',
      watchingMany: 'Watching {count} PRs',
      /** A delegated agent's turn ended on its own background work, which wakes it: what it waits for. */
      awaiting: 'Waiting on {what}',
      /** That work ended without waking it: the agent stopped there, its result never came. */
      interrupted: 'Interrupted',
      /** Its machine stopped answering while it worked: what it does now is unknown until the machine is back. */
      unreachable: 'Unreachable',
      unreachableWas: 'Machine unreachable. Last known state: {state}',
      interruptedBy: '{what} ended without waking it: {reason}',
      interruption: {
        'error': 'the task failed',
        'cancelled': 'the task was cancelled',
        'no-longer-reported': 'its process ended',
        'session-ended': 'its agent process was ended',
        'core-restarted': 'Boite or the PC restarted'
      }
    },
    /** A folded project's mark for the threads it hides: `2 threads: Needs you`. */
    rollupOne: '1 thread: {state}',
    rollupMany: '{count} threads: {state}',
    pin: 'Pin',
    unpin: 'Unpin',
    archive: 'Archive',
    deleteUnavailable: 'Update Boite on the machine hosting this conversation to delete it. The conversation has been kept.',
    deletedToast: 'Deleted "{title}". You can restore it from Settings.',
    /** The toast after an archive, with its way back: the button and Ctrl+Z. */
    archivedToast: 'Archived "{title}"',
    undo: 'Undo',
    undoHint: 'Undo (Ctrl+Z)',
    draft: 'New thread',
    /** A draft row's menu: what is typed there and not sent goes. */
    deleteDraft: 'Delete draft',
    /** A draft sent while its machine was away: its conversation starts once the machine is back. */
    draftQueued: 'Starts when {machine} is back',
    draftStarting: 'Starting on {machine}',
    draftQueueFailed: 'Not started: {reason}',
    /** Its menu takes the queued prompt back into the draft, which then waits to be sent again. */
    cancelQueuedDraft: 'Cancel the start'
  }
} as const;
