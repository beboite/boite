<script lang="ts">
  import { secureId } from '../../lib/secure-id';
  import { Dices } from '@lucide/svelte';
  import { choices, robotColor, ROBOT_FAMILIES, ROBOT_ROWS, shuffledRobot, withPart, type Robot, type RobotNumberPart } from '../../lib/robots';
  import { fill, strings } from '../../lib/strings';
  import RobotFace from './RobotFace.svelte';

  /**
   * Picks a robot the way one dresses a character: the robot as it stands,
   * Shuffle for a new one, and one row per part where every choice is drawn
   * on the robot itself, so nothing has to be read. Every part fits every
   * style, so a row offers the same choices whatever the style.
   */
  let { robot, onpick }: { robot: Robot; onpick: (robot: Robot) => void } = $props();
  const labels = $derived(strings.agents.robot);
  /** The rows whose first choice is to wear nothing. */
  const OPTIONAL = new Set<RobotNumberPart>(['mouth', 'top', 'cheeks', 'gear']);

  function shuffle() {
    onpick(shuffledRobot(secureId(), robot.family));
  }
  function nameOf(part: RobotNumberPart, index: number): string {
    if (OPTIONAL.has(part) && index === 0) return `${labels[part]}: ${labels.none}`;
    return fill(labels.option, { part: labels[part], n: String(OPTIONAL.has(part) ? index : index + 1) });
  }
</script>

<div class="robot-picker" data-testid="robot-picker">
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
    {#each ROBOT_ROWS as part (part)}
      <div class="part" role="radiogroup" aria-label={labels[part]} data-part={part}>
        <span class="part-label">{labels[part]}</span>
        <div class="options" class:swatches={part === 'color'}>
          {#each { length: choices(part) } as _, index (index)}
            {@const option = withPart(robot, part, index)}
            {@const name = nameOf(part, index)}
            {#if part === 'color'}
              <button type="button" class="swatch" class:on={robot.color === index} role="radio" aria-checked={robot.color === index} title={name} aria-label={name} style:--swatch={robotColor({ color: index })} onclick={() => onpick(option)}></button>
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
  /* The robot stays in view while the rows under it scroll by. */
  .stage { position: sticky; top: 8px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .portrait { width: 112px; height: 112px; border-radius: 50%; overflow: hidden; display: block; box-shadow: var(--shadow-e1); }
  .stage button { gap: 6px; }
  .parts { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .part-label { display: block; margin-bottom: 5px; font-size: var(--text-xs); font-weight: 600; color: var(--color-muted-foreground); }
  .options { display: flex; flex-wrap: wrap; gap: 6px; }
  /* Nine lively colors over nine pastel ones. */
  .options.swatches { display: grid; grid-template-columns: repeat(9, 28px); }
  .option { width: auto; height: auto; padding: 3px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); }
  .option.family { gap: 6px; padding: 3px 10px 3px 3px; font-size: var(--text-sm); font-weight: 500; }
  .option.on, .swatch.on { border-color: var(--color-accent); box-shadow: 0 0 0 2px var(--color-accent-soft); }
  .thumb { width: 34px; height: 34px; display: block; border-radius: 50%; overflow: hidden; flex: none; }
  .swatch { width: 28px; height: 28px; padding: 0; border-radius: 50%; border: 2px solid var(--color-surface); background: var(--swatch); }
  @media (max-width: 720px) {
    .robot-picker { grid-template-columns: 1fr; justify-items: center; }
    .stage { position: static; }
    .parts { width: 100%; }
    .options.swatches { grid-template-columns: repeat(auto-fill, 28px); }
  }
</style>
