
/**
 * Where a Worker file is on disk, which is not the same place in the three ways
 * the core runs. Windows workers are shipped separately: `build:exe` leaves
 * the `.js` next to the executable and that copy is checked first. Running under
 * `bun`, nothing sits next to `bun.exe`, and the file beside the calling module
 * is the source `.ts` or the bundled `.js`.
 *
 * `base` is the caller's `import.meta.url`, `name` the worker's file name
 * without an extension.
 */
export { workerEntry } from '../../worker-entry.ts';
