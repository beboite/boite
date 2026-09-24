/// <reference types="svelte" />
/// <reference types="vite/client" />

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    /** Visual-test fixture, read only on a `?fake=1` page. */
    __BOITE_APP_UPDATE_TEST__?: import('./lib/app-update.svelte').AppUpdateTestFixture;
  }
}

export {};
