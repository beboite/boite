/** Every user-facing string of the UI. No literal UI text lives anywhere else. */
export const strings = {
  app: {
    name: 'Boite',
    loading: 'Starting',
    noEndpointTitle: 'No core to connect to',
    noEndpointBody:
      'Open the pairing link from the desktop app, or set the core URL and token in Settings.'
  },

  nav: {
    threads: 'Threads',
    resources: 'Resources',
    accounts: 'Accounts',
    usage: 'Usage',
    settings: 'Settings'
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
    waiting: 'waiting',
    error: 'error'
  },

  sidebar: {
    newThread: 'New thread',
    noProjects: 'No project yet.',
    noThreads: 'No thread in this project.',
    unread: 'Unread',
    collapse: 'Collapse project',
    expand: 'Expand project',
    loadTitle: 'Live load'
  },

  newThread: {
    heading: 'New thread',
    project: 'Project',
    provider: 'Provider',
    account: 'Account',
    permissionMode: 'Permissions',
    title: 'Title',
    titlePlaceholder: 'What is this thread for',
    create: 'Create',
    cancel: 'Cancel',
    unavailable: 'unavailable',
    noAccounts: 'No account for this provider yet. Add one on the Accounts page.'
  },

  permissionMode: {
    default: 'Ask every time',
    acceptEdits: 'Accept edits',
    bypassPermissions: 'Bypass permissions',
    plan: 'Plan mode',
    dontAsk: 'Never ask'
  },

  thread: {
    chat: 'Chat',
    trace: 'Trace',
    none: 'No thread open',
    noneBody: 'Pick a thread on the left, or start a new one.',
    empty: 'Nothing said yet. Type below.',
    cwd: 'Working directory',
    model: 'Model',
    noModel: 'default model'
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
    permissionHeading: 'Permission requested',
    permissionBody: 'The agent wants to use',
    allow: 'Allow',
    deny: 'Deny',
    allowed: 'Allowed',
    denied: 'Denied',
    streaming: 'writing'
  },

  composer: {
    placeholder: 'Message the agent. Enter sends, Shift+Enter is a newline.',
    send: 'Send',
    stop: 'Stop',
    permissionMode: 'Permissions'
  },

  trace: {
    exe: 'Executable',
    pid: 'PID',
    started: 'Started',
    duration: 'Duration',
    cpu: 'CPU',
    memory: 'Peak memory',
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
    empty: 'No token spent yet.'
  },

  settings: {
    heading: 'Settings',
    connection: 'Connection',
    coreUrl: 'Core URL',
    token: 'Token',
    connect: 'Connect',
    scheduler: 'Scheduler',
    maxConcurrentTurns: 'Max concurrent turns',
    perAccountConcurrency: 'Per account concurrency',
    warmProcessMinutes: 'Warm process minutes',
    listenOnLan: 'Listen on the LAN so a phone can pair',
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

  statusBar: {
    running: 'running',
    queued: 'queued',
    noCore: 'no core'
  },

  errors: {
    prefix: 'Error',
    noEndpoint: 'No core endpoint could be resolved.',
    connect: 'Could not connect to the core.'
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
    dismiss: 'Dismiss'
  }
} as const;

export type Strings = typeof strings;
