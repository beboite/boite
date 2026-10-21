/** Test directives in transferred history must not execute again. Keep the
 * original prompt for response/context assertions and inspect this for control. */
export function instructionsOf(text: string): string {
  return text.replace(/<(conversation-history|interrupted-user-messages)>\n[\s\S]*?\n<\/\1>/g, '');
}
