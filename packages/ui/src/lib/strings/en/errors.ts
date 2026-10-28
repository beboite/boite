export const strings = {

  errors: {
    draftStorage: 'This device could not save your draft. Keep this window open and copy your text before closing it.',
    draftAttachment: 'An attachment could not be read from storage. Reload to recover it, or remove it before sending.',
    draftOverLimit: 'This draft holds more than one message may carry ({count} attachments, {max} in total), so your other devices cannot get it. It stays on this device: remove some attachments or split it.',
    prefix: 'Error',
    activityUnsupported: 'This core does not support goals or loops. Update Boite on {machine}, then reconnect. Your command has not been sent.',
    pullRequestUnsupported: 'Update Boite on the machine hosting this thread to show its pull request. This core does not support pull request lookup yet.',
    noEndpoint: 'No core endpoint could be resolved.',
    coreStart: 'The core on this computer did not start: {reason}',
    coreRetrying: 'Boite tries again by itself.',
    connect: 'Could not connect to the core.',
    clipboard: 'The clipboard refused the text.',
    revoked: 'This device was removed from the group. Add it again with a new code from one of your machines.',
    unpaired: 'This device is not in this machine\'s group yet. Add it with the code from Add a device.',
    olderCore: 'Boite on {machine} is too old for this. Update it in Settings, Machines and updates, then try again.',
    olderCoreHere: 'This machine runs a Boite too old for this. Update it in Settings, Machines and updates, then try again.',
    notConnected: '{machine} is not connected. Boite reconnects by itself once it answers again.',
    notConnectedHere: 'This machine is not connected. Boite reconnects by itself once it answers again.',
    pairingLink: 'That is not a link to add a device. Copy the link shown by Add a device on the other machine; it starts with http and contains ?grant=.'
  }
} as const;
