export const strings = {

  /** The project board in the drawer under the chat: the project's todos in four columns, tied to `/goal2`. */
  board: {
    tab: 'Board',
    terminalTab: 'Terminal',
    tabs: 'Drawer',
    open: 'Project board',
    hide: 'Hide the board',
    columns: { todo: 'To do', doing: 'In progress', review: 'In review', done: 'Done' },
    /** The "i" after In progress. */
    doingHint: 'A card put here starts a /goal2 conversation with the card as its objective. Its bar is that goal\'s checklist.',
    add: 'Add a card',
    addPlaceholder: 'What needs doing',
    actions: 'Card actions',
    moveTo: 'Move to {column}',
    openThread: 'Open its conversation',
    remove: 'Remove the card',
    reviewing: 'Under review',
    awaiting: 'Awaiting you',
    starting: 'Starting',
    /** The dots under a phone's board, one per column. */
    pages: 'Columns',
    page: '{column}, {count}'
  }
} as const;
