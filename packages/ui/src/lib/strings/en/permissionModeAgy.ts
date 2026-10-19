export const strings = {

  /** agy asks nothing in print mode: what its mode does not allow, it refuses by itself. */
  permissionModeAgy: {
    default: 'agy settings',
    defaultLong: 'Follows agy\'s own permission setting and refuses what it would ask about',
    acceptEditsLong: 'Edits files without asking, refuses commands that need approval',
    draft: "with agy's own permission settings"
  }
} as const;
