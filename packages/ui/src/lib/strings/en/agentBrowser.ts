export const strings = {
  /** The browser the conversation's agent drives on the machine that runs it, watched from any client. */
  agentBrowser: {
    cover: 'This agent controls a browser on {machine}', coverHint: 'Nothing streams to this device until you show it.',
    show: 'Show', hide: 'Hide', hideHint: 'Stop watching and cover the view again',
    none: 'The agent has no browser open', noneHint: 'It appears here when the agent opens a page.',
    unavailable: 'No agent browser on {machine}', tabs: 'The agent’s tabs', untitled: 'Untitled page',
    newTab: 'New tab', closeTab: 'Close {name}', newTabHint: 'Open a page in this conversation’s browser on {machine}. The agent sees it and can use it.'
  }
} as const;
