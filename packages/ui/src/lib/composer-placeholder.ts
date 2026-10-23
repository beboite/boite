import { fill, strings } from './strings';

/**
 * The composer's placeholder: a new conversation asks what the user wants
 * done, one under way names who reads the message. `target` is a side box's
 * own text, `bot` the persistent agent whose thread this is.
 */
export function composerPlaceholder(input: {
  target: { placeholder: string } | null;
  replying: boolean;
  bot: string | null;
  offline: boolean;
  onThread: boolean;
  draft: boolean;
  machine: string;
  project: string | null;
  provider: string | null;
}): string {
  const t = strings.composer;
  if (input.target) return input.target.placeholder;
  if (input.replying) return t.replyPlaceholder;
  if (input.bot) return fill(t.placeholderBot, { name: input.bot });
  if (input.offline) return fill(input.onThread ? t.placeholderOffline : t.placeholderOfflineDraft, { machine: input.machine });
  if (!input.onThread && input.draft) return t.placeholderNew;
  return input.project && input.provider ? fill(t.placeholder, { provider: input.provider, project: input.project }) : t.placeholderNoProject;
}
