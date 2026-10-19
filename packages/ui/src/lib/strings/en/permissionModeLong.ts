export const strings = {

  permissionModeLong: {
    default: 'Reads freely, asks before editing a file or running a command',
    acceptEdits: 'Edits files without asking, asks before running a command',
    bypassPermissions: 'Runs everything without asking, anywhere on this computer',
    yolo: 'Approves every tool request; skips Claude and Codex hooks',
    plan: 'Plan only, no changes',
    dontAsk: 'Deny anything that would need asking'
  }
} as const;
