import { Archive, Check, Copy, FolderInput, GitPullRequest, MessageSquare, PencilLine, Pin, PinOff, Sparkles, Trash2, X } from '@lucide/svelte';
import type { ThreadSummary } from '@boite/contracts';
import type { Store } from './store.svelte';
import { separator, type MenuItem } from './menu';
import { canMarkDone } from './recent.svelte';
import { canDeleteThread } from './thread-removal';
import { moveItems } from './thread-move.svelte';
import { strings } from './strings';

interface ThreadMenuOptions {
  /** Rows can open their thread; the header is already there. */
  open?: boolean;
  showDone?: boolean;
  /** Omitted where pull requests have no manual refresh action. */
  prLoading?: boolean;
  tools?: MenuItem[];
}

/** The same action groups in row, title and phone menus, with Archive always available. */
export function threadMenuItems(store: Store, thread: ThreadSummary, options: ThreadMenuOptions = {}): MenuItem[] {
  const retitling = store.retitling.includes(thread.id);
  const items: MenuItem[] = [
    ...(options.open === undefined ? [] : [{ id: 'open', label: strings.sidebar.open, glyph: MessageSquare, disabled: options.open }]),
    { id: 'pin', label: thread.pinned ? strings.sidebar.unpin : strings.sidebar.pin, glyph: thread.pinned ? PinOff : Pin },
    separator('sep-archive'),
    ...(options.showDone ? [{ id: 'done', label: strings.sidebar.markDone, glyph: Check, disabled: !canMarkDone(store, thread) }] : []),
    { id: 'archive', label: strings.sidebar.archive, glyph: Archive },
    separator('sep-organize'),
    { id: 'rename', label: strings.sidebar.rename, glyph: PencilLine },
    { id: 'retitle', label: retitling ? strings.sidebar.retitling : strings.sidebar.retitle, glyph: Sparkles, disabled: retitling },
    ...(thread.parentThreadId || thread.projectId === null ? [] : moveItems(store, thread).map(item => ({ ...item, glyph: item.id === 'move-cancel' ? X : FolderInput }))),
    separator('sep-tools'),
    { id: 'copy', label: strings.sidebar.copyPath, glyph: Copy, title: thread.cwd },
    ...(options.prLoading === undefined || !thread.branch || thread.branch === 'HEAD' ? [] : [{ id: 'pr', label: strings.machines.refreshPr, glyph: GitPullRequest, disabled: options.prLoading }]),
    ...(options.tools ?? [])
  ];
  if (canDeleteThread(thread)) items.push(separator('sep-delete'), { id: 'delete', label: strings.sidebar.delete, glyph: Trash2, danger: true });
  return items;
}
