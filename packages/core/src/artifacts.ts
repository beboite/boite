import { open, mkdir, rename, unlink, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ARTIFACT_MAX_BYTES, ATTACHMENT_MAX_BYTES, FILE_ROUTE, VIEW_ROUTE, type ArtifactContent, type Message, type MessagePart, type RpcParams } from '@boite/contracts';
import type { Core } from './core.ts';
import { existingInside, mediaOf } from './workdir.ts';
import { refused } from './errors.ts';
import { newId } from './ids.ts';
import type { SharedFilePermit } from './contacts/access-policy.ts';

const tooLarge = (path: string) => refused('artifacts.publish file must be at most 512 MB', { path });

/** Copy in bounded chunks; even a source that grows during the copy cannot exceed the cap. */
async function snapshot(core: Core, cwd: string, path: string, permit?: SharedFilePermit): Promise<{ part: MessagePart; stored: string | null }> {
  const found = existingInside(cwd, path, 'file', 'artifacts.publish path');
  if (found.stats.size > ARTIFACT_MAX_BYTES) throw tooLarge(path);
  const source = await open(found.absolute, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  const id = randomUUID();
  const directory = join(core.dataDir, 'artifacts');
  const temporary = join(directory, `${id}.partial`);
  const destination = join(directory, id);
  let completed = false;
  try {
    const opened = await source.stat({ bigint: true });
    permit?.opened?.(found.real, opened);
    if (!opened.isFile() || opened.dev !== found.stats.dev || opened.ino !== found.stats.ino) {
      throw refused('artifacts.publish path changed while opening; try again', { path });
    }
    await mkdir(directory, { recursive: true });
    const output = await open(temporary, 'wx');
    let total = 0;
    let pdfSignature = false;
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      let tail = '';
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        if (permit) {
          const text = buffer.subarray(0, bytesRead).toString('utf8');
          permit.inspect(tail + text); tail = text.slice(-512);
        }
        if (total === 0) pdfSignature = buffer.subarray(0, Math.min(5, bytesRead)).toString() === '%PDF-';
        total += bytesRead;
        if (total > ARTIFACT_MAX_BYTES) throw tooLarge(path);
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(buffer, written, bytesRead - written, null);
          if (result.bytesWritten === 0) throw new Error('artifacts.publish could not write its snapshot');
          written += result.bytesWritten;
        }
      }
      await output.sync();
    } finally { await output.close(); }
    const name = basename(found.absolute);
    permit?.check();
    const mimeType = /\.pdf$/i.test(name)
      ? pdfSignature ? 'application/pdf' : 'application/octet-stream'
      : mediaOf(found.relative).mime;
    if (total <= ATTACHMENT_MAX_BYTES) {
      const data = (await readFile(temporary)).toString('base64');
      return { part: { type: 'file', name, mimeType, data }, stored: null };
    }
    await rename(temporary, destination);
    completed = true;
    return { part: { type: 'artifact', id, name, mimeType, bytes: total }, stored: destination };
  } finally {
    await source.close();
    if (!completed) await unlink(temporary).catch(() => {});
  }
}

/** Snapshots survive edits, removal of the source, and core restarts. */
export async function publishArtifact(core: Core, params: RpcParams<'artifacts.publish'>): Promise<Message> {
  const thread = core.threads.require(params.threadId);
  const permit = core.sharedAccess.file(thread.id, params.path, 'publish');
  if (thread.archived) throw refused('artifacts.publish needs an active thread', { threadId: thread.id });
  const turn = core.journal.lastTurn(thread.id);
  if (!turn) throw refused('artifacts.publish needs a thread with a turn', { threadId: thread.id });
  const { part, stored } = await snapshot(core, thread.cwd, params.path, permit);
  let committed = false;
  try {
    if (core.threads.require(thread.id).archived) throw refused('artifacts.publish needs an active thread', { threadId: thread.id });
    permit?.check();
    const message: Message = {
      id: newId('msg_'), threadId: thread.id, turnId: turn.id, role: 'assistant', state: 'complete', createdAt: Date.now(),
      parts: [part],
    };
    core.sharedAccess.published(thread.id, message.id, [permit]);
    core.journal.append({ type: 'artifact.published', threadId: thread.id, version: 1, payload: message }, () => core.journal.putMessage(message));
    committed = true;
    if (core.threads.runner.handles.has(thread.id) && core.journal.getTurn(turn.id)?.status === 'running') {
      core.threads.runner.answerAfter.set(turn.id, message.createdAt);
    }
    core.bus.emit('message.started', message);
    core.bus.emit('message.completed', { threadId: thread.id, messageId: message.id, state: 'complete' });
    return message;
  } finally {
    if (!committed && stored) await unlink(stored).catch(() => {});
  }
}

/** Authorization names the message as well as the thread; an id alone is never a file capability. */
export function readArtifact(core: Core, params: RpcParams<'artifacts.read'>): ArtifactContent {
  core.threads.require(params.threadId);
  const message = core.journal.getMessage(params.messageId);
  const part = message?.threadId === params.threadId
    ? message.parts.find((p) => p.type === 'artifact' && p.id === params.artifactId) : null;
  if (part?.type !== 'artifact' || !/^[a-f0-9-]{36}$/.test(part.id)) throw refused('artifacts.read needs an artifact from this message and thread');
  const permit = core.sharedAccess.publication(params.threadId, params.messageId);
  const found = existingInside(join(core.dataDir, 'artifacts'), part.id, 'file', 'artifacts.read snapshot');
  if (params.view) {
    if (!part.view) throw refused('artifacts.read view needs an artifact published with boite view');
    // A page keeps the address it was loaded from: each frame takes a ticket of its own.
    const ticket = core.fileTickets.mint(found.absolute, part.mimeType, Date.now(), part.name, undefined, true, permit);
    return { url: `${VIEW_ROUTE}/${ticket}`, name: part.name, bytes: part.bytes, mimeType: part.mimeType };
  }
  const ticket = !permit && typeof params.renew === 'string' && core.fileTickets.renew(params.renew, found.absolute)
    ? params.renew : core.fileTickets.mint(found.absolute, part.mimeType, Date.now(), part.name, undefined, false, permit);
  return { url: `${FILE_ROUTE}/${ticket}`, name: part.name, bytes: part.bytes, mimeType: part.mimeType };
}
