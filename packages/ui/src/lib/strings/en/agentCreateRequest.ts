export const strings = {
  /** A card asking the user to create a bot (`agents.settings.create`). */
  agentCreateRequest: {
    heading: 'Suggested new bot',
    create: 'Create',
    refuse: 'Refuse',
    show: 'Open',
    guestHint: 'Only the computer running Boite can create a bot.',
    access: 'It runs with full access, like a bot made on the Bots page, and introduces itself once created.',
    loadFailed: 'This bot creation card did not load.',
    name: 'Name',
    domain: 'Role',
    model: 'Model',
    projects: 'Projects',
    instructions: 'Instructions',
    noProjects: 'No project',
    noInstructions: 'None yet',
    /** Ends the model line, `Claude · Claude Opus 5.5 · Default effort`, when the card names no reasoning effort. */
    defaultEffort: 'Default effort',
    created: 'Created',
    refused: 'Refused',
    closed: 'Closed without an answer',
  }
} as const;
