export const strings = {

  /** Images on their way to an agent, files given with an answer, and the full-screen viewer. */
  media: {
    sourceTooLarge: '{name} weighs {size}: Boite shrinks images of {max} at most, so it was left out.',
    viewer: 'Media viewer',
    previous: 'Previous',
    next: 'Next',
    position: '{index} of {total}',
    share: 'Share or save',
    shareFailed: '{name} could not be shared.',
    shareReady: '{name} is ready: tap Share again.',
    answerFiles: 'Files given: {names}',
    answerFileCount: '{count} files'
  }
} as const;
