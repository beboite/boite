<script lang="ts">
  import { resolveFileGlyph, type FileGlyph } from "./fileIcon";
  import FileText from "@lucide/svelte/icons/file-text";
  import FileCode from "@lucide/svelte/icons/file-code";
  import FileImage from "@lucide/svelte/icons/file-image";
  import FileVideo from "@lucide/svelte/icons/file-video";
  import FileAudio from "@lucide/svelte/icons/file-audio";
  import FileArchive from "@lucide/svelte/icons/file-archive";
  import FileLock from "@lucide/svelte/icons/file-lock";
  import FileSpreadsheet from "@lucide/svelte/icons/file-spreadsheet";
  import FileType from "@lucide/svelte/icons/file-type";
  import Binary from "@lucide/svelte/icons/binary";

  interface Props {
    filename: string;
    size?: number;
  }
  let { filename, size = 14 }: Props = $props();

  const glyph: FileGlyph = $derived(resolveFileGlyph(filename));
</script>

{#if glyph.kind === "brand"}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="#{glyph.hex}"
    aria-hidden="true"
    class="shrink-0 opacity-90"
    style:width="{size}px"
    style:height="{size}px"
  >
    <path d={glyph.path} />
  </svg>
{:else}
  <span class="inline-flex shrink-0 text-muted-foreground/85">
    {#if glyph.category === "image"}
      <FileImage {size} />
    {:else if glyph.category === "video"}
      <FileVideo {size} />
    {:else if glyph.category === "audio"}
      <FileAudio {size} />
    {:else if glyph.category === "archive"}
      <FileArchive {size} />
    {:else if glyph.category === "lock"}
      <FileLock {size} />
    {:else if glyph.category === "spreadsheet"}
      <FileSpreadsheet {size} />
    {:else if glyph.category === "doc"}
      <FileType {size} />
    {:else if glyph.category === "code"}
      <FileCode {size} />
    {:else if glyph.category === "binary"}
      <Binary {size} />
    {:else}
      <FileText {size} />
    {/if}
  </span>
{/if}
