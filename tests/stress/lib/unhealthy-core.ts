/** A real temporary core whose HTTP observer fails while agent RPCs still work. */
const serve = Bun.serve;
Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
  const originalFetch = options.fetch;
  if (typeof originalFetch !== 'function') throw new Error('unhealthy core fixture expects a fetch handler');
  return serve({ ...options, fetch(request, server) {
    if (new URL(request.url).pathname === '/health') return new Response('forced unhealthy core', { status: 503 });
    return originalFetch.call(server, request, server);
  } } as typeof options);
}) as typeof Bun.serve;

const { main } = await import('../../../packages/core/src/main.ts');
main(process.argv.slice(2));

export {};
