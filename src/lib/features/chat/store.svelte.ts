import {
  deleteChat as dbDeleteChat,
  loadChatMessages,
  loadChats,
  saveChat,
  saveChatMessage,
} from "$lib/storage/db";
import { logger } from "$lib/shared/services/logger.svelte";
import type { Chat, ChatMessage } from "$lib/types";

/**
 * Chats, and the turns of whichever ones have been opened.
 *
 * Messages are held per chat and loaded on demand: every one of them carries a
 * full agent answer, and a list of titles has no reason to pull a year of
 * conversations into memory to draw itself.
 */
class ChatStore {
  chats = $state<Chat[]>([]);
  messages = $state<Record<string, ChatMessage[]>>({});
  ready = $state(false);

  /** Chats whose turn is still running, so the composer can lock. */
  running = $state<Record<string, true>>({});

  private loadedMessages = new Set<string>();

  async init() {
    try {
      this.chats = await loadChats();
    } catch (err) {
      logger.error("chat", "could not load chats", String(err));
      this.chats = [];
    }
    this.ready = true;
  }

  byId(id: string | null | undefined): Chat | null {
    if (!id) return null;
    return this.chats.find((c) => c.id === id) ?? null;
  }

  async ensureMessages(chatId: string): Promise<void> {
    if (this.loadedMessages.has(chatId)) return;
    // Marked before the await: two components mounting in the same tick would
    // otherwise both miss the cache and both load.
    this.loadedMessages.add(chatId);
    try {
      this.messages[chatId] = await loadChatMessages(chatId);
    } catch (err) {
      logger.error("chat", `could not load messages for ${chatId}`, String(err));
      this.loadedMessages.delete(chatId);
      this.messages[chatId] = [];
    }
  }

  /**
   * Re-reads one chat's turns from storage, without disturbing the one being
   * written right now.
   *
   * The agent endpoint writes into this table from outside the app — that is
   * how a handover proposal arrives — so an open chat has to pick up rows it
   * did not add itself. But the proposal lands *during* the turn that asked for
   * it, and the streaming message's row on disk is the empty placeholder saved
   * when it was appended. Taking the database wholesale threw away the text
   * accumulated since, and read the row back through the cold-load rule that
   * calls an unfinished turn a failed one — so a turn that answered perfectly
   * well ended up an error bubble holding its own answer.
   *
   * Storage wins for everything except a message this client is still filling
   * in, which only it knows the truth about.
   */
  async refreshMessages(chatId: string): Promise<void> {
    const live = new Map(
      (this.messages[chatId] ?? [])
        .filter((m) => m.state === "streaming")
        .map((m) => [m.id, m] as const),
    );
    let stored: ChatMessage[];
    try {
      stored = await loadChatMessages(chatId);
    } catch (err) {
      logger.error("chat", `could not reload messages for ${chatId}`, String(err));
      return;
    }
    this.loadedMessages.add(chatId);
    const merged = stored.map((m) => live.get(m.id) ?? m);
    // A streaming message that has not been persisted at all yet still belongs
    // on screen.
    for (const [id, message] of live) {
      if (!stored.some((m) => m.id === id)) merged.push(message);
    }
    merged.sort((a, b) => a.createdAt - b.createdAt);
    this.messages[chatId] = merged;
  }

  async upsert(chat: Chat): Promise<void> {
    const at = this.chats.findIndex((c) => c.id === chat.id);
    if (at >= 0) this.chats[at] = chat;
    else this.chats = [chat, ...this.chats];
    await saveChat({ ...chat, args: [...chat.args] });
  }

  async remove(id: string): Promise<void> {
    this.chats = this.chats.filter((c) => c.id !== id);
    delete this.messages[id];
    this.loadedMessages.delete(id);
    delete this.running[id];
    await dbDeleteChat(id);
  }

  /** Appends a turn locally and persists it. */
  async append(message: ChatMessage): Promise<void> {
    const list = this.messages[message.chatId] ?? [];
    this.messages[message.chatId] = [...list, message];
    await this.persist(message);
  }

  /**
   * Replaces a turn in place, for the streaming one being filled in.
   *
   * `persist` is deliberately the caller's choice: a streaming bubble is
   * rewritten on every chunk, and writing each of those to SQLite would put a
   * transaction between the agent's tokens and the screen.
   */
  patch(chatId: string, messageId: string, patch: Partial<ChatMessage>) {
    const list = this.messages[chatId];
    if (!list) return;
    const at = list.findIndex((m) => m.id === messageId);
    if (at < 0) return;
    const next = [...list];
    next[at] = { ...next[at], ...patch };
    this.messages[chatId] = next;
  }

  current(chatId: string, messageId: string): ChatMessage | null {
    return this.messages[chatId]?.find((m) => m.id === messageId) ?? null;
  }

  async persist(message: ChatMessage): Promise<void> {
    try {
      await saveChatMessage(message);
    } catch (err) {
      logger.error("chat", `could not save a message in ${message.chatId}`, String(err));
    }
  }

  setRunning(chatId: string, on: boolean) {
    if (on) this.running[chatId] = true;
    else delete this.running[chatId];
  }

  /**
   * Desktop only. A handover proposal is written into `chat_messages` by the
   * loopback endpoint, so it arrives as a Rust event rather than through any
   * call this store made — the same shape as the todo panel's watcher, and for
   * the same reason: it can land while another chat is on screen.
   */
  watch(): () => void {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<string>("boite://chats-changed", (event) => {
          const chatId = typeof event.payload === "string" ? event.payload : null;
          if (chatId) void this.refreshMessages(chatId);
        }),
      )
      .then((un) => {
        if (cancelled) un();
        else stop = un;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  }

  /** A workspace switch invalidates everything: the rows live in that DB. */
  reset() {
    this.chats = [];
    this.messages = {};
    this.running = {};
    this.loadedMessages.clear();
    this.ready = false;
  }
}

export const chats = new ChatStore();
