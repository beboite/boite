export const SYSTEM_LABEL = { coordination: 'Agent coordination', delegation: 'Agent delegation', background: 'Background work finished' } as const;

/** The turns whose opening message is Boite's and not the user's. */
export function systemOperation(operation: string | undefined): operation is keyof typeof SYSTEM_LABEL {
  return operation === 'coordination' || operation === 'delegation' || operation === 'background';
}
