/** Opt-in kernel composition experiment; never admits production. */
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
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

const native = String.raw`
#include <winternl.h>
#include <tlhelp32.h>
/* These private NT layouts are a bypass witness only, not a production API.
 * Layout reference: winsiderss/phnt ntpsapi.h and ntrtl.h. x64 experiment only. */
typedef struct { ULONG_PTR Attribute; SIZE_T Size; ULONG_PTR Value; PSIZE_T ReturnLength; } SP_ATTRIBUTE;
typedef struct { SIZE_T TotalLength; SP_ATTRIBUTE Attributes[3]; } SP_ATTRIBUTES;
typedef struct {
  SIZE_T Size; ULONG State;
  union {
    struct { ULONG Flags; ACCESS_MASK Access; } Init;
    HANDLE FailureHandle;
    struct { ULONG Flags; HANDLE File, Section; ULONGLONG Parameters; ULONG WowParameters, ParameterFlags;
      ULONGLONG Peb; ULONG WowPeb; ULONGLONG Manifest; ULONG ManifestSize; } Success;
  } Data;
} SP_CREATE_INFO;
_Static_assert(sizeof(void *) == 8 && sizeof(SP_CREATE_INFO) == 88, "x64 native witness layout");
typedef struct {
  ULONG MaximumLength, Length, Flags, DebugFlags; HANDLE ConsoleHandle; ULONG ConsoleFlags;
  HANDLE Input, Output, Error;
} SP_PARAMETERS_PREFIX;
typedef NTSTATUS (NTAPI *sp_parameters_fn)(PRTL_USER_PROCESS_PARAMETERS *, PUNICODE_STRING,
  PUNICODE_STRING, PUNICODE_STRING, PUNICODE_STRING, PVOID, PUNICODE_STRING, PUNICODE_STRING,
  PUNICODE_STRING, PUNICODE_STRING, ULONG);
typedef VOID (NTAPI *sp_destroy_fn)(PRTL_USER_PROCESS_PARAMETERS);
typedef NTSTATUS (NTAPI *sp_create_fn)(PHANDLE, PHANDLE, ACCESS_MASK, ACCESS_MASK,
  POBJECT_ATTRIBUTES, POBJECT_ATTRIBUTES, ULONG, ULONG, PRTL_USER_PROCESS_PARAMETERS, SP_CREATE_INFO *, SP_ATTRIBUTES *);
typedef ULONG (WINAPI *sp_error_fn)(NTSTATUS);
typedef struct { UNICODE_STRING Name; USHORT Type, Reserved; ULONG Flags, Count; ULONGLONG *Values; } SP_CLAIM;
typedef struct { USHORT Version, Reserved; ULONG Count; SP_CLAIM *Claims; } SP_CLAIMS;

#define SP_MAGIC 0x53504b31UL
#define SP_NODES 4
/* Fixed anonymous-pipe fixture messages. No untrusted PID/path or host handle. */
typedef struct {
  DWORD Magic, Level, HostPid, Restricted;
  HANDLE Own[4], Alternate[4], ChildProcess, ChildThread, Included, Omitted;
  wchar_t Cwd[1024];
} SP_COMMAND;
typedef struct {
  DWORD Magic, Level, Argv, Env, Cwd, Stdio, Included, Omitted, Policy;
  DWORD HostCreate, HostWrite, Direct, Alternate, Native, NativeAlternate;
  DWORD NativeStatus, NativeAlternateStatus, Cleanup;
} SP_REPLY;
typedef struct {
  PROCESS_INFORMATION Process;
  HANDLE Peer[3], ParentHandles[4], Inherited[4], Event, OmittedEvent, OmittedRemote;
} SP_NODE;
static SP_NODE sp_nodes[SP_NODES];
static DWORD sp_restricted, sp_close_error;

static BOOL sp_closed(HANDLE handle) {
  BOOL result = CloseHandle(handle);
  if (!result && !sp_close_error) sp_close_error = GetLastError();
  return result;
}
static void sp_close(HANDLE *handle) { if (*handle && *handle != INVALID_HANDLE_VALUE) sp_closed(*handle); *handle = NULL; }
static BOOL sp_real(HANDLE h) { return h && (ULONG_PTR)h < (ULONG_PTR)-16; }
static DWORD sp_read(HANDLE pipe, void *buffer, DWORD size) {
  ULONGLONG deadline = GetTickCount64() + 10000; DWORD available = 0, done = 0;
  while (done < size) {
    if (!PeekNamedPipe(pipe, NULL, 0, NULL, &available, NULL)) return GetLastError();
    if (!available) { if (GetTickCount64() >= deadline) return ERROR_TIMEOUT; Sleep(1); continue; }
    DWORD part = 0, want = available < size - done ? available : size - done;
    if (!ReadFile(pipe, (BYTE *)buffer + done, want, &part, NULL)) return GetLastError();
    if (!part) return ERROR_BROKEN_PIPE;
    done += part;
  }
  return 0;
}
static DWORD sp_write(HANDLE pipe, const void *buffer, DWORD size) {
  DWORD done = 0;
  if (!WriteFile(pipe, buffer, size, &done, NULL)) return GetLastError();
  return done == size ? 0 : ERROR_WRITE_FAULT;
}
static DWORD sp_stop(PROCESS_INFORMATION *p) {
  DWORD error = 0;
  if (p->hProcess) {
    if (!TerminateProcess(p->hProcess, 0)) error = GetLastError();
    if (WaitForSingleObject(p->hProcess, 10000) != WAIT_OBJECT_0 && !error) error = ERROR_TIMEOUT;
  }
  sp_close(&p->hThread); sp_close(&p->hProcess); return error ? error : sp_close_error;
}
static UNICODE_STRING sp_unicode(wchar_t *text) {
  UNICODE_STRING s = {(USHORT)(wcslen(text) * sizeof(wchar_t)), (USHORT)((wcslen(text) + 1) * sizeof(wchar_t)), text};
  return s;
}
static wchar_t *sp_line(const wchar_t *exe, DWORD level) {
  wchar_t number[16]; swprintf(number, 16, L"%lu", level);
  wchar_t *args[] = {(wchar_t *)exe, L"--spike-node", number, L"space value", L"\x00e9\x96ea", L"quote\"tail\\", L""};
  return command_line(7, args);
}
static wchar_t *sp_env(DWORD level) {
  LPWCH original = GetEnvironmentStringsW(); if (!original) return NULL;
  size_t size = 64;
  for (wchar_t *s = original; *s; s += wcslen(s) + 1) size += wcslen(s) + 1;
  wchar_t *block = calloc(size, sizeof(wchar_t)), *out = block;
  if (out) {
    for (wchar_t *s = original; *s; s += wcslen(s) + 1) {
      if (!_wcsnicmp(s, L"BOITE_SPIKE_NODE=", 17)) continue;
      size_t length = wcslen(s) + 1; memcpy(out, s, length * sizeof(wchar_t)); out += length;
    }
    swprintf(out, 64, L"BOITE_SPIKE_NODE=%lu", level);
  }
  FreeEnvironmentStringsW(original); return block;
}
/* Handles in this list belong to 'parent', not to this creator. */
static DWORD sp_create_win32(const wchar_t *exe, const wchar_t *cwd, DWORD level, HANDLE parent,
    HANDLE handles[4], DWORD restricted, PSECURITY_DESCRIPTOR sd, PROCESS_INFORMATION *process) {
  SIZE_T bytes = 0; DWORD error = 0; BOOL initialized = FALSE;
  LPPROC_THREAD_ATTRIBUTE_LIST list = NULL; wchar_t *line = sp_line(exe, level), *env = sp_env(level);
  ZeroMemory(process, sizeof(*process));
  InitializeProcThreadAttributeList(NULL, parent ? 3 : 2, 0, &bytes);
  list = HeapAlloc(GetProcessHeap(), 0, bytes);
  if (!line || !env || !list) {error = ERROR_NOT_ENOUGH_MEMORY; goto end;}
  if (!InitializeProcThreadAttributeList(list, parent ? 3 : 2, 0, &bytes)) {error = GetLastError(); goto end;}
  initialized = TRUE;
  if ((parent && !UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_PARENT_PROCESS, &parent, sizeof(parent), NULL, NULL)) ||
      !UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(HANDLE) * 4, NULL, NULL) ||
      (restricted && !UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, &restricted, sizeof(restricted), NULL, NULL))) {error = GetLastError(); goto end;}
  STARTUPINFOEXW startup; ZeroMemory(&startup, sizeof(startup)); startup.StartupInfo.cb = sizeof(startup);
  startup.lpAttributeList = list; startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.StartupInfo.hStdInput = handles[0]; startup.StartupInfo.hStdOutput = handles[1]; startup.StartupInfo.hStdError = handles[2];
  SECURITY_ATTRIBUTES security = {sizeof(security), sd, FALSE};
  if (!CreateProcessW(exe, line, sd ? &security : NULL, sd ? &security : NULL, TRUE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT,
      env, cwd, &startup.StartupInfo, process)) error = GetLastError();
end:
  if (initialized) DeleteProcThreadAttributeList(list);
  if (list) HeapFree(GetProcessHeap(), 0, list);
  free(line); free(env); return error;
}
/* Same explicit native parameters/handle list in control and restricted modes.
 * Returned NTSTATUS is raw, with a separate Win32 translation. Never resume. */
static DWORD sp_create_native(const wchar_t *exe, const wchar_t *cwd, DWORD level, HANDLE parent,
    HANDLE handles[4], DWORD *status_out, DWORD *cleanup) {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  sp_parameters_fn parameters = (sp_parameters_fn)(void *)GetProcAddress(ntdll, "RtlCreateProcessParametersEx");
  sp_destroy_fn destroy = (sp_destroy_fn)(void *)GetProcAddress(ntdll, "RtlDestroyProcessParameters");
  sp_create_fn create = (sp_create_fn)(void *)GetProcAddress(ntdll, "NtCreateUserProcess");
  sp_error_fn translate = (sp_error_fn)(void *)GetProcAddress(ntdll, "RtlNtStatusToDosError");
  if (!parameters || !destroy || !create || !translate) return ERROR_PROC_NOT_FOUND;
  wchar_t image[2048]; if (swprintf(image, 2048, L"\\??\\%ls", exe) < 0) return ERROR_BUFFER_OVERFLOW;
  wchar_t *line = sp_line(exe, level), *env = sp_env(level);
  if (!line || !env) {free(line); free(env); return ERROR_NOT_ENOUGH_MEMORY;}
  UNICODE_STRING nt_image = sp_unicode(image), dos_image = sp_unicode((wchar_t *)exe);
  UNICODE_STRING command = sp_unicode(line), directory = sp_unicode((wchar_t *)cwd);
  PRTL_USER_PROCESS_PARAMETERS block = NULL;
  NTSTATUS status = parameters(&block, &dos_image, NULL, &directory, &command, env, NULL, NULL, NULL, NULL, 1);
  PROCESS_INFORMATION process; ZeroMemory(&process, sizeof(process));
  SP_CREATE_INFO info; ZeroMemory(&info, sizeof(info)); info.Size = sizeof(info);
  if (status >= 0) {
    SP_PARAMETERS_PREFIX *prefix = (SP_PARAMETERS_PREFIX *)block;
    prefix->Input = handles[0]; prefix->Output = handles[1]; prefix->Error = handles[2];
    SP_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes)); DWORD index = 0;
    if (parent) attributes.Attributes[index++] = (SP_ATTRIBUTE){0x60000, sizeof(HANDLE), (ULONG_PTR)parent, NULL};
    attributes.Attributes[index++] = (SP_ATTRIBUTE){0x20005, nt_image.Length, (ULONG_PTR)nt_image.Buffer, NULL};
    attributes.Attributes[index++] = (SP_ATTRIBUTE){0x2000b, sizeof(HANDLE) * 4, (ULONG_PTR)handles, NULL};
    attributes.TotalLength = sizeof(SIZE_T) + sizeof(SP_ATTRIBUTE) * index;
    status = create(&process.hProcess, &process.hThread, PROCESS_ALL_ACCESS, THREAD_ALL_ACCESS,
      NULL, NULL, 4 /* INHERIT_HANDLES */, 1 /* CREATE_SUSPENDED */, block, &info, &attributes);
  }
  *status_out = (DWORD)status;
  if (info.State == 6) {sp_close(&info.Data.Success.File); sp_close(&info.Data.Success.Section);}
  else if (info.State == 2 || info.State == 5) sp_close(&info.Data.FailureHandle);
  if (process.hProcess) {DWORD e = sp_stop(&process); if (e) *cleanup = e;}
  if (block) destroy(block);
  free(env); free(line); return status >= 0 ? 0 : translate(status);
}

static DWORD sp_check(HANDLE process, HANDLE job, PSID expected, DWORD parent, DWORD level) {
  HANDLE token = NULL; DWORD error = 0, bytes = 0, app = 0, integrity = 0;
  TOKEN_APPCONTAINER_INFORMATION *package = NULL; TOKEN_GROUPS *caps = NULL;
  TOKEN_MANDATORY_LABEL *label = NULL; DWORD package_ok = 0, lpac = 0, registry = 0, cap_count = 0, policy = 0, ppid = 0;
  BOOL in_job = FALSE; PSID *groups = NULL, *cap_sids = NULL; DWORD group_count = 0, cap_sid_count = 0;
  PROCESS_MITIGATION_CHILD_PROCESS_POLICY mitigation; ZeroMemory(&mitigation, sizeof(mitigation));
  if (!OpenProcessToken(process, TOKEN_QUERY, &token)) {error = GetLastError(); goto end;}
  if (!GetTokenInformation(token, TokenIsAppContainer, &app, sizeof(app), &bytes)) {error = GetLastError(); goto end;}
  GetTokenInformation(token, TokenAppContainerSid, NULL, 0, &bytes); package = calloc(1, bytes);
  if (!package || !GetTokenInformation(token, TokenAppContainerSid, package, bytes, &bytes)) {error = GetLastError(); goto end;}
  package_ok = package->TokenAppContainer && EqualSid(package->TokenAppContainer, expected);
  GetTokenInformation(token, TokenCapabilities, NULL, 0, &bytes); caps = calloc(1, bytes);
  if (!caps || !GetTokenInformation(token, TokenCapabilities, caps, bytes, &bytes)) {error = GetLastError(); goto end;}
  cap_count = caps->GroupCount;
  typedef BOOL (WINAPI *derive_fn)(LPCWSTR, PSID **, DWORD *, PSID **, DWORD *);
  derive_fn derive = (derive_fn)(void *)GetProcAddress(GetModuleHandleW(L"kernelbase.dll"), "DeriveCapabilitySidsFromName");
  if (!derive || !derive(L"registryRead", &groups, &group_count, &cap_sids, &cap_sid_count)) {error = ERROR_NOT_SUPPORTED; goto end;}
  registry = cap_count == 1 && cap_sid_count == 1 && EqualSid(caps->Groups[0].Sid, cap_sids[0]) &&
    (caps->Groups[0].Attributes & SE_GROUP_ENABLED);
  GetTokenInformation(token, TokenIntegrityLevel, NULL, 0, &bytes); label = calloc(1, bytes);
  if (!label || !GetTokenInformation(token, TokenIntegrityLevel, label, bytes, &bytes)) {error = GetLastError(); goto end;}
  integrity = *GetSidSubAuthority(label->Label.Sid, *GetSidSubAuthorityCount(label->Label.Sid) - 1);
  typedef NTSTATUS (NTAPI *claims_fn)(HANDLE, PUNICODE_STRING, ULONG, PVOID, ULONG, PULONG);
  claims_fn claims = (claims_fn)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQuerySecurityAttributesToken");
  wchar_t claim_name[] = L"WIN://NOALLAPPPKG"; UNICODE_STRING name = sp_unicode(claim_name);
  union { ULONGLONG Align; BYTE Data[8192]; } buffer; ZeroMemory(&buffer, sizeof(buffer));
  NTSTATUS status = claims ? claims(token, &name, 1, buffer.Data, sizeof(buffer.Data), &bytes) : (NTSTATUS)0xc0000002;
  SP_CLAIMS *values = (SP_CLAIMS *)buffer.Data;
  lpac = status >= 0 && values->Version == 1 && values->Count == 1 && values->Claims &&
    values->Claims->Count == 1 && (values->Claims->Type == 2 || values->Claims->Type == 6) &&
    values->Claims->Values && *values->Claims->Values == 1;
  if (!GetProcessMitigationPolicy(process, ProcessChildProcessPolicy, &mitigation, sizeof(mitigation)) ||
      !IsProcessInJob(process, job, &in_job)) {error = GetLastError(); goto end;}
  policy = mitigation.NoChildProcessCreation;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) {error = GetLastError(); goto end;}
  PROCESSENTRY32W entry; ZeroMemory(&entry, sizeof(entry)); entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot, &entry)) do {
    if (entry.th32ProcessID == GetProcessId(process)) {ppid = entry.th32ParentProcessID == parent; break;}
  } while (Process32NextW(snapshot, &entry));
  sp_closed(snapshot);
  if (!app || !package_ok || !lpac || !registry || integrity != SECURITY_MANDATORY_LOW_RID ||
      policy != sp_restricted || !in_job || !ppid) error = ERROR_INVALID_DATA;
end:
  fwprintf(stderr, L"SPIKE_TOKEN mode=%lu level=%lu app=%lu package=%lu lpac=%lu caps=%lu registry=%lu integrity=%lu policy=%lu job=%d ppid=%lu error=%lu\n",
    sp_restricted, level, app, package_ok, lpac, cap_count, registry, integrity, policy, in_job, ppid, error);
  for (DWORD i = 0; i < group_count; i++) LocalFree(groups[i]);
  LocalFree(groups);
  for (DWORD i = 0; i < cap_sid_count; i++) LocalFree(cap_sids[i]);
  LocalFree(cap_sids);
  free(package); free(caps); free(label); sp_close(&token); return error;
}

/* The fixture only duplicates handles already captured in a known client table.
 * A request never selects the host source table or accepts a pseudo handle. */
static DWORD sp_copy(HANDLE client, HANDLE source, HANDLE *result, HANDLE target, BOOL inherit) {
  if (!sp_real(source)) return ERROR_INVALID_HANDLE;
  return DuplicateHandle(client, source, target, result, 0, inherit, DUPLICATE_SAME_ACCESS) ? 0 : GetLastError();
}
static DWORD sp_channels(DWORD level, HANDLE parent, PSECURITY_DESCRIPTOR sd, HANDLE root_streams[3]) {
  SP_NODE *node = &sp_nodes[level]; DWORD error = 0;
  SECURITY_ATTRIBUTES attributes = {sizeof(attributes), sd, TRUE};
  HANDLE originals[4] = {NULL, NULL, NULL, NULL};
  for (int i = 0; i < 3; i++) {
    HANDLE ends[2] = {NULL, NULL};
    if (!CreatePipe(&ends[0], &ends[1], &attributes, 65536)) {error = GetLastError(); goto end;}
    originals[i] = ends[i ? 1 : 0]; node->Peer[i] = ends[i ? 0 : 1];
    if (!SetHandleInformation(node->Peer[i], HANDLE_FLAG_INHERIT, 0)) {error = GetLastError(); goto end;}
  }
  if (!level) {for (int i = 0; i < 3; i++) {root_streams[i] = originals[i]; originals[i] = NULL;} goto end;}
  node->Event = CreateEventW(&attributes, TRUE, FALSE, NULL);
  node->OmittedEvent = CreateEventW(&attributes, TRUE, FALSE, NULL);
  if (!node->Event || !node->OmittedEvent) {error = GetLastError(); goto end;}
  originals[3] = node->Event;
  for (int i = 0; i < 4; i++) {error = sp_copy(GetCurrentProcess(), originals[i], &node->ParentHandles[i], parent, TRUE); if (error) goto end;}
  error = sp_copy(GetCurrentProcess(), node->OmittedEvent, &node->OmittedRemote, parent, TRUE);
end:
  /* Event remains host-owned as the end-to-end inclusion witness. */
  originals[3] = NULL;
  for (int i = 0; i < 4; i++) sp_close(&originals[i]);
  return error;
}
static DWORD sp_broker(DWORD level, const wchar_t *exe, const wchar_t *cwd, HANDLE job,
    PSID app, PSECURITY_DESCRIPTOR sd) {
  SP_NODE *node = &sp_nodes[level]; HANDLE parent = sp_nodes[level - 1].Process.hProcess;
  DWORD error = 0; HANDLE snapshots[4] = {NULL, NULL, NULL, NULL};
  for (int i = 0; i < 4; i++) {
    error = sp_copy(parent, node->ParentHandles[i], &snapshots[i], GetCurrentProcess(), FALSE); if (error) goto end;
    error = sp_copy(GetCurrentProcess(), snapshots[i], &node->Inherited[i], parent, TRUE); if (error) goto end;
  }
  error = sp_create_win32(exe, cwd, level, parent, node->Inherited, sp_restricted, sd, &node->Process);
  fwprintf(stderr, L"SPIKE_CREATE mode=%lu level=%lu error=%lu suspended=1 override=0\n", sp_restricted, level, error);
  if (!error) error = sp_check(node->Process.hProcess, job, app, GetProcessId(parent), level);
end:
  for (int i = 0; i < 4; i++) {
    sp_close(&snapshots[i]);
    if (node->Inherited[i]) {
      HANDLE temporary = NULL;
      if (!DuplicateHandle(parent, node->Inherited[i], GetCurrentProcess(), &temporary, 0, FALSE,
          DUPLICATE_SAME_ACCESS | DUPLICATE_CLOSE_SOURCE) && !error) error = GetLastError();
      sp_close(&temporary);
    }
  }
  return error;
}
static int sp_node(int count, wchar_t **args) {
  SP_COMMAND command; SP_REPLY reply; ZeroMemory(&reply, sizeof(reply));
  DWORD error = sp_read(GetStdHandle(STD_INPUT_HANDLE), &command, sizeof(command));
  if (error || command.Magic != SP_MAGIC || command.Level > 2) return 125;
  reply.Magic = SP_MAGIC; reply.Level = command.Level;
  wchar_t expected[16]; swprintf(expected, 16, L"%lu", command.Level);
  reply.Argv = count == 7 && !wcscmp(args[2], expected) && !wcscmp(args[3], L"space value") &&
    !wcscmp(args[4], L"\x00e9\x96ea") && !wcscmp(args[5], L"quote\"tail\\") && !*args[6];
  wchar_t value[16], cwd[1024], exe[1024];
  reply.Env = GetEnvironmentVariableW(L"BOITE_SPIKE_NODE", value, 16) && !wcscmp(value, expected);
  reply.Cwd = GetCurrentDirectoryW(1024, cwd) && !wcscmp(cwd, command.Cwd);
  reply.Stdio = GetFileType(GetStdHandle(STD_INPUT_HANDLE)) == FILE_TYPE_PIPE &&
    GetFileType(GetStdHandle(STD_OUTPUT_HANDLE)) == FILE_TYPE_PIPE && GetFileType(GetStdHandle(STD_ERROR_HANDLE)) == FILE_TYPE_PIPE;
  reply.Included = !command.Level || SetEvent(command.Included);
  reply.Omitted = !command.Level || !SetEvent(command.Omitted);
  PROCESS_MITIGATION_CHILD_PROCESS_POLICY mitigation; ZeroMemory(&mitigation, sizeof(mitigation));
  reply.Policy = GetProcessMitigationPolicy(GetCurrentProcess(), ProcessChildProcessPolicy, &mitigation, sizeof(mitigation)) &&
    mitigation.NoChildProcessCreation == command.Restricted;
  HANDLE host = OpenProcess(PROCESS_CREATE_PROCESS, FALSE, command.HostPid);
  reply.HostCreate = host ? 0 : GetLastError(); sp_close(&host);
  host = OpenProcess(PROCESS_VM_WRITE, FALSE, command.HostPid);
  reply.HostWrite = host ? 0 : GetLastError(); sp_close(&host);
  if (command.Level < 2 && GetModuleFileNameW(NULL, exe, 1024)) {
    PROCESS_INFORMATION attempt;
    reply.Direct = sp_create_win32(exe, cwd, command.Level + 1, NULL, command.Own, command.Restricted, NULL, &attempt);
    if (attempt.hProcess) reply.Cleanup = sp_stop(&attempt);
    reply.Native = sp_create_native(exe, cwd, command.Level + 1, NULL, command.Own, &reply.NativeStatus, &reply.Cleanup);
    reply.Alternate = sp_create_win32(exe, cwd, command.Level + 2, command.ChildProcess, command.Alternate, command.Restricted, NULL, &attempt);
    if (attempt.hProcess) {DWORD e = sp_stop(&attempt); if (e) reply.Cleanup = e;}
    reply.NativeAlternate = sp_create_native(exe, cwd, command.Level + 2, command.ChildProcess, command.Alternate, &reply.NativeAlternateStatus, &reply.Cleanup);
    sp_close(&command.ChildProcess); sp_close(&command.ChildThread);
  }
  if (sp_close_error) reply.Cleanup = sp_close_error;
  DWORD marker = SP_MAGIC ^ command.Level;
  if (sp_write(GetStdHandle(STD_ERROR_HANDLE), &marker, sizeof(marker)) ||
      sp_write(GetStdHandle(STD_OUTPUT_HANDLE), &reply, sizeof(reply))) return 125;
  DWORD ack = 0; return sp_read(GetStdHandle(STD_INPUT_HANDLE), &ack, sizeof(ack)) || ack != SP_MAGIC ? 125 : 0;
}
static DWORD sp_driver(PROCESS_INFORMATION root, const wchar_t *exe, const wchar_t *cwd,
    HANDLE job, PSID app, PSECURITY_DESCRIPTOR sd) {
  DWORD error = 0; sp_nodes[0].Process = root;
  HANDLE ignored = NULL;
  DWORD process_guard = sp_copy(root.hProcess, GetCurrentProcess(), &ignored, GetCurrentProcess(), FALSE);
  DWORD thread_guard = sp_copy(root.hProcess, GetCurrentThread(), &ignored, GetCurrentProcess(), FALSE);
  DWORD null_guard = sp_copy(root.hProcess, NULL, &ignored, GetCurrentProcess(), FALSE);
  fwprintf(stderr, L"SPIKE_GUARD mode=%lu process=%lu thread=%lu null=%lu\n", sp_restricted, process_guard, thread_guard, null_guard);
  if (process_guard != ERROR_INVALID_HANDLE || thread_guard != ERROR_INVALID_HANDLE || null_guard != ERROR_INVALID_HANDLE) return ERROR_INVALID_DATA;
  error = sp_check(root.hProcess, job, app, GetCurrentProcessId(), 0); if (error) return error;
  for (DWORD level = 1; level < SP_NODES; level++) {
    error = sp_channels(level, sp_nodes[level - 1].Process.hProcess, sd, NULL); if (error) return error;
    if (level < 3) {error = sp_broker(level, exe, cwd, job, app, sd); if (error) return error;}
  }
  for (DWORD level = 0; level < 3; level++) {
    SP_NODE *node = &sp_nodes[level]; SP_COMMAND command; SP_REPLY reply; ZeroMemory(&command, sizeof(command));
    command.Magic = SP_MAGIC; command.Level = level; command.HostPid = GetCurrentProcessId(); command.Restricted = sp_restricted;
    size_t cwd_length = wcslen(cwd);
    if (cwd_length >= 1024) return ERROR_BUFFER_OVERFLOW;
    memcpy(command.Cwd, cwd, (cwd_length + 1) * sizeof(wchar_t));
    command.Included = node->Inherited[3]; command.Omitted = node->OmittedRemote;
    if (level < 2) {
      memcpy(command.Own, sp_nodes[level + 1].ParentHandles, sizeof(command.Own));
      memcpy(command.Alternate, sp_nodes[level + 2].ParentHandles, sizeof(command.Alternate));
      error = sp_copy(GetCurrentProcess(), sp_nodes[level + 1].Process.hProcess, &command.ChildProcess, node->Process.hProcess, FALSE); if (error) return error;
      error = sp_copy(GetCurrentProcess(), sp_nodes[level + 1].Process.hThread, &command.ChildThread, node->Process.hProcess, FALSE); if (error) return error;
    }
    DWORD available = 0;
    if (!PeekNamedPipe(node->Peer[1], NULL, 0, NULL, &available, NULL) || available) return ERROR_INVALID_DATA;
    /* All descendants remain suspended through token/job/parent checks. */
    if (ResumeThread(node->Process.hThread) != 1) return ERROR_INVALID_DATA;
    error = sp_write(node->Peer[0], &command, sizeof(command)); if (error) return error;
    error = sp_read(node->Peer[1], &reply, sizeof(reply)); if (error) return error;
    DWORD marker = 0; error = sp_read(node->Peer[2], &marker, sizeof(marker)); if (error) return error;
    DWORD included = !level || WaitForSingleObject(node->Event, 0) == WAIT_OBJECT_0;
    DWORD omitted = !level || WaitForSingleObject(node->OmittedEvent, 0) == WAIT_TIMEOUT;
    fwprintf(stderr, L"SPIKE_REPLY mode=%lu level=%lu magic=%lu argv=%lu env=%lu cwd=%lu stdio=%lu included=%lu omitted=%lu policy=%lu host-create=%lu host-write=%lu direct=%lu alternate=%lu native=%lu native-status=0x%08lx native-alternate=%lu native-alternate-status=0x%08lx cleanup=%lu\n",
      sp_restricted, level, reply.Magic == SP_MAGIC && reply.Level == level, reply.Argv, reply.Env, reply.Cwd,
      reply.Stdio && marker == (SP_MAGIC ^ level), reply.Included && included, reply.Omitted && omitted, reply.Policy,
      reply.HostCreate, reply.HostWrite, reply.Direct, reply.Alternate, reply.Native, reply.NativeStatus,
      reply.NativeAlternate, reply.NativeAlternateStatus, reply.Cleanup);
    DWORD expected = sp_restricted ? ERROR_CHILD_PROCESS_BLOCKED : 0;
    if (reply.Magic != SP_MAGIC || reply.Level != level || !reply.Argv || !reply.Env || !reply.Cwd || !reply.Stdio ||
        !reply.Included || !reply.Omitted || !reply.Policy || !included || !omitted || marker != (SP_MAGIC ^ level) ||
        reply.HostCreate != ERROR_ACCESS_DENIED || reply.HostWrite != ERROR_ACCESS_DENIED || reply.Cleanup ||
        (level < 2 && (reply.Direct != expected || reply.Alternate != expected || reply.Native != expected || reply.NativeAlternate != expected))) return ERROR_INVALID_DATA;
  }
  for (int level = 2; level >= 0; level--) {
    DWORD ack = SP_MAGIC, exit_code = 125;
    error = sp_write(sp_nodes[level].Peer[0], &ack, sizeof(ack)); if (error) return error;
    if (WaitForSingleObject(sp_nodes[level].Process.hProcess, 10000) != WAIT_OBJECT_0 ||
        !GetExitCodeProcess(sp_nodes[level].Process.hProcess, &exit_code) || exit_code) return ERROR_INVALID_DATA;
  }
  return 0;
}
static void sp_cleanup(void) {
  for (int i = 0; i < SP_NODES; i++) {
    for (int j = 0; j < 3; j++) sp_close(&sp_nodes[i].Peer[j]);
    sp_close(&sp_nodes[i].Event); sp_close(&sp_nodes[i].OmittedEvent);
    if (i) {sp_close(&sp_nodes[i].Process.hThread); sp_close(&sp_nodes[i].Process.hProcess);}
  }
  ZeroMemory(sp_nodes, sizeof(sp_nodes));
}
`;

