<!--
  The agents page: the CLIs on the machine, and the tools that switch accounts
  for them.

  Two pages until now, and the split asked the user to know that "CLI" meant
  installing the binary while "plugins" meant the switcher that logs it in.
  Both answer the same question — what can this machine run, and under which
  account — so they are one page with the install list first, since a switcher
  is worth nothing without the CLI it drives.
-->
<script lang="ts">
  import CliManagerSection from "./CliManagerSection.svelte";
  import PluginsSection from "./PluginsSection.svelte";
</script>

<CliManagerSection />
<PluginsSection />
