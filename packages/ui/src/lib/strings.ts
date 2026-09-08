/** Every user-facing string of the UI. No literal UI text lives anywhere else. */
export const strings = {
  app: {
    name: 'Boite',
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
    close: 'Close'
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
    archive: 'Archive',
    draft: 'New thread'
  },

  permissionMode: {
    default: 'Ask',
    acceptEdits: 'Accept edits',
    bypassPermissions: 'Bypass',
    plan: 'Plan',
    dontAsk: 'Never ask'
  },

  permissionModeLong: {
    default: 'Ask before every tool call',
    acceptEdits: 'Accept edits, ask for the rest',
    bypassPermissions: 'Run everything without asking',
    plan: 'Plan only, no changes',
    dontAsk: 'Deny what would need asking'
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
    draftHint: 'Type a message to start this thread.'
  },

  chat: {
    you: 'You',
    assistant: 'Agent',
    system: 'System',
    toolInput: 'Input',
    toolOutput: 'Output',
    noOutput: 'No output',
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
    streaming: 'writing',
    jumpToLatest: 'Jump to latest',
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
    providers: 'Providers',
    models: 'Models',
    legacyModels: 'Legacy models',
    probing: "Reading the agent's models",
    reasoning: 'Reasoning',
    newBadge: 'new',
    lockedHint: 'A thread keeps its provider and account',
    mode: 'Permissions',
    model: 'Model',
    unavailable: 'not installed',
    noAccount: 'no account',
    noProvider: 'No provider',
    hint: 'Enter to send, Shift+Enter for a new line'
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

  accounts: {
    heading: 'Accounts',
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
    loginSend: 'Send',
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
      accounts: 'Accounts',
      usage: 'Usage',
      resources: 'Resources'
    },
    back: 'Back to threads',
    appearance: 'Appearance',
    theme: 'Theme',
    themeSystem: 'System',
    themeDark: 'Dark',
    themeLight: 'Light',
    connection: 'Connection',
    coreUrl: 'Core URL',
    token: 'Token',
    connect: 'Connect',
    scheduler: 'Scheduler',
    maxConcurrentTurns: 'Max concurrent turns',
    perAccountConcurrency: 'Per account concurrency',
    warmProcessMinutes: 'Warm process minutes',
    listenOnLan: 'Listen on the LAN so a phone can pair',
    agentCpuCapPercent: 'CPU cap for all agents, percent of the machine (0 = none, Windows)',
    threadMemoryCapMb: 'Memory cap per thread tree, MB (0 = none, Windows)',
    save: 'Save',
    saved: 'Saved',
    core: 'Core',
    version: 'Version',
    protocol: 'Protocol',
    os: 'OS',
    pid: 'PID',
    dataDir: 'Data directory',
    endpoint: 'Endpoint',
    pairingUrl: 'Pairing URL',
    noCore: 'Not connected to a core.'
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
    tokens: 'tok'
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
