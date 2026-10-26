<script lang="ts">
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import type { CompactionTarget } from '@boite/contracts';
  import { compactionPatch, compactionPolicy } from '../lib/compaction-settings';
  import InfoTip from './InfoTip.svelte';

  /**
   * The `backgroundCompaction` setting: near the automatic compaction's token
   * limit, a copy of the session compacts while the thread goes on, and the
   * thread takes it at the next pause (`docs/context.md`, "Background compaction").
   * Common background compaction stays local; per-type policies follow the
   * group's compaction defaults when the machine inherits its settings.
   */
  let { store, target, embedded = false }: { store: Store; target?: CompactionTarget; embedded?: boolean } = $props();
  const uid = $props.id();

  /** A switch saves when it flips; a refusal puts it back. */
  let saving = $state(false);
  let inflight: Promise<boolean> | null = null;
  export async function flush() {
    while (inflight) await inflight.catch(() => false);
  }
  async function save(input: HTMLInputElement) {
    saving = true;
    const sent = inflight = store.saveSettings(compactionPatch(store.settings, target, { backgroundCompaction: input.checked })).finally(() => { saving = false; if (inflight === sent) inflight = null; });
    const ok = await sent;
    if (!ok) input.checked = !input.checked;
  }
</script>

<!-- The copies run on the core's machine and spend its accounts, so only the owner turns it on; an agent asks through a settings card. -->
{#if store.owner}
  <section class:card={!embedded} id="settings-background-compaction" data-testid="background-compaction-settings">
    <label for="{uid}-on" class="master">
      <span class="words">
        <h2 class="ui-label-box"><span class="ui-label" id="{uid}-on-name">{strings.settings.backgroundCompaction}</span><InfoTip topic={strings.settings.backgroundCompaction} text={strings.settings.backgroundCompactionHint} /></h2>
      </span>
      <input id="{uid}-on" aria-labelledby="{uid}-on-name" type="checkbox" role="switch" data-testid="background-compaction-on"
        checked={compactionPolicy(store.settings, target).backgroundCompaction} disabled={!store.settings || saving} onchange={(event) => void save(event.currentTarget)} />
    </label>
  </section>
{/if}

<style>
  .master { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; cursor: pointer; }
  .master .words { display: grid; gap: 6px; flex: 1; min-width: 0; }
  .master h2 { margin: 0; }
</style>
