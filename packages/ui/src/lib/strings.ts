/** Every user-facing string of the UI. No literal UI text lives anywhere else. */
export const strings = {
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
    removeProject: 'Remove from Boite',
    removeProjectTitle: 'Remove {project} from Boite?',
    removeProjectBody: 'Its threads go with it. Files on disk stay where they are.',
    remove: 'Remove',
    threadMenu: 'Thread actions',
    open: 'Open',
    rename: 'Rename',
    pin: 'Pin',
    unpin: 'Unpin',
    pinned: 'Pinned',
    archive: 'Archive',
    draft: 'New thread'
  },

  permissionMode: {
    default: 'Ask',
    acceptEdits: 'Accept edits',
    bypassPermissions: 'Bypass',
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
    changeProject: 'Change project'
  },

  chat: {
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
    probing: "Reading the agent's models",
    notInstalled: 'Not installed on this machine',
    installInSettings: 'Install in Settings',
    reasoning: 'Reasoning',
    effortTitle: 'Reasoning effort',
    newBadge: 'new',
    lockedHint: 'A thread keeps its provider and account',
    mode: 'Permissions',
    model: 'Model',
    unavailable: 'not installed',
    noAccount: 'no account',
    noProvider: 'No provider',
    hint: 'Enter to send, Shift+Enter for a new line'
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

  resources: {
    heading: 'Resources',
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
    tabs: {
      general: 'General',
      appearance: 'Appearance',
      accounts: 'Providers',
      plugins: 'Plugins',
      usage: 'Usage',
      resources: 'Resources',
      experiments: 'Experiments'
    },
    back: 'Back to threads',
    projects: 'Projects',
    projectsHint: 'Right-click a project in the sidebar to remove it from Boite.',
    appearance: 'Appearance',
    theme: 'Theme',
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
      lanHint: 'The core listens on this machine only: turn on the LAN switch above, then restart it, before a phone can reach this link.',
      devices: 'Paired devices',
      noDevices: 'No device paired yet.',
      thisDevice: 'this device',
      lastSeen: 'seen {when}',
      revoke: 'Revoke',
      revokeTitle: 'Revoke this device?',
      revokeBody: 'It disconnects now and its key opens nothing any more. Pair it again with a new link.',
      paired: 'This device is paired with a key of its own. Pairing links are made from the desktop app.'
    }
  },

  experiments: {
    themeGrain: {
      title: 'Grain theme',
      hint: 'A grainy ground fading from light grey at the top left to black at the bottom right'
    }
  },

  quotas: {
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
    intro: 'Connect accounts, verify access and choose which quotas to monitor.',
    connect: 'Connect an account',
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
    noEndpoint: 'No core endpoint could be resolved.',
    connect: 'Could not connect to the core.',
    clipboard: 'The clipboard refused the text.'
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
  }
} as const;

export type Strings = typeof strings;

/** `fill('New thread in {project}', { project: 'boite' })`. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
