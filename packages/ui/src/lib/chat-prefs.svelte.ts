/** File activity preferences belong to this device, like the conversation width. */
export interface ChatPrefs {
  groupChanges: boolean;
  expandDiffs: boolean;
}

export const CHAT_PREFS_STORAGE_KEY = 'boite.chatActivity';

export function readChatPrefs(): ChatPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAT_PREFS_STORAGE_KEY) ?? 'null') as Partial<ChatPrefs> | null;
    return { groupChanges: raw?.groupChanges !== false, expandDiffs: raw?.expandDiffs === true };
  } catch {
    return { groupChanges: true, expandDiffs: false };
  }
}

export const chatPrefs = $state(readChatPrefs());

export function setChatPref<K extends keyof ChatPrefs>(key: K, value: ChatPrefs[K]): void {
  chatPrefs[key] = value;
  try { localStorage.setItem(CHAT_PREFS_STORAGE_KEY, JSON.stringify(chatPrefs)); }
  catch { /* The preference still applies when storage is unavailable. */ }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key !== CHAT_PREFS_STORAGE_KEY && event.key !== null) return;
    Object.assign(chatPrefs, readChatPrefs());
  });
}
