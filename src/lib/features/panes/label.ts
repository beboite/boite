import { app } from "$lib/app/store.svelte";
import { t } from "$lib/i18n/index.svelte";
import type { PaneContent } from "./types";

/**
 * What this pane is, in words.
 *
 * Nothing draws it any more: the strip that used to sit on top of every pane
 * was chrome over a terminal that the sidebar already names, and over a panel
 * whose own header says the same thing again. It is still what a screen reader
 * is told the pane is, which is the one reader that cannot see the content.
 */
export function paneLabel(content: PaneContent): string {
  switch (content.kind) {
    case "thread":
    case "chat": {
      const thread = app.threadById(content.threadId);
      return thread?.title ?? thread?.label ?? "";
    }
    case "dashboard":
      return t("panes.kindDashboard");
    case "git":
      return t("panes.kindGit");
    case "explorer":
      return t("panes.kindExplorer");
    case "todo":
      return t("panes.kindTodo");
    case "editor":
      return t("panes.kindEditor");
    case "browser":
      return hostOf(content.url);
  }
}

/** The host rather than the whole URL, which is what names a page in one word. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
