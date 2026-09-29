<script lang="ts">
  import type { Attachment } from '@boite/contracts';
  import type { PromptSegment } from '../lib/message-display';
  import { imageTextParts } from '../lib/composer-images';
  import { unresolvedAssetId } from '../lib/draft-attachments';

  let { segments, attachments, onopen, onhover }: {
    segments: PromptSegment[];
    attachments: Attachment[];
    onopen: (attachment: Attachment) => void;
    onhover: (attachment: Attachment | null) => void;
  } = $props();
</script>

{#each segments as segment, index (index)}{#if segment.kind === 'plain'}{#each imageTextParts(segment.text, attachments) as part, at (at)}{#if part.attachment && !unresolvedAssetId(part.attachment)}{@const attachment = part.attachment}<span role="button" tabindex="0" class="image-reference" data-testid="composer-image-reference"
  onpointerdown={(event) => event.preventDefault()}
  onpointerenter={() => onhover(attachment)} onpointerleave={() => onhover(null)}
  onfocus={() => onhover(attachment)} onblur={() => onhover(null)}
  onclick={() => onopen(attachment)}
  onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onopen(attachment); } }}>{part.text}</span>{:else}<span aria-hidden="true">{part.text}</span>{/if}{/each}{:else}<span class={segment.kind === 'command' ? 'command-token' : `keyword-${segment.kind}`} data-testid={segment.kind === 'command' ? 'command-highlight' : 'keyword-highlight'} aria-hidden="true">{segment.text}</span>{/if}{/each}

<style>
  .image-reference { color: var(--color-accent); cursor: pointer; border-radius: var(--radius-sm); pointer-events: auto; }
  .image-reference:hover, .image-reference:focus-visible { background: var(--color-accent-soft); outline: 1px solid var(--color-accent); }
  .command-token { color: var(--color-accent); }
</style>
