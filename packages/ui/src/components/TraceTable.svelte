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

  // The column is too narrow for a path, so everything it drops lives in the
  // tooltip: the full path, the pid the column no longer shows, the command line.
  function tip(record: ProcessRecord): string {
    const lines = [record.exe, `pid ${record.pid}`];
    if (record.commandLine && record.commandLine !== record.exe) lines.push(record.commandLine);
    return lines.join('\n');
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
    <table data-testid="trace-table">
      <colgroup>
        <col />
        <col class="c-duration" />
        <col class="c-cpu" />
        <col class="c-memory" />
        <col class="c-io" />
        <col class="c-exit" />
      </colgroup>
      <thead>
        <tr>
          <th>{strings.trace.exe}</th>
          <th class="num">{strings.trace.duration}</th>
          <th class="num">{strings.trace.cpu}</th>
          <th class="num">{strings.trace.memory}</th>
          <th class="num">{strings.trace.io}</th>
          <th>{strings.trace.exit}</th>
        </tr>
      </thead>
      <tbody>
        {#each records as record (`${record.pid}-${record.startedAt}`)}
          <tr class:live={record.exitedAt === null} data-testid="trace-row" data-pid={record.pid}>
            <td class="mono exe" data-exe={record.exe} title={tip(record)}>{name(record.exe)}</td>
            <td class="mono num">{duration(record.startedAt, record.exitedAt)}</td>
            <td class="mono num">{millis(record.cpuMs)}</td>
            <td class="mono num">{bytes(record.peakMemoryBytes)}</td>
            <td class="mono num" data-testid="trace-io">{bytes(record.ioBytes)}</td>
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
    font-size: var(--text-sm);
  }

  .mode {
    color: var(--color-muted-foreground);
    margin-right: 6px;
    font-size: var(--text-sm);
  }

  /* The panel is 360 px and never scrolls sideways: the columns are fixed and
     the executable takes whatever is left of them. */
  table {
    table-layout: fixed;
    width: 100%;
  }

  .c-duration {
    width: 74px;
  }

  .c-cpu {
    width: 44px;
  }

  .c-memory {
    width: 60px;
  }

  .c-io {
    width: 44px;
  }

  .c-exit {
    width: 50px;
  }

  th,
  td {
    padding: 5px 5px;
  }

  /* The mono cells read at 13; the header stays a section label at 12. */
  td {
    font-size: var(--text-sm);
  }

  th {
    font-size: var(--text-xs);
    letter-spacing: 0.06em;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  th:first-child,
  td:first-child {
    padding-left: 10px;
  }

  th:last-child,
  td:last-child {
    padding-right: 10px;
  }

  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .exe {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .running {
    color: var(--color-live);
  }

  /* A row rises the first time it appears, and only then: the key holds the pid
     and the start, so a row that is already here is never minted twice. */
  tbody tr {
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  tbody tr:hover td {
    background: var(--color-surface-2);
  }

  tr.live td {
    background: var(--color-surface-2);
  }
</style>
