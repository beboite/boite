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
 * `submit` is for agent-initiated spawns only: Boite presses Enter after the
 * text lands, because the caller already believes the worker started. A move
 * note and a todo hand-off leave Enter to the user, same as typing in the pane.
 *
 * Claimed rather than read: a thread that is relaunched, respawned or restored
 * must not be handed the same opening line a second time.
 */
export interface StagedPrompt {
  text: string;
  submit: boolean;
}

const pending = new Map<string, StagedPrompt>();

export function stageTypedPrompt(threadId: string, prompt: string, submit = false) {
  const oneLine = prompt.replace(/\s*[\r\n]+\s*/g, " ").trim();
  if (oneLine) pending.set(threadId, { text: oneLine, submit });
}

export function claimTypedPrompt(threadId: string): StagedPrompt | null {
  const staged = pending.get(threadId) ?? null;
  pending.delete(threadId);
  return staged;
}

/** What the PTY receives. Enter is `\r`, the byte a terminal Enter sends. */
export function typedPromptPayload(staged: StagedPrompt): string {
  return staged.submit ? `${staged.text}\r` : staged.text;
}
