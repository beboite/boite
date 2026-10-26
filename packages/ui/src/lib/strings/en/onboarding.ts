export const strings = {

  /**
   * The tour a machine sees once, the first time Boite opens on it. Every
   * screen carries the switch for what it explains, so reading it and setting
   * it up are the same pass.
   */
  onboarding: {
    /** Boite Legacy's trade offer: picking a row is the tour's last click. */
    privacy: {
      title: 'SELL YOUR SOUL TO BOITE!',
      intro: 'A few anonymous stats tell us what to fix first. Your messages, files and accounts never leave your machine.',
      question: 'Deal?',
      video: 'Trade offer meme',
      basic: 'NO! Just the basic counters',
      basicDefault: '(default)',
      basicHint: 'Anonymous counters, no profile.',
      deal: 'DEAL',
      dealHint: 'Also the models and settings you use. Thank you!',
      details: 'Basic: active installs under a hashed random ID, and launches, conversations and turn outcomes under IDs that change every day. No profile. Deal adds the public models you pick, reasoning level, speed and permission modes, durations and token volumes, under a stable random ID; private models count as "other". The app works the same either way, and Settings changes it anytime.',
      optOut: "If you REALLY don't want to help Boite:",
      offLabel: 'turn usage analytics off :c',
      doc: 'What is collected'
    },
    demo: {
      pause: 'Pause', play: 'Replay', resume: 'Resume',
      record: 'Click the microphone', speak: 'Speak your message', review: 'Review before sending',
      listening: 'Listening', draft: 'Your draft', localLabel: 'On this computer',
      chooseAgent: 'Choose the next agent', handoff: 'Codex picks up the conversation', checked: 'Labels checked. Contrast improved.', nextMessage: 'Message Codex',
      before: 'Before', after: 'After', buttonBefore: 'Send', buttonAfter: 'Send message', changedFile: 'ContactForm.svelte', changesReady: 'Two lines changed',
      background: 'Working in the background', writing: "Preparing tomorrow's launch", notes: 'Notes', noteOne: 'Review the new contact form', noteTwo: 'Publish the portfolio',
      taskResult: 'Contact form ready', loginResult: 'Login fixed', testsResult: 'Tests passed', hoverTray: 'Hover the Boite icon',
      conversation: 'Change agent', voice: 'Dictate', panel: 'Inspect changes',
      task: 'Build my portfolio', secondTask: 'Fix the login', thirdTask: 'Write the tests', working: 'Working', request: 'Add a contact form', answer: 'The form is ready.', followup: 'Now check the accessibility', continued: 'Same thread. Same history.',
      voiceWords: 'Make the buttons easier to read', voiceHint: 'Speak, review the draft, then send.',
      changes: 'Changes', reviewed: 'Review the changes beside the chat.',
      usageLabel: 'Claude', window: '5-hour limit', used: '24% used', reset: 'Resets in 2 h 10 min', trayHint: 'Hover the Boite icon to see your limits without opening the app.',
      desktop: 'Your computer', phone: 'Your phone', synced: 'The same conversation', reachHint: 'After pairing by QR code, follow your agents from your phone. Your computer keeps running them.',
      notification: 'Contact form finished', quietBody: 'Let your agents work without taking over your screen or your speakers.',
      installVoice: 'Install local dictation', downloadVoice: 'About 200 MB. Audio stays on this computer.', installingVoice: 'Downloading voice engine', cancelVoice: 'Cancel download', readyVoice: 'Dictation is ready. Use the microphone in the composer.',
    },
    label: 'Getting started',
    skip: 'Skip',
    back: 'Back',
    next: 'Next',
    done: "Let's Boite",
    step: 'Step {index} of {total}',
    progress: 'Go to step {index}: {title}',
    replay: 'Show the tour again',
    changeLater: 'All of this is in Settings.',

    /** The question the preset hangs on: said plainly, with a smile, so nobody is unsure which one they are. */
    profile: {
      title: 'First, which one are you?',
      everyday: "I'm not a developer! Don't confuse me with code and commands!",
      everydayHint: 'A new conversation waits in Documents/Boite until you give it a folder, and the agent asks before it acts.',
      developer: "I'm a developer, give me the works.",
      developerHint: 'The app opens on your last project, conversations show the terminal and the process trace, and the panel opens on the changes.',
      later: 'Nothing is taken away either way. Settings, Appearance shows or hides any button, one by one.'
    },

    welcome: {
      title: 'Boite runs your agents',
      body: 'One conversation per task. The agents keep working while you do something else.'
    },

    /** Switching model inside a live conversation, the composer's picker. */
    agents: {
      title: 'A conversation that follows your work',
      body: 'Switch agents, dictate a message, inspect the result. Stay in the same thread.',
    },

    /** Dictation: what it does, and where this core stands on setting it up. */
    voice: {
      title: 'Talk instead of typing',
      body: 'Press the microphone and speak. You read the text before it is sent.',
      open: 'Voice settings',
      reading: 'Reading the voice engine'
    },

    /** The panel on the right, each surface with its key. */
    panel: {
      title: 'The panel beside the conversation',
      body: 'Changes, files, tasks and a browser, one key away.',
      open: 'Keyboard shortcuts',
    },

    /** The quota bars, and the switch that fills them. */
    usage: {
      title: 'See what you have left',
      body: 'See which subscription is filling up and when it resets, even with Boite in the background.',
      monitor: 'Read subscription limits for {account}',
      connect: 'Connect a provider',
      deviceHint: 'Limits are read on the machine hosting the core.'
    },

    /** The two ways this core reaches further: a phone, and another core. */
    reach: {
      onPhoneTitle: 'Your computer does the work',
      onPhoneBody: 'This phone shows the conversations of your computer. The agents run there and keep going when you put the phone away.',
      onPhoneSettings: 'Notifications and the home screen app are in Settings.',
      title: 'Step away. Keep the conversation.',
      phone: 'On your phone',
      phoneBody: 'Scan a QR code and your phone gets the conversations of all your machines, with notifications.',
      pair: 'Add a device',
      machines: 'Another Boite',
      machinesBody: 'Drive a Boite running on a server or another computer from this app.',
      connect: 'Connect a machine',
      deviceHint: 'Pairing and machines are managed from the app the core runs in.'
    },

    /** The switches everyone ends up looking for on the first evening. */
    quiet: {
      title: 'Agents that do not interrupt you',
      deviceHint: 'Focus and audio are settings of the machine hosting the core.'
    },

    /** The last screen, and the only one that does something irreversible: it opens a folder. */
    project: {
      title: 'Open your first project',
      body: 'The folder an agent works in.',
    }
  }
} as const;
