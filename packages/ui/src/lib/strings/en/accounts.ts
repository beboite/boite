export const strings = {

  accounts: {
    heading: 'Providers',
    login: 'Sign in',
    loginStarting: 'Starting the sign-in',
    loginOpen: 'Open the sign-in page',
    loginHint: 'Finish in your browser. This row turns ready on its own.',
    loginInputPlaceholder: 'Paste the code the page gives you, if it gives one',
    loginRedirectPlaceholder: 'On another device? Paste the localhost address the page ends on',
    loginSend: 'Send',
    terminalHint: 'Answer its questions in the terminal, then close it once you are signed in.',
    terminalDone: 'Close the terminal',
    remove: 'Remove',
    removeTitle: 'Remove {account}?',
    removeBody: 'This signs the account out of Boite and deletes its files.',
    removeDefaultBody: 'Boite stops using this login. It stays signed in on your computer.',
    removeThread: '1 conversation still uses this account. Its next message moves it to another signed-in account of the same agent, which reloads its whole context.',
    removeThreads: '{count} conversations still use this account. The next message in each moves it to another signed-in account of the same agent, which reloads its whole context.',
    removed: 'Account removed',
    removedHint: 'The account of this conversation was removed. Choose a model on another account to continue.',
    status: {
      unknown: 'unknown',
      ok: 'ok',
      unauthenticated: 'not signed in',
      error: 'error'
    }
  }
} as const;
