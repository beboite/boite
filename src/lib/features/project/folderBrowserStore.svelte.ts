// Drives the web folder picker (FolderBrowser.svelte). In a browser/PWA there
// is no native dialog, so pickAndAddProject opens this modal instead.
class FolderBrowserStore {
  open = $state(false);
  /**
   * What the chosen folder is for, when it is not a new project.
   *
   * Null is the original job: confirm adds a project at that path. A callback
   * takes the path instead and the dialog closes on it, which is how a project
   * whose folder moved is pointed at the new one without a second browser.
   */
  onPick = $state<((path: string) => Promise<void>) | null>(null);

  /** Browse for a folder and hand it to `onPick` rather than adding a project. */
  choose(onPick: (path: string) => Promise<void>) {
    this.onPick = onPick;
    this.open = true;
  }

  close() {
    this.open = false;
    this.onPick = null;
  }
}

export const folderBrowser = new FolderBrowserStore();
