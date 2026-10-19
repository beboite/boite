export const strings = {

  /** The file tree and the file viewer, the two surfaces reading the working directory. */
  files: {
    tree: 'Files of the working directory',
    noRoot: 'No working directory',
    filter: 'Filter',
    filterHint: 'Narrow the rows already loaded',
    reading: 'Reading this directory',
    empty: 'This directory is empty',
    noMatch: 'No loaded row matches',
    failed: 'This directory could not be read. {reason}',
    capped: 'Only the first {count} entries of this directory are listed.',
    // The viewer and the editor, one file per tab.
    readFailed: 'This file could not be read. {reason}',
    writeFailed: 'This file could not be saved. {reason}',
    readingFile: 'Reading this file',
    noFile: 'This tab carries no path',
    truncated: 'This file was cut short at its size limit, so what is below is not the whole file and cannot be saved.',
    readOnly: "Saving a file is the owner's, so this one opens read only.",
    saving: 'Saving',
    unsaved: 'Unsaved changes',
    discardOne: 'Close {name} without saving?',
    discardMany: 'Close {count} files without saving?',
    discardBody: 'What was typed since the last save is lost.',
    discardConfirm: 'Close without saving',
    editorLabel: 'File contents',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    fit: 'Fit',
    actual: '1:1',
    natural: '{width} x {height}',
    picture: 'The picture of this file',
    download: 'Download this file',
    binary: 'Nothing here reads as text.'
  }
} as const;
