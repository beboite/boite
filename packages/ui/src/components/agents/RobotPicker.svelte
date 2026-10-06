<script lang="ts">
  import { Dices } from '@lucide/svelte';
  import { choices, ROBOT_FAMILIES, seededRobot, withPart, type Robot, type RobotPart } from '../../lib/robots';
  import { fill, strings } from '../../lib/strings';
  import RobotFace from './RobotFace.svelte';

  /**
   * Picks a robot the way one dresses a character: the robot as it stands,
   * Shuffle for a new one, and one row per part where every choice is drawn
   * on the robot itself, so nothing has to be read.
   */
  let { robot, onpick, compact = false }: { robot: Robot; onpick: (robot: Robot) => void; compact?: boolean } = $props();
  const labels = $derived(strings.agents.robot);
  const rows: Exclude<RobotPart, 'family'>[] = ['shape', 'color', 'eyes', 'top'];

  function shuffle() {
    onpick(seededRobot(crypto.randomUUID(), robot.family));
  }
</script>

<div class="robot-picker" class:compact data-testid="robot-picker">
  <div class="stage">
    <span class="portrait"><RobotFace {robot} /></span>
    <button type="button" class="small" onclick={shuffle} data-testid="robot-shuffle"><Dices size={14} strokeWidth={1.75} />{labels.shuffle}</button>
  </div>
  <div class="parts">
    <div class="part" role="radiogroup" aria-label={labels.family}>
      <span class="part-label">{labels.family}</span>
      <div class="options">
        {#each ROBOT_FAMILIES as family (family)}
          {@const option = withPart(robot, 'family', family)}
          <button type="button" class="option family" class:on={robot.family === family} role="radio" aria-checked={robot.family === family} title={labels.families[family]} aria-label={labels.families[family]} onclick={() => onpick(option)}>
            <span class="thumb"><RobotFace robot={option} state="still" /></span><span>{labels.families[family]}</span>
          </button>
        {/each}
      </div>
    </div>
    {#each rows as part (part)}
      <div class="part" role="radiogroup" aria-label={labels[part]}>
        <span class="part-label">{labels[part]}</span>
        <div class="options">
          {#each { length: choices(robot, part) } as _, index (index)}
            {@const option = withPart(robot, part, index)}
            {@const name = fill(labels.option, { part: labels[part], n: String(index + 1) })}
            {#if part === 'color'}
              <button type="button" class="swatch" class:on={robot.color === index} role="radio" aria-checked={robot.color === index} title={name} aria-label={name} style:--swatch="var(--robot-{index + 1})" onclick={() => onpick(option)}></button>
            {:else}
              <button type="button" class="option" class:on={robot[part] === index} role="radio" aria-checked={robot[part] === index} title={name} aria-label={name} onclick={() => onpick(option)}>
                <span class="thumb"><RobotFace robot={option} state="still" /></span>
              </button>
            {/if}
          {/each}
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .robot-picker { display: grid; grid-template-columns: auto 1fr; gap: 20px; align-items: start; }
  .stage { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .portrait { width: 112px; height: 112px; border-radius: 50%; overflow: hidden; display: block; box-shadow: var(--shadow-e1); }
  .stage button { gap: 6px; }
  .parts { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .part-label { display: block; margin-bottom: 5px; font-size: var(--text-xs); font-weight: 600; color: var(--color-muted-foreground); }
  .options { display: flex; flex-wrap: wrap; gap: 6px; }
  .option { width: auto; height: auto; padding: 3px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); }
  .option.family { gap: 6px; padding: 3px 10px 3px 3px; font-size: var(--text-sm); font-weight: 500; }
  .option.on, .swatch.on { border-color: var(--color-accent); box-shadow: 0 0 0 2px var(--color-accent-soft); }
  .thumb { width: 32px; height: 32px; display: block; border-radius: 50%; overflow: hidden; flex: none; }
  .swatch { width: 28px; height: 28px; padding: 0; border-radius: 50%; border: 2px solid var(--color-surface); background: var(--swatch); }
  .compact .portrait { width: 88px; height: 88px; }
  .compact .thumb { width: 28px; height: 28px; }
  @media (max-width: 720px) {
    .robot-picker { grid-template-columns: 1fr; justify-items: center; }
    .parts { width: 100%; }
  }
</style>
