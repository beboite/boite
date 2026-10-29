// Synthetic native lane only: locate a cold Node startup before pi attaches RPC.
// Writes to stderr, leaving the provider's JSONL stdout and deadlines unchanged.
import {registerHooks} from 'node:module';

const started = Date.now(), cpu = process.cpuUsage();
let modules = 0, loadingMs = 0, lastModule = '';
function report(phase, extra = {}) {
  const usage = process.cpuUsage(cpu);
  console.error('[native-pi-startup]', JSON.stringify({
    phase, elapsedMs: Date.now() - started, modules, loadingMs, lastModule,
    cpuMs: Math.round((usage.user + usage.system) / 1000), ...extra,
  }));
}
registerHooks({load(url, context, nextLoad) {
  lastModule = url;
  const before = Date.now();
  try {return nextLoad(url, context);}
  finally {
    const durationMs = Date.now() - before;
    modules++;
    loadingMs += durationMs;
    if (durationMs >= 1000) report('slow-load', {url, durationMs});
  }
}});
report('preload', {node: process.version});
setInterval(() => report('progress'), 2000).unref();
