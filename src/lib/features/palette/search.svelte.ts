import { backend, workspace } from "$lib/backend";
import type { WorkspaceHit } from "$lib/backend/types";
import { logger } from "$lib/shared/services/logger.svelte";
import { debounce } from "$lib/shared/utils/debounce";
import {
  MIN_SEARCH_LENGTH,
  SEARCH_DEBOUNCE_MS,
  SEARCH_LIMIT,
  usableHits,
} from "./content";

export type AskWorkspace = (text: string, limit: number) => Promise<WorkspaceHit[]>;

/**
 * Every open host, merged.
 *
 * Same shape the todo list loads in, and for the same reason: in dynamic mode a
 * project sits on one of two machines and the palette is the one place somebody
 * asks about all of them at once. A boite that is down costs its own hits and
 * not the answer.
 */
const askEveryHost: AskWorkspace = async (text, limit) => {
  if (!workspace.isDynamic) return backend().search.query(text, limit);
  const remote = workspace.remoteBackend;
  const [here, boite] = await Promise.all([
    workspace.backendFor("local").search.query(text, limit),
    remote
      ? remote.search.query(text, limit).catch((err) => {
          logger.error("palette", "search.query (remote) failed", err);
          return [] as WorkspaceHit[];
        })
      : Promise.resolve([] as WorkspaceHit[]),
  ]);
  return [...here, ...boite];
};

/**
 * What the workspace has written down about what is being typed.
 *
 * Deliberately its own thing rather than part of the command list: the commands
 * are built locally and answer on the keystroke, and nothing about them may ever
 * wait on this.
 *
 * Two rails, both about an answer arriving out of order. Every query carries a
 * number, and an answer whose number is not newer than the one already on
 * screen is dropped: a slow query for `wo` landing after a fast one for
 * `worktree` would otherwise put the shorter query's hits under the longer
 * query's text. Clearing bumps the same counter, so a query in flight when the
 * palette closes lands on nothing.
 */
export class PaletteSearch {
  hits = $state<WorkspaceHit[]>([]);

  #ask: AskWorkspace;
  #run: ((text: string) => void) & { flush: () => void; cancel: () => void };
  /** The last query sent, and the newest one whose answer reached `hits`. */
  #issued = 0;
  #settled = 0;
  /** What `hits` is about, so re-typing the same text asks nothing. */
  #asked: string | null = null;

  constructor(ask: AskWorkspace = askEveryHost, debounceMs = SEARCH_DEBOUNCE_MS) {
    this.#ask = ask;
    this.#run = debounce((text: string) => this.#fetch(text), debounceMs);
  }

  /**
   * What the user has typed. Cheap to call on every keystroke: below the
   * minimum length nothing is sent, and above it the timer collapses a burst
   * into one query.
   */
  query(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length < MIN_SEARCH_LENGTH) {
      this.#run.cancel();
      this.clear();
      return;
    }
    this.#run(trimmed);
  }

  /** Nothing is being asked, and nothing in flight may land. */
  clear(): void {
    this.#run.cancel();
    this.#settled = ++this.#issued;
    this.#asked = null;
    // Not an unconditional assignment: the palette clears on every keystroke
    // below the minimum length, and re-assigning an already empty array would
    // re-run everything reading it for nothing.
    if (this.hits.length > 0) this.hits = [];
  }

  #fetch(text: string): void {
    if (text === this.#asked) return;
    this.#asked = text;
    const token = ++this.#issued;
    void this.#ask(text, SEARCH_LIMIT)
      .then((hits) => {
        if (token <= this.#settled) return;
        this.#settled = token;
        this.hits = usableHits(hits);
      })
      .catch((err) => {
        if (token <= this.#settled) return;
        this.#settled = token;
        logger.error("palette", "search.query failed", err);
        // The hits on screen are about an older query, so they are wrong now
        // whatever went wrong here.
        if (this.hits.length > 0) this.hits = [];
      });
  }
}

export const paletteSearch = new PaletteSearch();
