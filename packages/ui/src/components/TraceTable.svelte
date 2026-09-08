<script lang="ts">
  import type { ProcessRecord, TraceCapability } from '@boite/contracts';
  import { bytes, duration, millis } from '../lib/format';
  import { strings } from '../lib/strings';

  let {
    records,
    capability
  }: { records: ProcessRecord[]; capability: TraceCapability | null } = $props();

  function name(exe: string): string {
    return exe.split(/[\\/]/).pop() ?? exe;
  }
</script>

<div class="trace">
  {#if capability}
    <p class="note subtle" data-testid="trace-note">
      <span class="mono mode">{capability.os} / {capability.mode}</span>
      {capability.note}
    </p>
  {/if}

  {#if records.length === 0}
    <p class="empty" data-testid="trace-empty">{strings.trace.empty}</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th>{strings.trace.exe}</th>
          <th>{strings.trace.pid}</th>
          <th>{strings.trace.duration}</th>
          <th>{strings.trace.cpu}</th>
          <th>{strings.trace.memory}</th>
          <th>{strings.trace.io}</th>
          <th>{strings.trace.exit}</th>
        </tr>
      </thead>
      <tbody>
        {#each records as record (`${record.pid}-${record.startedAt}`)}
          <tr class:live={record.exitedAt === null} data-testid="trace-row" data-pid={record.pid}>
            <td class="mono exe" title={record.commandLine ?? record.exe}>{name(record.exe)}</td>
            <td class="mono">{record.pid}</td>
            <td class="mono">{duration(record.startedAt, record.exitedAt)}</td>
            <td class="mono">{millis(record.cpuMs)}</td>
            <td class="mono">{bytes(record.peakMemoryBytes)}</td>
            <td class="mono" data-testid="trace-io">{bytes(record.ioBytes)}</td>
            <td class="mono">
              {#if record.exitedAt === null}
                <span class="running">{strings.trace.live}</span>
              {:else}
                {record.exitCode ?? strings.common.unknown}
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .trace {
    padding: 10px 0 14px;
  }

  .note {
    margin: 0 14px 10px;
    font-size: var(--text-xs);
  }

  .mode {
    color: var(--color-muted-foreground);
    margin-right: 6px;
    font-size: var(--text-xs);
  }

  th,
  td {
    padding: 5px 8px;
    font-size: var(--text-xs);
  }

  th:first-child,
  td:first-child {
    padding-left: 14px;
  }

  .exe {
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .running {
    color: var(--color-live);
  }

  tr.live td {
    background: var(--color-surface-2);
  }
</style>
