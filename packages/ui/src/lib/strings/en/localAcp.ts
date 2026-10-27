export const strings = {
  /** Settings > Providers: an ACP agent added from the command that starts it. */
  localAcp: {
    heading: 'Local ACP command',
    hint: 'Any agent that speaks ACP, started from its own command. It keeps its own sign-in and settings, and lists its models itself. Each argument is passed exactly as written, with no shell.',
    open: 'Add',
    name: 'Name',
    namePlaceholder: 'My agent',
    commandPlaceholder: 'my-agent',
    command: 'Command',
    commandHint: 'A program on PATH, or its full path. On Windows, the program itself rather than a .cmd launcher.',
    args: 'Arguments',
    /** An argument field's accessible name: `{n}` is its position from 1. */
    arg: 'Argument {n}',
    addArg: 'Add argument',
    env: 'Environment',
    envHint: "Saved in plain text in the provider file. Keep API keys in the agent's own sign-in.",
    envName: 'Variable',
    envValue: 'Value',
    addEnv: 'Add variable',
    removeRow: 'Remove',
    save: 'Add provider',
    added: '{provider} added',
    source: 'Added here',
    remove: 'Remove provider',
    removeTitle: 'Remove {provider}?',
    removeBody: 'Boite deletes its provider file. Its accounts and conversations stay, and come back if you add it again under the same name.'
  }
} as const;
