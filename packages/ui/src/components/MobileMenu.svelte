<script lang="ts">
  import { Activity, Bot, ChevronDown, ChevronRight, Ellipsis, Folder, MessageSquare, Monitor, Plus, Settings, X } from '@lucide/svelte';
  import type { MenuItem } from '../lib/menu';
  import Menu from './Menu.svelte';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import { experimentOn } from '../lib/experiments.svelte';
  import { mobileOverlay } from '../lib/mobile-history';
  import { focusedElement, restoreFocus } from '../lib/focus';
  import WhipButton from './WhipButton.svelte';
  let { store, place, waiting, screen, navigate, create, projects, pickProject }: { store: Store; place: string; waiting: number; screen: string; navigate: (screen: 'threads' | 'activity') => void; create: () => void; projects: MenuItem[]; pickProject: (id: string) => void } = $props();
  let shown = $state(false), dialog = $state<HTMLDialogElement>();
  $effect(() => {
    if (!shown || !dialog) return;
    const node = dialog, previous = focusedElement(); node.showModal();
    const release = mobileOverlay(() => { shown = false; });
    return () => { release(); node.close(); restoreFocus(previous); };
  });
  function go(action: () => void) { shown = false; action(); }
</script>

<button type="button" class="ghost icon" data-testid="mobile-menu" aria-label={strings.mobile.navigation} aria-expanded={shown} onclick={() => { shown = true; }}><Ellipsis size={21} /></button>
{#if shown}
  <dialog bind:this={dialog} aria-label={strings.mobile.navigation} data-testid="mobile-menu-dialog" oncancel={e => { e.preventDefault(); shown = false; }}>
    <header><img src="./icons/icon.svg" alt="" width="28" height="28" /><strong>Boite</strong><button class="ghost icon" aria-label={strings.imports.close} onclick={() => { shown = false; }}><X size={20} /></button></header>
    <button class="connection ghost" onclick={() => go(() => store.showSettings('machines'))}><Monitor size={18} /><span><strong>{place}</strong><small>{strings.connection[store.connection]}</small></span><ChevronRight size={16} /></button>
    <nav aria-label={strings.mobile.navigation}>
      <button class="ghost" data-testid="mobile-conversations" aria-current={store.page === 'chat' && screen !== 'activity' ? 'page' : undefined} onclick={() => go(() => navigate('threads'))}><MessageSquare size={20} /><span>{strings.mobile.threads}</span></button>
      <button class="ghost" data-testid="mobile-activity" aria-current={store.page === 'chat' && screen === 'activity' ? 'page' : undefined} onclick={() => go(() => navigate('activity'))}><Activity size={20} /><span>{strings.mobile.activity}</span>{#if waiting}<span class="badge">{waiting}</span>{/if}</button>
      <button class="ghost" data-testid="mobile-settings" aria-current={store.page === 'settings' ? 'page' : undefined} onclick={() => go(() => store.showSettings())}><Settings size={20} /><span>{strings.settings.heading}</span></button>
      {#if experimentOn('resident-agents')}<button class="ghost" data-testid="mobile-agents" onclick={() => go(() => store.showAgents())}><Bot size={20} /><span>{strings.agents.heading}</span></button>{/if}
    </nav>
    <div class="project-picker"><Menu items={projects} onpick={id => go(() => pickProject(id))} label={strings.mobile.project} placement="bottom" variant="ghost" testid="mobile-menu-project"><Folder size={18} /><span>{strings.mobile.project}</span><ChevronDown size={15} /></Menu></div>
    <button class="primary create" data-testid="mobile-menu-new" disabled={store.connection !== 'ready'} onclick={() => go(create)}><Plus size={18} />{strings.sidebar.newThread}</button>
    {#if experimentOn('whip')}<div class="extra"><WhipButton mobile /><span>{strings.experiments.whip.title}</span></div>{/if}
  </dialog>
{/if}

<style>
  dialog { position: fixed; inset: max(8px, env(safe-area-inset-top)) 8px auto auto; width: min(360px, calc(100vw - 16px)); max-height: calc(var(--app-height, 100dvh) - 24px); margin: 0; padding: 14px; overflow: auto; border: 1px solid var(--color-edge); border-radius: var(--radius-xl); background: var(--color-surface); color: var(--color-foreground); box-shadow: var(--shadow-e3); }
  dialog::backdrop { background: var(--color-scrim); }
  header { display: flex; align-items: center; gap: 10px; } header strong { flex: 1; }
  .connection { width: 100%; gap: 12px; text-align: left; height: auto; padding: 12px; margin: 12px 0; background: var(--color-surface-2); border-radius: var(--radius-lg); }
  .connection span { flex: 1; min-width: 0; } .connection strong, small { display: block; overflow: hidden; text-overflow: ellipsis; } small { margin-top: 3px; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  nav { display: grid; gap: 4px; } nav button { justify-content: flex-start; min-height: 48px; gap: 12px; padding: 12px; border-radius: var(--radius-md); } nav button > span:first-of-type { flex: 1; text-align: left; }
  [aria-current=page] { color: var(--color-accent); background: var(--color-accent-soft); }
  .badge { padding: 2px 6px; border-radius: var(--radius-sm); background: var(--color-accent-soft); color: var(--color-accent); }
  .create { width: 100%; min-height: 44px; margin-top: 14px; } .extra { display: flex; align-items: center; gap: 8px; margin-top: 10px; color: var(--color-muted-foreground); }
  .project-picker { margin-top: 8px; } .project-picker :global(.trigger) { width: 100%; min-height: 44px; gap: 12px; justify-content: flex-start; } .project-picker span { flex: 1; text-align: left; }
</style>
