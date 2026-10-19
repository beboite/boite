export const strings = {
  updateAll: {
    heading: 'Updates',
    trigger: 'Updates available',
    busy: 'Updating',
    run: 'Update all',
    app: 'Update the app',
    retry: 'Try again',
    later: 'Remind me later',
    restarts: 'Boite downloads its release, then asks to restart. Threads resume where they were.',
    summary: (count: number) => count === 1 ? '1 update' : `${count} updates`,
    downloading: (percent: number | null) => percent === null ? 'Downloading' : `Downloading ${percent}%`,
    ready: 'Restart to finish',
    restartsNext: 'Restart once the agents are done',
    waiting: 'Waits for work to finish',
    installing: 'Restarting',
    updating: 'Updating',
    waitingFor: (count: number) => count === 1 ? 'Waits for a thread to pause' : `Waits for ${count} threads to pause`,
    failed: 'Failed',
    done: 'Up to date',
    allDone: 'Everything is up to date',
    finish: 'Boite is ready: restart it to finish.',
    restart: 'Restart'
  }
} as const;
