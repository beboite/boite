import { stripAnsi } from '../ansi.ts';

/**
 * Reading what an agent's updater printed: its output, kept within bounds,
 * and the line that says why it failed.
 */

/** What is kept of each stream of an agent's run: its end, where the error line is. */
const OUTPUT_MAX_BYTES = 256 * 1024;

/** Reads a stream to its end, keeping its last OUTPUT_MAX_BYTES, so a chatty program never blocks on a full pipe. */
export async function capture(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> }): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done || chunk.value === undefined) break;
    chunks.push(chunk.value);
    size += chunk.value.length;
    while (size > OUTPUT_MAX_BYTES && chunks.length > 1) size -= chunks.shift()!.length;
  }
  const text = Buffer.concat(chunks);
  return text.subarray(Math.max(0, text.length - OUTPUT_MAX_BYTES)).toString('utf8');
}

/** stderr carries the failure; stdout often only announces the updater. */
export function failureSummary(stdout: string, stderr: string): string | undefined {
  const lines = (output: string): string[] => stripAnsi(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errors = lines(stderr);
  const output = errors.length > 0 ? errors : lines(stdout);
  // npm ends with its log location; OpenCode ends with a generic Failed frame.
  // apt marks its errors `E:`, after its warnings and progress.
  return output.find((line) => /\berror:|^E: |\b(?:could not|cannot|unable to)\b|\b(?:EACCES|EPERM)\b.*(?:permission denied|operation not permitted)/i.test(line)) ?? output.at(-1);
}

/**
 * Why an updater that exited with zero left its version where it was, in its
 * own words. `opencode upgrade` reports every failure and every skip this way,
 * through a prompt library whose frame falls back to ASCII letters (`x`, `o`)
 * when its output is not a Unicode terminal, and closes with `Done`.
 */
export function stuckReason(output: string): string | undefined {
  const lines = stripAnsi(output).split(/\r?\n/)
    .map((line) => line.trim().replace(/^[^\p{L}\p{N}]+/u, '').replace(/^[xoT]\s{2,}/, '').trim())
    .filter((line) => /[\p{L}\p{N}]/u.test(line) && !/^done\.?$/i.test(line));
  // An errno such as EBUSY or EPERM counts in capitals only: `exit` is no error code.
  const reason = lines.findLast((line) => /fail|error|skipped|unknown|denied|cannot|could not|unable/i.test(line) || /\bE[A-Z]{3,}\b/.test(line)) ?? lines.at(-1);
  return reason?.slice(0, 300);
}
