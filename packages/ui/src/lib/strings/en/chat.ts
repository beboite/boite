export const strings = {

  chat: {
    accepted: 'Request accepted',
    responseStarted: 'Agent activity received',
    working: 'Working',
    writing: 'Writing',
    stopped: 'Stopped',
    inputTokens: '{count} input tokens',
    outputTokens: '{count} output tokens',
    cacheTokens: '{read} read from the cache, {write} written to it',
    /** The footer of a turn: `Working 12s`, then `Worked 4m 41s`. */
    workingFor: 'Working for {time}',
    workedFor: 'Worked for {time}',
    compacting: 'Compacting conversation',
    compactionElapsed: 'Elapsed: {time}',
    turnOwnTime: 'This reply alone: {time}',
    compactedFor: 'Compacted in {time}',
    compactionFailed: 'Compaction failed',
    compactionStopped: 'Compaction stopped',
    progress: { starting: 'Starting agent', thinking: 'Thinking', compacting: 'Compacting context', retrying: 'Retrying request', tool: 'Running tool', working: 'Receiving activity', waiting: 'Waiting for provider' },
    providerSignal: 'Provider signal {time} ago',
    noActivity: 'No new activity for {time}',
    /** The jump button once something arrived below the reader. */
    newMessage: '1 new message',
    newMessages: '{count} new messages',
    findPlaceholder: 'Find in thread',
    findNone: 'No match',
    findCount: '{at} of {total}',
    findPrevious: 'Previous match (Shift+Enter)',
    findNext: 'Next match (Enter)',
    finishedAt: 'done {time}',
    failedAt: 'failed {time}',
    /** `{what}` is a list of `backgroundOne` and `backgroundMany` joined by `backgroundJoin`. */
    backgroundRunning: '{what} still running',
    forkOrigin: 'Forked from', forkReturn: 'Send conclusions back', forkSummary: 'Conclusions for the original conversation',
    forkReturned: 'Conclusions sent to the original conversation', forkSourceUnavailable: 'Original conversation unavailable',
    forkNative: 'Native context preserved', forkSeeded: 'Visible history copied',
    backgroundJoin: ', ',
    backgroundOne: { shell: '{count} shell', agent: '{count} agent', monitor: '{count} monitor', workflow: '{count} workflow', other: '{count} task' },
    backgroundMany: { shell: '{count} shells', agent: '{count} agents', monitor: '{count} monitors', workflow: '{count} workflows', other: '{count} tasks' },
    backgroundStop: 'Stop the agent and what it runs in the background',
    /** The chip on a tool card whose work went on in the background. */
    backgroundChip: 'in the background',
    /** A call's line while it runs and once it ran; `{subject}` is a file name, a pattern, a host or a program. */
    toolLive: { command: 'Running {subject}', read: 'Reading {subject}', edit: 'Editing {subject}', write: 'Writing {subject}', search: 'Searching {subject}', fetch: 'Fetching {subject}', web: 'Searching the web for {subject}', agent: 'Delegating {subject}', other: 'Running {subject}' },
    toolDone: { command: 'Ran {subject}', read: 'Read {subject}', edit: 'Edited {subject}', write: 'Wrote {subject}', search: 'Searched {subject}', fetch: 'Fetched {subject}', web: 'Searched the web for {subject}', agent: 'Delegated {subject}', other: 'Used {subject}' },
    /** The line of a call whose input names nothing to show. */
    toolBare: { command: 'Ran a command', read: 'Read a file', edit: 'Edited a file', write: 'Wrote a file', search: 'Searched the code', fetch: 'Fetched a page', web: 'Searched the web', agent: 'Delegated a task', other: 'Used a tool' },
    /** `Running {subject}` for a command whose program has no name. */
    toolCommandWord: 'a command',
    /** A folded run of calls: one clause per kind, joined into one sentence. */
    toolRunOne: { command: 'Ran {count} command', read: 'Read {count} file', edit: 'Changed {count} file', search: 'Searched the code once', fetch: 'Fetched {count} page', web: 'Searched the web once', agent: 'Delegated {count} task', other: 'Used {count} tool', attempt: 'Attempted {count} call' },
    toolRunMany: { command: 'Ran {count} commands', read: 'Read {count} files', edit: 'Changed {count} files', search: 'Searched the code {count} times', fetch: 'Fetched {count} pages', web: 'Searched the web {count} times', agent: 'Delegated {count} tasks', other: 'Used {count} tools', attempt: 'Attempted {count} calls' },
    toolRunJoin: ', ',
    toolRunLast: ' and ',
    toolRunShow: 'Show each call',
    toolRunHide: 'Hide the calls',
    toolIssueOne: '{count} unsuccessful call',
    toolIssueMany: '{count} unsuccessful calls',
    system: 'System',
    toolInput: 'Input',
    toolOutput: 'Output',
    toolDocuments: 'Documents',
    /** Under a text the core cut because its message was too heavy to send whole. */
    textOmitted: 'This message is too long to show in full. {count} characters are left out.',
    /** The chip on a folded card: `1 diff`, `2 diffs`, `1 doc`, `3 docs`. */
    documentChip: {
      diff: '{count} diff',
      diffs: '{count} diffs',
      doc: '{count} doc',
      docs: '{count} docs'
    },
    documentImage: 'What the tool produced',
    /** An image the user sent with the prompt, when it came with no name. */
    imagePart: 'Image sent with the prompt',
    /** A picture whose bytes could not be fetched from its machine. */
    imageUnavailable: 'This picture could not be loaded. Scroll back to it to retry.',
    diffHidden: '{count} unchanged lines',
    diffIgnoreWhitespace: 'Ignore whitespace changes',
    diffSideBySide: 'Old and new side by side',
    /** A diff whose every change was spaces, with whitespace ignored. */
    diffWhitespaceOnly: 'Only whitespace changed.',
    diffShowAll: 'Show all {count} lines',
    diffAdded: '+{count}',
    diffRemoved: '-{count}',
    noOutput: 'No output',
    toolExitCode: 'Exit code {code}',
    toolCommandFailed: 'No diagnostic was reported. See the full output below.',
    /** Under an expanded tool input that opened cut to six lines. */
    showAll: 'Show all',
    toolStatus: {
      running: 'running',
      done: 'done',
      error: 'error',
      denied: 'denied'
    },
    thinking: 'Thinking',
    thinkingShow: 'Show the reasoning',
    thinkingHide: 'Hide the reasoning',
    /** The divider a compaction draws: `{pre}` and `{post}` formatted token counts. */
    compaction: 'Context compacted, {pre} to {post} tokens',
    compactionNoPost: 'Context compacted from {pre} tokens',
    compactionUnknown: 'Context compacted',
    compactionManual: 'by hand',
    /** Beside a compaction a copy of the session made while the conversation went on. */
    compactionBackground: 'in the background',
    /** The accent line on the first message after a move: the agent was told where it works now. */
    moveExplained: 'Move explained to the agent',
    moveShow: 'Show what the agent was told',
    moveHide: 'Hide what the agent was told',
    wake: { routine: 'Routine', event: 'Woken up' },
    wakeShow: 'Show what the bot read',
    wakeHide: 'Hide what the bot read',
    /** A bot's finished turn: its steps folded above its answer, or a wake that had nothing for the user. */
    fold: {
      worked: 'Worked {time}', workedBare: 'Worked',
      stepOne: '1 step', stepMany: '{count} steps',
      seconds: '{count} s', minutes: '{count} min', hours: '{hours} h {minutes} min',
      quiet: 'Nothing to report',
      showSteps: 'Show the steps', hideSteps: 'Hide the steps',
      showTurn: 'Show the whole turn', hideTurn: 'Fold this turn',
      memory: { running: 'Updating its memory', done: 'Memory updated', unchanged: 'Memory checked, nothing to change', error: 'Memory update failed' },
      memoryOpen: 'See its memory on the desk',
    },
    /** At the foot of a thread the user moved: the note rides on the next prompt, not sent yet. */
    movePending: 'Moved to {project} · the agent will be told with your next message',
    movePendingShow: 'Show what the agent will be told',
    movePendingHide: 'Hide what the agent will be told',
    /** A line of the timeline: the agent moved its own thread with `boite thread move`. */
    movedByAgent: 'Moved by the agent to {project}',
    /** A line of the timeline: Boite pinged the cached prompt while the thread waits on its agents. */
    keepalive: 'Prompt cache kept warm',
    keepaliveMany: 'Prompt cache kept warm {count} times',
    keepaliveRunning: 'Keeping the prompt cache warm',
    /** Above the first prompt of a thread another thread's agent started with `boite thread new`. */
    startedByAgent: 'Started by the agent of {title} in {project}',
    /** Above the first prompt of a thread another agent started: the prompt is that agent's, not the user's. */
    promptFromAgent: 'Sent by the agent of',
    /** A line of the starting thread's timeline: its agent started another thread. */
    agentStartedThread: 'The agent started {title} in {project}',
    openLinkedThread: 'Open this thread',
    /** One of the user's own hooks ended the turn (`part.type === 'hook'`). */
    hookBlocked: 'A hook blocked this message',
    hookStopped: 'A hook stopped the turn',
    /** The line above with what the hook said: `{label}` one of the two, `{message}` its words. */
    hookSays: '{label}: {message}',
    /** What the agent asks to do, one sentence per kind of tool (`lib/tool-summary.ts`). */
    permissionAsk: {
      command: 'Run a command',
      edit: 'Change {file}',
      editFiles: 'Change files',
      editFolder: 'Write files in {folder} from now on',
      write: 'Create or replace {file}',
      read: 'Read {file}',
      search: 'Search the files for {subject}',
      fetch: 'Open {subject}',
      web: 'Search the web for {subject}',
      agent: 'Start a helper agent',
      other: 'Use its {tool} tool'
    },
    permissionTechnical: 'Technical details',
    turnFiles: 'Changed files',
    showTurnDiff: 'Show diff',
    hideTurnDiff: 'Hide diff',
    /** Opens the Changes panel: everything the working tree changed since its last commit, all turns together. */
    allChanges: 'All changes in this folder',
    expandFileFolders: 'Expand all folders',
    collapseFileFolders: 'Collapse all folders',
    fileCreated: 'New',
    fileChanged: 'Changed',
    fileDeleted: 'Deleted',
    openFile: 'Open {name}',
    revealFile: 'Show in folder',
    revealFailed: 'The folder could not be opened: {reason}',
    allow: 'Allow',
    deny: 'Deny',
    allowed: 'Allowed',
    denied: 'Denied',
    /** The shield on a call's line once the user answered the agent's ask for it. */
    permissionAllowedBy: 'Allowed by you',
    permissionDeniedBy: 'Denied by you',
    questionHeading: 'Asks you',
    questionAsyncHeading: 'Question',
    questionAsyncHint: 'The agent keeps working. Without an answer it goes on with a default.',
    questionAnswer: 'Answer',
    questionAnswered: 'Answered',
    questionCancelled: 'No longer waiting for an answer',
    questionSkip: 'Skip',
    questionOpenPage: 'Open',
    /** The composer is the free field of the question; the card points there. */
    questionReplying: 'Write your answer in the message box below, with any photos or files.',
    questionWrite: 'Answer in writing',
    /** The timeline's line for a question waiting in the dock above the composer. */
    questionDocked: 'Waiting for your answer above the message box',
    questionOpen: 'Answer it',
    streaming: 'writing',
    jumpToLatest: 'Jump to latest',
    /** The one line at the top of the timeline while an older page is being fetched. */
    loadingOlder: 'Loading earlier messages',
    loadingNewer: 'Loading later messages',
    /** The view a thread shows while its page downloads. */
    opening: 'Loading the conversation',
    /** Received against the total, both already formatted: "1.2 MB / 3.4 MB". */
    openingProgress: '{received} / {total}',
    /** What a picture left on the core says until it is fetched: "Loading 240 kB". */
    partLoading: 'Loading {size}',
    outline: 'Messages in this conversation',
    messageGroup: 'Browse {count} messages',
    earlierMessages: 'Load earlier messages',
    /** The rail's own chevrons: they move its window over the conversation without moving the timeline. */
    outlineEarlier: 'Show earlier messages in the rail',
    outlineLater: 'Show later messages in the rail',
    goToMessage: 'Go to message {number}: {text}',
    copied: 'Copied',
    /** The card an agent's proposed plan is read in, before it starts editing. */
    plan: 'Plan',
    planDownload: 'Download .md',
    planSave: 'Save to folder',
    planSaveHint: "Write the plan as a markdown file at the root of this thread's folder",
    planSaved: 'Saved as {name}',
    copyMessage: 'Copy message',
    /** The menu of a file, folder or thread link in an answer, opened by a right click or a long press. */
    openLink: 'Open',
    copyPath: 'Copy path',
    copyThreadAddress: 'Copy thread address',
    editMessage: 'Edit and send again from here',
    retry: 'Retry this answer',
    fork: 'Fork from here',
    forkHere: 'Fork into a new thread',
    forkWorktree: 'Fork into a new worktree',
    /** A prompt's exact time, under its bubble: `Sent Tue 28 Sep 2026, 10:31:05`. */
    sentAt: 'Sent {time}',
    error: 'Error',
    errorTitle: "The agent couldn't continue",
    errorSubscriptionTitle: 'No subscription available',
    errorSubscriptionHint: 'Connect an account or wait for its quota to reset.',
    errorRateTitle: 'Rate limit reached',
    errorRateHint: 'The provider is limiting requests for now. Send your message again in a few minutes.',
    errorServerTitle: 'The provider is unavailable',
    errorServerHint: 'Try again in a moment.',
    errorDetails: 'Technical details',
    failedAttempts: '{count} failed attempts',
    /** A Mermaid block of an answer, drawn (`lib/rich-markdown.ts`). */
    diagram: {
      label: 'Diagram',
      showCode: 'Code',
      showDiagram: 'Diagram',
      enlarge: 'Enlarge',
      failed: 'This diagram could not be drawn: {reason}',
      unavailable: 'The diagram could not be drawn here.'
    },
    /** A ```view block of an answer, its HTML shown as a page (`lib/view-block.ts`). The reasons end `failed`. */
    viewBlock: {
      label: 'View',
      showView: 'View',
      failed: 'This view could not be shown: {reason}',
      unavailable: 'The view could not be shown here.',
      timeout: 'it did not load in time',
      silent: 'its page did not start',
      navigated: 'it left its own page'
    },
    /** What stands in for a diagram, a formula or a view an answer is still writing. */
    drawingPending: 'Drawing…',
    /** The tooltip of a formula Temml could not read, its source left as written. */
    formulaFailed: 'This formula could not be read: {reason}'
  }
} as const;
