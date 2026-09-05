<script lang="ts">
  /** The Boite mark: a box with its lid ajar, in the current text colour. */
  let { size = 16 }: { size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d="M4 10.5v8a1.5 1.5 0 0 0 1.5 1.5h13a1.5 1.5 0 0 0 1.5-1.5v-8" />
  <path d="M3 7.5 12 4l9 3.5-9 3.5z" />
  <path d="M12 11v9" />
</svg>
