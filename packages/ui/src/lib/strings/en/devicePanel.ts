export const strings = {
  /** The Device panel: simulators and emulators an agent opened with `boite device`. */
  devicePanel: {
    cover: 'This agent controls a device on {machine}', coverHint: 'Nothing streams to this device until you show it.',
    show: 'Show', hide: 'Hide', hideHint: 'Stop watching and cover the view again',
    empty: 'No device is open in this conversation. An agent opens one with boite device open, or open one here.',
    onMachine: 'On this machine', add: 'Open a device',
    none: 'No simulators or emulators were found on this machine.',
    starting: 'Starting {name}. This can take a minute.', failed: '{name} did not start',
    stopped: 'Off', running: 'Running', booting: 'Starting',
    viewOnly: 'View only. The agent drives iOS Simulators with xcrun simctl.',
    back: 'Back', home: 'Home', recents: 'Recent apps', rotate: 'Rotate', power: 'Power button', enter: 'Enter', backspace: 'Delete the previous character',
    text: 'Type into the focused field', send: 'Send the text', ascii: 'Only printable ASCII characters reach the device.',
    screenshot: 'Save a screenshot', close: 'Close {name}', shutdown: 'Power off',
    interact: 'Tap or swipe the device screen', interactDesk: 'The device screen: click it, then type',
    deskHint: 'Click the screen, then type. Drag to swipe, scroll with the wheel, Esc goes back. Paste types the clipboard; copying from the device is not available.', image: 'Live view of {name}', gesture: 'Tap to touch. Drag to swipe.',
    deskHintLive: 'Click the screen, then type. Drag to swipe, scroll with the wheel, Esc goes back. Paste sends your clipboard to the device and pastes it; Ctrl+C copies the device\'s selection here.',
    streamOff: 'Screenshots: the live stream is off in Settings > Experiments.',
    streamDecoder: 'Screenshots: this browser cannot decode the live video.',
    streamFailed: 'Screenshots: the live stream stopped. {reason}',
    copy: 'Copy the device\'s selection', copied: 'Copied from the device', copyEmpty: 'Nothing is selected on the device'
  }
} as const;
