export const SYSTEM_LABEL = { coordination: 'Agent coordination', delegation: 'Agent delegation', background: 'Background work finished', resume: 'Resumed after a restart' } as const;

/** Native command names may be unknown until the session starts; paths are ordinary input. */
export function nativeCommandPrompt(prompt: string): boolean {
  return /^\s*\/[\w:-]+(?:\s|$)/.test(prompt);
}

/** The turns whose opening message is Boite's and not the user's. */
export function systemOperation(operation: string | undefined): operation is keyof typeof SYSTEM_LABEL {
  return operation === 'coordination' || operation === 'delegation' || operation === 'background' || operation === 'resume';
}
