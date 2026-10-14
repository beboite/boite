// Pure workflow input checks and conversion of plan errors to RPC failures.
import { WorkflowPlanError } from '@boite/contracts';
import { invalidParams } from '../errors.ts';

export function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalidParams(`${field}: expected 1 to ${max} characters`);
  return value;
}

export function planError<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof WorkflowPlanError) throw invalidParams(error.message);
    throw error;
  }
}
