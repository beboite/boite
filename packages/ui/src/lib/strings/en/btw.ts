export const strings = {
  /** The composer's slash menu: the agent's own commands over Boite's. */
  btw: {
    fork: 'Fork', forking: 'Forking',
    title: 'Side question', description: 'Ask a side question without interrupting the agent',
    loading: 'Answering your side question', close: 'Close the side answer',
    needsThread: 'Open a conversation before asking a side question.',
    questionRequired: 'Type a question after /btw.',
    textOnly: 'Side questions take text only. Remove attachments and preview references first.',
    editing: 'Finish or cancel the message edit before asking a side question.',
    offline: 'Reconnect this machine before asking a side question.'
  }
} as const;
