/** Every user-facing string of the UI. No literal UI text lives anywhere else. */
export const strings = {
  phone: {
    preparing: 'The app is still preparing offline files. Reload and try again.',
    settingsOffline: 'Settings have not been downloaded yet. Reconnect and open Settings again.',
    heading: 'Phone app', publicUrl: 'Public HTTPS address', urlPlaceholder: 'https://boite.example.com',
    publicUrlHint: 'Use the HTTPS origin configured on your reverse proxy. New pairing links use this address. The proxy must forward the page and /rpc to this core.',
    install: 'Install Boite', installed: 'Boite is running as an installed app.',
    installHint: 'On iPhone, open Share in Safari, then Add to Home Screen. On Android, use Install app or Add to Home screen in the browser menu.',
    httpsRequired: 'This connection uses HTTP. Open Boite through HTTPS to enable offline files and notifications.',
    ownOrigin: 'Open this machine’s own pairing link to enable notifications for it.',
    pairFirst: 'Open a device pairing link before enabling notifications.',
    unsupported: 'This browser does not support push here. On iPhone, add Boite to the Home Screen and open it from its icon.',
    pushHint: 'Receive a notification when an agent finishes, fails or needs your answer, including while Boite is closed.',
    enable: 'Enable notifications', disable: 'Disable notifications', test: 'Send test notification',
    enabled: 'Notifications enabled for this device.', testSent: 'The push service accepted the test notification.',
    denied: 'Notifications were not allowed. You can change this in the browser or device settings.',
    subscriptionFailed: 'The browser did not return a complete push subscription.'
  },
  mobile: {
    settingsDevice: 'This phone', settingsDeviceHint: 'Preferences saved on this device.',
    settingsPhone: 'App & notifications', settingsPhoneHint: 'Installation and alerts from your connected machine.',
    settingsMachinesHint: 'Connect, switch or disconnect a remote machine.',
    settingsAppearanceHint: 'Theme and accent for this phone.',
    settingsRemoteHint: 'Providers, projects and server administration are managed from the desktop app.',
    settingsBack: 'Back to settings',
    navigation: 'Navigation', threads: 'Conversations', activity: 'Activity', project: 'Choose project',
    activityHint: 'Running agents and requests waiting for you.', threadsHint: 'Your conversations across machines.',
    search: 'Find a conversation', unread: 'Unread', noActivity: 'No agents need your attention.', noThreads: 'No matching conversations.'
  },
  machines: {
    heading: 'Machines', local: 'This PC', projects: 'Projects', recent: 'Recent',
    dynamic: 'All machines', recentHint: 'Most recent user message first',
    intro: 'Connect machines to see their projects and threads together. Each machine runs its own agents and files.',
    label: 'Machine name', icon: 'Machine icon', icons: { desktop: 'Desktop', laptop: 'Laptop', server: 'Server', rack: 'Server rack', cloud: 'Cloud', cpu: 'Processor' }, link: 'Pairing link', add: 'Add machine', adding: 'Connecting',
    remove: 'Disconnect', open: 'Open machine', invalidUrl: 'Machine URL must be an HTTP or HTTPS URL without credentials, query or fragment.',
    duplicate: 'This machine is already connected.', noPr: 'No PR', refreshPr: 'Refresh pull request',
    prUnavailable: 'Pull request unavailable', manual: 'Connect with URL and token',
    filter: 'Filter machines', all: 'All machines',
    timeout: 'Machine did not answer within 12 seconds. Check its address and browser origins, then reconnect.',
    browserOrigins: 'Allowed browser origins',
    browserOriginsHint: 'For a browser or phone viewing several machines, add the origin that serves Boite on each remote machine. One exact http(s) origin per line. Desktop connections need no extra origin.',
  },
  app: {
    name: 'Boite',
    /** The tag the title bar shows when the core is the dev install. */
    channelDev: 'Dev',
    channelDevTitle: 'The dev channel, on its own data directory',
    loading: 'Starting',
    noEndpointTitle: 'No core to connect to',
    noEndpointBody:
      'Open the pairing link from the desktop app, or set the core URL and token in Settings.',
    openSettings: 'Open settings'
  },

  titlebar: {
    minimize: 'Minimize',
    maximize: 'Maximize',
    restore: 'Restore',
    close: 'Close',
    quitHold: 'Hold Ctrl+Q to quit',
    quitHoldHint: 'or press it twice'
  },

  connection: {
    machine: 'Machine',
    local: 'This PC',
    current: 'Current machine',
    machines: 'machines connected',
    oneMachine: 'machine connected',
    issues: 'need attention',
    manage: 'Manage machines',
    folder: 'Folder',
    browse: 'Browse folders',
    nativeBrowse: 'Choose in Windows Explorer',
    parent: 'Parent folder',
    emptyFolder: 'No subfolders',
    unavailable: 'Could not connect',
    idle: 'Not connected',
    connecting: 'Connecting',
    ready: 'Connected',
    closed: 'Disconnected',
    label: 'Connection'
  },

  threadStatus: {
    idle: 'idle',
    queued: 'queued',
    running: 'running',
    waiting: 'waiting for you',
    error: 'error'
  },

  firstRun: {
    heading: 'Open a project',
    body: 'Pick the folder an agent will work in. Threads live inside it.',
    deviceBody: 'Projects are opened from the app the core runs in. The ones it holds show up here.',
    pick: 'Choose a folder',
    dropHint: 'or drop a folder anywhere in this window',
    typePath: 'Or type the path',
    pathPlaceholder: 'Absolute path of the folder',
    add: 'Open'
  },

  drop: {
    title: 'Drop to add a project',
    body: 'Each folder becomes a project. Files are refused.'
  },

  sidebar: {
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
    loadTitle: 'Live load',
    settings: 'Settings',
    projectMenu: 'Project actions',
    copyPath: 'Copy path',
    copied: 'Copied',
    importSession: 'Import a Claude Code session',
    removeProject: 'Remove from Boite',
    removeProjectTitle: 'Remove {project} from Boite?',
    removeProjectBody: 'Its threads go with it. Files on disk stay where they are.',
    remove: 'Remove',
    threadMenu: 'Thread actions',
    open: 'Open',
    rename: 'Rename',
    retitle: 'Regenerate title',
    retitling: 'Writing a title',
    pin: 'Pin',
    unpin: 'Unpin',
    pinned: 'Pinned',
    archive: 'Archive',
    draft: 'New thread'
  },

  palette: {
    placeholder: 'Search threads, or type a command',
    threads: 'Threads',
    commands: 'Commands',
    empty: 'Nothing matches.',
    hint: 'Enter to open, Esc to close',
    newThread: 'New thread',
    addProject: 'Add a project',
    importSession: 'Import a Claude Code session',
    settings: 'Open settings',
    appearance: 'Appearance settings',
    providers: 'Providers and accounts',
    pair: 'Pair a phone',
    sidebar: 'Toggle the sidebar',
    panel: 'Toggle the right panel',
    trace: 'Show the trace',
    pin: 'Pin this thread',
    unpin: 'Unpin this thread',
    rename: 'Rename this thread',
    retitle: 'Regenerate the title of this thread',
    archive: 'Archive this thread',
    themeDark: 'Theme: dark',
    themeLight: 'Theme: light',
    themeSystem: 'Theme: system'
  },

  /** The import dialog: the sessions Claude Code kept for a project's folder. */
  imports: {
    title: 'Import a session into {project}',
    intro: 'Claude Code sessions started in this folder. One becomes a thread with its history, and the next turn continues it.',
    loading: 'Looking for sessions',
    empty: 'No Claude Code session for this folder.',
    imported: 'Imported',
    importing: 'Importing',
    close: 'Close'
  },

  /** The composer's slash menu: the agent's own commands over Boite's. */
  slash: {
    label: 'Commands',
    agent: 'Agent',
    app: 'Boite',
    empty: 'No command matches',
    model: 'Change the model',
    effort: 'Change the reasoning effort',
    mode: 'Change the permission mode'
  },

  activity: {
    goal: 'Goal',
    loop: 'Loop',
    tasks: 'Tasks',
    taskCount: '{done}/{total} tasks',
    showTasks: 'Show tasks',
    goalDescription: 'Keep working toward an objective',
    loopDescription: 'Repeat a task a set number of times or on a schedule',
    goalUsage: 'Use /goal followed by an objective.',
    loopUsage: 'Use /loop 2 prompt for two iterations, or /loop 5m prompt for a schedule. Choose 1 to 1000 iterations.',
    intervalError: 'Loop intervals must be between 1 second and 24 hours.',
    noAttachments: 'Send images in a message before starting a goal or loop.',
    active: 'Active',
    paused: 'Paused',
    complete: 'Complete',
    pause: 'Pause',
    resume: 'Resume',
    remove: 'Remove',
    finish: 'Mark complete',
    every: 'Every {interval}',
    iterations: '{count} runs',
    iteration: 'Iteration {count}',
    iterationOf: 'Iteration {count} of {total}',
    history: 'Iteration history',
    noHistory: 'No completed iterations yet',
    allTasksDone: 'All tasks completed',
    waitingTasks: 'Waiting for next task',
    stopped: 'Stopped',
    running: 'Running',
    done: 'Done',
    error: 'Failed',
    pending: 'Pending',
    in_progress: 'In progress',
    completed: 'Completed'
  },

  /** The composer's `@` menu: the project's files, the picked one written in as `@path`. */
  mention: {
    label: 'Files',
    empty: 'No file matches',
    more: '{count} more, keep typing'
  },

  notify: {
    done: 'Done',
    failed: 'Failed',
    needsYou: 'Needs your answer'
  },

  permissionMode: {
    default: 'Ask',
    acceptEdits: 'Auto decide',
    bypassPermissions: 'Yolo',
    plan: 'Plan',
    dontAsk: 'Auto-deny'
  },

  permissionModeLong: {
    default: 'Ask before every tool call',
    acceptEdits: 'Accept edits, ask for the rest',
    bypassPermissions: 'Run everything without asking',
    plan: 'Plan only, no changes',
    dontAsk: 'Deny anything that would need asking'
  },

  thread: {
    contextDetails: 'Context',
    contextInput: 'Input',
    contextCache: 'Cached input',
    contextOutput: 'Output',
    contextUsed: 'Used',
    contextFree: 'Available',
    contextNoBreakdown: 'This agent does not report a breakdown.',
    contextNoReading: 'No measurement received from this agent yet.',
    contextMeasured: 'Last measurement',
    none: 'No thread open',
    noneBody: 'Pick one on the left, or start a new one.',
    trace: 'Trace',
    traceHint: 'Processes this thread launched',
    cwd: 'Working directory',
    model: 'Model',
    defaultModel: 'Default model',
    renamePlaceholder: 'Thread title',
    /** The draft's own heading, the project's name in the dropdown after it. */
    startIn: 'Start a thread in',
    start: 'Start a thread',
    inWorktree: 'in a worktree',
    inProject: 'in',
    using: 'using',
    onEffort: 'on {effort} effort',
    draftMode: {
      default: 'with approval requests',
      acceptEdits: 'with edits allowed',
      bypassPermissions: 'with all permissions',
      plan: 'in plan mode',
      dontAsk: 'with automatic denial of approval requests'
    },
    changeProject: 'Change project',
    /** The header badge of a thread working in its own worktree; the title says where. */
    branchHint: 'Working in a worktree on this branch',
    /** The context meter's tooltip: `{tokens}` and `{window}` formatted, `{percent}` whole. */
    contextHint: 'Context: {tokens} of {window} tokens ({percent}%) as of the last request',
    contextHintNoWindow: 'Context: {tokens} tokens as of the last request; the agent named no window'
  },

  chat: {
    accepted: 'Request accepted',
    responseStarted: 'Agent activity received',
    working: 'Working',
    writing: 'Writing',
    stopped: 'Stopped',
    toolCall: '1 tool call',
    toolCount: '{count} tool calls',
    inputTokens: '{count} input tokens',
    outputTokens: '{count} output tokens',
    you: 'You',
    assistant: 'Agent',
    system: 'System',
    toolInput: 'Input',
    toolOutput: 'Output',
    toolDocuments: 'Documents',
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
    diffHidden: '{count} unchanged lines',
    diffAdded: '+{count}',
    diffRemoved: '-{count}',
    noOutput: 'No output',
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
    permissionHeading: 'Wants to use',
    allow: 'Allow',
    deny: 'Deny',
    allowed: 'Allowed',
    denied: 'Denied',
    questionHeading: 'Asks you',
    questionTextLabel: 'Your own answer',
    questionTextPlaceholder: 'Type an answer',
    questionAnswer: 'Answer',
    questionAnswered: 'Answered',
    questionCancelled: 'The turn ended before this was answered',
    streaming: 'writing',
    jumpToLatest: 'Jump to latest',
    /** The one line at the top of the timeline while an older page is being fetched. */
    loadingOlder: 'Loading earlier messages',
    outline: 'Messages in this conversation',
    messageGroup: 'Browse {count} messages',
    earlierMessages: 'Load earlier messages',
    goToMessage: 'Go to message {number}: {text}',
    copy: 'Copy',
    copied: 'Copied',
    error: 'Error'
  },

  composer: {
    placeholder: 'Message {provider} in {project}',
    placeholderNoProject: 'Message the agent',
    send: 'Send',
    stop: 'Stop',
    queued: 'Sent when the current turn ends',
    picker: 'Provider and model',
    models: 'Models',
    searchModels: 'Search models',
    noModels: 'No model matches',
    legacyModels: 'Legacy models',
    refreshModels: 'Refresh models',
    probing: "Reading the agent's models",
    notInstalled: 'Not installed on this machine',
    installInSettings: 'Install in Settings',
    reasoning: 'Reasoning',
    effortTitle: 'Reasoning effort',
    speed: 'Response speed',
    standardSpeed: 'Standard speed',
    effortHint: 'Drag or use the arrow keys to choose a level.',
    favorites: 'Favorites',
    favorite: 'Add to favorites',
    unfavorite: 'Remove from favorites',
    favoritesEmpty: 'Star a model to find it here.',
    favoriteUnavailable: 'This favorite is no longer offered by the account. Choose another model.',
    compact: 'Compact context',
    compactBusy: 'Wait for the current turn to finish',
    compactUnavailable: 'This agent has not advertised context compaction',
    compactNoSession: 'Send a message before compacting',
    contextUnknown: 'Context usage not reported',
    newBadge: 'new',
    lockedHint: 'A thread keeps its provider and account',
    mode: 'Permissions',
    model: 'Model',
    unavailable: 'not installed',
    noAccount: 'no account',
    noProvider: 'No provider',
    hint: 'Enter to send, Shift+Enter for a new line',
    /** The draft's worktree switch, off and on. */
    worktree: 'Worktree',
    worktreeOff: 'Start in a git worktree on its own branch',
    worktreeOn: 'Starts in a git worktree on its own branch',
    /** Images sent with the prompt: the strip above the box and what refuses one. */
    attach: 'Attach images',
    editQueued: 'Edit this pending message, or press Up in the empty composer',
    attachRemove: 'Remove {name}',
    attachAlt: 'Attached image',
    attachUnnamed: 'the pasted image',
    attachFormat: '{name} is {type}, and an image must be one of {formats}.',
    attachTooLarge: '{name} is too big: an image may weigh {max} at most.',
    attachTooMany: 'A turn carries at most {max} images, so {name} was left out.',
    attachNoImages: '{provider} takes no images: send the prompt without them.'
  },

  /** The panel on the right of the chat: its tab strip, its launcher, its surfaces. */
  rightPanel: {
    label: 'Panel',
    toggle: 'Show or hide the panel',
    resize: 'Resize the panel, double-click to reset',
    maximize: 'Maximize the panel',
    restore: 'Restore the panel',
    newSurface: 'Open a surface',
    scrollLeft: 'Scroll the tabs left',
    scrollRight: 'Scroll the tabs right',
    close: 'Close',
    closeTab: 'Close {title}',
    closeOthers: 'Close others',
    closeToRight: 'Close to the right',
    closeAll: 'Close all',
    trace: 'Trace',
    traceHint: 'Processes this thread launched',
    browser: 'Browser',
    browserHint: 'A page beside the thread',
    desktopOnly: 'Only in the desktop app',
    ownerOnly: "Only in the owner's app",
    launcher: 'Open a surface in this panel',
    untitled: 'Browser'
  },

  browser: {
    back: 'Back',
    forward: 'Forward',
    reload: 'Reload',
    urlPlaceholder: 'Search or enter URL',
    openExternal: 'Open in the system browser',
    slotEmpty: 'The page opens here once the shell provides the webview'
  },

  trace: {
    exact: 'All child processes tracked',
    limited: 'Limited process tracking',
    finished: 'Finished',
    parent: 'Parent PID',
    cpuTime: 'CPU time',
    currentMemory: 'Memory now',
    active: 'active',
    recorded: 'recorded',
    exe: 'Executable',
    pid: 'PID',
    started: 'Started',
    duration: 'Duration',
    cpu: 'CPU',
    memory: 'Peak memory',
    io: 'I/O',
    exit: 'Exit',
    live: 'live',
    empty: 'This thread has launched no process yet.',
    modeLabel: 'Trace mode'
  },

  protection: {
    intro: 'Keep agents from interrupting your work and control what they use.',
    quiet: 'Peace and quiet',
    limits: 'Resource limits',
    tasks: 'Task manager',
    windows: 'Focus, audio and resource limits apply on the Windows host.',
  },
  resources: {
    heading: 'Protection',
    empty: 'No thread is using anything right now.',
    live: 'Live processes',
    totals: 'Totals',
    processes: 'processes',
    killTree: 'Kill tree',
    killConfirm: 'Kill every process of this thread?',
    killConfirmYes: 'Kill',
    killConfirmNo: 'Cancel',
    killed: 'Killed'
  },

  /** A provider whose files Boite downloads itself. Settings is the only place this shows. */
  install: {
    heading: 'Installed by Boite',
    action: 'Install',
    update: 'Update',
    retry: 'Install again',
    cancel: 'Cancel',
    remove: 'Remove',
    removeTitle: 'Remove {provider}?',
    removeBody: 'The files Boite downloaded go with it. It can be installed again later.',
    removeConfirm: 'Remove',
    removeCancel: 'Keep',
    absent: 'Not installed, {size}',
    verifying: 'Checking the archive',
    extracting: 'Unpacking',
    upToDate: 'Version {version}',
    updateAvailable: 'Version {installed}, {available} available',
    progress: 'Download progress'
  },

  accounts: {
    heading: 'Providers',
    empty: 'No account yet.',
    add: 'Add account',
    provider: 'Provider',
    label: 'Label',
    labelPlaceholder: 'How you will recognise it',
    useDefaultLocation: 'Use the provider default location (your real login)',
    create: 'Add',
    cancel: 'Cancel',
    check: 'Check',
    identity: 'Identity',
    isolation: 'Isolation directory',
    defaultLocation: 'provider default',
    login: 'Log in',
    loginStarting: 'Waiting for the provider CLI',
    loginOpen: 'Open this link to log in',
    loginInputPlaceholder: 'Paste the code the page gives you',
    loginRedirectPlaceholder: 'Paste the localhost redirect URL from the sign-in page',
    loginSend: 'Send',
    loginCancel: 'Cancel login',
    remove: 'Remove',
    removeTitle: 'Remove {account}?',
    removeBody: 'This deletes the account and its isolation directory. Accounts used by a thread cannot be removed.',
    removeDefaultBody: 'This removes the account from Boite. The provider login stays on this machine. Accounts used by a thread cannot be removed.',
    status: {
      unknown: 'unknown',
      ok: 'ok',
      unauthenticated: 'not logged in',
      error: 'error'
    }
  },

  usage: {
    heading: 'Usage',
    note: 'On a subscription this cost is an API equivalent, not money spent.',
    thread: 'Thread',
    input: 'Input',
    output: 'Output',
    cacheRead: 'Cache read',
    cacheWrite: 'Cache write',
    cost: 'API equivalent',
    total: 'Total',
    empty: 'No token spent yet.',
    today: 'today'
  },

  settings: {
    heading: 'Settings',
    modelDefaults: 'Default models',
    modelDefaultsHint: 'Model and reasoning effort for new threads, per provider. Saved on this device. Existing threads keep their choices.',
    modelDefaultUnavailable: '{provider} does not offer the default model {model} on this account. Choose an available model in the picker or change the default in Settings.',
    tabs: {
      general: 'General',
      appearance: 'Appearance',
      keyboard: 'Keyboard',
      accounts: 'Providers',
      plugins: 'Plugins',
      usage: 'Usage',
      resources: 'Protection',
      experiments: 'Experiments'
    },
    back: 'Back to threads',
    projects: 'Projects',
    projectsHint: 'Right-click a project in the sidebar to remove it from Boite.',
    projectsDevice: 'Folders are added and removed from the app the core runs in.',
    appearance: 'Appearance',
    /** The language the UI speaks, on this device. `system` follows the machine. */
    language: 'Language',
    languageHint: 'Saved on this device. System follows the language your machine is set to.',
    languageSystem: 'System',
    languageNames: { en: 'English', fr: 'Français' },
    theme: 'Theme',
    accent: 'Accent colour',
    accentHint: 'Reasoning, buttons, links and focus indicators',
    accentCustom: 'Custom accent colour',
    accentNames: ['Blue', 'Violet', 'Rose', 'Orange', 'Amber', 'Green', 'Teal'],
    themeSystem: 'System',
    themeDark: 'Dark',
    themeLight: 'Light',
    themeGrain: 'Grain',
    experiments: {
      heading: 'Experiments',
      intro: 'These are unfinished. They may change shape or leave in a later build.'
    },
    material: 'Window material',
    materialHint: 'What Windows draws behind the window',
    materialAcrylic: 'Acrylic',
    materialMica: 'Mica',
    materialSolid: 'Solid',
    connection: 'Connection',
    localCore: 'This app runs on the core it started on this computer.',
    coreAt: 'Connected to the core at {url}.',
    pairingLink: 'Pairing link',
    pairingLinkPlaceholder: 'http://host:port/?grant=',
    pair: 'Pair',
    pairHint:
      'Paste a link minted by the other core, from its own Settings or with boite-core pair --owner on the machine it runs on. The key it becomes stays on this computer.',
    useLocal: "Use this computer's core",
    useLocalHint: 'The remembered cores below stay remembered.',
    environments: 'Remembered cores',
    environmentsHint: 'Paired or connected cores stay here. Switching back needs no new link: the key stays until revoked there or forgotten here.',
    envCurrent: 'current',
    envSwitch: 'Switch',
    envForget: 'Forget',
    manual: 'Core URL and token',
    coreUrl: 'Core URL',
    token: 'Token',
    connect: 'Connect',
    scheduler: 'Scheduler',
    maxConcurrentTurns: 'Max concurrent turns',
    perAccountConcurrency: 'Per account concurrency',
    warmProcessMinutes: 'Warm process minutes',
    listenOnLan: 'Listen on the LAN so a phone can pair',
    listenOnLanHint: 'Takes effect the next time the core starts, and a --host or --lan flag wins over it',
    agentCpuCapPercent: 'CPU cap for all agents, percent of the machine (0 = none, Windows)',
    threadMemoryCapMb: 'Memory cap per thread tree, MB (0 = none, Windows)',
    background: 'Background',
    closeToTray: 'Keep Boite running when the window closes',
    closeToTrayHint: 'Off by default. Enable to hide to the notification area and keep turns running. Quit always stops Boite.',
    notifications: 'Notify me when a thread finishes or asks something',
    notificationsHint: 'A toast for a thread you are not looking at, or when Boite is not the window in front. This machine only.',
    notificationsDenied: 'Notifications are blocked for Boite on this system; allow them in its settings.',
    focusGuard: 'Keep agent windows out of the foreground',
    focusGuardHint: 'Windows an agent opens are sent behind Boite instead of taking your focus',
    muteAgents: 'Mute agent audio',
    muteAgentsHint: 'Sounds an agent process plays never reach your speakers',
    save: 'Save',
    saved: 'Saved',
    core: 'Core',
    version: 'Version',
    protocol: 'Protocol',
    os: 'OS',
    pid: 'PID',
    dataDir: 'Data directory',
    endpoint: 'Endpoint',
    noCore: 'Not connected to a core.',
    pairing: {
      heading: 'Phones and other devices',
      intro: 'A pairing link opens Boite on another device with a key of its own. It works once and for ten minutes.',
      mint: 'New pairing link',
      copy: 'Copy link',
      expires: 'Works once, until {time}',
      qr: 'The pairing link as a QR code',
      scan: 'Scan the code with the phone, or open the link on it.',
      lanHint: 'The core listens on this machine only: turn on the LAN switch above, then restart it, before a phone can reach this link.',
      devices: 'Paired devices',
      noDevices: 'No device paired yet.',
      thisDevice: 'this device',
      lastSeen: 'seen {when}',
      revoke: 'Revoke',
      revokeTitle: 'Revoke this device?',
      revokeBody: 'It disconnects now and its key opens nothing any more. Pair it again with a new link.',
      paired: 'This device is paired with a key of its own. Pairing links are made from the desktop app.',
      owner: 'Full control',
      ownerHint:
        'For another computer of yours: its key drives this core as you do, accounts, projects and settings included. Leave it off for a phone.',
      ownerTag: 'full control',
      pasteOwner: 'Paste it in Settings, General, on the other computer.'
    }
  },

  /** The Keyboard settings page: the table, the file, and the commands the palette has no word for. */
  keyboard: {
    heading: 'Shortcuts',
    intro: 'Every chord Boite answers to. Change one in the file below: it is read the moment it is saved, no restart.',
    file: 'The file',
    fileHint:
      'A JSON object of command ids to chords, "mod+shift+k" style, or null to take a key away. mod is Ctrl here and Cmd on a Mac. Only the entries you name change; the rest keep their default.',
    example: 'Example',
    command: 'Command',
    id: 'Id',
    chord: 'Chord',
    none: 'none',
    custom: 'from the file',
    problems: 'Refused',
    problemsHint: 'These lines of the file were not applied. Fix them and save; the rest of the file is in use.',
    commands: {
      palette: 'Open the command palette',
      browser: 'Open the browser surface',
      closeSurface: 'Close the active surface',
      stash: 'Stash the composer text, or take it back',
      sendAndDraft: 'Send and open a new draft',
      pin: 'Pin or unpin this thread'
    }
  },

  experiments: {
    themeGrain: {
      title: 'Grain theme',
      hint: 'A grainy ground fading from light grey at the top left to black at the bottom right'
    },
    sessionImport: {
      title: 'Claude Code session import',
      hint: 'Turn a session started in the terminal into a thread, from the project menu and the palette'
    }
  },

  quotas: {
    trayHeading: 'Usage',
    trayIntro: 'Subscription limits',
    names: { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', grok: 'Grok', opencode: 'OpenCode Go' },
    off: 'Off',
    noReading: 'Unavailable',
    notConnected: 'Not connected',
    autoConnect: 'Uses your connected account',
    cliSource: 'Antigravity CLI account',
    cliHint: 'Uses the account signed in through agy on this computer. Install Antigravity CLI 1.1.11 or later and sign in once, then enable monitoring below. Separate from Boite’s isolated Antigravity accounts.',
    connectHint: 'Connect {provider} once in Providers. Usage appears here automatically.',
    connect: 'Connect account',
    noReset: 'Reset time not reported',
    heading: 'Provider quotas',
    intro: 'Subscription limits reported by your providers. Separate from tokens used in Boite.',
    remaining: '{percent}% left',
    resets: 'Resets {time}',
    checked: 'Updated {time}',
    stale: 'Last successful reading',
    empty: 'Connect a provider to see its subscription limits.',
    unsupported: 'This provider does not expose subscription quotas here.',
    disabled: 'Quota monitoring is off for this account.',
    loading: 'Reading provider limits',
    monitor: 'Monitor subscription quotas',
    providers: 'Manage providers',
    unavailable: 'No quota reading available.',
    refresh: 'Refresh quotas',
    quit: 'Quit Boite',
  },
  providerSettings: {
    heading: 'Providers',
    intro: 'Boite runs agents installed on the machine hosting your core. Existing command-line logins are detected automatically; website logins are separate.',
    installHint: 'Install {provider} to connect an account.',
    detectHint: 'After installing an agent, detect providers again. If it is still missing, restart Boite to refresh its PATH.',
    setup: 'Installation instructions',
    connect: 'Connect an account',
    connectInstalling: 'Installing the agent. Sign-in will start when the download finishes.',
    reinstall: 'The managed agent is installed but its executable is missing. Remove it and install it again.',
    reconnect: 'Reconnect',
    available: 'Ready on this machine',
    missing: 'Executable not found',
    executable: 'Executable',
    isolated: 'Boite login',
    default: 'CLI login',
    defaultHint: 'Uses your existing CLI login. To sign in through Boite, connect a separate account above.',
    isolatedHint: 'This login is kept separately from your command-line account.',
    modelCheck: 'Verify access and models',
    models: '{count} models available',
    refresh: 'Detect providers again',
  },
  plugins: {
    heading: 'Plugins',
    intro: 'Add tools to Boite. Each plugin runs on the machine hosting your core.',
    description: 'Save and switch Claude, Codex and Antigravity CLI logins, with quota readings for each saved account.',
    install: 'Install',
    installed: 'Installed',
    update: 'Update',
    remove: 'Uninstall',
    installing: 'Downloading verified release',
    source: 'Source code',
    empty: 'No saved account in this pool.',
    add: 'Save current CLI login',
    switch: 'Use this account',
    forget: 'Forget account',
    active: 'Active',
    refresh: 'Refresh saved accounts',
    removeTitle: 'Uninstall kebacc-switcher?',
    removeBody: 'Removes the plugin binary from Boite. Your saved logins stay in kebacc.',
    switchTitle: 'Change the CLI login?',
    switchBody: 'This changes the provider\'s default CLI login for future turns, including outside Boite. Isolated Boite accounts keep their own login.',
    forgetTitle: 'Forget this saved login?',
    forgetBody: 'Removes this login from kebacc\'s pool.',
    cliScope: 'These are the CLI account pools. They are separate from isolated accounts connected in Providers.',
  },

  time: {
    now: 'now'
  },

  errors: {
    prefix: 'Error',
    activityUnsupported: 'This core does not support goals or loops. Update Boite on {machine}, then reconnect. Your command has not been sent.',
    pullRequestUnsupported: 'Update Boite on the machine hosting this thread to show its pull request. This core does not support pull request lookup yet.',
    noEndpoint: 'No core endpoint could be resolved.',
    connect: 'Could not connect to the core.',
    clipboard: 'The clipboard refused the text.',
    revoked: 'This device was revoked from the desktop app. Open a new pairing link to connect again.',
    pairingLink: 'That is not a pairing link: it needs an http or https address carrying a grant.'
  },

  units: {
    bytes: 'B',
    kilobytes: 'kB',
    megabytes: 'MB',
    gigabytes: 'GB',
    milliseconds: 'ms',
    seconds: 's',
    minutes: 'min',
    hours: 'h',
    tokens: 'tokens'
  },

  common: {
    none: 'none',
    unknown: 'unknown',
    yes: 'yes',
    no: 'no',
    close: 'Close',
    refresh: 'Refresh',
    dismiss: 'Dismiss',
    cancel: 'Cancel',
    confirm: 'Confirm'
  },

  /**
   * The tour a machine sees once, the first time Boite opens on it. Every
   * screen carries the switch for what it explains, so reading it and setting
   * it up are the same pass.
   */
  onboarding: {
    label: 'Getting started',
    skip: 'Skip',
    back: 'Back',
    next: 'Next',
    done: 'Open Boite',
    step: 'Step {index} of {total}',
    progress: 'Go to step {index}: {title}',
    replay: 'Show the tour again',
    replayHint: 'The same screens as the first launch. Nothing you have set is undone.',
    changeLater: 'All of this is in Settings afterwards.',

    welcome: {
      title: 'Boite runs your agents',
      body: 'One conversation per task, each one in a project folder, all of them side by side. The agents run on the machine hosting this core, not in this window, so a turn keeps going while you do something else.',
      pick: 'Two things worth picking now.'
    },

    /** Switching model inside a live conversation, the composer's picker. */
    agents: {
      title: 'Change the agent inside a conversation',
      body: 'The chip at the bottom left of the composer holds every provider you connected, its accounts and its models. Change the model in the middle of a thread and nothing is lost: the history stays, and the process already running is told rather than dropped.',
      effort: 'The chip beside it sets how hard the model thinks, on that model\'s own scale.',
      locked: 'A thread keeps the provider and the account it started on. The model and the reasoning effort change whenever you want.',
      demoModel: 'Claude Sonnet 5',
      demoEffort: 'High',
      demoMode: 'Ask'
    },

    /**
     * Dictation. The screen is written and translated; `VOICE_STEP` in
     * `lib/onboarding.ts` is what puts it in the tour, once the feature it
     * describes has landed.
     */
    voice: {
      title: 'Talk instead of typing',
      body: 'Hold the microphone in the composer and speak. The recording is transcribed on the machine hosting this core and lands in the box as text, which you read before anything is sent.',
      hint: 'Pick an engine once and dictation works in every conversation, on the phone as well.',
      open: 'Voice settings'
    },

    /** The quota bars and the token count, and the switch that fills them. */
    usage: {
      title: 'See what you are spending',
      body: 'Your providers report how much of your subscription is left. Boite draws one bar per window with the hour it resets, in the tray and on the Providers page.',
      tokens: 'Tokens spent inside Boite are counted apart, in Settings, Usage, with what the same turns would have cost on the API.',
      monitor: 'Read subscription limits for {account}',
      noAccounts: 'No provider account yet. Connect one and its limits appear here on their own.',
      connect: 'Connect a provider',
      deviceHint: 'Limits are read on the machine hosting the core.'
    },

    /** The two ways this core reaches further: a phone, and another core. */
    reach: {
      title: 'Your phone, and your other machines',
      phone: 'On your phone',
      phoneBody: 'A one-time link, or the QR code beside it, opens Boite on your phone with a key of its own. Same conversations, and a notification when a turn finishes or asks you something.',
      pair: 'Pair a phone',
      machines: 'Another Boite',
      machinesBody: 'This app also drives a Boite running somewhere else, a server or a second computer. Connect it once and its projects and threads sit beside the local ones, each machine still running its own agents on its own files.',
      connect: 'Connect a machine',
      deviceHint: 'Pairing and machines are managed from the app the core runs in.'
    },

    /** The switches everyone ends up looking for on the first evening. */
    quiet: {
      title: 'Agents that do not interrupt you',
      body: 'Boite is built to run while you work on something else. These are the switches worth deciding now.',
      windows: 'The last two apply on a Windows host and are ignored elsewhere.',
      deviceHint: 'Focus and audio are settings of the machine hosting the core.'
    },

    /** The last screen, and the only one that does something irreversible: it opens a folder. */
    project: {
      title: 'Open your first project',
      body: 'A project is the folder an agent works in. Threads live inside it, and an agent sees nothing outside it unless you point it there.',
      opened: '{count} project open. You can add more from the sidebar.',
      openedMany: '{count} projects open. You can add more from the sidebar.',
      deviceBody: 'Projects are opened from the app the core runs in. The ones it holds show up here on their own.'
    }
  }
} as const;

export type Strings = typeof strings;

/** `fill('New thread in {project}', { project: 'boite' })`. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
