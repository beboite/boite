export const strings = {
  harnessUpdates: {
    heading: 'Agent updates',
    intro: 'Each machine checks its own agents every six hours.',
    auto: 'Update agents automatically',
    autoHint: 'An agent updates with nobody connected: a running thread pauses after its tool call and goes on once the update is done',
    checking: 'Checking',
    available: (name: string, version: string) => `${name} ${version} is available`,
    availableShort: 'Update available',
    installed: (version: string) => `Installed: ${version}`,
    on: (machine: string) => `On ${machine}`,
    update: 'Update', skip: 'Skip',
    updating: (name: string) => `Updating ${name}`,
    waiting: (count: number) => count === 1 ? 'Waits for a thread to pause' : `Waits for ${count} threads to pause`,
    failed: (name: string) => `${name} did not update`,
    upToDate: 'Up to date', unknown: 'Checks by itself', runUpdater: 'Run its updater',
    skipped: (version: string) => `${version} skipped`,
    unskip: 'Offer it again', none: 'No agent on this machine has an updater Boite can run.',
    route: { managed: 'Installed by Boite', self: 'Your own install' }
  }
} as const;
