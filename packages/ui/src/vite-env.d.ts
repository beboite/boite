/// <reference types="svelte" />
/// <reference types="vite/client" />

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    /**
     * The machine's regional format, set by the desktop shell before the page runs
     * (`apps/shell/src-tauri/src/platform/region.rs`). A missing, null or unparsable
     * `locale` falls back to the webview's languages; a tag without a region (`en`)
     * means none. An explicit `hour12` applies either way.
     */
    __BOITE_REGION__?: { locale?: string | null; hour12?: boolean | null };
    /** Visual-test fixture, read only on a `?fake=1` page. */
    __BOITE_APP_UPDATE_TEST__?: import('./lib/app-update.svelte').AppUpdateTestFixture;
  }
}

export {};
