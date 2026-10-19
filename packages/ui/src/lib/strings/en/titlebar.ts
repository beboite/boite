export const strings = {

  titlebar: {
    minimize: 'Minimize',
    maximize: 'Maximize',
    restore: 'Restore',
    quitHold: 'Hold Ctrl+Q to quit',
    quitHoldHint: 'or press it twice',
    quitTitle: 'Close Boite?',
    quitWorkingOne: '1 agent is still working or waiting. Are you sure you want to close Boite?',
    quitWorkingMany: '{count} agents are still working or waiting. Are you sure you want to close Boite?',
    quitUnknownBody: 'Work on a disconnected machine could not be checked.',
    quitResidentBody: 'Resident engines keep working after the app closes. Engines configured to stop with the app will stop.',
    quitConfirm: 'Close Boite',
    quitCancel: 'Keep open'
  }
} as const;
