import { LineSplitter, STDOUT_LINE_MAX } from '../lines.ts';

/**
 * The agent's stdout with everything that is not a JSON-RPC line taken out of
 * it. Antigravity prints its Google sign-in link on stdout, in the middle of
 * the ndjson stream, and a real agent may print a warning there too; either one
 * would break the SDK's parser. A line that does not start with `{` never
 * reaches it: it goes to `onOther` instead, which is what carries the sign-in
 * link to the Accounts page and every other line to the core log.
 */
export function jsonLinesOnly(
  source: ReadableStream<Uint8Array>,
  onOther: (line: string) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let out: ReadableStreamDefaultController<Uint8Array> | null = null;
  // A pull that returns without enqueuing is not called again, and the
  // reader's pending read never resolves: pull reads on until a protocol line
  // went out, whatever the dropped and oversized lines in between.
  let enqueued = false;
  const lines = new LineSplitter((text) => {
    if (text.trimStart().startsWith('{')) {
      out?.enqueue(encoder.encode(`${text}\n`));
      enqueued = true;
      return;
    }
    onOther(text.trim());
  }, {
    maxLine: STDOUT_LINE_MAX,
    onOverflow: () => {
      onOther('the agent sent a stdout line too large to be a protocol line');
    },
  });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      out = controller;
      enqueued = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          lines.feed(decoder.decode());
          lines.end();
          controller.close();
          return;
        }
        lines.feed(decoder.decode(value, { stream: true }));
        if (enqueued) return;
      }
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });
}
