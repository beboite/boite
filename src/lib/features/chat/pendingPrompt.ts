/**
 * A first message waiting for a thread whose PTY does not exist yet.
 *
 * A handover creates the thread and the agent's process starts a moment later,
 * when the terminal mounts, so there is nowhere to type until then. The prompt
 * waits here and the terminal claims it once its PTY is up.
 *
 * Claimed rather than read: a thread that is relaunched, respawned or restored
 * must not be handed the same opening line a second time.
 */
const pending = new Map<string, string>();

export function stagePrompt(threadId: string, prompt: string) {
  const oneLine = prompt.replace(/\s*[\r\n]+\s*/g, " ").trim();
  if (oneLine) pending.set(threadId, oneLine);
}

export function claimPrompt(threadId: string): string | null {
  const prompt = pending.get(threadId) ?? null;
  pending.delete(threadId);
  return prompt;
}

export function dropPrompt(threadId: string) {
  pending.delete(threadId);
}
