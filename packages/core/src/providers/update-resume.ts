/**
 * What a turn paused for an agent update is told when it goes on, and the
 * line its thread shows. The prompt goes to the agent; the label is Boite's.
 */
export interface Resume {
  prompt: string;
  label: string;
}

const GO_ON = 'Continue the task where you stopped.';

/** The update ran: moved from one version to another, or failed and left the agent where it was. */
export function resumeAfterUpdate(name: string, from: string | null, to: string | null, failed: boolean): Resume {
  if (failed) {
    return {
      prompt: `Boite paused this turn between two tool calls to update ${name}, and the update failed${to === null ? '' : `; ${name} is still ${to}`}. ${GO_ON}`,
      label: `Resumed: the ${name} update failed`,
    };
  }
  // An updater that found nothing newer leaves the version where it was: no move to announce.
  const unchanged = to !== null && from === to;
  const moved = to === null || unchanged ? '' : from === null ? ` to ${to}` : ` from ${from} to ${to}`;
  return {
    prompt: `Boite paused this turn between two tool calls to update ${name}${moved}.${unchanged ? ` ${name} stays on ${to}.` : ''} Your session and the results of your tool calls are kept. ${GO_ON}`,
    label: to === null || unchanged ? `Resumed after the ${name} update` : `Resumed after the ${name} ${to} update`,
  };
}

/** The pause limit passed with other turns still in a tool call: the update waits for them instead. */
export function resumePostponed(name: string): Resume {
  return {
    prompt: `Boite paused this turn between two tool calls to update ${name}, but other turns are still working, so the update waits for them. ${GO_ON}`,
    label: `Resumed: the ${name} update waits for other turns`,
  };
}

/** The update this turn paused for is gone: done or dropped before the pause was seen. */
export function resumeUnwaited(name: string): Resume {
  return {
    prompt: `Boite paused this turn between two tool calls for an update of ${name} that no longer waits. ${GO_ON}`,
    label: `Resumed: the ${name} update no longer waits`,
  };
}
