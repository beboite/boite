/**
 * What a Retry button does for a chunk that failed to load: ask again, and
 * when that fails too, load a fresh page once the core answers. Chromium keeps
 * a failed `import()` for the life of the page, so asking for the same file
 * again fails at once without a request; a new page asks the network again,
 * and gets the current build's files when an update replaced the old ones.
 * While the core does not answer, the page stays as it is and `stillFailing`
 * runs, so the notice that called it can stand again.
 */
export async function retryOrReload(
  load: () => Promise<unknown>,
  stillFailing: () => void = () => undefined,
  reload: () => void = () => location.reload()
): Promise<void> {
  try {
    await load();
    return;
  } catch {
    // Kept by the browser, or still out of reach: the core decides which.
  }
  if (await coreAnswers()) reload();
  else stillFailing();
}

/** The manifest, which the service worker never answers (`public/sw.js`): a reply is the core's own. */
async function coreAnswers(): Promise<boolean> {
  try {
    return (await fetch('./manifest.webmanifest', { cache: 'no-store' })).ok;
  } catch {
    return false;
  }
}
