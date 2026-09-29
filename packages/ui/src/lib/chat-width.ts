/*
 * How wide the conversation column runs, per device: the reading column, a
 * wider one for a big screen, or the whole window. It stamps `data-chat-width`
 * on `<html>` and `app.css` moves `--content` and `--prose` from there, so the
 * timeline, the composer and the cards around them widen together.
 */

export type ChatWidth = 'comfortable' | 'wide' | 'full';

export const CHAT_WIDTHS: readonly ChatWidth[] = ['comfortable', 'wide', 'full'];

export const CHAT_WIDTH_STORAGE_KEY = 'boite.chatWidth';

/** The stored width, `comfortable` when nothing is stored, storage is refused or the id is unknown. */
export function readChatWidth(): ChatWidth {
  try {
    const raw = window.localStorage.getItem(CHAT_WIDTH_STORAGE_KEY);
    return CHAT_WIDTHS.includes(raw as ChatWidth) ? (raw as ChatWidth) : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

/** Stamps the width on the page; the default leaves no attribute behind. */
export function applyChatWidth(width: ChatWidth): void {
  if (width === 'comfortable') document.documentElement.removeAttribute('data-chat-width');
  else document.documentElement.dataset['chatWidth'] = width;
}

export function setChatWidth(width: ChatWidth): void {
  try {
    if (width === 'comfortable') window.localStorage.removeItem(CHAT_WIDTH_STORAGE_KEY);
    else window.localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, width);
  } catch {
    /* a browser that refuses storage still widens for this session */
  }
  applyChatWidth(width);
}
