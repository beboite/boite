import { ContextRequestError, resolveContextFor } from '@boite/contracts';
import type { ProviderDescriptor, ThreadContextMode } from '@boite/contracts';
import { invalidParams } from './errors.ts';

/** Set in the environment of a conversation with a context mode, to its label, so the user's hooks can stay quiet. */
export const CONTEXT_ENV = 'BOITE_CONTEXT';
/** `0` when the mode drops guides: a hook that adds a guide of its own (a brain's) prints nothing. */
export const CONTEXT_GUIDES_ENV = 'BOITE_GUIDES';

/**
 * The mode a `context` request resolves to on this provider, or null for the
 * whole setup. Refuses, with the field, what the request or the provider
 * cannot honour.
 */
export function checkContext(provider: Pick<ProviderDescriptor, 'protocol' | 'name'>, request: unknown): ThreadContextMode | null {
  try {
    return resolveContextFor(provider, request);
  } catch (error) {
    if (error instanceof ContextRequestError) throw invalidParams(error.message, { field: `context.${error.field}` });
    throw error;
  }
}
