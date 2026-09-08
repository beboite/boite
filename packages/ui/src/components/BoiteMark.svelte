<script lang="ts">
  /**
   * The Boite mark: a two-level shelf in the current text colour, with a small
   * filled box on the top level and a bigger one under it. The two boxes read
   * as a lowercase b.
   */
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
  <!-- the shelf: one frame, one middle shelf, two levels -->
  <rect x="4" y="3" width="16" height="18" rx="1.5" />
  <path d="M4 10h16" />
  <!-- the two boxes, the small one up, the big one down: the b -->
  <rect x="5.75" y="4.75" width="3.5" height="3.5" rx="0.5" fill="currentColor" stroke="none" />
  <rect x="5.75" y="12.25" width="6.5" height="6.5" rx="0.6" fill="currentColor" stroke="none" />
</svg>
