import { messageOf } from './errors.ts';

const DIAGNOSTIC = Symbol('boite.logDiagnostic');

/** Attach a fixed diagnostic to an error whose client message includes raw stderr. */
export function withLogDiagnostic<E extends Error>(error: E, message: string): E {
  Object.defineProperty(error, DIAGNOSTIC, { value: message });
  return error;
}

export function logMessageOf(error: unknown): string {
  const diagnostic = error instanceof Error ? (error as Error & { [DIAGNOSTIC]?: string })[DIAGNOSTIC] : undefined;
  return diagnostic ?? messageOf(error);
}
