<script lang="ts">
  import { Bell, CircleAlert, CircleCheck, Gauge, MessageCircleQuestionMark, ShieldCheck } from '@lucide/svelte';
  import { NOTIFICATION_KINDS, type NotificationKind } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';

  /**
   * Which notifications this device gets: on the desktop the five kinds under
   * the General page's switch, on the phone the switch itself then the kinds.
   * The kinds dim while the switch is off. The choice is this device's, and a
   * device with Web Push hands it to its core (`Layout.setNotificationKind`).
   */
  let { store, mobile = false }: { store: Store; mobile?: boolean } = $props();
  const uid = $props.id();
  const icons = { approvals: ShieldCheck, questions: MessageCircleQuestionMark, finished: CircleCheck, errors: CircleAlert, limits: Gauge } satisfies Record<NotificationKind, unknown>;
</script>

<div class="kinds" class:mobile class:off={!store.notifications} data-testid="notification-kinds">
  {#if mobile}
    <label for="{uid}-all" class="row">
      <Bell size={20} />
      <span class="text ui-label-box"><span class="ui-label" id="{uid}-all-name">{strings.settings.notifications}</span></span>
      <input id="{uid}-all" aria-labelledby="{uid}-all-name" type="checkbox" role="switch" data-testid="phone-notifications"
        checked={store.notifications} onchange={(event) => void store.setNotifications(event.currentTarget.checked)} />
    </label>
  {/if}
  {#each NOTIFICATION_KINDS as kind (kind)}
    {@const Icon = icons[kind]}
    <label for="{uid}-{kind}" class={mobile ? 'row kind' : 'switch-row kind'}>
      <Icon size={mobile ? 20 : 16} />
      <span class="text ui-label-box">
        <span class="ui-label" id="{uid}-{kind}-name">{strings.settings.notificationKinds[kind]}</span>{#if kind === 'approvals'}<InfoTip topic={strings.settings.notificationKinds.approvals} text={strings.settings.notificationKindsHint} />{:else if kind === 'limits'}<InfoTip topic={strings.settings.notificationKinds.limits} text={strings.settings.notificationKindsLimitsHint} />{/if}
      </span>
      <input id="{uid}-{kind}" aria-labelledby="{uid}-{kind}-name" type="checkbox" role="switch" data-testid="setting-notification-kind-{kind}"
        checked={store.notificationKinds.includes(kind)} disabled={!store.notifications}
        onchange={(event) => store.setNotificationKind(kind, event.currentTarget.checked)} />
    </label>
  {/each}
</div>

<style>
  .kinds { display: contents; }
  .kinds :global(svg) { flex: none; color: var(--color-muted-foreground); }
  /* Under the switch they belong to, one step in; dimmed while it is off. */
  /* Under app.css's `.settings .page .switch-row`, which pads every row 16 px top and bottom. */
  .kinds:not(.mobile) .kind { min-height: 52px; padding: 10px 0 10px 16px; gap: 12px; }
  /* The switch dims itself when disabled (app.css): the words and the icon follow it. */
  .off .kind .text, .off .kind :global(svg) { opacity: .45; }
  .kind .text { flex: 1; min-width: 0; }
  /* The desktop's rows sit in a wrapper: the separators the card draws between its rows are drawn here. */
  .kinds:not(.mobile) .kind:first-child, .kinds:not(.mobile) + :global(.switch-row) { border-top: 1px solid var(--color-border); }
  /* The phone's rows, inside the notifications card: the height of a settings row, no side padding of their own. */
  .mobile { display: flex; flex-direction: column; }
  .row { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 8px 0; }
  .row + .row { border-top: 1px solid var(--color-border); }
  .row .text { flex: 1; min-width: 0; font-size: var(--text-base); font-weight: 500; color: var(--color-foreground); }
  .mobile .kind { padding-left: 12px; }
  input { flex: none; }
</style>
