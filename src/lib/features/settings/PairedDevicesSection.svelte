<script lang="ts">
  import { onMount } from "svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import { backend } from "$lib/backend";
  import type { PairedDevice, PairingInvite } from "$lib/backend/types";
  import { t } from "$lib/i18n/index.svelte";
  import { formatAgo } from "$lib/shared/utils/relative-time";
  import Trash2 from "@lucide/svelte/icons/trash-2";

  /**
   * Which devices may reach this boite, and the way to invite or remove one.
   *
   * Every call behind this needs the `admin` scope server-side, so a device
   * paired without it sees the refusal rather than a broken screen. Nothing
   * here is available against a local desktop workspace: a window on the
   * machine is one of the devices, not a host that pairs them.
   */
  const pairing = $derived(backend().pairing);

  const SCOPES = ["read", "write", "terminal", "approve", "admin"] as const;
  /** What a new device gets unless the user says otherwise. `admin` is not in it. */
  const DEFAULT_SCOPES = ["read", "write", "terminal", "approve"];

  let devices = $state<PairedDevice[]>([]);
  let loading = $state(true);
  let error = $state("");

  let label = $state("");
  let chosen = $state<string[]>([...DEFAULT_SCOPES]);
  let invite = $state<PairingInvite | null>(null);
  let inviting = $state(false);

  async function reload() {
    const api = pairing;
    if (!api) {
      loading = false;
      return;
    }
    loading = true;
    error = "";
    try {
      devices = await api.list();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(reload);

  async function createInvite() {
    const api = pairing;
    if (!api || inviting || chosen.length === 0) return;
    inviting = true;
    error = "";
    try {
      invite = await api.invite({
        label: label.trim(),
        kind: "unknown",
        scopes: chosen,
        // This device's own origin. A boite behind a reverse proxy cannot work
        // out the name it is reached by, and a configured BOITE_PUBLIC_URL wins
        // over this one anyway.
        base: typeof location === "undefined" ? "" : location.origin,
      });
      label = "";
      await reload();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      inviting = false;
    }
  }

  async function revoke(row: PairedDevice) {
    const api = pairing;
    if (!api) return;
    error = "";
    try {
      await api.revoke(row.id);
      await reload();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function toggle(scope: string) {
    chosen = chosen.includes(scope)
      ? chosen.filter((s) => s !== scope)
      : [...chosen, scope];
  }

  async function copyLink() {
    if (!invite || typeof navigator === "undefined") return;
    try {
      await navigator.clipboard.writeText(invite.url);
    } catch {
      // Clipboard access can be refused; the link is on screen either way.
    }
  }
</script>

<!-- One card, not one per branch: a local workspace and a boite are two things
     this list can say, not two settings. Two cards would also mean the same
     anchor drawn twice, which is what search resolves a hit against. -->
<SettingsCard
  title={t("devices.title")}
  anchor="devices.title"
  description={pairing ? t("devices.description") : t("devices.localOnly")}
>
  {#if !pairing}
    <p class="text-sm text-muted-2">{t("devices.localOnlyDetail")}</p>
  {:else}
    {#if loading}
      <p class="text-sm text-muted-2">{t("common.loading")}</p>
    {:else if devices.length === 0}
      <p class="text-sm text-muted-2">{t("devices.none")}</p>
    {:else}
      <ul class="flex flex-col gap-1.5">
        {#each devices as row (row.id)}
          <li
            class="flex items-center gap-3 rounded-md border border-border bg-[var(--color-surface-2)] px-3 py-2 {row.revokedAt
              ? 'opacity-50'
              : ''}"
          >
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate text-sm text-foreground">{row.label}</span>
                <span class="shrink-0 text-xs text-muted-2">{row.kind}</span>
                {#if row.revokedAt}
                  <span class="shrink-0 text-xs text-danger">{t("devices.revoked")}</span>
                {/if}
              </div>
              <p class="truncate text-xs text-muted-2">
                {row.scopes.join(", ") || t("devices.noScopes")}
                &middot;
                {row.lastSeenAt
                  ? t("devices.lastSeen", { when: formatAgo(Date.now() - row.lastSeenAt) })
                  : t("devices.neverSeen")}
              </p>
            </div>
            {#if !row.revokedAt}
              <button
                type="button"
                class="shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-danger"
                onclick={() => revoke(row)}
                aria-label={t("devices.revokeAction")}
                use:tip={t("devices.revokeAction")}
              >
                <Trash2 class="size-4" />
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if error}
      <p class="text-sm text-danger">{error}</p>
    {/if}
  {/if}
</SettingsCard>

{#if pairing}
  <SettingsCard
    title={t("devices.inviteTitle")}
    anchor="devices.inviteTitle"
    description={t("devices.inviteDesc")}
  >
    <label class="flex flex-col gap-1 text-xs text-muted-foreground">
      {t("devices.inviteLabel")}
      <input
        class="rounded-md border border-edge bg-[var(--color-surface)] px-3 py-2 text-sm text-foreground outline-none focus:border-[var(--color-success)]"
        bind:value={label}
        placeholder={t("devices.invitePlaceholder")}
        autocomplete="off"
      />
    </label>

    <div class="flex flex-wrap gap-1.5">
      {#each SCOPES as scope (scope)}
        <button
          type="button"
          aria-pressed={chosen.includes(scope)}
          class="rounded-md border px-2 py-1 text-xs transition {chosen.includes(scope)
            ? 'border-foreground/40 bg-[var(--color-surface-3)] text-foreground'
            : 'border-edge text-muted-foreground hover:text-foreground'}"
          onclick={() => toggle(scope)}
        >
          {t(`devices.scope.${scope}`)}
        </button>
      {/each}
    </div>
    <p class="text-xs text-muted-2">{t("devices.scopeHint")}</p>

    <button
      type="button"
      disabled={inviting || chosen.length === 0}
      class="self-start rounded-md border border-edge bg-[var(--color-surface-2)] px-3 py-1.5 text-sm text-foreground transition hover:bg-[var(--color-surface-3)] disabled:opacity-50"
      onclick={createInvite}
    >
      {t("devices.inviteAction")}
    </button>

    {#if invite}
      <div class="flex flex-col items-center gap-3 rounded-md border border-border bg-[var(--color-surface-2)] p-4">
        {#if invite.qr}
          <!-- Drawn from the server's matrix rather than injected as markup: a
               QR is fifteen lines of <rect> on this side, and pasting
               server-sent HTML into the page would be a second way for the
               server to write into the DOM. -->
          <svg
            viewBox="0 0 {invite.qr.size} {invite.qr.size}"
            class="size-56 rounded bg-white p-2"
            role="img"
            aria-label={t("devices.qrAlt")}
          >
            {#each invite.qr.rows as row, y (y)}
              {#each row.split("") as cell, x (x)}
                {#if cell === "1"}
                  <rect {x} {y} width="1" height="1" fill="#000" />
                {/if}
              {/each}
            {/each}
          </svg>
        {/if}
        <p class="text-xs text-muted-foreground">{t("devices.inviteOnce")}</p>
        <code class="w-full break-all rounded bg-[var(--color-surface-3)] px-2 py-1 text-xs text-foreground">
          {invite.url}
        </code>
        <button
          type="button"
          class="rounded-md border border-edge px-3 py-1.5 text-sm text-foreground transition hover:bg-[var(--color-surface-3)]"
          onclick={copyLink}
        >
          {t("devices.copyLink")}
        </button>
      </div>
    {/if}
  </SettingsCard>
{/if}
