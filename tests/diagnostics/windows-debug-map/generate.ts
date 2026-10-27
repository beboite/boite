import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join, resolve} from 'node:path';

export const sourcePath = resolve(import.meta.dir, '../windows-protected-reference.c');
export const sourceHash = '8f414f91eab4ed1e9a846ae3d0bac64eec11e5d924a2a811f998f91567b25f5a';
export const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

function once(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error(`diagnostic substitution must match once: ${before}`);
  return source.replace(before, after);
}

/** Pin the historical reviewed v1 boundary; emit a separate test helper, never edit it. */
export function generate(source: string): string {
  if (sha256(source) !== sourceHash) throw new Error('historical Windows reference changed: review diagnostic provenance before running');
  source = once(source, 'static int launch(int count, wchar_t **args) {',
    '#include "routing.h"\n#include "inspect.h"\n#include "setter.h"\n#include "creator.h"\n#include "target-creator.h"\n#include "retirement-timing.h"\n#include "live-root-fence.h"\n#include "stdio-root-fence.h"\n#include "debug-pipe.h"\n\nstatic int launch(int count, wchar_t **args) {');
  source = once(source, 'CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT, NULL, args[3]',
    'CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT | (debug_mode ? DEBUG_PROCESS : 0), NULL, args[3]');
  source = once(source, '  if (!CreateProcessW(args[4], line, &child_security, &child_security, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED |',
    '  if (target_creator_mode) {\n' +
    '    error = target_creator_start(args[2], args[4], line, args[3], desktop_name, object_security, app, registry_read.Sid, job, streams, &child);\n' +
    '    if (error) goto end;\n  } else if (!CreateProcessW(args[4], line, &child_security, &child_security, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED |');
  source = once(source, '  if (ResumeThread(child.hThread)',
    '  stage = L"routing.boundary"; if (!lowbox_verify(child.hProcess, job, app, registry_read.Sid)) { error = ERROR_ACCESS_DENIED; goto end; }\n' +
    '  stage = L"routing.prepare"; error = map_prepare(child.hProcess, object_security, args[3], args[4]); if (error) goto end;\n' +
    '  if (target_creator_mode) { stage = L"routing.creator-resume"; error = target_creator_before_resume(child.dwProcessId); if (error) goto end; }\n' +
    '  if (retirement_timing_mode) { stage = L"routing.retirement.start"; error = retirement_start(&child, args[3]); if (error) goto end; }\n  if (ResumeThread(child.hThread)');
  source = once(source, '  if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0 || !GetExitCodeProcess(child.hProcess, &exit_code)) {error = GetLastError(); goto end;}',
    '  if (debug_mode) { stage = L"routing.events"; error = debug_loop(child.dwProcessId, job, app, registry_read.Sid, &exit_code, FALSE); }\n' +
    '  else {\n    if (retirement_timing_mode) { stage = L"routing.retirement.final"; } error = retirement_final(&child, job, object_security, app, registry_read.Sid); if (error) goto end;\n' +
    '    DWORD waited = WaitForSingleObject(child.hProcess, retirement_timing_mode ? retirement_remaining() : 15000);\n' +
    '    if (waited != WAIT_OBJECT_0) { error = waited == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError(); goto end; }\n' +
    '    if (!GetExitCodeProcess(child.hProcess, &exit_code)) { error = GetLastError(); goto end; }\n' +
    '    error = retirement_exited(&child); if (error) goto end;\n  }');
  source = once(source, '  CloseHandle(child_token);',
    '  { BOOL closed = CloseHandle(child_token); DWORD close_error = closed ? 0 : GetLastError();\n' +
    '    fwprintf(stderr, L"token-cleanup role=launch pid=%lu success=%d error=%lu\\n", child.dwProcessId, closed, close_error); fflush(stderr);\n' +
    '    if (!closed) { error = close_error ? close_error : ERROR_INVALID_HANDLE; stage = L"routing.cleanup.launch-token"; goto end; }\n  }');
  // Even failures between CreateProcess and ResumeThread must continue debug exit events.
  source = once(source, '    TerminateJobObject(job, 125);\n    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;',
    '    if (!TerminateJobObject(job, 125) && !error) error = GetLastError();\n' +
    '    if (debug_mode && child.hProcess) {\n' +
    '      DWORD drain = debug_loop(child.dwProcessId, job, app, registry_read.Sid, &exit_code, TRUE);\n' +
    '      if (drain && !error) error = drain;\n    }\n    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;');
  source = once(source, '      if (!accounting.ActiveProcesses) break;',
    '      if (!accounting.ActiveProcesses) { fputws(L"cleanup job-active=0\\n", stderr); break; }');
  source = once(source, '  if (child.hThread) CloseHandle(child.hThread);',
    '  if (retire_owned_map && child.hProcess && retirement_timing_mode != 1) {\n' +
    '    DWORD retired = map_retire(child.hProcess, job, object_security);\n' +
    '    retired = retirement_assigned(retired);\n' +
    '    if (retired && !error) { error = retired; stage = L"routing.cleanup.retire"; }\n  }\n' +
    '  if (child.hThread) CloseHandle(child.hThread);');
  // Keep the production cleanup order. Observe our own returned handles only;
  // debug-event process/thread handles still belong to Windows.
  for (const [index, [field, label]] of [['child.hThread', 'root-thread'], ['child.hProcess', 'root-process'], ['job', 'job']].entries()) {
    source = once(source, `  if (${field}) CloseHandle(${field});`,
      `  { BOOL owned = ${field} != NULL; DWORD cleanup = close_owned(L"${label}", &${field}); if (owned && !cleanup) lf_cleanup_mask |= 1UL << ${index}; if (cleanup && !error) { error = cleanup; stage = L"routing.cleanup.${label}"; } }`);
  }
  // Capture the existing calls once, in their original order, before logging
  // can overwrite GetLastError. No new USER32 call precedes desktop creation.
  for (const [index, [guard, call, label]] of [
    ['station', 'SetProcessWindowStation(original_station)', 'station-restore'],
    ['desktop', 'CloseDesktop(desktop)', 'desktop'],
    ['station', 'CloseWindowStation(station)', 'station'],
  ].entries()) {
    source = once(source, `  if (${guard}) ${call};`,
      `  if (${guard}) {\n    BOOL ok = ${call}; DWORD native_error = ok ? 0 : GetLastError();\n` +
      `    fwprintf(stderr, L"window-cleanup action=${label} success=%d error=%lu\\n", ok, native_error); fflush(stderr);\n` +
      `    if (ok) lf_cleanup_mask |= 1UL << ${index + 3};\n` +
      `    if (!ok && !error) { error = native_error ? native_error : ERROR_INVALID_DATA; stage = L"routing.cleanup.${label}"; }\n  }`);
  }
  source = once(source, '  for (int i = 0; i < 3; i++) if (streams[i]) CloseHandle(streams[i]);',
    '  for (int i = 0; i < 3; i++) if (streams[i]) {\n' +
    '    BOOL ok = CloseHandle(streams[i]); DWORD native_error = ok ? 0 : GetLastError();\n' +
    '    fwprintf(stderr, L"stream-cleanup index=%d success=%d error=%lu\\n", i, ok, native_error); fflush(stderr);\n' +
    '    if (ok) lf_cleanup_mask |= 1UL << (i + 6);\n' +
    '    if (!ok && !error) { error = native_error ? native_error : ERROR_INVALID_DATA; stage = L"routing.cleanup.stream"; }\n  }');
  source = once(source, '  for (DWORD i = 0; i < group_count; i++)',
    '  { DWORD cleanup = debug_pipe_cleanup(child.dwProcessId); if (cleanup && !error) { error = cleanup; stage = L"routing.cleanup.debug-pipe"; } }\n' +
    '  { DWORD cleanup = map_close(); if (cleanup && !error) { error = cleanup; stage = L"routing.cleanup.map"; } }\n  for (DWORD i = 0; i < group_count; i++)');
  source = once(source, '  else if (count > 1 && !wcscmp(args[1], L"run")) result = launch(count, args);',
    '  else if (count == 3 && !wcscmp(args[1], L"observe")) result = observe(args[2]);\n' +
    '  else if (count == 3 && !wcscmp(args[1], L"observe-map")) result = observe_map(args[2]);\n' +
    '  else if (count == 3 && !wcscmp(args[1], L"cleanup")) result = cleanup_profile(args[2]);\n' +
    '  else if (count > 1 && !wcscmp(args[1], L"inspect")) result = inspect(count, args);\n' +
    '  else if (count > 1 && !wcscmp(args[1], L"assign-map")) result = setter_entry(count, args);\n' +
    '  else if (count > 1 && !wcscmp(args[1], L"anchor-setter")) result = anchor_setter_entry(count, args);\n' +
    '  else if (count > 1 && !wcscmp(args[1], L"create-map")) result = creator_entry(count, args);\n' +
    '  else if (count > 1 && !wcscmp(args[1], L"create-target")) result = target_creator_entry(count, args);\n' +
    '  else if (count > 4 && (!wcscmp(args[1], L"run") || !wcscmp(args[1], L"debug-run") || !wcscmp(args[1], L"debug-pipe-held-run") || !wcscmp(args[1], L"debug-pipe-closed-run") ||\n' +
    '      !wcscmp(args[1], L"direct-run") || !wcscmp(args[1], L"setter-run") || !wcscmp(args[1], L"quiet-run") ||\n' +
    '      !wcscmp(args[1], L"reopen-run") || !wcscmp(args[1], L"creator-run") || !wcscmp(args[1], L"retire-run") || !wcscmp(args[1], L"retire-named-run") || !wcscmp(args[1], L"retire-live-run") || !wcscmp(args[1], L"retire-exited-run") || !wcscmp(args[1], L"directory-twin-run") || !wcscmp(args[1], L"anchor-exclusive-run") || !wcscmp(args[1], L"anchor-stdio-run") || !wcscmp(args[1], L"anchor-stdout-run") || !wcscmp(args[1], L"anchor-zero-run") || !wcscmp(args[1], L"anchor-close-run") || !wcscmp(args[1], L"anchor-byte-run") || !wcscmp(args[1], L"anchor-held-run") ||\n' +
    '      !wcscmp(args[1], L"target-exited-run") || !wcscmp(args[1], L"target-waiting-run") || !wcscmp(args[1], L"target-helper-exited-run"))) {\n' +
    '    debug_pipe_mode = !wcscmp(args[1], L"debug-pipe-held-run") ? 1 : !wcscmp(args[1], L"debug-pipe-closed-run") ? 2 : 0;\n' +
    '    debug_mode = !wcscmp(args[1], L"debug-run") || debug_pipe_mode;\n' +
    '    reopen_owned_map = !wcscmp(args[1], L"reopen-run");\n' +
    '    external_map_creator = !wcscmp(args[1], L"creator-run");\n' +
    '    target_creator_mode = !wcscmp(args[1], L"target-exited-run") ? 1 : !wcscmp(args[1], L"target-waiting-run") ? 2 : !wcscmp(args[1], L"target-helper-exited-run") ? 3 : 0;\n' +
    '    directory_twin_mode = !wcscmp(args[1], L"directory-twin-run");\n' +
    '    stdio_root_mode = !wcscmp(args[1], L"anchor-stdio-run");\n' +
    '    stdout_root_mode = !wcscmp(args[1], L"anchor-stdout-run");\n' +
    '    zero_root_mode = !wcscmp(args[1], L"anchor-zero-run");\n' +
    '    close_root_mode = !wcscmp(args[1], L"anchor-close-run");\n' +
    '    byte_root_mode = !wcscmp(args[1], L"anchor-byte-run");\n' +
    '    anchor_overlap_mode = (stdio_root_mode || stdout_root_mode || zero_root_mode || byte_root_mode || close_root_mode || !wcscmp(args[1], L"anchor-exclusive-run")) ? 1 : !wcscmp(args[1], L"anchor-held-run") ? 2 : 0;\n' +
    '    if (anchor_overlap_mode) directory_twin_mode = TRUE;\n' +
    '    retirement_timing_mode = (directory_twin_mode || !wcscmp(args[1], L"retire-live-run")) ? 1 : !wcscmp(args[1], L"retire-exited-run") ? 2 : 0;\n' +
    '    retire_named_map = !wcscmp(args[1], L"retire-named-run") || target_creator_mode || retirement_timing_mode;\n' +
    '    retire_owned_map = !wcscmp(args[1], L"retire-run") || retire_named_map;\n' +
    '    observe_owned_handles = wcscmp(args[1], L"quiet-run") != 0;\n' +
    '    assignment_scope = !wcscmp(args[1], L"setter-run") ? 2 :\n' +
    '      (!wcscmp(args[1], L"direct-run") || !observe_owned_handles || reopen_owned_map || external_map_creator || retire_owned_map) ? 1 : 0;\n' +
    '    DWORD before = caller_snapshot(args[3], FALSE);\n' +
    '    if (!before) result = launch(count, args);\n' +
    '    DWORD after = caller_snapshot(args[3], TRUE);\n' +
    '    fwprintf(stderr, L"owned-observers enabled=%d object-queries=%u handle-snapshots=%u\\n",\n' +
    '      observe_owned_handles, object_count_queries, handle_snapshot_queries); fflush(stderr);\n' +
    '    if (before || after) result = failure(L"routing.caller-state", before ? before : after);\n' +
    '    DWORD final_map = retired_absence(L"final");\n' +
    '    if (final_map) result = failure(L"routing.cleanup.final-map", final_map);\n' +
    '    retirement_complete();\n' +
    '    DWORD creator_exit = target_creator_mode == 3 ? hj_parent() : target_creator_finish(FALSE);\n' +
    '    if (creator_exit && target_creator_mode == 3) target_creator_finish(TRUE);\n' +
    '    if (creator_exit) result = failure(L"routing.cleanup.target-creator", creator_exit);\n' +
    '    if (target_creator_mode == 2 && tc_released) {\n' +
    '      DWORD creator_closed = creator_exit ? creator_exit : tc_barrier(L"closed", NULL);\n' +
    '      if (creator_closed) result = failure(L"routing.cleanup.creator-registry", creator_closed);\n' +
    '      DWORD creator_map = creator_closed ? creator_closed : target_creator_absence();\n' +
    '      if (creator_map) result = failure(L"routing.cleanup.creator-exited-map", creator_map);\n' +
    '    }\n' +
    '    if (stdio_root_mode || stdout_root_mode || zero_root_mode || byte_root_mode || close_root_mode) (void)stdio_root_fence(result, close_root_mode ? 4 : byte_root_mode ? 3 : zero_root_mode ? 2 : stdout_root_mode ? 1 : 0); else (void)live_root_fence(result);\n  }');
  // Share exactly the generated DIRECT body with both worker arms. Other arms
  // retain their existing inline body and selectors.
  const bodyStart = source.indexOf('    DWORD before = caller_snapshot(args[3], FALSE);');
  const bodyEnd = source.indexOf('\n  }\n  else result', bodyStart);
  if (bodyStart < 0 || bodyEnd < 0) throw new Error('DIRECT body boundary changed');
  const directBody = source.slice(bodyStart, bodyEnd);
  source = once(source, directBody,
    '    if (!wcscmp(args[1], L"direct-run")) result = direct_body(count, args);\n    else {\n' + directBody + '\n    }');
  source = once(source, 'int main(void) {',
    'static int direct_body(int count, wchar_t **args) {\n  int result = 125;\n' + directBody +
    '\n  return result;\n}\n#include "worker-lifetime.h"\n\nint main(void) {');
  source = once(source, '  else if (count > 4 && (!wcscmp(args[1], L"run")',
    '  else if (count > 4 && (!wcscmp(args[1], L"thread-exited-run") || !wcscmp(args[1], L"thread-waiting-run")))\n' +
    '    result = worker_lifetime_run(count, args, !wcscmp(args[1], L"thread-waiting-run"));\n' +
    '  else if (count > 4 && (!wcscmp(args[1], L"run")');
  if (source.includes('INFINITE')) throw new Error('diagnostic retains an unbounded wait');
  return source;
}

export function writeSource(output: string): Record<string, string> {
  mkdirSync(output, {recursive: true});
  const original = readFileSync(sourcePath, 'utf8');
  const source = generate(original);
  writeFileSync(join(output, 'debug-map.c'), source);
  const hashes: Record<string, string> = {'windows-protected-reference.c': sha256(original), 'debug-map.c': sha256(source)};
  for (const file of ['routing.h', 'inspect.h', 'ownership.h', 'identity.h', 'startup-site.h', 'startup-site.json', 'roundtrip.h', 'setter.h', 'creator.h', 'target-creator.h', 'target-acl.h', 'helper-job.h', 'worker-lifetime.h', 'retirement-timing.h', 'directory-twin.h', 'anchor-overlap.h', 'live-root-fence.h', 'stdio-root-fence.h', 'debug-pipe.h']) {
    const bytes = readFileSync(join(import.meta.dir, file));
    writeFileSync(join(output, file), bytes);
    hashes[file] = sha256(bytes);
  }
  return hashes;
}

if (import.meta.main) {
  const output = process.argv[2];
  if (!output) throw new Error('usage: bun tests/diagnostics/windows-debug-map/generate.ts <output-directory>');
  console.log(JSON.stringify(writeSource(resolve(output)), null, 2));
}
