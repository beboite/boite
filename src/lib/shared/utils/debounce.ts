export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void | Promise<void>,
  ms: number,
): {
  (...args: Args): void;
  flush: () => void;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Args | null = null;

  function run() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const args = pending;
    pending = null;
    if (args) void fn(...args);
  }

  function call(...args: Args) {
    pending = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
  }

  call.flush = run;
  call.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
  };

  return call;
}
