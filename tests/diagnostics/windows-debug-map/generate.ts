import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join, resolve} from 'node:path';

export const sourcePath = resolve(import.meta.dir, '../../../packages/core/src/platform/windows/protected-tool.c');
export const sourceHash = '8f414f91eab4ed1e9a846ae3d0bac64eec11e5d924a2a811f998f91567b25f5a';
export const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

function once(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error(`diagnostic substitution must match once: ${before}`);
  return source.replace(before, after);
}

/** Pin the reviewed production boundary; emit a separate test helper, never edit it. */
export function generate(source: string): string {
  if (sha256(source) !== sourceHash) throw new Error('protected-tool.c changed: review and repin the diagnostic before running');
  source = once(source, 'static int launch(int count, wchar_t **args) {',
    '#include "routing.h"\n#include "inspect.h"\n#include "setter.h"\n\nstatic int launch(int count, wchar_t **args) {');
  source = once(source, 'CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT, NULL, args[3]',
    'CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT | (debug_mode ? DEBUG_PROCESS : 0), NULL, args[3]');
  source = once(source, '  if (ResumeThread(child.hThread)',
    '  stage = L"routing.boundary"; if (!lowbox_verify(child.hProcess, job, app, registry_read.Sid)) { error = ERROR_ACCESS_DENIED; goto end; }\n' +
    '  stage = L"routing.prepare"; error = map_prepare(child.hProcess, object_security, args[3], args[4]); if (error) goto end;\n  if (ResumeThread(child.hThread)');
  source = once(source, '  if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0 || !GetExitCodeProcess(child.hProcess, &exit_code)) {error = GetLastError(); goto end;}',
    '  if (debug_mode) { stage = L"routing.events"; error = debug_loop(child.dwProcessId, job, app, registry_read.Sid, &exit_code, FALSE); }\n' +
    '  else {\n    DWORD waited = WaitForSingleObject(child.hProcess, 15000);\n' +
    '    if (waited != WAIT_OBJECT_0) { error = waited == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError(); goto end; }\n' +
    '    if (!GetExitCodeProcess(child.hProcess, &exit_code)) { error = GetLastError(); goto end; }\n  }');
  // Even failures between CreateProcess and ResumeThread must continue debug exit events.
  source = once(source, '    TerminateJobObject(job, 125);\n    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;',
    '    if (!TerminateJobObject(job, 125) && !error) error = GetLastError();\n' +
    '    if (debug_mode && child.hProcess) {\n' +
    '      DWORD drain = debug_loop(child.dwProcessId, job, app, registry_read.Sid, &exit_code, TRUE);\n' +
    '      if (drain && !error) error = drain;\n    }\n    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;');
  source = once(source, '      if (!accounting.ActiveProcesses) break;',
    '      if (!accounting.ActiveProcesses) { fputws(L"cleanup job-active=0\\n", stderr); break; }');
  // Keep the production cleanup order. Observe our own returned handles only;
  // debug-event process/thread handles still belong to Windows.
  for (const [field, label] of [['child.hThread', 'root-thread'], ['child.hProcess', 'root-process'], ['job', 'job']]) {
    source = once(source, `  if (${field}) CloseHandle(${field});`,
      `  { DWORD cleanup = close_owned(L"${label}", &${field}); if (cleanup && !error) { error = cleanup; stage = L"routing.cleanup.${label}"; } }`);
  }
  // Capture the existing calls once, in their original order, before logging
  // can overwrite GetLastError. No new USER32 call precedes desktop creation.
  for (const [guard, call, label] of [
    ['station', 'SetProcessWindowStation(original_station)', 'station-restore'],
    ['desktop', 'CloseDesktop(desktop)', 'desktop'],
    ['station', 'CloseWindowStation(station)', 'station'],
  ]) {
    source = once(source, `  if (${guard}) ${call};`,
      `  if (${guard}) {\n    BOOL ok = ${call}; DWORD native_error = ok ? 0 : GetLastError();\n` +
      `    fwprintf(stderr, L"window-cleanup action=${label} success=%d error=%lu\\n", ok, native_error); fflush(stderr);\n` +
      `    if (!ok && !error) { error = native_error ? native_error : ERROR_INVALID_DATA; stage = L"routing.cleanup.${label}"; }\n  }`);
  }
  source = once(source, '  for (int i = 0; i < 3; i++) if (streams[i]) CloseHandle(streams[i]);',
    '  for (int i = 0; i < 3; i++) if (streams[i]) {\n' +
    '    BOOL ok = CloseHandle(streams[i]); DWORD native_error = ok ? 0 : GetLastError();\n' +
    '    fwprintf(stderr, L"stream-cleanup index=%d success=%d error=%lu\\n", i, ok, native_error); fflush(stderr);\n' +
    '    if (!ok && !error) { error = native_error ? native_error : ERROR_INVALID_DATA; stage = L"routing.cleanup.stream"; }\n  }');
  source = once(source, '  for (DWORD i = 0; i < group_count; i++)',
    '  { DWORD cleanup = map_close(); if (cleanup && !error) { error = cleanup; stage = L"routing.cleanup.map"; } }\n  for (DWORD i = 0; i < group_count; i++)');
  source = once(source, '  else if (count > 1 && !wcscmp(args[1], L"run")) result = launch(count, args);',
    '  else if (count == 3 && !wcscmp(args[1], L"observe")) result = observe(args[2]);\n' +
    '  else if (count == 3 && !wcscmp(args[1], L"observe-map")) result = observe_map(args[2]);\n' +
    '  else if (count == 3 && !wcscmp(args[1], L"cleanup")) result = cleanup_profile(args[2]);\n' +
    '  else if (count > 1 && !wcscmp(args[1], L"inspect")) result = inspect(count, args);\n' +
    '  else if (count > 1 && !wcscmp(args[1], L"assign-map")) result = setter_entry(count, args);\n' +
    '  else if (count > 4 && (!wcscmp(args[1], L"run") || !wcscmp(args[1], L"debug-run") ||\n' +
    '      !wcscmp(args[1], L"direct-run") || !wcscmp(args[1], L"setter-run"))) {\n' +
    '    debug_mode = !wcscmp(args[1], L"debug-run");\n' +
    '    assignment_scope = !wcscmp(args[1], L"setter-run") ? 2 : !wcscmp(args[1], L"direct-run") ? 1 : 0;\n' +
    '    DWORD before = caller_snapshot(args[3], FALSE);\n' +
    '    if (!before) result = launch(count, args);\n' +
    '    DWORD after = caller_snapshot(args[3], TRUE);\n' +
    '    if (before || after) result = failure(L"routing.caller-state", before ? before : after);\n  }');
  if (source.includes('INFINITE')) throw new Error('diagnostic retains an unbounded wait');
  return source;
}

export function writeSource(output: string): Record<string, string> {
  mkdirSync(output, {recursive: true});
  const original = readFileSync(sourcePath, 'utf8');
  const source = generate(original);
  writeFileSync(join(output, 'debug-map.c'), source);
  const hashes: Record<string, string> = {'protected-tool.c': sha256(original), 'debug-map.c': sha256(source)};
  for (const file of ['routing.h', 'inspect.h', 'ownership.h', 'identity.h', 'startup-site.h', 'startup-site.json', 'roundtrip.h', 'setter.h']) {
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
