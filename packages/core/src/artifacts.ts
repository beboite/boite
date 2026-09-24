import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename } from 'node:path';
import { ATTACHMENT_MAX_BYTES, type Message, type RpcParams } from '@boite/contracts';
import type { Core } from './core.ts';
import { existingInside, mediaOf } from './workdir.ts';
import { refused } from './errors.ts';
import { newId } from './ids.ts';

/** Snapshot bytes so a later edit, deletion or core restart cannot change a delivered file. */
export async function publishArtifact(core: Core, params: RpcParams<'artifacts.publish'>): Promise<Message> {
  const thread = core.threads.require(params.threadId);
  if (thread.archived) throw refused('artifacts.publish needs an active thread', { threadId: thread.id });
  const turn = core.journal.listTurns(thread.id).at(-1);
  if (!turn) throw refused('artifacts.publish needs a thread with a turn', { threadId: thread.id });
  const found = existingInside(thread.cwd, params.path, 'file', 'artifacts.publish path');
  if (found.stats.size > ATTACHMENT_MAX_BYTES) throw refused('artifacts.publish file must be at most 5 MB', { path: params.path });
  const file = await open(found.absolute, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  let data: Buffer;
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== found.stats.dev || opened.ino !== found.stats.ino) {
      throw refused('artifacts.publish path changed while opening; try again', { path: params.path });
    }
    // A bounded read also covers a file growing after the size check.
    data = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1);
    let total = 0;
    while (total < data.length) {
      const read = await file.read(data, total, data.length - total, null);
      if (!read.bytesRead) break;
      total += read.bytesRead;
    }
    if (total > ATTACHMENT_MAX_BYTES) throw refused('artifacts.publish file must be at most 5 MB', { path: params.path });
    data = data.subarray(0, total);
  } finally { await file.close(); }
  // The thread may have been archived while its file was being read.
  if (core.threads.require(thread.id).archived) throw refused('artifacts.publish needs an active thread', { threadId: thread.id });
  const mimeType = /\.pdf$/i.test(found.relative) ? 'application/pdf' : mediaOf(found.relative).mime;
  const message: Message = {
    id: newId('msg_'), threadId: thread.id, turnId: turn.id, role: 'assistant', state: 'complete', createdAt: Date.now(),
    parts: [{ type: 'file', name: basename(found.absolute), mimeType, data: data.toString('base64') }],
  };
  core.journal.append({ type: 'artifact.published', threadId: thread.id, version: 1, payload: message }, () => core.journal.putMessage(message));
  core.bus.emit('message.started', message);
  core.bus.emit('message.completed', { threadId: thread.id, messageId: message.id, state: 'complete' });
  return message;
}
