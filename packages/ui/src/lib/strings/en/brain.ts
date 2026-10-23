export const strings = {

  brain: {
    heading: 'Brain', description: 'Your agents share the same instructions and skills.',
    folder: 'Brain folder', pathHint: 'Folder path', save: 'Connect folder', browse: 'Browse', useFolder: 'Choose this folder',
    enabled: 'Share instructions automatically', enabledHint: 'Adds instructions and the skill catalog to each turn. Manual /skill commands stay available while the folder is connected.',
    disconnect: 'Disconnect', sync: 'Synchronize', working: 'Working',
    empty: 'Connect your brain', emptyHint: 'Choose the folder with your instructions and skills.',
    change: 'Change folder',
    autoPull: 'Pull automatically', onStartup: 'At startup', periodic: 'Periodically', minutes: 'min',
    globalInstructions: 'Global AGENTS.md', globalDetails: 'Connected harnesses',
    globalHint: 'Uses this brain in every project, including outside Boite. Existing files are backed up and restored when disabled.',
    boiteGuide: 'Boite guide', boiteGuideHint: 'A note after AGENTS.md when an agent session starts: the boite command and the panel. About 300 tokens.',
    linked: 'Linked', existing: 'Already linked', blocked: 'Needs attention',
    interval: 'Pull interval in minutes', intervalHint: 'Choose a whole number from 1 to 1440 minutes.',
    detected: 'Contents', instructions: 'Instructions', skill: 'Skills', plugin: 'Plugins',
    pluginHint: 'Detected here. Install plugins through their agent.',
    details: 'Sync details', noGit: 'Local folder. Connect a Git repository to sync between computers.',
    noUpstream: 'Set an upstream branch in Git to enable sync.', dirty: 'Commit your changes in Git before syncing.',
    counts: '{ahead} to send, {behind} to receive', lastSync: 'Last synchronized', never: 'Not synchronized yet',
    upToDate: 'Up to date', noEntries: 'Nothing detected in this category.',
    missing: 'Update Boite on this machine to connect a brain.',
  }
} as const;
