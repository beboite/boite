<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { app } from "$lib/store.svelte";

  let { children } = $props();

  onMount(() => {
    void app.init();
  });
</script>

{@render children()}
