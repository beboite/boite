import type { PaletteItem } from './palette';
import type { Store } from './store.svelte';
import { mentionRows } from './composer-menus';

const PAGE = 30;
const DEBOUNCE_MS = 60;

/**
 * The composer's mention menu: `@` at the start of a word, wherever the caret
 * is, and the word after it is the query the core ranks the project's files
 * on. The pick writes the path in as `@path`, plain text every agent reads,
 * its own way. One per composer.
 */
export class ComposerMentions {
  /** Escape shut the menu on text it keeps, until that text changes again. */
  dismissed = $state(false);
  /** The row the keyboard is on. */
  at = $state(0);
  /** The core's last page of files for the query. */
  items = $state<PaletteItem[]>([]);
  /** How many matches the core held beyond that page. */
  more = $state(0);
  /** The number of the last `projects.files` asked, so an older answer is dropped. */
  #ask = 0;
  /** The project `items` was ranked in: another one's paths are never shown. */
  #from: string | null = null;

  /**
   * The core's page for the query, asked a beat after the last keystroke, the
   * stale answer dropped. Run from an `$effect`; it returns the cleanup.
   */
  follow(query: string | null, projectId: string | null, client: Store['client']): (() => void) | undefined {
    // Every run drops the page in flight, the one that shuts the menu included.
    const ask = ++this.#ask;
    // The menu opens on the frame `@` is typed, a whole round trip before the
    // answer: a list ranked in another project, or for a word the user has
    // left, would be pickable until then. Narrowing inside one project keeps
    // its rows, which is what makes the list stand still while he types.
    if (query === null || projectId !== this.#from) {
      this.#from = projectId;
      this.items = [];
      this.more = 0;
      this.at = 0;
    }
    if (query === null || projectId === null || !client) return undefined;
    const timer = setTimeout(() => {
      void client
        .call('projects.files', { projectId, query, limit: PAGE })
        .then((page) => {
          if (ask !== this.#ask) return;
          this.items = mentionRows(page.files);
          this.more = Math.max(0, page.total - page.files.length);
          this.at = 0;
        })
        .catch(() => {
          // A project gone or a core away: the menu says nothing matches, the text stands.
          if (ask !== this.#ask) return;
          this.items = [];
          this.more = 0;
          this.at = 0;
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }
}
