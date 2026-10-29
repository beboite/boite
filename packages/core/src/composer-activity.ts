import { composerActivity as parse } from '@boite/contracts';
import { invalidParams } from './errors.ts';
export { isComposerActivity } from '@boite/contracts';

export function composerActivity(text: string, experiments: readonly string[] = []) {
  try { return parse(text, experiments); }
  catch (error) { throw invalidParams(error instanceof Error ? error.message : String(error)); }
}
