# Shell core identity, tray memory and core start order (2026-10-15)

## Probing a `core.json` whose PID another process now wears

The regression test `a_core_json_whose_pid_now_names_a_later_process_costs_no_connection`
stands the test process in for the stranger: it is alive, it started after the
`startedAt` the file names, and the file's port accepts connections without
answering.

Windows 11 desktop, the lib test binary cross-compiled with
`cargo test --lib --no-run --target x86_64-pc-windows-gnu`, run with
`<exe> a_core_json_whose_pid_now_names_a_later_process --test-threads=1`:

| Build | Probe time | Verdict |
| --- | --- | --- |
| Before (bare `alive(pid)`) | 500.5 ms, 500.0 ms (two runs) | `Absent` after `HEALTH_TIMEOUT` |
| After (`same_core`: PID plus start time) | under 1 ms (test total 0.00 s) | `Absent` without a socket |

The bound is `HEALTH_TIMEOUT` (500 ms): before, a reused PID after a reboot cost
up to that on the path to the first data; after, one `OpenProcess` and
`GetProcessTimes` (Windows) or one `/proc` read (Linux).

## Not measured

- WebView2 low memory level in the tray (Windows): needs the installed shell on
  a desktop session. Measure the main renderer's private working set
  (`Get-Process msedgewebview2`, matched by `--webview-exe-name=boite-shell.exe`)
  60 s after hiding to the tray, before and after.
- Core start order in `setup`: the WebView version query and the second-launch
  listener moved after the core's spawn, a few milliseconds of work off the
  critical path. The new `pre-setup` phase record (process start to `setup`)
  gives the number that decides whether the core should start before Tauri's
  builder; read it from `logs/shell.0.ndjson` after a Windows start.
