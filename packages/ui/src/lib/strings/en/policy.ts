export const strings = {

  policy: {
    managed: 'Managed by your organization',
    lockedHint: 'Managed by your organization. The key {key} in {file} sets this, and only an administrator can change it.',
    heading: 'Managed by your organization',
    info: 'An administrator put a policy on this machine. Each setting listed here is locked to the value shown. Everything else stays yours.',
    file: 'Policy file',
    none: 'The file locks nothing.',
    failedClosed: 'The file cannot be read, so every setting it can lock takes its strictest value until it is fixed.',
    problemsTitle: 'Your organization\'s policy has problems',
    problemsInfo: 'Boite applies every valid key and keeps the strictest value for the others. Send these lines to your administrator.',
    problem: '{field}: expected {expected}',
    providerOff: 'Turned off by your organization',
    quotasOff: 'Your organization turned off quota reads on this machine, so no limit is read for your accounts.',
    browserOff: 'Your organization turned off the agent browser on {machine}.',
    keys: {
      analytics: 'Usage analytics',
      'updates.app': 'App updates',
      'updates.server': 'Server updates',
      'updates.agents': 'Agent updates',
      'providers.allow': 'Allowed providers',
      'providers.deny': 'Blocked providers',
      gateway: 'Subscription gateway',
      'gateway.allowedBaseUrls': 'Allowed gateway addresses',
      quotaReads: 'Quota reads',
      'plugins.install': 'Plugin installs',
      'plugins.recommended': 'Recommended plugin checks',
      issueReports: 'Issue reports',
      dictation: 'Dictation',
      'previews.remoteResources': 'Remote resources in previews',
      agentBrowser: 'Agent browser',
      'agentBrowser.searchUrl': 'Address bar search',
      'network.lan': 'Local network access',
      'network.tailscaleServe': 'Tailscale HTTPS',
      'network.groups': 'Groups',
      'network.contacts': 'Contacts',
      'network.push': 'Push notifications',
      pullRequests: 'Pull requests'
    },
    values: {
      on: 'Allowed',
      off: 'Off',
      basic: 'Basic at most',
      check: 'Check only',
      auto: 'Automatic',
      local: 'Local engines only',
      none: 'None'
    }
  }
} as const;
