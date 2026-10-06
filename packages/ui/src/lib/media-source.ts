import { getContext, setContext } from 'svelte';
import type { Store } from './store.svelte';

/** The message a tool card's pictures belong to, which the card itself is not told. */
export interface MediaSource {
  readonly store: Store;
  readonly threadId: string;
  readonly messageId: string;
}

const KEY = Symbol('media-source');

/** Called by the component that draws one message, with getters so a changed prop is read again. */
export function provideMediaSource(source: MediaSource): void {
  setContext(KEY, source);
}

export function mediaSource(): MediaSource | undefined {
  return getContext<MediaSource | undefined>(KEY);
}