function once(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error(`spike substitution must match once: ${before}`);
  return source.replace(before, after);
}

export function spikeSource(source: string): string {
  if (hash(source) !== sourceHash) throw new Error('protected-tool.c changed: review spike provenance before running');
  const start = source.indexOf('static int launch(int count, wchar_t **args) {');
  const end = source.indexOf('\nstatic int probe(', start);
  let launch = source.slice(start, end);
  launch = once(launch, 'static int launch(', 'static int sp_launch(');
  launch = once(launch, '  PSID app = NULL;', '  sp_restricted = wcscmp(args[1], L"spike-control") ? 1 : 0;\n  PSID app = NULL;');
  const streamsStart = launch.indexOf('  DWORD ids[3]');
  const streamsEnd = launch.indexOf('  SIZE_T bytes', streamsStart);
  launch = launch.slice(0, streamsStart) + '  error = sp_channels(0, GetCurrentProcess(), object_security, streams);\n  if (error) goto end;\n' + launch.slice(streamsEnd);
  launch = launch.replaceAll('AttributeList(NULL, 4,', 'AttributeList(NULL, 5,').replaceAll('AttributeList(list, 4,', 'AttributeList(list, 5,');
  launch = once(launch, '  STARTUPINFOEXW startup;', '  if (sp_restricted && !UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, &sp_restricted, sizeof(sp_restricted), NULL, NULL)) {error = GetLastError(); goto end;}\n  STARTUPINFOEXW startup;');
  const resume = launch.indexOf('  if (ResumeThread(child.hThread)');
  const cleanup = launch.indexOf('\nend:', resume);
  launch = launch.slice(0, resume) + '  error = sp_driver(child, args[4], args[3], job, app, object_security);\n  exit_code = error ? 125 : 0;\n' + launch.slice(cleanup);
  launch = once(launch, '  if (child.hThread) CloseHandle(child.hThread);',
    '  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION final_accounting; ZeroMemory(&final_accounting, sizeof(final_accounting));\n  DWORD cleanup_error = 0;\n  if (job && !QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &final_accounting, sizeof(final_accounting), NULL)) cleanup_error = GetLastError();\n  if (final_accounting.ActiveProcesses) cleanup_error = ERROR_BUSY;\n  sp_cleanup();\n  if (child.hThread) CloseHandle(child.hThread);');
  launch = launch.replaceAll('CloseHandle(', 'sp_closed(');
  launch = once(launch, '  return error ? failure(stage, error) : (int)exit_code;',
    '  if (sp_close_error && !cleanup_error) cleanup_error = sp_close_error;\n  fwprintf(stderr, L"SPIKE_CLEANUP mode=%lu active=%lu error=%lu\\n", sp_restricted, final_accounting.ActiveProcesses, cleanup_error);\n  if (cleanup_error && !error) error = cleanup_error;\n  return error ? failure(stage, error) : (int)exit_code;');
  source = source.slice(0, start) + native + '\n' + source.slice(start, end) + '\n' + launch + source.slice(end);
  return once(source, '  else if (count == 3 && !wcscmp(args[1], L"--probe"))',
    '  else if (count >= 2 && !wcscmp(args[1], L"--spike-node")) result = sp_node(count, args);\n  else if (count > 1 && (!wcscmp(args[1], L"spike-control") || !wcscmp(args[1], L"spike-run"))) result = sp_launch(count, args);\n  else if (count == 3 && !wcscmp(args[1], L"--probe"))');
}

