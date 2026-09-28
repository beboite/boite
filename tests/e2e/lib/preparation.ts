/** Each preparation phase has its own diagnostic and deadline, including shutdown. */
export async function preparationStep<T>(
  label: string,
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 120_000,
): Promise<T> {
  const started = performance.now();
  const controller = new AbortController();
  console.log(`e2e preparation: ${label} started`);
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`e2e preparation: ${label} exceeded ${timeoutMs} ms`);
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => run(controller.signal)), deadline]);
    console.log(`e2e preparation: ${label} finished in ${Math.round(performance.now() - started)} ms`);
    return result;
  } finally {
    clearTimeout(timer!);
  }
}
