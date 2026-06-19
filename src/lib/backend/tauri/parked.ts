// Thread ids whose local PTY was detached (kept alive) on a workspace switch.
// Module-level on purpose: it must survive the store reset that a switch
// performs, so the return to the local workspace knows which threads to
// reattach (replay) instead of spawning fresh.
export const parkedLocal = new Set<string>();
