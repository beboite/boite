// The addresses a file ticket opens: a download, or a published view as a page.
import { VIEW_CONTENT_POLICY, VIEW_SANDBOX } from '@boite/contracts';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import type { Core } from '../core.ts';
import { VIEW_GZIP_SUFFIX } from '../views.ts';
import { fdResponse, heldBytes } from './file-response.ts';

/**
 * The file a ticket opens: what `files.read` could not put in a JSON frame.
 * The ticket is the whole address, so no request here names a path and no
 * answer says what an unknown one missed. A `Range` is honoured because that
 * is how a video seeks, and nothing is cached because the ticket outlives
 * neither the ten minutes nor the next write to the file. A message's
 * attachment comes from the journal instead (`heldBytes`), with the same range support.
 */
export async function ticketedFile(core: Core, ticket: string, range: string | null): Promise<Response> {
  const held = core.fileTickets.bytes(ticket);
  if (held !== null) return heldBytes(held, range);
  const opened = await core.fileTickets.open(ticket);
  if (opened === null) return new Response('unknown or expired ticket', { status: 404 });
  const headers: Record<string, string> = {
    'content-type': opened.mime,
    'cache-control': 'no-store',
    // The type is the one the extension named and nothing the bytes suggest,
    // and a ticket opened as a page downloads instead of rendering: an agent
    // picks what the panel opens, so no file of its may run in a window.
    // Neither header touches an <img> or a <video> loading the same address.
    'x-content-type-options': 'nosniff',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(opened.name ?? 'download')}`,
  };
  return fdResponse(opened.handle, opened.size, range, headers, opened.permit);
}

/**
 * A published view, opened as a page: the one address of the core where an
 * agent's HTML runs. Only a ticket minted for a view opens here, so a file
 * ticket still only downloads. The sandbox puts the page on an opaque origin,
 * whether a client frames it or someone opens the address: it has no storage,
 * no cookie and no way to the core's socket, and the policy lets it load and
 * call nothing. The snapshot never changes, but its ticket does not outlive
 * ten minutes, so nothing is cached. `publishView` gzipped the snapshot once
 * beside it; a client that reads gzip (`gzip`) gets that copy, and a view
 * published before the copy existed is sent as it is. A ```view block's page
 * (`viewBlock`) is held in memory and sent under the same headers.
 */
export async function viewPage(core: Core, ticket: string, gzip: boolean): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': `sandbox ${VIEW_SANDBOX}; ${VIEW_CONTENT_POLICY}`,
    vary: 'accept-encoding',
  };
  const held = core.fileTickets.bytes(ticket);
  if (held !== null) return held.view ? new Response(held.data as Uint8Array<ArrayBuffer>, { headers }) : new Response('unknown or expired ticket', { status: 404 });
  const opened = await core.fileTickets.open(ticket);
  if (opened === null || !opened.view) {
    void opened?.handle.close();
    return new Response('unknown or expired ticket', { status: 404 });
  }
  if (gzip && !opened.permit) {
    const compressed = await openViewCopy(`${opened.path}${VIEW_GZIP_SUFFIX}`);
    if (compressed !== null) {
      void opened.handle.close();
      return fdResponse(compressed.handle, compressed.size, null, { ...headers, 'content-encoding': 'gzip' });
    }
  }
  return fdResponse(opened.handle, opened.size, null, headers, opened.permit);
}

/** The gzipped copy of a view, opened without following a link; null when it is missing or not a file. */
async function openViewCopy(path: string): Promise<{ handle: FileHandle; size: number } | null> {
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { return null; }
  try {
    const stats = await handle.stat();
    if (stats.isFile()) return { handle, size: stats.size };
  } catch { /* Closed below. */ }
  await handle.close();
  return null;
}
