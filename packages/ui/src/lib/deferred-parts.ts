import { LazyComponent } from './lazy-component.svelte';

/**
 * Components that rows and bars of the first screen hold but do not draw on
 * it: the image viewer, the dictation panel's microphone, a diff, the quota
 * popup's table, the coordination settings, the updates card and a robot's
 * face. Each is its own chunk; the place that draws one asks for it when it
 * mounts (`components/Deferred.svelte`), and App fetches them all once the app
 * is idle, so a first open finds its code already here.
 */
export const parts = {
  ImageViewer: new LazyComponent(() => import('../components/ImageViewer.svelte')),
  Dictation: new LazyComponent(() => import('../components/Dictation.svelte')),
  DiffView: new LazyComponent(() => import('../components/DiffView.svelte')),
  QuotaOverview: new LazyComponent(() => import('../components/QuotaOverview.svelte')),
  CoordinationPanel: new LazyComponent(() => import('../components/CoordinationPanel.svelte')),
  UpdatesNotice: new LazyComponent(() => import('../components/UpdatesNotice.svelte')),
  RobotFace: new LazyComponent(() => import('../components/agents/RobotFace.svelte'))
};

/** The idle prefetch of every part (App.svelte). A failure is quiet: the part asks again when drawn. */
export function prefetchParts(): void {
  for (const part of Object.values(parts)) void part.load().catch(() => undefined);
}
