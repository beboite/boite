<script lang="ts">
  import { strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';

  const s = strings.secrets;
</script>

<section class="card" id="settings-secrets" data-testid="secrets-card">
  <h2 class="ui-label-box"><span class="ui-label">{s.heading}</span><InfoTip topic={s.heading} text={s.info} /></h2>
  <p class="muted" data-testid="secrets-storage" data-storage="memory">{s.transit}</p>
</section>
