export const strings = {
  /** The Hooks card under the brain (`HooksCard.svelte`): each agent's own hooks and the runs that did not pass. */
  hooks: {
    heading: 'Hooks',
    description: 'The scripts your agents run on their own events. The counts and the recent list start when Boite starts on this machine.',
    refresh: 'Refresh hooks',
    missing: 'Update Boite on this machine to see your hooks.',
    hookOne: '{count} hook', hookMany: '{count} hooks',
    moduleOne: '{count} module', moduleMany: '{count} modules',
    none: 'No hooks yet',
    notFound: 'Nothing found',
    runOne: '{count} run', runMany: '{count} runs',
    noRuns: 'No runs yet',
    blockedOne: '{count} blocked', blockedMany: '{count} blocked',
    failedOne: '{count} failed', failedMany: '{count} failed',
    skippedOne: '{count} skipped', skippedMany: '{count} skipped',
    sourceMissing: 'Not found',
    sourceError: 'Unreadable',
    unreadable: 'Could not read {path}',
    configOnly: 'Boite reads this configuration but does not see each run.',
    sharedOne: 'Shared with {count} separate account', sharedMany: 'Shared with {count} separate accounts',
    /** A separate account without a file the provider's own profile has: `{account}` its label. */
    accountMisses: '{account} does not get {path}',
    /** The providers without hooks, joined into one list: `{names}`. */
    withoutOne: '{names} does not run hooks.', withoutMany: '{names} do not run hooks.',
    recent: 'Recent',
    since: 'Since {time}',
    quiet: 'Nothing blocked or failed.',
    /** Under the newest runs, the older ones folded: `{count}` of them. */
    more: 'Show {count} more',
    outcomes: { blocked: 'Blocked', failed: 'Failed', stopped: 'Stopped', skipped: 'Skipped' },
  }
} as const;
