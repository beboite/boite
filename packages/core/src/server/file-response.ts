import type { BunFile } from 'bun';

/** A single byte range, shared by downloadable snapshots and isolated preview assets. */
export function fileResponse(file: BunFile, range: string | null, headers: Record<string, string>, head = false): Response {
  const size = file.size;
  headers = { ...headers, 'accept-ranges': 'bytes' };
  if (head) return new Response(null, { headers: { ...headers, 'content-length': String(size) } });
  const asked = range === null ? null : /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!asked) return new Response(file, { headers });
  const from = asked[1] ?? '', to = asked[2] ?? '';
  const start = from ? Number(from) : Math.max(0, size - Number(to));
  const end = !from ? size - 1 : to ? Math.min(Number(to), size - 1) : size - 1;
  if ((!from && !to) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    return new Response('range not satisfiable', { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
  }
  return new Response(file.slice(start, end + 1), {
    status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) },
  });
}
