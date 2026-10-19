export const strings = {
  /** A card asking the user to change one setting of a persistent agent (`agents.settings.request`). */
  agentSettingRequest: {
    heading: 'Suggested change to {name}',
    apply: 'Apply',
    show: 'Open its settings',
    refuse: 'Refuse',
    guestHint: 'Only the computer running Boite can change an agent\'s settings.',
    projectsHint: 'Untick a project to leave it out.',
    entrust: 'Entrust',
    takeBack: 'Take back',
    loadFailed: 'This agent setting card did not load.',
    to: 'to',
    applied: 'Applied',
    changed: 'Set to {value} instead',
    refused: 'Refused',
    closed: 'Closed without an answer',
    on: 'On',
    off: 'Off',
    none: 'None',
    noProjects: 'No project',
    defaultEffort: 'Default',
    minutes: '{count} min',
    /** A plain question a persistent agent asked without stopping, shown in its conversation. */
    send: 'Send',
    keys: {
      projects: 'Projects',
      model: 'Model',
      effort: 'Reasoning effort',
      autoMemory: 'Update memory after each task',
      subagents: 'Subagents',
      maxRunMinutes: 'Maximum minutes per execution',
    },
  }
} as const;
