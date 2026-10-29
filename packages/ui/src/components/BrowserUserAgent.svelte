<script lang="ts">
  import { browserUserAgentError, type BrowserProfile, type BrowserUserAgent as UserAgent } from '@boite/contracts';
  import { browserProfiles } from '../lib/browser-profiles.svelte';
  import { fill, strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';
  import Menu from './Menu.svelte';

  let { profile, disabled = false }: { profile: BrowserProfile; disabled?: boolean } = $props();
  const s = $derived(strings.browserProfiles);
  let open = $state(false);
  let mode = $state<UserAgent['mode']>('suffix');
  let value = $state('');
  let busy = $state(false);
  let problem = $state('');

  function edit(): void {
    mode = profile.userAgent?.mode ?? 'suffix';
    value = profile.userAgent?.value ?? '';
    problem = '';
    open = true;
  }

  async function save(event: Event): Promise<void> {
    event.preventDefault();
    if (browserUserAgentError({ mode, value })) { problem = s.userAgentInvalid; return; }
    const id = profile.id;
    const userAgent = value.trim() ? { mode, value: value.trim() } : undefined;
    busy = true;
    try {
      if (await browserProfiles.save(profiles => profiles.map(one => {
        if (one.id !== id) return one;
        const { userAgent: _old, ...base } = one;
        return { ...base, ...(userAgent ? { userAgent } : {}) };
      }))) open = false;
    } finally { busy = false; }
  }
</script>

{#if open}
  <form class="user-agent" onsubmit={save} data-testid="browser-user-agent-form">
    <span class="ui-label-box"><span class="ui-label">{s.userAgent}</span><InfoTip topic={s.userAgent} text={s.userAgentHint} /></span>
    <div class="fields">
      <Menu items={[{ id: 'suffix', label: s.userAgentSuffix }, { id: 'replace', label: s.userAgentReplace }]} onpick={(id) => { mode = id as UserAgent['mode']; }} label={s.userAgentMode} testid="browser-user-agent-mode">{mode === 'suffix' ? s.userAgentSuffix : s.userAgentReplace}</Menu>
      <input bind:value aria-label={fill(s.userAgentLabel, { name: profile.name })} placeholder={s.userAgentPlaceholder} maxlength="8192" disabled={busy || disabled} data-testid="browser-user-agent-value" />
      <button type="submit" class="small" disabled={busy || disabled} data-testid="browser-user-agent-save">{strings.common.save}</button>
      <button type="button" class="small ghost" disabled={busy} onclick={() => { open = false; }}>{strings.common.cancel}</button>
    </div>
    {#if problem}<p role="alert">{problem}</p>{/if}
  </form>
{:else}
  <button type="button" class="small ghost" disabled={disabled} onclick={edit} data-testid="browser-user-agent-edit">{s.userAgent}{profile.userAgent ? ' *' : ''}</button>
{/if}

<style>
  .user-agent { flex: 1 0 100%; min-width: 0; padding: 6px 0; }
  .fields { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  input { flex: 1 1 12em; min-width: 0; }
  p { margin: 6px 0 0; font-size: var(--text-sm); color: var(--color-danger); }
</style>
