export const strings = {

  /** A provider whose files Boite downloads itself. */
  install: {
    action: 'Install',
    update: 'Update',
    repair: 'Reinstall',
    remove: 'Uninstall',
    removeTitle: 'Uninstall {provider}?',
    removeBody: 'The files Boite downloaded go with it. Your accounts stay, and it can be installed again later.',
    removeConfirm: 'Uninstall',
    removeCancel: 'Keep',
    absent: 'Not installed · {size}',
    downloading: 'Downloading · {percent}',
    verifying: 'Checking the download',
    extracting: 'Unpacking',
    installed: 'Installed by Boite',
    updateAvailable: 'Version {installed} · {available} is available',
    progress: 'Download progress'
  }
} as const;
