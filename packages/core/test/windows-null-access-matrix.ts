/** Read-only native experiment. Does not admit production or alter its source. */
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {release, tmpdir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {Bus} from '../src/bus.ts';
import {ExecutionProtections} from '../src/execution-protection.ts';
import {Journal} from '../src/journal.ts';
import {ProcRegistry} from '../src/procs.ts';
import {protectionRunner} from '../src/protection-runner.ts';
import {capture, type Captured} from '../../../tests/diagnostics/windows-debug-map/capture.ts';
import {selectedEnvironment} from '../../../tests/diagnostics/windows-debug-map/environment.ts';

const sourcePath = join(import.meta.dir, '../src/platform/windows/protected-tool.c');
const sourceHash = '8f414f91eab4ed1e9a846ae3d0bac64eec11e5d924a2a811f998f91567b25f5a';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

const instrumentation = String.raw`
#include <winternl.h>
typedef struct {
  UNICODE_STRING Name; USHORT ValueType, Reserved; ULONG Flags, ValueCount;
  union { ULONGLONG *Uint64; } Values;
} MATRIX_ATTRIBUTE;
typedef struct { USHORT Version, Reserved; ULONG Count; MATRIX_ATTRIBUTE *Attributes; } MATRIX_ATTRIBUTES;
typedef NTSTATUS (NTAPI *matrix_create_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
  PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
typedef NTSTATUS (NTAPI *matrix_query_object_fn)(HANDLE, ULONG, PVOID, ULONG, PULONG);
typedef NTSTATUS (NTAPI *matrix_query_file_fn)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, ULONG);

/* Preserve membership and attributes without publishing a user/domain SID. */
static DWORD matrix_sid(const wchar_t *phase, const wchar_t *set, DWORD index, SID_AND_ATTRIBUTES entry) {
  LPWSTR text = NULL;
  if (!ConvertSidToStringSidW(entry.Sid, &text)) return GetLastError();
  BOOL visible = !wcscmp(text, L"S-1-5-12") || !wcscmp(text, L"S-1-1-0") ||
    !wcsncmp(text, L"S-1-15-2-", 9) || !wcsncmp(text, L"S-1-15-3-", 9);
  fwprintf(stderr, L"NULL_SID phase=%ls set=%ls index=%lu sid=%ls attributes=0x%08lx\n",
    phase, set, index, visible ? text : L"redacted", entry.Attributes);
  LocalFree(text); return 0;
}

static DWORD matrix_open(const wchar_t *phase, const wchar_t *path, const wchar_t *mode,
    const wchar_t *dos_path, ACCESS_MASK desired, ULONG options, BOOL native,
    matrix_create_fn create, matrix_query_object_fn query_object, matrix_query_file_fn query_file) {
  HANDLE file = NULL; NTSTATUS status = (NTSTATUS)0xc0000002; DWORD open_error = 0;
  wchar_t status_text[16] = L"na", error_text[16] = L"na", options_text[16] = L"na";
  if (native) {
    wchar_t object_text[] = L"\\Device\\Null";
    UNICODE_STRING name = {(USHORT)(wcslen(object_text) * 2), (USHORT)sizeof(object_text), object_text};
    OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
    attributes.Length = sizeof(attributes); attributes.ObjectName = &name; attributes.Attributes = 0x40;
    IO_STATUS_BLOCK io; ZeroMemory(&io, sizeof(io));
    status = create(&file, desired, &attributes, &io, NULL, 0,
      FILE_SHARE_READ | FILE_SHARE_WRITE, 1 /* FILE_OPEN */, options, NULL, 0);
    swprintf(status_text, 16, L"0x%08lx", (DWORD)status); swprintf(options_text, 16, L"0x%08lx", options);
  } else {
    file = CreateFileW(dos_path, desired, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    open_error = file == INVALID_HANDLE_VALUE ? GetLastError() : 0;
    swprintf(error_text, 16, L"%lu", open_error);
  }
  BOOL owned = file && file != INVALID_HANDLE_VALUE;
  DWORD type = 0, type_error = 0, close_error = 0, granted = 0, mode_value = 0;
  wchar_t grant_text[16] = L"na", mode_text[16] = L"na";
  NTSTATUS grant_status = 0;
  if (owned) {
    PUBLIC_OBJECT_BASIC_INFORMATION basic; ULONG returned = 0; ZeroMemory(&basic, sizeof(basic));
    grant_status = query_object(file, 0 /* ObjectBasicInformation */, &basic, sizeof(basic), &returned);
    granted = basic.GrantedAccess;
    struct {ULONG Mode;} information; IO_STATUS_BLOCK io;
    ZeroMemory(&information, sizeof(information)); ZeroMemory(&io, sizeof(io));
    NTSTATUS mode_status = query_file(file, &io, &information, sizeof(information), 16 /* FileModeInformation */);
    mode_value = information.Mode;
    swprintf(grant_text, 16, L"0x%08lx", (DWORD)grant_status); swprintf(mode_text, 16, L"0x%08lx", (DWORD)mode_status);
    SetLastError(0); type = GetFileType(file); type_error = type ? 0 : GetLastError();
    if (!CloseHandle(file)) close_error = GetLastError();
  }
  fwprintf(stderr, L"NULL_ACCESS phase=%ls path=%ls access=%ls desired=0x%08lx options=%ls flags=%ls opened=%d error=%ls status=%ls granted=0x%08lx grant-status=%ls mode=0x%08lx mode-status=%ls type=%lu type-error=%lu close-error=%lu\n",
    phase, path, mode, desired, options_text, native ? L"na" : L"0x00000000", owned, error_text, status_text,
    granted, grant_text, mode_value, mode_text, type, type_error, close_error);
  if (owned && grant_status < 0) return ERROR_INVALID_DATA;
  return type_error ? type_error : close_error;
}

/* Query only this process token; close every successful device open. */
static DWORD null_matrix(const wchar_t *phase) {
  HANDLE token = NULL; DWORD bytes = 0, appcontainer = 0, error = 0;
  TOKEN_ACCESS_INFORMATION *access = NULL; TOKEN_GROUPS *restricted = NULL; LPWSTR package = NULL;
  PSID *groups = NULL, *capabilities = NULL; DWORD group_count = 0, capability_count = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return GetLastError();
  if (!GetTokenInformation(token, TokenIsAppContainer, &appcontainer, sizeof(appcontainer), &bytes)) {error = GetLastError(); goto done;}
  GetTokenInformation(token, TokenAccessInformation, NULL, 0, &bytes);
  access = calloc(1, bytes);
  if (!access) {error = ERROR_NOT_ENOUGH_MEMORY; goto done;}
  if (!GetTokenInformation(token, TokenAccessInformation, access, bytes, &bytes)) {error = GetLastError(); goto done;}
  GetTokenInformation(token, TokenRestrictedSids, NULL, 0, &bytes);
  restricted = calloc(1, bytes);
  if (!restricted) {error = ERROR_NOT_ENOUGH_MEMORY; goto done;}
  if (!GetTokenInformation(token, TokenRestrictedSids, restricted, bytes, &bytes)) {error = GetLastError(); goto done;}
  if (access->PackageSid && !ConvertSidToStringSidW(access->PackageSid, &package)) {error = GetLastError(); goto done;}
  DWORD actual_count = access->CapabilitiesHash ? access->CapabilitiesHash->SidCount : 0;
  BOOL registry = FALSE;
  if (appcontainer) {
    typedef BOOL (WINAPI *derive_fn)(LPCWSTR, PSID **, DWORD *, PSID **, DWORD *);
    derive_fn derive = (derive_fn)(void *)GetProcAddress(GetModuleHandleW(L"kernelbase.dll"), "DeriveCapabilitySidsFromName");
    if (!derive || !derive(L"registryRead", &groups, &group_count, &capabilities, &capability_count) || capability_count != 1) {
      error = GetLastError(); if (!error) error = ERROR_NOT_SUPPORTED; goto done;
    }
    registry = actual_count == 1 && EqualSid(access->CapabilitiesHash->SidAttr[0].Sid, capabilities[0]) &&
      (access->CapabilitiesHash->SidAttr[0].Attributes & SE_GROUP_ENABLED);
  }
  fwprintf(stderr, L"NULL_TOKEN phase=%ls appcontainer=%lu flags=0x%08lx capabilities=%lu registry-read=%d package=%ls\n",
    phase, appcontainer, access->Flags, actual_count, registry, package ? package : L"none");
  typedef NTSTATUS (NTAPI *query_attributes_fn)(HANDLE, PUNICODE_STRING, ULONG, PVOID, ULONG, PULONG);
  query_attributes_fn query_attributes = (query_attributes_fn)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQuerySecurityAttributesToken");
  wchar_t attribute_text[] = L"WIN://NOALLAPPPKG";
  UNICODE_STRING attribute_name = {(USHORT)(wcslen(attribute_text) * 2), (USHORT)sizeof(attribute_text), attribute_text};
  union {ULONGLONG align; BYTE data[8192];} attribute_buffer; ZeroMemory(&attribute_buffer, sizeof(attribute_buffer));
  NTSTATUS attribute_status = query_attributes ? query_attributes(token, &attribute_name, 1,
    attribute_buffer.data, sizeof(attribute_buffer.data), &bytes) : (NTSTATUS)0xc0000002;
  MATRIX_ATTRIBUTES *info = (MATRIX_ATTRIBUTES *)attribute_buffer.data;
  BOOL lpac = attribute_status >= 0 && info->Version == 1 && info->Count == 1 && info->Attributes &&
    info->Attributes->ValueCount == 1 && (info->Attributes->ValueType == 2 || info->Attributes->ValueType == 6) &&
    info->Attributes->Values.Uint64 && *info->Attributes->Values.Uint64 == 1;
  fwprintf(stderr, L"NULL_LPAC phase=%ls status=0x%08lx value=%d\n", phase, (DWORD)attribute_status, lpac);
  if (appcontainer && !lpac) {error = ERROR_ACCESS_DENIED; goto done;}
  const wchar_t *sets[] = {L"normal", L"restricted", L"access-restricted", L"capability"};
  DWORD counts[] = {access->SidHash ? access->SidHash->SidCount : 0, restricted->GroupCount,
    access->RestrictedSidHash ? access->RestrictedSidHash->SidCount : 0, actual_count};
  SID_AND_ATTRIBUTES *entries[] = {access->SidHash ? access->SidHash->SidAttr : NULL, restricted->Groups,
    access->RestrictedSidHash ? access->RestrictedSidHash->SidAttr : NULL, access->CapabilitiesHash ? access->CapabilitiesHash->SidAttr : NULL};
  fwprintf(stderr, L"NULL_SIDS phase=%ls normal=%lu restricted=%lu access-restricted=%lu capability=%lu\n",
    phase, counts[0], counts[1], counts[2], counts[3]);
  for (int set = 0; set < 4; set++) for (DWORD i = 0; i < counts[set]; i++) {
    error = matrix_sid(phase, sets[set], i, entries[set][i]); if (error) goto done;
  }
  matrix_create_fn create = (matrix_create_fn)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile");
  matrix_query_object_fn query_object = (matrix_query_object_fn)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryObject");
  matrix_query_file_fn query_file = (matrix_query_file_fn)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationFile");
  if (!create || !query_object || !query_file) {error = ERROR_PROC_NOT_FOUND; goto done;}
  const wchar_t *paths[] = {L"NUL", L"\\\\?\\GLOBALROOT\\Device\\Null", NULL, NULL};
  const wchar_t *path_names[] = {L"dos", L"globalroot", L"native", L"native-sync"};
  const DWORD rights[] = {0, GENERIC_READ, GENERIC_WRITE, GENERIC_READ | GENERIC_WRITE};
  const wchar_t *modes[] = {L"none", L"read", L"write", L"readwrite"};
  for (int p = 0; p < 4; p++) for (int mode = 0; mode < 4; mode++) {
    /* Compare exact rights without implicit synchronization, then the explicit
     * Win32-like synchronous request. Report actual grants, never infer them. */
    ACCESS_MASK desired = rights[mode] | (p == 3 ? SYNCHRONIZE | FILE_READ_ATTRIBUTES : 0);
    ULONG options = p == 3 ? 0x60 /* NON_DIRECTORY | SYNCHRONOUS_NONALERT */ : 0x40 /* NON_DIRECTORY */;
    DWORD observed = matrix_open(phase, path_names[p], modes[mode], paths[p], desired, options, p >= 2, create, query_object, query_file);
    if (!error && observed) error = observed;
  }
done:
  if (token && !CloseHandle(token) && !error) error = GetLastError();
  if (package) LocalFree(package);
  if (access) free(access);
  if (restricted) free(restricted);
  for (DWORD i = 0; i < group_count; i++) LocalFree(groups[i]);
  if (groups) LocalFree(groups);
  for (DWORD i = 0; i < capability_count; i++) LocalFree(capabilities[i]);
  if (capabilities) LocalFree(capabilities);
  fflush(stderr); return error;
}
`;

function once(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error(`matrix substitution must match once: ${before}`);
  return source.replace(before, after);
}

export function matrixSource(source: string): string {
  if (hash(source) !== sourceHash) throw new Error('protected-tool.c changed: review experiment provenance before running');
  source = once(source, 'static int probe(const wchar_t *path) {', `${instrumentation}\nstatic int probe(const wchar_t *path) {`);
  source = once(source, '  /* Native child runtimes open NUL',
    '  fputws(L"NULL_AMBIENT denied=1\\n", stderr);\n  DWORD matrix_error = null_matrix(L"lpac");\n  if (matrix_error) return failure(L"probe.matrix", matrix_error);\n  /* Native child runtimes open NUL');
  return once(source, '  else if (count == 2 && !wcscmp(args[1], L"--diagnose-null"))',
    '  else if (count == 2 && !wcscmp(args[1], L"--matrix-host")) {DWORD error = null_matrix(L"host"); result = error ? failure(L"matrix.host", error) : 0;}\n  else if (count == 2 && !wcscmp(args[1], L"--diagnose-null"))');
}

export function completeMatrix(text: string, phase: 'host' | 'lpac'): boolean {
  const records = (tag: string): Record<string, string>[] => text.split(/\r?\n/)
    .filter(line => line.startsWith(`${tag} `) && line.includes(` phase=${phase} `))
    .map(line => Object.fromEntries(line.split(' ').slice(1).map(field => field.split('='))));
  const hex = (value: string | undefined): value is string => !!value && /^0x[0-9a-f]{8}$/.test(value);
  const decimal = (value: string | undefined): number => value && /^\d+$/.test(value) ? Number(value) : NaN;
  const tokens = records('NULL_TOKEN'), lpac = records('NULL_LPAC'), counts = records('NULL_SIDS');
  if (tokens.length !== 1 || lpac.length !== 1 || counts.length !== 1) return false;
  const token = tokens[0]!;
  if (!hex(token.flags) || !hex(lpac[0]!.status)) return false;
  if (phase === 'lpac' && (token.appcontainer !== '1' || token.capabilities !== '1' || token['registry-read'] !== '1'
    || !/^S-1-15-2-\d+(?:-\d+)*$/.test(token.package ?? '') || lpac[0]!.status !== '0x00000000' || lpac[0]!.value !== '1')) return false;
  if (phase === 'host' && (token.appcontainer !== '0' || lpac[0]!.value !== '0')) return false;
  const sids = records('NULL_SID');
  for (const set of ['normal', 'restricted', 'access-restricted', 'capability']) {
    const expected = decimal(counts[0]![set]), entries = sids.filter(sid => sid.set === set);
    if (!Number.isSafeInteger(expected) || expected < 0 || entries.length !== expected
      || new Set(entries.map(sid => decimal(sid.index))).size !== expected) return false;
    if (entries.some(sid => !Number.isSafeInteger(decimal(sid.index)) || decimal(sid.index) >= expected || !hex(sid.attributes)
      || !/^(?:redacted|S-1-5-12|S-1-1-0|S-1-15-[23]-\d+(?:-\d+)*)$/.test(sid.sid ?? ''))) return false;
    if (set === 'capability' && (expected !== decimal(token.capabilities)
      || (phase === 'lpac' && (Number.parseInt(entries[0]!.attributes!, 16) & 4) === 0))) return false;
  }
  if (sids.some(sid => !['normal', 'restricted', 'access-restricted', 'capability'].includes(sid.set ?? ''))) return false;
  const rows = records('NULL_ACCESS');
  if (rows.length !== 16 || new Set(rows.map(row => `${row.path}:${row.access}`)).size !== 16) return false;
  const rights: Record<string, number> = {none: 0, read: 0x80000000, write: 0x40000000, readwrite: 0xc0000000};
  return rows.every(row => {
    if (!['dos', 'globalroot', 'native', 'native-sync'].includes(row.path ?? '') || rights[row.access ?? ''] === undefined) return false;
    const native = row.path!.startsWith('native');
    const desired = (rights[row.access!]! | (row.path === 'native-sync' ? 0x100080 : 0)) >>> 0;
    if (!hex(row.desired) || Number.parseInt(row.desired, 16) !== desired || !hex(row.granted) || !hex(row.mode)
      || row['type-error'] !== '0' || row['close-error'] !== '0' || !['0', '1'].includes(row.opened ?? '')) return false;
    if (native) {
      if (row.flags !== 'na' || row.options !== (row.path === 'native-sync' ? '0x00000060' : '0x00000040')
        || row.error !== 'na' || !hex(row.status) || (Number.parseInt(row.status, 16) < 0x80000000) !== (row.opened === '1')) return false;
    } else if (row.flags !== '0x00000000' || row.options !== 'na' || row.status !== 'na'
      || !Number.isSafeInteger(decimal(row.error)) || (decimal(row.error) === 0) !== (row.opened === '1')) return false;
    if (row.opened === '1') return row.type === '2' && row['grant-status'] === '0x00000000' && hex(row['mode-status']);
    return phase === 'lpac' && row.type === '0' && row.granted === '0x00000000' && row['grant-status'] === 'na'
      && row.mode === '0x00000000' && row['mode-status'] === 'na';
  });
}

if (import.meta.main) {
  const [output, mode] = process.argv.slice(2);
  if (!output || !isAbsolute(output) || (mode && mode !== '--compile-only')) throw new Error('usage: bun packages/core/test/windows-null-access-matrix.ts <fresh absolute artifact directory> [--compile-only]');
  const compileOnly = mode === '--compile-only';
  if (!compileOnly && (process.platform !== 'win32' || process.env.BOITE_TEST_NULL_ACCESS_MATRIX !== '1')) throw new Error('requires Windows and BOITE_TEST_NULL_ACCESS_MATRIX=1; no native fixture allocated');
  if (existsSync(output)) throw new Error('choose a fresh output directory to preserve evidence');
  mkdirSync(output, {recursive: true});
  const source = matrixSource(readFileSync(sourcePath, 'utf8'));
  const generated = join(output, 'null-access-matrix.c'); writeFileSync(generated, source);
  const results: Record<string, unknown>[] = [];
  const manifest = {platform: process.platform, kernel: release(), bun: Bun.version, compileOnly, sourceHash,
    generatedSha256: hash(source), runnerSha256: hash(readFileSync(import.meta.path)), results, productionAccepted: false, experimentComplete: false};
  const save = () => writeFileSync(join(output, 'matrix.json'), JSON.stringify(manifest, null, 2) + '\n');
  save();
  const compilers = process.platform === 'win32'
    ? [{name: 'sdk', path: Bun.which('clang')}, {name: 'mingw', path: 'C:\\mingw64\\bin\\gcc.exe'}]
    : [{name: 'mingw-cross', path: Bun.which('x86_64-w64-mingw32-gcc')}];
  let failed = false;
  for (const compiler of compilers) {
    const entry: Record<string, unknown> = {name: compiler.name, compiler: compiler.path}; results.push(entry);
    const scratch = mkdtempSync(join(tmpdir(), 'boite-null-access-'));
    const journal = new Journal(join(scratch, 'journal.db')), procs = new ProcRegistry(journal, new Bus());
    let protection: ExecutionProtections | undefined;
    async function execute(id: string, command: string, args: string[], timeout: number): Promise<Captured> {
      const child = procs.spawnPiped(id, command, args, {cwd: output!, env: selectedEnvironment(), agentRoot: false});
      return capture(procs, id, child, timeout);
    }
    try {
      if (!compiler.path || !existsSync(compiler.path)) throw new Error(`compiler unavailable: ${compiler.name}`);
      const helper = join(output, `null-access-${compiler.name}.exe`);
      const args = ['-O2', '-Wall', '-Wextra', '-Werror', generated, '-o', helper,
        ...(process.platform === 'win32' && /clang/i.test(compiler.path) ? [] : ['-static']), '-luserenv', '-ladvapi32', '-lshell32', '-luser32'];
      entry.compileCommand = [compiler.path, ...args];
      const built = await execute(`compile-${compiler.name}`, compiler.path, args, 90000); entry.compile = built;
      if (built.code || built.timedOut) throw new Error(`strict compile failed: ${compiler.name}`);
      entry.helperSha256 = hash(readFileSync(helper));
      if (!compileOnly) {
        const baseline = await execute(`host-${compiler.name}`, helper, ['--matrix-host'], 10000); entry.host = baseline;
        if (baseline.code || baseline.timedOut || !completeMatrix(baseline.err, 'host')) throw new Error('host matrix incomplete or unexpected NUL device');
        const {WindowsExecutionBoundary} = await import('../src/platform/windows/protected.ts');
        const calls: Record<string, unknown>[] = []; entry.calls = calls;
        const runner = protectionRunner(procs);
        protection = new ExecutionProtections(new WindowsExecutionBoundary(() => helper), async (id, ...args) => {
          const result = await runner(id, ...args); calls.push({command: args[0], args: args[1], ...result}); return result;
        }, id => procs.stopAndWait(id), id => procs.liveCount(id));
        const project = join(scratch, 'project'); mkdirSync(project); writeFileSync(join(project, 'ordinary.txt'), 'synthetic');
        try {
          await protection.install('matrix', {scope: {kind: 'job', id: 'matrix', associationId: 'synthetic', grantRevision: 1},
            route: {providerId: 'synthetic', accountId: 'synthetic', permissionMode: 'default'}, checkout: project,
            credentialPaths: [], executables: [process.execPath], expiresAt: Date.now() + 120000}, () => {});
          entry.admission = 'original probe succeeded';
        } catch (error) {
          entry.admission = String(error);
          try {protection.launch('matrix', process.execPath, [], {cwd: project}); throw new Error('refused install allowed a launch');}
          catch (refusal) {if (!String(refusal).includes('revoked')) throw refusal; entry.refusedLaunch = String(refusal);}
        }
        const probe = calls.find(call => (call.args as string[]).includes('--probe'));
        if (!probe || !completeMatrix(String(probe.stderr), 'lpac') || !String(probe.stderr).includes('NULL_AMBIENT denied=1')) throw new Error('LPAC matrix or original ambient refusal incomplete');
        const originalSucceeded = probe.code === 0 && probe.stdout === 'boite-windows-protected 1';
        const originalNulDenied = probe.code === 125 && String(probe.stderr).includes('execution.windows.probe.null-device: native call failed (5)');
        if (!originalSucceeded && !originalNulDenied) throw new Error('original production probe ended unexpectedly');
        entry.experimentComplete = true;
      }
      console.log(`NULL_ACCESS_MATRIX compiler=${compiler.name} compiled=1 native=${!compileOnly} experimentComplete=${entry.experimentComplete === true} productionAccepted=0`);
    } catch (error) {entry.error = String(error); console.error(entry.error); failed = true;}
    finally {
      const cleanupErrors: string[] = [];
      for (const [name, cleanup] of [
        ['protection', () => protection?.close()], ['processes', () => procs.killAll()],
        ['registry', () => procs.close()], ['journal', () => journal.close()],
      ] as const) {
        try {await cleanup();} catch (error) {cleanupErrors.push(`${name}: ${String(error)}`);}
      }
      if (!cleanupErrors.length) {
        try {rmSync(scratch, {recursive: true, force: true});} catch (error) {cleanupErrors.push(`scratch: ${String(error)}`);}
      }
      if (cleanupErrors.length) {entry.cleanupErrors = cleanupErrors; entry.scratchRetained = scratch; entry.experimentComplete = false; failed = true;}
      save();
    }
  }
  manifest.experimentComplete = !failed && !compileOnly && results.length === 2;
  save(); process.exitCode = failed ? 1 : 0;
}