export type SpikeVerdict = {complete: boolean; kernelGatePassed: boolean; reason: string};
function records(text: string, prefix: string): Record<string, string>[] {
  return text.split(/\r?\n/).filter(line => line.startsWith(prefix + ' ')).map(line =>
    Object.fromEntries(line.slice(prefix.length + 1).split(' ').map(pair => pair.split('='))));
}
export function spikeVerdict(control: Captured, restricted: Captured): SpikeVerdict {
  const invalid = (reason: string): SpikeVerdict => ({complete: false, kernelGatePassed: false, reason});
  for (const [mode, capture] of [[0, control], [1, restricted]] as const) {
    if (capture.timedOut) return invalid(`mode ${mode}: timeout`);
    const cleanup = records(capture.err, 'SPIKE_CLEANUP');
    if (cleanup.length !== 1 || cleanup[0]!.mode !== String(mode) || cleanup[0]!.active !== '0' || cleanup[0]!.error !== '0') return invalid(`mode ${mode}: cleanup incomplete`);
    const guard = records(capture.err, 'SPIKE_GUARD');
    if (guard.length !== 1 || guard[0]!.mode !== String(mode) || !['process', 'thread', 'null'].every(key => guard[0]![key] === '6')) return invalid(`mode ${mode}: pseudo-handle guard incomplete`);
    const tokens = records(capture.err, 'SPIKE_TOKEN');
    const creates = records(capture.err, 'SPIKE_CREATE');
    const last = creates.at(-1);
    const refusedAt = mode === 1 && capture.code === 125 && last && /^[1-9][0-9]*$/.test(last.error ?? '')
      && ['1', '2'].includes(last.level ?? '') ? Number(last.level) : 0;
    const expectedTokens = refusedAt || 3;
    const expectedCreates = refusedAt || 2;
    if ((!refusedAt && capture.code !== 0) || tokens.length !== expectedTokens || creates.length !== expectedCreates) return invalid(`mode ${mode}: creation incomplete`);
    for (let level = 0; level < expectedTokens; level++) {
      const matching = tokens.filter(row => row.level === String(level) && row.mode === String(mode));
      if (matching.length !== 1) return invalid(`mode ${mode}: token identity missing/duplicate`);
      const row = matching[0]!;
      if (!['app', 'package', 'lpac', 'registry', 'job', 'ppid'].every(key => row[key] === '1') ||
          row.caps !== '1' || row.integrity !== '4096' || row.policy !== String(mode) || row.error !== '0') return invalid(`mode ${mode}: wrong token/job/policy/parent`);
    }
    for (let level = 1; level <= expectedCreates; level++) {
      const matching = creates.filter(row => row.level === String(level) && row.mode === String(mode));
      if (matching.length !== 1 || (level !== refusedAt && matching[0]!.error !== '0') ||
          matching[0]!.override !== '0' || matching[0]!.suspended !== '1') return invalid(`mode ${mode}: broker creation invalid`);
    }
    if (refusedAt) return {complete: true, kernelGatePassed: false, reason: 'restricted parent broker creation refused; see raw Win32 error'};
    const replies = records(capture.err, 'SPIKE_REPLY');
    if (replies.length !== 3) return invalid(`mode ${mode}: client evidence incomplete`);
    for (let level = 0; level < 3; level++) {
      const matching = replies.filter(row => row.level === String(level) && row.mode === String(mode));
      if (matching.length !== 1) return invalid(`mode ${mode}: reply identity missing/duplicate`);
      const row = matching[0]!;
      if (!['magic', 'argv', 'env', 'cwd', 'stdio', 'included', 'omitted', 'policy'].every(key => row[key] === '1') ||
          row['host-create'] !== '5' || row['host-write'] !== '5' || row.cleanup !== '0') return invalid(`mode ${mode}: client contract failed`);
      if (level < 2) {
        const expected = mode ? '367' : '0';
        if (!['direct', 'alternate', 'native', 'native-alternate'].every(key => row[key] === expected)) return invalid(`mode ${mode}: policy witness failed`);
        for (const key of ['native-status', 'native-alternate-status']) {
          if (!/^0x[0-9a-f]{8}$/i.test(row[key] ?? '') || (Number(row[key]) >= 0x80000000) !== Boolean(mode)) return invalid(`mode ${mode}: native status absent/inconsistent`);
        }
      }
    }
  }
  return {complete: true, kernelGatePassed: true, reason: 'kernel composition and scoped fixture contracts passed; production not admitted'};
}

