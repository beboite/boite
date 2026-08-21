<!--
  The machines page: which devices may reach this boite, and what travels
  between them.

  Pairing and config sync were two pages, and a user looking for either was
  looking for the same thing: this boite and the other computers around it.
  Sync comes first because it applies everywhere; pairing is drawn only where a
  boite-server answers for it, so on a plain desktop this page is the sync page
  and says nothing about a capability that machine does not have.
-->
<script lang="ts">
  import SyncSection from "./SyncSection.svelte";
  import PairedDevicesSection from "./PairedDevicesSection.svelte";
  import { backend } from "$lib/backend";

  const pairs = $derived(backend().pairing !== null);
</script>

<SyncSection />
{#if pairs}
  <PairedDevicesSection />
{/if}
