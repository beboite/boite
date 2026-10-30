export const strings = {
  /** Native desktop windows an agent captures with `boite window`, and the Window panel that shows one. */
  windows: {
    panel: {
      cover: 'An agent opened a window of {machine} here', coverHint: 'Nothing is captured until you show it.',
      show: 'Show', hide: 'Hide', hideHint: 'Stop watching and cover the view again',
      close: 'Close', closeHint: 'Close the Window panel; an agent can open it again',
      empty: 'No window is open in this conversation. An agent opens one with boite window watch.',
      readOnly: 'View only: nothing you do here reaches the window.',
      waiting: 'Waiting for the first picture…',
      picture: 'Live view of {process}'
    },
    capture: {
      screenshot: 'Screenshot', clip: 'Clip of {count} frames', stream: 'Live view',
      open: 'Open the capture of {process}', alt: 'Capture of {process}'
    },
    consent: {
      asks: '{agent} wants to capture {process}', asksRead: '{agent} wants to read {process}', anAgent: 'An agent',
      screenshot: 'A screenshot', clip: 'A short clip', stream: 'A live view in the Window panel',
      read: 'The names of its buttons and menus, to show you where to click',
      waits: 'The capture waits until {time}.',
      once: 'Allow once', always: 'Always for this project', refuse: 'Refuse',
      allowedOnce: 'Allowed once: {process}', allowedAlways: 'Always allowed in this project: {process}',
      refused: 'Refused: {process}', expired: 'Not answered in time: {process}'
    },
    settings: {
      allowedHeading: 'Allowed windows', allowedIntro: 'Apps whose windows agents of a project may capture without asking. A project adds one when you answer Always for this project on a capture request.',
      allowedEmpty: 'No app is allowed yet. Apps get added from a capture request in the conversation.',
      remove: 'Remove', removeTitle: 'Stop allowing {process}?', removeBody: 'Agents in {project} will ask again before capturing {process}.',
      exclusionsHeading: 'Never capture', exclusionsIntro: 'Executable names or paths no agent may capture, even with your permission.',
      always: 'Password managers and the sign-in screen are always excluded: {list}.',
      add: 'Add', addLabel: 'Executable name or path', placeholder: 'game.exe or C:\\Games\\game.exe',
      none: 'No other app is excluded.', removeExclusion: 'Stop excluding {name}'
    }
  }
} as const;
