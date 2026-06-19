import type { ThreadStatus } from "$lib/types";

// Thread ids whose local PTY was detached (kept alive) on a workspace switch,
// mapped to the status they carried at park time. Module-level on purpose: it
// must survive the store reset a switch performs, so the return to the local
// workspace knows which threads to reattach (replay) instead of spawning fresh,
// and can repaint their dot colour — a parked PTY is unplugged, not dead.
export const parkedLocal = new Map<string, ThreadStatus>();
