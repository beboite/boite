/** Wait for exit and optional stdio closure within one deadline, retaining any known exit code. */
export function exitWithin(exited: Promise<number | null> | null, ms: number, closed?: Promise<void>): Promise<number | null | undefined> {
  if (exited === null) return Promise.resolve(undefined);
  return new Promise<number | null | undefined>((resolve) => {
    let code: number | null | undefined;
    const timer = setTimeout(() => {
      resolve(code);
    }, ms);
    timer.unref?.();
    void exited.then((exitCode) => {
      code = exitCode;
      const done = (): void => { clearTimeout(timer); resolve(exitCode); };
      if (closed === undefined) done();
      else void closed.then(done);
    });
  });
}
