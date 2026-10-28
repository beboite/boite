<script lang="ts">
  import { slide } from 'svelte/transition';
  import { Plus, X } from '@lucide/svelte';
  import type { LocalAcpCommand } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';

  /**
   * Settings > Providers: an ACP agent added from the command that starts it.
   * The core writes it as a user descriptor and refuses a field it cannot use;
   * the refusal lands beside that field. Removing one sits in its row's details.
   */
  let { store }: { store: Store } = $props();
  const uid = $props.id();

  interface Arg { id: number; value: string }
  interface Variable { id: number; key: string; value: string }

  let open = $state(false);
  let name = $state('');
  let command = $state('');
  let args = $state<Arg[]>([]);
  let env = $state<Variable[]>([]);
  let busy = $state(false);
  let error = $state('');
  /** The field the core refused, as it names it: `name`, `command`, `args[1]`, `env.KEY`. */
  let field = $state<string | null>(null);
  let added = $state('');
  let rows = 0;

  const fold = (): number =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'reduced' ? 0 : 180;

  /**
   * What is sent: empty argument rows and blank variable rows are left out, and `field` points back at the rows that stayed.
   * A value without a name is sent, so the core refuses it instead of the form dropping it.
   */
  const sent = $derived(args.filter((arg) => arg.value.length > 0));
  const named = $derived(env.filter((entry) => entry.key.trim().length > 0 || entry.value.length > 0));

  function invalidArg(arg: Arg): boolean {
    return field === `args[${sent.indexOf(arg)}]`;
  }
  function invalidVariable(entry: Variable): boolean {
    return field === 'env' || field === `env.${entry.key.trim()}`;
  }

  function reset() {
    name = ''; command = ''; args = []; env = []; error = ''; field = null;
  }

  function close() {
    reset();
    open = false;
  }

  async function save() {
    if (busy) return;
    busy = true; error = ''; field = null; added = '';
    const input: LocalAcpCommand = {
      name,
      command,
      args: sent.map((arg) => arg.value),
      env: Object.fromEntries(named.map((entry) => [entry.key.trim(), entry.value])),
    };
    try {
      const result = await store.addLocalProvider(input);
      if (result.ok) {
        added = fill(strings.localAcp.added, { provider: name.trim() });
        close();
      } else {
        error = result.message;
        field = result.field;
      }
    } finally {
      busy = false;
    }
  }
</script>

