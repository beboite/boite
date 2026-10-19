export const strings = {

  serverUpdate: {
    heading: 'Server',
    updates: 'Updates',
    current: 'Up to date',
    waiting: 'Waiting for work to finish',
    installing: 'Restarting the server',
    reconnecting: 'Reconnecting',
    progress: 'Server update download',
    release: 'What\'s new',
    details: 'Details',
    timing: 'Agents finish their current tool call, 30 seconds at most, then the server updates, restarts and resumes them. An agent update under way finishes first.',
    backup: 'Conversations and settings are backed up. If startup fails, the previous version is restored.',
    reconnect: 'Connected devices reconnect automatically.',
    confirmTitle: 'Update {machine}?',
    confirmBody: 'Agents finish their current tool call, 30 seconds at most. Version {version} then installs and they resume after the restart. Your conversations are backed up.',
    manualTitle: 'Manual update',
    docker: 'After agents finish, run this in the Compose directory:',
    manual: 'Use the guide to update this installation.',
    legacy: 'Update it once manually to enable this button.',
    guide: 'Update guide'
  }
} as const;
