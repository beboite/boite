import type { ComposerState } from './composer-queue';
import type { Store } from './store.svelte';
import { strings } from './strings';

/** Refuse an unsafe edit without clearing its replacement text. */
export async function rewindComposerEdit(store: Store, key: string, state: ComposerState): Promise<boolean> {
  if (!state.editing) return true;
  if (state.queued.length) { store.error = strings.composer.editingQueued; return false; }
  state.sending = true;
  try {
    if (!await store.rewind(state.editing, key)) return false;
    state.editing = null;
    return true;
  } finally {
    state.sending = false;
  }
}