<section class="card local-acp" data-testid="local-acp">
  <div class="head">
    <h2 class="ui-label-box"><span class="ui-label">{strings.localAcp.heading}</span><InfoTip topic={strings.localAcp.heading} text={strings.localAcp.hint} /></h2>
    {#if !open}
      <button type="button" class="quiet small" data-testid="local-acp-open" onclick={() => { open = true; added = ''; }}><Plus size={14} /><span class="ui-label">{strings.localAcp.open}</span></button>
    {/if}
  </div>
  {#if added && !open}<p class="hint" role="status" data-testid="local-acp-added">{added}</p>{/if}
  {#if open}
    <form transition:slide={{ duration: fold() }} onsubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>
        <span class="ui-label">{strings.localAcp.name}</span>
        <input bind:value={name} required maxlength="60" placeholder={strings.localAcp.namePlaceholder} aria-invalid={field === 'name'} data-testid="local-acp-name" />
      </label>
      <label>
        <span class="ui-label-box"><span class="ui-label">{strings.localAcp.command}</span><InfoTip topic={strings.localAcp.command} text={strings.localAcp.commandHint} /></span>
        <input class="mono" bind:value={command} required spellcheck="false" autocapitalize="off" autocomplete="off" placeholder={strings.localAcp.commandPlaceholder} aria-invalid={field === 'command'} data-testid="local-acp-command" />
      </label>

      <fieldset>
        <legend class="ui-label">{strings.localAcp.args}</legend>
        {#each args as arg, index (arg.id)}
          <div class="row">
            <input class="mono" bind:value={arg.value} spellcheck="false" autocapitalize="off" autocomplete="off" aria-label={fill(strings.localAcp.arg, { n: String(index + 1) })} aria-invalid={invalidArg(arg)} data-testid="local-acp-arg" />
            <button type="button" class="quiet small icon" aria-label={strings.localAcp.removeRow} title={strings.localAcp.removeRow} onclick={() => args = args.filter((entry) => entry !== arg)}><X size={14} /></button>
          </div>
        {/each}
        <div class="actions">
          <button type="button" class="ghost small" data-testid="local-acp-add-arg" onclick={() => args = [...args, { id: ++rows, value: '' }]}><Plus size={14} /><span class="ui-label">{strings.localAcp.addArg}</span></button>
        </div>
      </fieldset>

      <fieldset>
        <legend class="ui-label-box"><span class="ui-label">{strings.localAcp.env}</span><InfoTip topic={strings.localAcp.env} text={strings.localAcp.envHint} /></legend>
        {#each env as entry (entry.id)}
          <div class="row">
            <input class="mono key" bind:value={entry.key} spellcheck="false" autocapitalize="off" autocomplete="off" placeholder={strings.localAcp.envName} aria-label={strings.localAcp.envName} aria-invalid={invalidVariable(entry)} data-testid="local-acp-env-key" />
            <input class="mono" bind:value={entry.value} spellcheck="false" autocapitalize="off" autocomplete="off" placeholder={strings.localAcp.envValue} aria-label={strings.localAcp.envValue} aria-invalid={invalidVariable(entry)} data-testid="local-acp-env-value" />
            <button type="button" class="quiet small icon" aria-label={strings.localAcp.removeRow} title={strings.localAcp.removeRow} onclick={() => env = env.filter((row) => row !== entry)}><X size={14} /></button>
          </div>
        {/each}
        <div class="actions">
          <button type="button" class="ghost small" data-testid="local-acp-add-env" onclick={() => env = [...env, { id: ++rows, key: '', value: '' }]}><Plus size={14} /><span class="ui-label">{strings.localAcp.addEnv}</span></button>
        </div>
      </fieldset>

      {#if error}<p class="error" role="alert" id="{uid}-error" data-testid="local-acp-error">{error}</p>{/if}
      <div class="actions">
        <button type="submit" class="primary small" disabled={busy || !name.trim() || !command.trim()} aria-describedby={error ? `${uid}-error` : undefined} data-testid="local-acp-save"><span class="ui-label">{strings.localAcp.save}</span></button>
        <button type="button" class="quiet small" disabled={busy} onclick={close} data-testid="local-acp-cancel"><span class="ui-label">{strings.common.cancel}</span></button>
      </div>
    </form>
  {/if}
</section>

<style>
  .local-acp { max-width: var(--settings-width); padding: var(--settings-padding); }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h2 { display: flex; align-items: center; margin: 0; }
  form { display: grid; gap: 14px; margin-top: 16px; }
  label { display: grid; gap: 6px; font-size: var(--text-sm); }
  fieldset { display: grid; gap: 6px; min-width: 0; margin: 0; padding: 0; border: 0; font-size: var(--text-sm); }
  legend { display: flex; align-items: center; margin-bottom: 6px; padding: 0; }
  input { width: 100%; min-width: 0; }
  .mono { font-family: var(--font-mono); font-size: var(--text-sm); }
  .row { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .row .key { flex: 0 0 38%; }
  [aria-invalid='true'] { border-color: var(--color-danger); }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .hint { margin: 8px 0 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  /* Not a `.hint`: the settings pages paint every hint muted, and a refusal reads as one. */
  .error { margin: 0; color: var(--color-danger); font-size: var(--text-sm); line-height: 1.5; overflow-wrap: anywhere; }
  .error::first-letter { text-transform: uppercase; }
</style>
