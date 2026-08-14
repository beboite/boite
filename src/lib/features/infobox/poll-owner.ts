/**
 * One poller per repository, however many boxes describe it.
 *
 * Split view mounts an info box over every terminal, and threads that run in
 * the project folder rather than in a worktree all resolve to the same git
 * scope: four such panes would have spawned four `git status` every ten
 * seconds for the same directory. The first box to claim a scope owns its
 * timer, the others read the store it fills.
 *
 * Deliberately not reactive: ownership is asked for on every tick rather than
 * subscribed to, so when an owner unmounts the next box takes over at its own
 * next tick instead of an effect re-running (which, reading and writing the
 * same state, is how this loops forever). The cost is up to one poll interval
 * with nobody polling, on a box that already tolerates ten-second-old numbers.
 */

const owners = new Map<string, symbol>();

/** True while `token` is the box responsible for polling `scope`. */
export function ownsPoll(scope: string, token: symbol): boolean {
  const current = owners.get(scope);
  if (current === undefined) {
    owners.set(scope, token);
    return true;
  }
  return current === token;
}

/** Give the scope up, from the same effect that claimed it. */
export function releasePoll(scope: string, token: symbol): void {
  if (owners.get(scope) === token) owners.delete(scope);
}
