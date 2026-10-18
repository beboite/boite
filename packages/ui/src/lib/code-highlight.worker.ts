/*
 * Runs long texts through their grammar off the main thread
 * (`code-highlight.ts` sends it those past `WORKER_FROM`). It loads a grammar
 * the first time a text needs it, as the page does.
 */
import { highlightText, type Language } from './code-grammar';

self.onmessage = async ({ data }: MessageEvent<{ id: number; text: string; language: Language }>) => {
  try {
    self.postMessage({ id: data.id, lines: await highlightText(data.text, data.language) });
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
};
