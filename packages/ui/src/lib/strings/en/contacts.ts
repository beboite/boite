export const strings = {

  /** Contacts: the column on the right, one contact's page, and the page that adds one with Tailscale and the settings. */
  contacts: {
    heading: 'Contacts',
    intro: 'Other owners\' Boites. Your agents and theirs work together on the projects each side shares, and on nothing else.',
    tip: 'A contact never sees your other projects, your machines or your other contacts.',
    loadFailed: 'Could not read the contacts.',
    retry: 'Retry',
    stale: 'This machine is disconnected: what shows may be out of date.',
    /** The column's button and its empty row. */
    add: 'Add a contact',
    /** The title bar's button that folds the column on the right. */
    rail: { show: 'Show contacts', hide: 'Hide contacts', home: 'Contacts home' },
    waiting: '{count} waiting',
    link: { connected: 'Connected', connecting: 'Connecting', offline: 'Offline' },
    lastSeen: 'Seen {time}',
    rename: 'Rename {name}',
    nameLabel: 'Contact name',
    trusted: 'Trusted',
    trustedTip: 'Its requests can open a project without you: one whose git remote matches, otherwise the one the concierge agent picks. A request it cannot place waits for you. Its messages reach your agents without waiting for you. Reading conversations is never granted that way.',
    youShare: 'You share with {name}',
    theyShare: '{name} shares with you',
    nothingOpen: 'Nothing yet',
    openProject: 'Share a project',
    openTo: 'Share a project with {name}',
    noProject: 'Every project is already shared',
    read: 'Read',
    readTip: 'Its agents may read this project\'s conversations, not only write to its threads. Off by default.',
    readLabel: 'Let {name} read {project}',
    closeProject: 'Stop sharing {project}',
    /** The compact board beside a shared project: its cards per column, a click opens the board. */
    board: 'Open the {project} board',
    closeTitle: 'Stop sharing {project} with {name}?',
    closeBody: 'Its letters waiting for this project are rejected and its threads leave {name}\'s directory.',
    closeConfirm: 'Stop sharing',
    about: 'This contact',
    words: 'Check words',
    wordsTip: 'Both owners see the same eight words. If the other owner reads different ones, someone sits between you: remove the contact.',
    role: { host: 'It dials your machine', guest: 'You dial its machine' },
    added: 'Added {time}',
    remove: 'Remove',
    removeHint: 'Stops sharing every project and closes the link.',
    removeTitle: 'Remove {name}?',
    removeBody: 'Every project you share with it closes, letters waiting both ways are rejected and the link closes. The Tailscale share stays until you remove it in the admin console.',
    requests: {
      title: 'Requests',
      review: 'Review the contact request',
      pending: '{count} contact requests waiting',
      asks: '{contact} asks',
      asked: 'You asked {contact}',
      remote: 'Git remote',
      accept: 'Accept',
      acceptLabel: 'Accept: pick the project to share',
      refuse: 'Refuse',
      reason: 'Reason',
      reasonPlaceholder: 'Why, in a sentence the asking agent reads',
      send: 'Send',
      cancel: 'Cancel',
      decided: 'Decided ({count})',
      accepted: 'Shared {project}',
      refused: 'Refused',
      by: { owner: 'Owner', match: 'Match', concierge: 'Concierge' },
      byTip: { owner: 'Decided by the owner.', match: 'Its git remote matched exactly one project.', concierge: 'Decided by the concierge agent for a trusted contact.' }
    },
    /** Mail a contact sent outside a shared project, held until the owner delivers it to the agent it was written to. */
    mail: {
      title: 'Messages',
      tip: 'Sent outside a shared project: no agent reads it until you deliver it. A trusted contact\'s messages reach your agents directly.',
      writes: '{contact} writes to {thread}',
      from: 'Sent from: {thread}',
      until: 'Waits until {time}',
      deliver: 'Deliver',
      deliverTip: 'The agent of {thread} reads it as written.',
      refuse: 'Refuse',
      refuseTip: 'The sender reads that you refused it.',
      details: 'Details',
      pending: '{count} contact messages waiting'
    },
    invite: {
      title: 'Invite someone',
      tip: 'A one-time link, valid 24 hours. Whoever holds it can join, so send it like a password.',
      pick: 'Copies a link. Where is the person?',
      /** Already reaches this machine on Tailscale: the link goes alone. */
      tailnet: 'Already on my Tailscale',
      tailnetTip: 'On your tailnet, or this machine is already shared with them: the link alone, no share.',
      /** On their own tailscale.com tailnet: the link also shares this machine through Tailscale. */
      create: 'On another Tailscale',
      createTip: 'On their own tailscale.com tailnet: the link also shares this machine with them.',
      /** Headscale, another network or no Tailscale: the link reaches this machine through Tailscale Funnel. */
      internet: 'Elsewhere',
      internetTip: 'Headscale, another network or no Tailscale: the link reaches this machine over the internet through Tailscale Funnel, on Boite\'s contact routes only.',
      internetOld: 'This Boite is too old to invite someone on another network: update it first.',
      /** Under the buttons when this machine's tailnet is not a tailscale.com one. */
      selfHosted: 'Your tailnet is not on tailscale.com, so it can neither share this machine nor open Funnel. For someone on another network, they invite you.',
      link: 'Invitation link',
      copy: 'Copy',
      copied: 'Link copied',
      expires: 'Works once, until {time}',
      shared: 'Tailscale share created',
      noShare: 'No share: for someone already on your Tailscale',
      funnel: 'Reachable over the internet through Tailscale Funnel while a contact or an invitation needs it',
      /** Under a link for another network: whether a request from the internet reaches this machine yet. */
      reach: {
        checking: 'Checking that the internet reaches this machine…',
        ready: 'The internet reaches this machine: the link is ready to send',
        unknown: 'Public DNS did not answer this machine, so Boite cannot tell yet whether the internet reaches it',
        wait: 'Wait before sending the link.',
        unpublished: 'Tailscale has not put this machine\'s address on the internet yet, which usually takes a few minutes. Boite checks every 30 seconds and turns Funnel off and on again after 10 minutes.',
        repaired: 'Boite turned Funnel off and on again so that Tailscale publishes this machine\'s address, and is checking again…',
        stillUnpublished: 'Tailscale still has not put this machine\'s address on the internet, even after Funnel was turned off and on again. Restart Tailscale on this machine, then make a new invitation.',
        unreachable: 'This machine\'s address is on the internet, but requests do not reach Boite. Check that Tailscale is running here.',
        moved: 'Funnel moved to another port since this link was made, so it no longer reaches this machine. Make a new invitation.'
      },
      manual: 'Share this machine by hand',
      openConsole: 'Tailscale admin console',
      /** How many links sent from this machine can still join it. */
      open: 'Open invitations: {count}',
      cancel: 'Cancel them',
      cancelTip: 'Every link not used yet stops working, a leaked one included. Contacts already joined stay. A Tailscale share a link carried stays too: remove it in the Tailscale admin console.'
    },
    join: {
      title: 'Join a contact',
      tip: 'Paste the link another owner sent you.',
      label: 'Invitation link',
      placeholder: 'boite://contact#',
      submit: 'Join',
      joining: 'Joining',
      /** The inviter's Funnel address is not in public DNS yet: the same join goes again. */
      waiting: 'The inviter\'s address is not on the internet yet. Boite joins again every 30 seconds until {time}.',
      stop: 'Stop',
      acceptShare: 'Accept the Tailscale share',
      acceptShareTip: 'This invitation shares the other machine through Tailscale. Without an API key here, accept the share in your browser first, then join.',
      compare: 'Compare with {name}',
      compareTip: 'Read these eight words to each other, on a call or in person. The same words on both screens mean nobody sat between you.',
      done: 'Done'
    },
    tailscale: {
      title: 'Tailscale',
      tip: 'Tailscale carries the link between owners, each on their own tailnet. With an API key, invitations share this machine themselves and the policy is read.',
      configure: 'Configure',
      noTailnet: 'Not on a tailnet',
      key: 'API key',
      keyStored: 'Stored',
      keyMissing: 'None',
      keyPlaceholder: 'tskey-api-',
      keyTip: 'Kept by the core and never shown again. It creates and accepts machine shares and reads the policy.',
      save: 'Save',
      clear: 'Clear',
      policy: 'Policy',
      policyIs: 'Policy: {state}',
      state: { restricted: 'Restricted', open: 'Open', unknown: 'Unknown' },
      stateTip: {
        restricted: 'Shared users reach only Boite\'s port on this machine.',
        open: 'A shared user may reach other ports of this machine. Add these lines to the tailnet policy.',
        unknown: 'No API key, or the policy could not be read. Check it in the admin console.'
      },
      copy: 'Copy the lines',
      copied: 'Copied'
    },
    settings: {
      title: 'Settings',
      minTier: 'Weakest model allowed',
      minTierTip: 'An agent on a weaker model cannot write to a contact or ask one, and a contact\'s letter from one is refused. Frontier: Opus, Fable, GPT-6 class. Mid: Sonnet, high Flash. Small: Haiku, Lite, open models. An unknown model counts as mid.',
      tiers: { frontier: 'Frontier', mid: 'Mid', small: 'Small' }
    }
  }
} as const;
