<script lang="ts">
  import { onMount } from 'svelte';
  import type { AgentsSnapshot } from '@boite/contracts';
  import type { AgentSelection } from '../../lib/agents.svelte';
  import { agentScene, type AgentSceneNode } from '../../lib/agent-scene';
  import { strings } from '../../lib/strings';
  let { snapshot, onpick }: { snapshot: AgentsSnapshot; onpick: (selection: AgentSelection) => void } = $props();
  let layout = $derived(agentScene(snapshot));
  let canvas = $state<HTMLCanvasElement>();
  let host = $state<HTMLDivElement>();
  let invalidate: () => void = () => {};
  $effect(() => { void layout; invalidate(); });
  onMount(() => {
    if (!canvas || !host) return;
    const element = canvas; const root = host;
    const context = element.getContext('2d'); if (!context) return;
    let frame = 0; let previousPaint = 0; let closed = false;
    let messageExpiry: ReturnType<typeof setTimeout> | undefined;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let colors: Record<string, string> = {};
    function palette() {
      const style = getComputedStyle(root);
      colors = Object.fromEntries(['background', 'surface', 'surface-2', 'surface-3', 'foreground', 'muted-foreground', 'border', 'accent', 'success', 'destructive'].map(key => [key, style.getPropertyValue(`--color-${key}`).trim()]));
    }
    function diamond(x: number, y: number, w: number, h: number, fill: string) {
      context!.beginPath(); context!.moveTo(x, y - h); context!.lineTo(x + w, y); context!.lineTo(x, y + h); context!.lineTo(x - w, y); context!.closePath(); context!.fillStyle = fill; context!.fill(); context!.strokeStyle = colors['border']!; context!.stroke();
    }
    function character(node: AgentSceneNode, now: number) {
      const moving = node.state === 'running' && !reduced.matches;
      const bob = moving ? Math.sin(now / 180 + node.x) * 2 : 0;
      const x = node.x; const y = node.y + bob;
      context!.globalAlpha = 0.2; context!.fillStyle = colors['foreground']!; context!.beginPath(); context!.ellipse(x, node.y + 10, 17, 6, 0, 0, Math.PI * 2); context!.fill(); context!.globalAlpha = 1;
      context!.fillStyle = colors['surface-3']!; context!.fillRect(x - 8, y - 3, 6, 13); context!.fillRect(x + 2, y - 3, 6, 13);
      context!.fillStyle = node.state === 'running' ? colors['accent']! : colors['muted-foreground']!;
      context!.beginPath(); context!.roundRect(x - 12, y - 22, 24, 24, 6); context!.fill();
      context!.fillStyle = colors['foreground']!; context!.beginPath(); context!.arc(x, y - 31, 10, 0, Math.PI * 2); context!.fill();
      context!.fillStyle = colors['surface']!; context!.fillRect(x - 5, y - 33, 3, 3); context!.fillRect(x + 3, y - 33, 3, 3);
      if (['waiting', 'interrupted', 'error'].includes(node.state)) {
        context!.fillStyle = colors['foreground']!; context!.beginPath(); context!.roundRect(x + 12, y - 59, 26, 24, 7); context!.fill();
        context!.fillStyle = colors['background']!; context!.font = 'bold 16px sans-serif'; context!.textAlign = 'center'; context!.fillText('!', x + 25, y - 42);
      }
    }
    function paint(now: number) {
      frame = 0;
      if (closed || document.hidden) return;
      const animated = !reduced.matches && layout.nodes.some(n => n.state === 'running');
      if (animated && now - previousPaint < 65) { frame = requestAnimationFrame(paint); return; }
      previousPaint = now;
      const scale = Math.min(1.5, devicePixelRatio || 1) * root.clientWidth / layout.width;
      const w = Math.max(1, Math.round(layout.width * scale)); const h = Math.max(1, Math.round(layout.height * scale));
      if (element.width !== w || element.height !== h) { element.width = w; element.height = h; }
      context!.setTransform(scale, 0, 0, scale, 0, 0); context!.clearRect(0, 0, layout.width, layout.height);
      for (let y = 25; y < layout.height; y += 50) for (let x = 25; x < layout.width; x += 100) diamond(x + (y % 100 ? 50 : 0), y, 49, 24, colors['surface']!);
      for (const node of layout.nodes.filter(n => n.kind === 'team')) { diamond(node.x, node.y + 85, 215, 100, colors['surface-3']!); diamond(node.x, node.y + 73, 215, 100, colors['surface-2']!); }
      for (const node of layout.nodes.filter(n => n.kind === 'group')) {
        context!.fillStyle = colors['surface-3']!; context!.fillRect(node.x - 40, node.y, 7, 24); context!.fillRect(node.x + 33, node.y, 7, 24);
        diamond(node.x, node.y + 6, 66, 31, colors['surface-3']!); diamond(node.x, node.y, 66, 31, colors['accent']!);
      }
      for (const node of layout.nodes.filter(n => n.kind === 'profile').sort((a, b) => a.y - b.y)) character(node, now);
      for (const message of snapshot.messages.slice(-12)) {
        if (!message.senderId || Date.now() - message.createdAt > 5000) continue;
        const from = layout.nodes.find(n => n.id === message.senderId);
        if (!from) continue;
        for (const recipient of message.recipientIds) {
          const to = layout.nodes.find(n => n.id === recipient); if (!to) continue;
          context!.strokeStyle = colors['accent']!; context!.lineWidth = 2; context!.setLineDash([4, 5]); context!.beginPath(); context!.moveTo(from.x, from.y - 30); context!.lineTo(to.x, to.y - 30); context!.stroke(); context!.setLineDash([]); context!.lineWidth = 1;
        }
      }
      clearTimeout(messageExpiry);
      if (snapshot.messages.slice(-12).some(m => Date.now() - m.createdAt < 5000)) messageExpiry = setTimeout(invalidate, 5100);
      if (animated) frame = requestAnimationFrame(paint);
    }
    invalidate = () => { if (!frame && !closed && !document.hidden) frame = requestAnimationFrame(paint); };
    const resize = new ResizeObserver(invalidate); resize.observe(root);
    const theme = new MutationObserver(() => { palette(); invalidate(); }); theme.observe(document.documentElement, { attributes: true });
    const visibility = () => { if (document.hidden) { cancelAnimationFrame(frame); frame = 0; } else invalidate(); };
    document.addEventListener('visibilitychange', visibility); reduced.addEventListener('change', invalidate);
    palette(); invalidate();
    return () => { closed = true; cancelAnimationFrame(frame); clearTimeout(messageExpiry); resize.disconnect(); theme.disconnect(); document.removeEventListener('visibilitychange', visibility); reduced.removeEventListener('change', invalidate); invalidate = () => {}; };
  });
</script>

<section class="agents-scene" aria-label={strings.agents.sceneLabel}>
  <p class="muted">{strings.agents.sceneHint}</p>
  <div class="agent-world" bind:this={host} style:aspect-ratio={`${layout.width} / ${layout.height}`} data-testid="agents-scene">
    <canvas bind:this={canvas} aria-hidden="true"></canvas>
    {#each layout.nodes as node (`${node.kind}:${node.id}`)}
      <button class="agent-scene-hit" class:character={node.kind === 'profile'} style:left={`${node.x / layout.width * 100}%`} style:top={`${node.y / layout.height * 100}%`} onclick={() => onpick({ kind: node.kind, id: node.id })} aria-label={`${node.label}: ${strings.agents[node.state]}`}>
        <span>{node.label}</span>{#if node.kind === 'profile'}<small data-status={node.state}>{strings.agents[node.state]}</small>{/if}
      </button>
    {/each}
  </div>
  {#if !snapshot.profiles.length}<p class="agent-empty">{strings.agents.sceneEmpty}</p>{/if}
</section>
