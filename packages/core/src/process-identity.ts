/** Which native process a PID names, so a reused PID is not taken for the one recorded earlier. */
export interface ProcessIdentity {
  startedAt: number | null;
  incarnation: string | null;
}

export interface KnownProcess {
  identity: ProcessIdentity;
  incarnations: Set<string>;
  recordedAt: number;
}

/** True when `next` is a process the thread has not recorded under this PID yet. */
export function unseenIdentity(next: ProcessIdentity, previous: KnownProcess): boolean {
  if (next.incarnation !== null && previous.identity.incarnation !== null) {
    return !previous.incarnations.has(next.incarnation);
  }
  // An unknown event is kept conservative: today's occupant cannot identify
  // an earlier event for a short-lived process that has already exited.
  return next.startedAt !== null && previous.identity.startedAt !== null && next.startedAt > previous.identity.startedAt;
}
