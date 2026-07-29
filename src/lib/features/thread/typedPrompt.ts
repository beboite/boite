/**
 * A first message for a thread whose CLI cannot take one on the command line.
 *
 * `withPendingPrompt` appends the briefing as a positional argument whenever the
 * agent accepts one, which is the better delivery: it is there before the
 * process starts and nothing can race it. The CLIs that accept none used to lose
 * the line entirely, so a thread opened through `thread_spawn` or moved by
 * `thread_move` started at a bare prompt knowing nothing about why. Those get it
 * typed into the PTY instead, once the terminal is up.
 *
 * Claimed rather than read: a thread that is relaunched, respawned or restored
 * must not be handed the same opening line a second time.
 */
const pending = new Map<string, string>();

export function stageTypedPrompt(threadId: string, prompt: string) {
  const oneLine = prompt.replace(/\s*[\r\n]+\s*/g, " ").trim();
  if (oneLine) pending.set(threadId, oneLine);
}

export function claimTypedPrompt(threadId: string): string | null {
  const prompt = pending.get(threadId) ?? null;
  pending.delete(threadId);
  return prompt;
}
