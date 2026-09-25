import type { ExperimentId } from './experiments';
import { strings } from './strings';

/**
 * The title and hint of every shipped experiment, in the language the app
 * speaks when this is called. One entry per id, so a new experiment cannot land
 * without its words, and the Settings nav lists the same rows as the page.
 */
export function experimentCopy(): Record<ExperimentId, { title: string; hint: string }> {
  return {
    'theme-grain': strings.experiments.themeGrain,
    'session-import': strings.experiments.sessionImport,
    'prompt-cache': strings.experiments.promptCache,
    'chat-artifacts': strings.experiments.chatArtifacts,
    'preview-comments': strings.experiments.previewComments
  };
}
