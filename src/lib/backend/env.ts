// Runtime probe for the Tauri host. The only place that sniffs for the
// injected IPC internals; PWA builds (Phase 5) branch on this to pick a
// transport and to gate window controls that only exist in the desktop shell.
export function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
