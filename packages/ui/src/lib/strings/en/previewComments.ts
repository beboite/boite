export const strings = {
  previewComments: {
  annotate: 'Reference an element',
  picking: 'Select an element in the page. Escape cancels.',
  add: 'Add to message',
  added: 'Element added to your message.',
  unavailable: 'Element selection is unavailable on this page. Use the desktop app for cross-origin pages.',
  failed: 'Element selection failed. Reload the page and try again.',
  reveal: 'Show this element in the preview',
  remove: 'Remove element reference',
  stale: 'This preview has changed page. Reopen the original page or select the element again.',
  missing: 'This element no longer exists on the page. Select it again.',
  tooMany: 'A message can reference at most 8 page elements.',
  activityUnsupported: 'Element references cannot be used with /goal or /loop. Send a regular message or remove the references.',
  stashUnsupported: 'This draft contains element references and cannot be stashed. Send it or remove the references first.'
}
} as const;
