import { strings } from './strings';
import type { Store } from './store.svelte';

/** Local answers belong to one composer and machine, never to the message list. */
export class ComposerSide {
  current = $state<{ threadId: string; requestId: string; question: string; answer: string | null; error: string | null } | null>(null);
  private dispose: (() => void) | null = null;

  clear(): void { this.dispose?.(); this.dispose = null; this.current = null; }

  /** True means this was /btw, including invalid input that must never reach the main agent. */
  submit(store: Store, key: string, prompt: string): boolean {
    const match = /^\s*\/btw(?:\s+([\s\S]*))?$/.exec(prompt);
    if (!match) return false;
    const state = store.composerStates[key];
    const threadId = store.openThread?.id;
    const question = match[1]?.trim() ?? '';
    let error: string | null = null;
    if (!threadId || store.draft) error = strings.btw.needsThread;
    else if (!question) error = strings.btw.questionRequired;
    else if (state?.attachments.length || state?.previewReferences?.length) error = strings.btw.textOnly;
    else if (state?.editing) error = strings.btw.editing;
    else if (store.connection !== 'ready' || !store.client) error = strings.btw.offline;
    if (error) { store.error = error; return true; }
    if (this.current?.answer === null && this.current.error === null) return true;
    this.clear();
    const client = store.client!, id = threadId!, requestId = crypto.randomUUID();
    this.current = { threadId: id, requestId, question, answer: null, error: null };
    let pending = true, active = true;
    const off = client.on('thread.btw', result => {
      if (result.threadId !== id || result.requestId !== requestId) return;
      pending = false;
      off();
      if (this.current) { this.current.answer = result.answer; this.current.error = result.error; }
    });
    this.dispose = () => {
      active = false;
      off();
      void client.call('threads.btw.cancel', { threadId: id, requestId }).catch(() => {});
    };
    if (state) state.text = '';
    void client.call('threads.btw', { threadId: id, question, requestId }).catch(reason => {
      if (!pending) return; // A delivered answer remains authoritative if its admission reply was lost.
      pending = false;
      off();
      // Navigation and dismissal unsubscribe this request, so late failures cannot replace another answer.
      if (active && this.current) this.current.error = reason instanceof Error ? reason.message : String(reason);
    });
    return true;
  }
}