export type CompilerSpikeResult = {name: string; verdict?: SpikeVerdict; [key: string]: unknown};
export function aggregateSpike(results: readonly CompilerSpikeResult[], compileOnly: boolean, failed: boolean) {
  const incomplete = (aggregationReason: string) => ({experimentComplete: false, kernelGatePassed: false, aggregationReason});
  if (failed) return incomplete('compiler run or cleanup failed');
  if (compileOnly) return incomplete('compile-only: no native verdicts');
  if (results.length !== 2 || results.some(entry => !entry.verdict?.complete)) return incomplete('requires two complete compiler verdicts');
  const passed = results[0]!.verdict!.kernelGatePassed;
  if (results.some(entry => entry.verdict!.kernelGatePassed !== passed)) {
    return incomplete(`compiler disagreement: ${results.map(entry => `${entry.name} kernelGatePassed=${entry.verdict!.kernelGatePassed}`).join('; ')}`);
  }
  return {experimentComplete: true, kernelGatePassed: passed, aggregationReason: `compilers agree: kernelGatePassed=${passed}`};
}

if (import.meta.main) {
  const [output, mode] = process.argv.slice(2);
  if (!output || !isAbsolute(output) || (mode && mode !== '--compile-only')) throw new Error('usage: bun packages/core/test/windows-lpac-parent-spike.ts <fresh absolute artifact directory> [--compile-only]');
  const compileOnly = mode === '--compile-only';
  if (!compileOnly && (process.platform !== 'win32' || process.env.BOITE_TEST_LPAC_PARENT_SPIKE !== '1')) throw new Error('requires Windows and BOITE_TEST_LPAC_PARENT_SPIKE=1; no fixture allocated');
  if (existsSync(output)) throw new Error('choose a fresh output directory to preserve evidence');
  mkdirSync(output, {recursive: true});
  const generated = join(output, 'lpac-parent-spike.c'), source = spikeSource(readFileSync(sourcePath, 'utf8'));
  writeFileSync(generated, source);
  const results: CompilerSpikeResult[] = [];
  const manifest = {platform: process.platform, kernel: release(), bun: Bun.version, sourceHash, generatedSha256: hash(source),
    runnerSha256: hash(readFileSync(import.meta.path)), compileOnly, results, productionAccepted: false, experimentComplete: false, kernelGatePassed: false, aggregationReason: 'compiler runs pending'};
  const save = () => writeFileSync(join(output, 'spike.json'), JSON.stringify(manifest, null, 2) + '\n'); save();
  const compilers = process.platform === 'win32' ? [{name: 'sdk', path: Bun.which('clang')}, {name: 'mingw', path: 'C:\\mingw64\\bin\\gcc.exe'}]
    : [{name: 'mingw-cross', path: Bun.which('x86_64-w64-mingw32-gcc')}];
  let failed = false;
  for (const compiler of compilers) {
    const entry: CompilerSpikeResult = {name: compiler.name, compiler: compiler.path}; results.push(entry);
    const scratch = mkdtempSync(join(tmpdir(), 'boite-lpac-parent-'));
    const journal = new Journal(join(scratch, 'journal.db')), procs = new ProcRegistry(journal, new Bus());
    let protection: ExecutionProtections | undefined;
    async function execute(id: string, command: string, args: string[], cwd = output!, env = selectedEnvironment(), timeout = 90000): Promise<Captured> {
      return capture(procs, id, procs.spawnPiped(id, command, args, {cwd, env, agentRoot: false}), timeout);
    }
    try {
      if (!compiler.path || !existsSync(compiler.path)) throw new Error(`compiler unavailable: ${compiler.name}`);
      const helper = join(output, `lpac-parent-${compiler.name}.exe`);
      const args = ['-O2', '-Wall', '-Wextra', '-Werror', generated, '-o', helper,
        ...(process.platform === 'win32' && /clang/i.test(compiler.path) ? [] : ['-static']), '-luserenv', '-ladvapi32', '-lshell32', '-luser32'];
      entry.compileCommand = [compiler.path, ...args]; const built = await execute(`compile-${compiler.name}`, compiler.path, args); entry.compile = built;
      if (built.code || built.timedOut) throw new Error(`strict compile failed: ${compiler.name}`);
      entry.helperSha256 = hash(readFileSync(helper));
      if (!compileOnly) {
        const {WindowsExecutionBoundary} = await import('../src/platform/windows/protected.ts');
        const calls: Record<string, unknown>[] = []; entry.calls = calls;
        const runner = protectionRunner(procs); let control: Captured | undefined, restricted: Captured | undefined;
        protection = new ExecutionProtections(new WindowsExecutionBoundary(() => helper), async (id, ...call) => {
          const [command, args, cwd, environment] = call;
          if (args.includes('--probe')) {
            const fixture = ['0', 'space value', 'é雪', 'quote"tail\\', ''];
            for (const variant of ['spike-control', 'spike-run']) {
              const childArgs = [variant, args[1]!, args[2]!, args[3]!, '--spike-node', ...fixture];
              const result = await execute(`${variant}-${compiler.name}`, command, childArgs, cwd,
                {...environment, BOITE_SPIKE_NODE: '0'}); entry[variant] = result;
              if (variant === 'spike-control') control = result; else restricted = result;
              save();
            }
          }
          const result = await runner(id, ...call); calls.push({command, args, ...result}); return result;
        }, id => procs.stopAndWait(id), id => procs.liveCount(id));
        const project = join(scratch, 'project'); mkdirSync(project); writeFileSync(join(project, 'ordinary.txt'), 'synthetic');
        try {
          await protection.install('spike', {scope: {kind: 'job', id: 'spike', associationId: 'synthetic', grantRevision: 1},
            route: {providerId: 'synthetic', accountId: 'synthetic', permissionMode: 'default'}, checkout: project,
            credentialPaths: [], executables: [process.execPath], expiresAt: Date.now() + 240000}, () => {});
          entry.admission = 'original probe succeeded';
        } catch (error) {
          entry.admission = String(error);
          try {protection.launch('spike', process.execPath, [], {cwd: project}); throw new Error('refused install allowed a launch');}
          catch (refusal) {if (!String(refusal).includes('revoked')) throw refusal; entry.refusedLaunch = String(refusal);}
        }
        const probe = calls.find(call => (call.args as string[]).includes('--probe'));
        if (!probe || !control || !restricted) throw new Error('original probe or spike capture missing');
        if (!(probe.code === 125 && String(probe.stderr).includes('execution.windows.probe.null-device: native call failed (5)')) &&
            !(probe.code === 0 && probe.stdout === 'boite-windows-protected 1')) throw new Error('original production probe ended unexpectedly');
        const verdict = spikeVerdict(control, restricted); entry.verdict = verdict;
        if (!verdict.complete) throw new Error(verdict.reason);
      }
      console.log(`LPAC_PARENT_SPIKE compiler=${compiler.name} compiled=1 native=${!compileOnly} kernelGatePassed=${(entry.verdict as SpikeVerdict | undefined)?.kernelGatePassed === true ? 1 : 0} productionAccepted=0`);
    } catch (error) {entry.error = String(error); failed = true; console.error(entry.error);}
    finally {
      const errors: string[] = [];
      for (const [name, cleanup] of [['protection', () => protection?.close()], ['processes', () => procs.killAll()],
        ['registry', () => procs.close()], ['journal', () => journal.close()]] as const) {
        try {await cleanup();} catch (error) {errors.push(`${name}: ${String(error)}`);}
      }
      if (!errors.length) {try {rmSync(scratch, {recursive: true, force: true});} catch (error) {errors.push(`scratch: ${String(error)}`);}}
      if (errors.length) {entry.cleanupErrors = errors; entry.scratchRetained = scratch; failed = true;}
      save();
    }
  }
  Object.assign(manifest, aggregateSpike(results, compileOnly, failed));
  save(); process.exitCode = failed || (!compileOnly && !manifest.experimentComplete) ? 1 : 0;
}
