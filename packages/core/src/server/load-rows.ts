import type { RpcEvents } from '@boite/contracts';
import { mayReceiveEvent } from '../access.ts';
import type { Core } from '../core.ts';
import { withLoad } from '../threads/records.ts';
import type { EventFrames, ServerConnection } from './connection.ts';

/**
 * A load sample reaches a client whose hello does not accept `thread.load` as
 * the whole `thread.updated` row. One broadcast reads and serializes that row
 * once for all of them, and only when such a client is among its sockets.
 */
export function loadRowSender(core: Core, { threadId, load }: RpcEvents['thread.load']): (connection: ServerConnection) => void {
  let row: RpcEvents['thread.updated'] | null | undefined;
  const frames: EventFrames = new Map();
  return (connection) => {
    if (row === undefined) {
      const thread = core.journal.getThread(threadId);
      row = thread === null ? null : { ...withLoad(core, thread), load };
    }
    if (row !== null && mayReceiveEvent('thread.updated', connection)) connection.sendEvent('thread.updated', row, frames);
  };
}
