export const strings = {

  experiments: {
    pinnedQuotas: { title: 'Pinned model quotas', hint: 'Pin the current model provider limits in a corner of the conversation or below the thread list' },
    recordingIndicators: { title: 'Show actions in recordings', hint: 'Add click markers and navigation keys to browser recordings. Typed text and password input are never shown as key labels.' },
    whip: {
      title: 'Whip',
      hint: 'An animated whip follows your pointer or finger. Flick to crack it, click or tap to drop it',
      action: 'Throw the whip',
      drop: 'Drop the whip'
    },
    themeGrain: {
      title: 'Grain theme',
      hint: 'A grainy ground fading from light grey at the top left to black at the bottom right'
    },
    sessionImport: {
      title: 'Claude Code session import',
      hint: 'Turn a session started in the terminal into a thread, from the project menu and the palette'
    },
    promptCache: {
      title: 'Prompt cache timer',
      hint: 'A clock beside the context meter counting down how long the provider keeps the conversation cached'
    },
    residentAgents: {
      title: 'Bots',
      hint: 'Bots: persistent agents with their own brain, memory and routines, from the sidebar. Bots you already made keep running while this is off'
    },
    contacts: {
      title: 'Contacts',
      hint: 'A Home page beside Threads where you link your Boite with another owner\'s through Tailscale, so your agents and theirs work together on the projects each side opens. Not ready for everyday use'
    },
    autoGoal: {
      title: 'Automatic goals',
      hint: 'A long prompt starts a reviewed goal on itself, with its checklist and a card on the project board, and the agent may start one when a prompt lists several requests. Remove the goal from the goal bar to drop it',
      minChars: 'Prompt length',
      minCharsHint: 'A prompt that starts a turn with at least this many characters starts an automatic goal',
      unit: 'characters'
    },
    teams: {
      title: 'Teams',
      hint: 'Bots that work together in a shared chat: a post wakes the bots it names, and each answers in the group or privately. Your bots post with boite team. Not ready for everyday use'
    }
  }
} as const;
