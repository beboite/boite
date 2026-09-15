/** Instructions for automated turns stay out of the journal's user message. */
export function activityPrompt(kind: 'goal' | 'loop', text: string, iteration: number): string {
  const objective = text.replace(/^\/(?:goal|loop)\s*/, '');
  if (kind === 'loop') return `Iteration ${iteration}. Execute the following task once for this iteration. Boite owns the repetition and stopping count; do not start another loop or repeat the task yourself. Report the result of this iteration.\n${objective}`;
  return `Work toward this goal: ${objective}\nContinue until the objective is achieved. When you have verified completion, write [BOITE_GOAL_COMPLETE] alone on its own line. If blocked or waiting for user input, explain what is missing and write [BOITE_GOAL_BLOCKED] alone on its own line.\nTrack the work with your native planning tool. Update task statuses as you verify results. Boite already owns the goal; do not create another goal.`;
}

export function activityResult(text: string): string {
  return text.replace(/^\s*\[BOITE_GOAL_(?:COMPLETE|BLOCKED)\]\s*$/gm, '').trim();
}
