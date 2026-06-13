// Drives the web folder picker (FolderBrowser.svelte). In a browser/PWA there
// is no native dialog, so pickAndAddProject opens this modal instead.
class FolderBrowserStore {
  open = $state(false);
}

export const folderBrowser = new FolderBrowserStore();
