import { basename, dirname, extname } from 'node:path';
import { realpathSync } from 'node:fs';
import type { Core } from './core.ts';
import { existingInside, resolveInside } from './workdir.ts';
import { newToken } from './ids.ts';
import { refused } from './errors.ts';
import { fileResponse } from './server/file-response.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};
const MAX_PREVIEWS = 16;
const MAX_ASSET_BYTES = 512 * 1024 * 1024;

interface Preview { server: ReturnType<typeof Bun.serve>; url: string; port: number; root: string; }

/** A separate origin per HTML entry point: preview scripts never share the core UI's storage or RPC origin. */
export class ArtifactPreviews {
  private readonly previews = new Map<string, Preview>();
  private unlisten: (() => void) | null = null;
  constructor(private readonly core: Core) {}

  private key(threadId: string, path: string): string { return `${threadId}\0${path}`; }

  open(threadId: string, path: string): { url: string; port: number; path: string } {
    this.unlisten ??= this.core.bus.onAny((name) => {
      if (name !== 'thread.updated' && name !== 'thread.removed') return;
      for (const [key, preview] of this.previews) {
        try { if (!this.core.threads.require(key.split('\0')[0]!).archived) continue; } catch { /* removed */ }
        preview.server.stop(true); this.previews.delete(key);
      }
    });
    const thread = this.core.threads.require(threadId);
    if (thread.archived) throw refused('artifacts.preview needs an active thread');
    const found = existingInside(thread.cwd, path, 'file', 'artifacts.preview path');
    if (!/\.html?$/i.test(found.relative)) throw refused('artifacts.preview path must be an HTML file', { path });
    const root = realpathSync(dirname(found.absolute));
    const key = this.key(threadId, found.relative);
    const previous = this.previews.get(key);
    if (previous && previous.root === root) return { url: previous.url, port: previous.port, path: found.relative };
    if (previous) { previous.server.stop(true); this.previews.delete(key); }
    if (this.previews.size >= MAX_PREVIEWS) throw refused('artifacts.preview has 16 open previews; close one with boite preview-close <file>');
    const token = newToken();
    const prefix = `/${token}/`;
    const server = Bun.serve({
      hostname: this.core.info().endpoint.host, port: 0,
      fetch: request => {
        const notFound = () => new Response('preview asset not found', { status: 404 });
        if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('GET or HEAD only', { status: 405 });
        // Do not keep serving a project after its conversation was removed or archived.
        try { if (this.core.threads.require(threadId).archived) return notFound(); } catch { return notFound(); }
        const parsed = new URL(request.url);
        if (!parsed.pathname.startsWith(prefix)) return notFound();
        let relative: string;
        try { relative = decodeURIComponent(parsed.pathname.slice(prefix.length)); } catch { return notFound(); }
        if (!relative || relative.split(/[\\/]/).some(part => part.startsWith('.') || part.includes(':'))) return notFound();
        const mime = TYPES[extname(relative).toLowerCase()];
        if (!mime) return notFound();
        try {
          // Check both roots on every request: replacing a folder by a junction cannot widen the preview.
          const target = existingInside(root, relative, 'file', 'preview asset');
          // macOS /var aliases and linked project folders must compare canonical paths.
          existingInside(realpathSync(thread.cwd), target.absolute, 'file', 'preview asset');
          if (realpathSync(root) !== root || target.stats.size > MAX_ASSET_BYTES) return notFound();
          const file = Bun.file(target.absolute);
          return fileResponse(file, request.headers.get('range'), {
            'content-type': mime, 'cache-control': 'no-store',
            'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
            'cross-origin-resource-policy': 'same-origin',
            // Preview HTML can run its scripts, but cannot navigate a parent or create popups.
            'content-security-policy': "sandbox allow-scripts allow-same-origin; object-src 'none'; frame-src 'none'; base-uri 'self'",
          }, request.method === 'HEAD');
        } catch { return notFound(); }
      },
    });
    const url = new URL(this.core.reachableUrl());
    url.port = String(server.port);
    url.pathname = `${prefix}${encodeURIComponent(basename(found.absolute))}`;
    this.previews.set(key, { server, url: url.href, port: server.port!, root });
    return { url: url.href, port: server.port!, path: found.relative };
  }

  close(threadId: string, path: string): void {
    const thread = this.core.threads.require(threadId);
    // Closing still works after the original HTML has been deleted.
    const key = this.key(threadId, resolveInside(thread.cwd, path, 'artifacts.previewClose path').relative);
    this.previews.get(key)?.server.stop(true);
    this.previews.delete(key);
  }

  stop(): void {
    this.unlisten?.(); this.unlisten = null;
    for (const preview of this.previews.values()) preview.server.stop(true);
    this.previews.clear();
  }
}
