// Pure workflow input checks and conversion of plan errors to RPC failures.
import { WorkflowPlanError } from '@boite/contracts';
import { invalidParams } from '../errors.ts';

export { requiredText as text } from '../errors.ts';

export function planError<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof WorkflowPlanError) throw invalidParams(error.message);
    throw error;
  }
}
