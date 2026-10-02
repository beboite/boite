import { open, mkdir, rename, unlink, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ARTIFACT_MAX_BYTES, ATTACHMENT_MAX_BYTES, FILE_ROUTE, type ArtifactContent, type Message, type MessagePart, type RpcParams } from '@boite/contracts';
import type { Core } from './core.ts';
import { existingInside, mediaOf } from './workdir.ts';
import { refused } from './errors.ts';
import { newId } from './ids.ts';

const tooLarge = (path: string) => refused('artifacts.publish file must be at most 512 MB', { path });

/** Copy in bounded chunks; even a source that grows during the copy cannot exceed the cap. */
async function snapshot(core: Core, cwd: string, path: string): Promise<{ part: MessagePart; stored: string | null }> {
  const found = existingInside(cwd, path, 'file', 'artifacts.publish path');
  if (found.stats.size > ARTIFACT_MAX_BYTES) throw tooLarge(path);
  const source = await open(found.absolute, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  const id = randomUUID();
  const directory = join(core.dataDir, 'artifacts');
  const temporary = join(directory, `${id}.partial`);
  const destination = join(directory, id);
  let completed = false;
  try {
    const opened = await source.stat();
    if (!opened.isFile() || opened.dev !== found.stats.dev || opened.ino !== found.stats.ino) {
      throw refused('artifacts.publish path changed while opening; try again', { path });
    }
    await mkdir(directory, { recursive: true });
    const output = await open(temporary, 'wx');
    let total = 0;
    let pdfSignature = false;
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
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
  if (thread.archived) throw refused('artifacts.publish needs an active thread', { threadId: thread.id });
  const turn = core.journal.listTurns(thread.id).at(-1);
  if (!turn) throw refused('artifacts.publish needs a thread with a turn', { threadId: thread.id });
  const { part, stored } = await snapshot(core, thread.cwd, params.path);
  let committed = false;
  try {
    if (core.threads.require(thread.id).archived) throw refused('artifacts.publish needs an active thread', { threadId: thread.id });
    const message: Message = {
      id: newId('msg_'), threadId: thread.id, turnId: turn.id, role: 'assistant', state: 'complete', createdAt: Date.now(),
      parts: [part],
    };
    core.journal.append({ type: 'artifact.published', threadId: thread.id, version: 1, payload: message }, () => core.journal.putMessage(message));
    committed = true;
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
  const found = existingInside(join(core.dataDir, 'artifacts'), part.id, 'file', 'artifacts.read snapshot');
  const ticket = typeof params.renew === 'string' && core.fileTickets.renew(params.renew, found.absolute)
    ? params.renew : core.fileTickets.mint(found.absolute, part.mimeType, Date.now(), part.name);
  return { url: `${FILE_ROUTE}/${ticket}`, name: part.name, bytes: part.bytes, mimeType: part.mimeType };
}
