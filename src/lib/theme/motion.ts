import type { MotionMode } from "$lib/types";

// Applies the animation preference as a data attribute on <html> so CSS gates
// on `html[data-motion="reduced"]` instead of the media query directly — the
// user's explicit choice wins over the OS. Only "system" keeps listening to
// the OS setting. Returns a cleanup for the media-query listener.
export function applyMotionPreference(
  mode: MotionMode,
  doc: Document = document,
): () => void {
  const query =
    doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)") ?? null;
  const apply = () => {
    const reduced =
      mode === "off" || (mode === "system" && (query?.matches ?? false));
    doc.documentElement.dataset.motion = reduced ? "reduced" : "full";
  };
  apply();
  if (mode === "system" && query) {
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }
  return () => {};
}
