export const strings = {

  /** The guided connection: from "nothing works yet" to a composer on a signed-in agent. */
  connect: {
    button: 'Connect an AI',
    title: 'Connect an AI',
    intro: 'Boite works with an AI subscription you already have. Pick it, Boite installs what it needs and opens its sign-in page.',
    more: 'Other agents',
    plan: {
      claude: 'Uses a Claude Pro or Max plan',
      codex: 'Uses a ChatGPT plan'
    },
    otherPlan: 'Uses your {provider} account',
    install: 'Install {provider}',
    installNote: 'Downloads {size}. Nothing else changes on this computer.',
    signIn: 'Sign in to {provider}',
    signInNote: 'Your browser opens the sign-in page. Come back here once it says you are connected.',
    manual: '{provider} installs with its own installer. Run it, then check again here.',
    manualOpen: 'Open the installer page',
    external: '{provider} signs in from its own window. Sign in there, then check again.',
    checkAgain: 'Check again',
    ready: '{provider} is connected.',
    use: 'Use {provider}',
    back: 'Back',
    device: 'No AI is connected on the computer running Boite yet. Connect one from that computer.',
    reconnect: 'Sign in again',
    signedOut: '{provider} is signed out'
  }
} as const;
