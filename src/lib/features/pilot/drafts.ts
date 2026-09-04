/** Device-local text drafts. No provider, backend or sync call receives them. */
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const PREFIX = "boite.pilot.draft.v1:";
const MAX_PERSISTED_CHARS = 256 * 1024;

export function draftKey(workspace: string, thread: string): string {
  return PREFIX + JSON.stringify([workspace, thread]);
}

export function remoteDraftScope(id: string | null, url: string | null): string {
  if (id) return `remote:${id}`;
  try {
    const parsed = new URL(url ?? "");
    // Connection credentials and query parameters must not become storage keys.
    return `remote:${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch { return "remote:unknown"; }
}

export function restoreFailedDraft(failed: string, current: string): string {
  return current ? `${failed}\n\n${current}` : failed;
}

export function createDraftStore(storage: () => DraftStorage | null) {
  const memory = new Map<string, string>();
  return {
    read(key: string): string {
      if (memory.has(key)) return memory.get(key)!;
      try {
        const raw = storage()?.getItem(key);
        if (!raw || raw.length > MAX_PERSISTED_CHARS * 6 + 2) return "";
        const text: unknown = JSON.parse(raw);
        return typeof text === "string" && text.length <= MAX_PERSISTED_CHARS ? text : "";
      } catch { return ""; }
    },
    write(key: string, text: string): void {
      memory.set(key, text);
      try {
        const target = storage();
        if (!text || text.length > MAX_PERSISTED_CHARS) target?.removeItem(key);
        else target?.setItem(key, JSON.stringify(text));
      } catch { /* Quota and private mode must not break composing. */ }
    },
  };
}

export const composerDrafts = createDraftStore(() =>
  typeof window === "undefined" ? null : window.localStorage,
);
