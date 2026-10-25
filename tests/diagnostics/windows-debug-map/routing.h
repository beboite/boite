/* Test-only adaptation of the retained DEBUG_PROCESS candidate. See gates.md.
 * No attach, privilege adjustment, memory/context writes or caller map changes. */
#include <winternl.h>
#include <stdint.h>

typedef NTSTATUS (NTAPI *query_process_fn)(HANDLE, PROCESSINFOCLASS, PVOID, ULONG, PULONG);
typedef NTSTATUS (NTAPI *query_object_fn)(HANDLE, OBJECT_INFORMATION_CLASS, PVOID, ULONG, PULONG);
typedef NTSTATUS (NTAPI *open_directory_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES);
typedef struct {
  UNICODE_STRING Name; USHORT ValueType, Reserved; ULONG Flags, ValueCount;
  union { ULONGLONG *Uint64; } Values;
} ROUTE_ATTRIBUTE;
typedef struct { USHORT Version, Reserved; ULONG Count; ROUTE_ATTRIBUTE *Attributes; } ROUTE_ATTRIBUTES;
typedef struct { DWORD pid, main_tid; uintptr_t initial, native_base; BOOL consumed, exited; } ROUTE_RECORD;
static HANDLE probe_map, probe_link;
static wchar_t probe_name[256];
static BOOL debug_mode;
static ROUTE_RECORD records[32];
static int captured, active;

static FARPROC nt_api(const char *name) { return GetProcAddress(GetModuleHandleW(L"ntdll.dll"), name); }

/* Read-only snapshots through our live handle. Counts alone do not identify
 * which kernel component owns a remaining reference. */
static DWORD object_counts(const wchar_t *label, HANDLE object) {
  struct { ULONG attributes, granted, handles, pointers; ULONG reserved[10]; } info;
  ZeroMemory(&info, sizeof(info)); ULONG used = 0;
  query_object_fn query = (query_object_fn)(void *)nt_api("NtQueryObject");
  NTSTATUS status = query ? query(object, (OBJECT_INFORMATION_CLASS)0, &info, sizeof(info), &used) : (NTSTATUS)0xc0000002;
  fwprintf(stderr, L"cleanup object=%ls handle=%p query=0x%08lx attributes=0x%08lx granted=0x%08lx handles=%lu pointers=%lu\n",
    label, object, (unsigned long)status, info.attributes, info.granted, info.handles, info.pointers);
  fflush(stderr); return status < 0 ? (DWORD)status : 0;
}

#include "ownership.h"
#include "identity.h"

static DWORD close_owned(const wchar_t *label, HANDLE *object) {
  if (!*object) return 0;
  DWORD lifetime = map_lifetime(L"before-close", label);
  DWORD observed = object_counts(label, *object);
  BOOL closed = CloseHandle(*object); DWORD error = closed ? 0 : GetLastError();
  fwprintf(stderr, L"cleanup close=%ls closed=%d error=%lu\n", label, closed, error); fflush(stderr);
  if (closed) *object = NULL;
  DWORD after = map_lifetime(L"after-close", label);
  return error ? error : observed ? observed : lifetime ? lifetime : after;
}

static DWORD object_name(HANDLE object, wchar_t *out, size_t length) {
  BYTE buffer[8192]; ULONG used = 0;
  query_object_fn query = (query_object_fn)(void *)nt_api("NtQueryObject");
  if (!query) return ERROR_PROC_NOT_FOUND;
  NTSTATUS status = query(object, (OBJECT_INFORMATION_CLASS)1, buffer, sizeof(buffer), &used);
  if (status < 0) return (DWORD)status;
  UNICODE_STRING *name = (UNICODE_STRING *)buffer;
  if (!name->Buffer || (size_t)name->Length / 2 + 1 > length) return ERROR_INSUFFICIENT_BUFFER;
  memcpy(out, name->Buffer, name->Length); out[name->Length / 2] = 0;
  return 0;
}

typedef struct { BYTE privileges[4096]; DWORD bytes; wchar_t nul[4096], drive[4096], map[4096]; } CALLER_STATE;
static CALLER_STATE caller_before;

static DWORD read_caller(const wchar_t *root, CALLER_STATE *state) {
  ZeroMemory(state, sizeof(*state));
  HANDLE token = NULL, map = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return GetLastError();
  BOOL ok = GetTokenInformation(token, TokenPrivileges, state->privileges, sizeof(state->privileges), &state->bytes);
  DWORD error = ok ? 0 : GetLastError(); CloseHandle(token);
  if (error) return error;
  if (wcslen(root) < 3 || root[1] != L':') return ERROR_BAD_PATHNAME;
  wchar_t drive[3] = {root[0], L':', 0};
  if (!QueryDosDeviceW(L"NUL", state->nul, 4096) || !QueryDosDeviceW(drive, state->drive, 4096)) return GetLastError();
  open_directory_fn open = (open_directory_fn)(void *)nt_api("NtOpenDirectoryObject");
  if (!open) return ERROR_PROC_NOT_FOUND;
  wchar_t text[] = L"\\??"; UNICODE_STRING name = {6, 8, text};
  OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
  attributes.Length = sizeof(attributes); attributes.ObjectName = &name; attributes.Attributes = 0x40;
  NTSTATUS status = open(&map, 1, &attributes);
  if (status < 0) return (DWORD)status;
  error = object_name(map, state->map, 4096); CloseHandle(map);
  return error;
}

static DWORD caller_snapshot(const wchar_t *root, BOOL compare) {
  CALLER_STATE current;
  DWORD error = read_caller(root, &current);
  if (error) return error;
  if (!compare) caller_before = current;
  else if (memcmp(&current, &caller_before, sizeof(current))) return ERROR_INVALID_DATA;
  fwprintf(stderr, L"caller snapshot=%ls map=%ls NUL=%ls drive=%ls privileges-bytes=%lu unchanged=1\n",
    compare ? L"after" : L"before", current.map, current.nul, current.drive, current.bytes);
  fflush(stderr); return 0;
}

static DWORD map_apply(HANDLE process) {
  typedef NTSTATUS (NTAPI *set_process_fn)(HANDLE, PROCESSINFOCLASS, PVOID, ULONG);
  set_process_fn set = (set_process_fn)(void *)nt_api("NtSetInformationProcess");
  if (!set) return ERROR_PROC_NOT_FOUND;
  DWORD observed = map_lifetime(L"before-assign", L"process");
  if (observed) return observed;
  NTSTATUS status = set(process, (PROCESSINFOCLASS)23, &probe_map, sizeof(probe_map));
  fwprintf(stderr, L"private-map pid=%lu set=0x%08lx\n", GetProcessId(process), (unsigned long)status);
  fflush(stderr);
  observed = map_lifetime(L"after-assign", L"process");
  return status < 0 ? (DWORD)status : observed;
}

static DWORD map_prepare(HANDLE process, PSECURITY_DESCRIPTOR security, const wchar_t *root, const wchar_t *image) {
  typedef NTSTATUS (NTAPI *create_directory_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, HANDLE, ULONG);
  typedef NTSTATUS (NTAPI *create_link_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PUNICODE_STRING);
  create_directory_fn create = (create_directory_fn)(void *)nt_api("NtCreateDirectoryObjectEx");
  create_link_fn link = (create_link_fn)(void *)nt_api("NtCreateSymbolicLinkObject");
  if (!create || !link) return ERROR_PROC_NOT_FOUND;
  if (debug_mode) { DWORD error = prepare_target(image); if (error) return error; }
  DWORD session = 0;
  if (!ProcessIdToSessionId(GetCurrentProcessId(), &session)) return GetLastError();
  if (session) swprintf(probe_name, 256, L"\\Sessions\\%lu\\BaseNamedObjects\\boite.route.%lu", session, GetCurrentProcessId());
  else swprintf(probe_name, 256, L"\\BaseNamedObjects\\boite.route.%lu", GetCurrentProcessId());
  UNICODE_STRING name = {(USHORT)(wcslen(probe_name) * 2), (USHORT)sizeof(probe_name), probe_name};
  OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
  attributes.Length = sizeof(attributes); attributes.ObjectName = &name;
  attributes.Attributes = 0x40; attributes.SecurityDescriptor = security;
  NTSTATUS status = create(&probe_map, 0xf000f, &attributes, NULL, 0);
  fwprintf(stderr, L"private-map path=%ls create=0x%08lx\n", probe_name, (unsigned long)status);
  if (status < 0) return (DWORD)status;
  DWORD observed = map_lifetime(L"after-create", L"directory");
  if (observed) return observed;
  wchar_t drive[3] = {root[0], L':', 0}, device[4096], target[8192];
  if (!QueryDosDeviceW(drive, device, 4096)) return GetLastError();
  int length = swprintf(target, 8192, L"%ls%ls\\null-map-marker", device, root + 2);
  if (length < 0 || length >= 8192) return ERROR_INSUFFICIENT_BUFFER;
  wchar_t leaf_text[] = L"NUL"; UNICODE_STRING leaf = {6, 8, leaf_text};
  UNICODE_STRING destination = {(USHORT)(wcslen(target) * 2), (USHORT)sizeof(target), target};
  attributes.RootDirectory = probe_map; attributes.ObjectName = &leaf;
  status = link(&probe_link, 0xf0001, &attributes, &destination);
  if (status < 0) return (DWORD)status;
  observed = map_lifetime(L"after-create", L"link");
  if (observed) return observed;
  return debug_mode ? 0 : map_apply(process);
}

static DWORD map_close(void) {
  DWORD error = probe_map ? object_counts(L"map-before-link-close", probe_map) : 0;
  DWORD closed = close_owned(L"link", &probe_link); if (closed && !error) error = closed;
  if (!probe_map) return error;
  closed = close_owned(L"map", &probe_map); if (closed && !error) error = closed;
  open_directory_fn open = (open_directory_fn)(void *)nt_api("NtOpenDirectoryObject");
  if (!open) return ERROR_PROC_NOT_FOUND;
  UNICODE_STRING name = {(USHORT)(wcslen(probe_name) * 2), (USHORT)sizeof(probe_name), probe_name};
  OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
  attributes.Length = sizeof(attributes); attributes.ObjectName = &name; attributes.Attributes = 0x40;
  ULONGLONG started = GetTickCount64(), deadline = started + 2000;
  HANDLE remaining = NULL; NTSTATUS status = open(&remaining, 1, &attributes);
  if (remaining) { closed = close_owned(L"map-immediate-observer", &remaining); if (closed && !error) error = closed; }
  /* Preserve the original immediate-absence gate, even if rundown later ends.
   * Close every observer before sleeping so the poll holds no reference. */
  fwprintf(stderr, L"cleanup map-open=0x%08lx absent=%d\n", (unsigned long)status, status == (NTSTATUS)0xc0000034);
  if (status != (NTSTATUS)0xc0000034 && !error) error = ERROR_INVALID_DATA;
  unsigned int attempts = 1;
  while (status >= 0 && !remaining && GetTickCount64() < deadline) {
    Sleep(20); attempts++;
    status = open(&remaining, 1, &attributes);
    /* No repeated count queries: only the immediate observer is sampled. */
    if (remaining) {
      BOOL ok = CloseHandle(remaining);
      if (!ok) { if (!error) error = GetLastError(); break; }
      remaining = NULL;
    }
  }
  fwprintf(stderr, L"cleanup map-eventual-open=0x%08lx absent=%d elapsed-ms=%llu attempts=%u limit-ms=2000\n",
    (unsigned long)status, status == (NTSTATUS)0xc0000034, (unsigned long long)(GetTickCount64() - started), attempts);
  fflush(stderr);
  if (status != (NTSTATUS)0xc0000034 && !error) error = ERROR_INVALID_DATA;
  return error;
}

static BOOL lowbox_verify(HANDLE process, HANDLE job, PSID expected, PSID capability) {
  BOOL in_job = FALSE; DWORD value = 0, used = 0; HANDLE token = NULL;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  if (!IsProcessInJob(process, job, &in_job) || !in_job ||
      !QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits), NULL) ||
      !OpenProcessToken(process, TOKEN_QUERY, &token)) return FALSE;
  DWORD flags = limits.BasicLimitInformation.LimitFlags;
  BOOL confined = (flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) &&
    !(flags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK));
  BYTE sid_buffer[4096], cap_buffer[4096], attrs[8192];
  BOOL ok = GetTokenInformation(token, TokenIsAppContainer, &value, sizeof(value), &used) && value == 1 &&
    GetTokenInformation(token, TokenAppContainerSid, sid_buffer, sizeof(sid_buffer), &used) &&
    EqualSid(((TOKEN_APPCONTAINER_INFORMATION *)sid_buffer)->TokenAppContainer, expected) &&
    GetTokenInformation(token, TokenCapabilities, cap_buffer, sizeof(cap_buffer), &used);
  TOKEN_GROUPS *caps = (TOKEN_GROUPS *)cap_buffer;
  if (ok) ok = caps->GroupCount == 1 && EqualSid(caps->Groups[0].Sid, capability) && (caps->Groups[0].Attributes & SE_GROUP_ENABLED);
  wchar_t attr_text[] = L"WIN://NOALLAPPPKG";
  UNICODE_STRING name = {(USHORT)(wcslen(attr_text) * 2), (USHORT)sizeof(attr_text), attr_text};
  typedef NTSTATUS (NTAPI *query_attributes_fn)(HANDLE, PUNICODE_STRING, ULONG, PVOID, ULONG, PULONG);
  query_attributes_fn query = (query_attributes_fn)(void *)nt_api("NtQuerySecurityAttributesToken");
  NTSTATUS status = query ? query(token, &name, 1, attrs, sizeof(attrs), &used) : (NTSTATUS)0xc0000002;
  ROUTE_ATTRIBUTES *info = (ROUTE_ATTRIBUTES *)attrs;
  BOOL lpac = status >= 0 && info->Version == 1 && info->Count == 1 && info->Attributes &&
    info->Attributes->ValueCount == 1 && (info->Attributes->ValueType == 2 || info->Attributes->ValueType == 6) &&
    info->Attributes->Values.Uint64 && *info->Attributes->Values.Uint64 == 1;
  CloseHandle(token);
  fwprintf(stderr, L"debug-create pid=%lu job=%d nonbreakaway=%d package/capability=%d lpac=%d attribute=0x%08lx\n",
    GetProcessId(process), in_job, confined, ok, lpac, (unsigned long)status);
  fflush(stderr); return ok && lpac && confined;
}

/* Deadline checked for every event too: a stream of events cannot defeat it.
 * Records survive an early error so cleanup drains pending creation/exit events. */
static DWORD debug_loop(DWORD root, HANDLE job, PSID app, PSID capability, DWORD *exit_code, BOOL drain) {
  BOOL stopping = drain; DWORD error = 0;
  if (drain && captured && !active) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
    if (QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL) && !accounting.ActiveProcesses) {
      fwprintf(stderr, L"debug-drain cleanup=1 captured=%d remaining=0 error=0\n", captured);
      return 0;
    }
  }
  ULONGLONG deadline = GetTickCount64() + (drain ? 5000 : 15000);
  uintptr_t local = (uintptr_t)GetModuleHandleW(L"ntdll.dll");
  uintptr_t exported = (uintptr_t)nt_api("DbgBreakPoint"); DWORD image_size = 0;
  /* The basename alone is not identity. Require the same volume/file id as
   * the trusted helper's actual loaded ntdll before using its export offset. */
  BY_HANDLE_FILE_INFORMATION trusted; ZeroMemory(&trusted, sizeof(trusted));
  wchar_t local_path[4096]; DWORD local_length = GetModuleFileNameW((HMODULE)local, local_path, 4096);
  HANDLE local_file = local_length && local_length < 4096 ? CreateFileW(local_path, FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL) : INVALID_HANDLE_VALUE;
  BOOL identified = local_file != INVALID_HANDLE_VALUE && !file_identity(L"trusted-ntdll", GetCurrentProcessId(), local_file, &trusted);
  if (local_file != INVALID_HANDLE_VALUE && !CloseHandle(local_file)) identified = FALSE;
  if (identified && exported && native_metadata(local, exported, &image_size)) identified = FALSE;
  if (!exported || !identified) { stopping = TRUE; error = ERROR_INVALID_DATA; TerminateJobObject(job, 125); }
  for (;;) {
    if (GetTickCount64() >= deadline) {
      if (stopping) { if (!error) error = ERROR_TIMEOUT; break; }
      error = ERROR_TIMEOUT; stopping = TRUE; TerminateJobObject(job, 125); deadline = GetTickCount64() + 5000;
    }
    DEBUG_EVENT event; ZeroMemory(&event, sizeof(event));
    if (!WaitForDebugEvent(&event, 100)) {
      DWORD wait_error = GetLastError();
      if (wait_error != ERROR_SEM_TIMEOUT) { if (!error) error = wait_error; break; }
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
      if (stopping && !active && QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL) && !accounting.ActiveProcesses) break;
      continue;
    }
    DWORD continuation = DBG_CONTINUE; ROUTE_RECORD *record = NULL;
    for (int i = 0; i < captured; i++) if (records[i].pid == event.dwProcessId) record = &records[i];
    switch (event.dwDebugEventCode) {
      case CREATE_PROCESS_DEBUG_EVENT: {
        active++;
        if (record || captured >= 32) error = ERROR_INVALID_DATA;
        else { record = &records[captured++]; record->pid = event.dwProcessId; record->main_tid = event.dwThreadId; }
        HANDLE limited = NULL;
        if (!stopping && !error) {
          if (!DuplicateHandle(GetCurrentProcess(), event.u.CreateProcessInfo.hProcess, GetCurrentProcess(), &limited,
              PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_INFORMATION, FALSE, 0)) error = GetLastError();
          else {
            error = event_image(&event, root);
            if (!error && !lowbox_verify(limited, job, app, capability)) error = ERROR_ACCESS_DENIED;
            fwprintf(stderr, L"debug-event-boundary pid=%lu tid=%lu verified=%d error=%lu\n", event.dwProcessId, event.dwThreadId, !error, error);
            if (!error) error = map_apply(limited);
            DWORD closed = close_owned(L"debug-limited-process", &limited); if (closed && !error) error = closed;
          }
        }
        if (stopping) fwprintf(stderr, L"debug-create-draining pid=%lu tid=%lu start=%p\n", event.dwProcessId, event.dwThreadId, (void *)event.u.CreateProcessInfo.lpStartAddress);
        if (event.u.CreateProcessInfo.hFile && !CloseHandle(event.u.CreateProcessInfo.hFile) && !error) error = GetLastError();
        /* Windows owns event process/thread handles through exit continuation.
         * PROCESS_INFORMATION returned from CreateProcess remains separately ours. */
        break;
      }
      case LOAD_DLL_DEBUG_EVENT: {
        HANDLE file = event.u.LoadDll.hFile;
        if (file) {
          wchar_t path[4096]; DWORD length = GetFinalPathNameByHandleW(file, path, 4096, 0);
          if (length && length < 4096 && record) {
            wchar_t *leaf = wcsrchr(path, L'\\');
            BY_HANDLE_FILE_INFORMATION loaded;
            if (leaf && !_wcsicmp(leaf + 1, L"ntdll.dll")) {
              DWORD identity = file_identity(L"loaded-ntdll", event.dwProcessId, file, &loaded);
              BOOL match = !identity && identified && same_file(&loaded, &trusted);
              fwprintf(stderr, L"debug-native-load pid=%lu tid=%lu base=%p identity=%d error=%lu\n",
                event.dwProcessId, event.dwThreadId, event.u.LoadDll.lpBaseOfDll, match, identity);
              if (!stopping && !match && !error) error = ERROR_INVALID_DATA;
              if (match) {
                record->native_base = (uintptr_t)event.u.LoadDll.lpBaseOfDll;
                record->initial = record->native_base + exported - local;
              }
            }
          }
          if (!CloseHandle(file) && !error) error = GetLastError();
        }
        break;
      }
      case EXCEPTION_DEBUG_EVENT: {
        EXCEPTION_DEBUG_INFO *exception = &event.u.Exception;
        BOOL loader = !stopping && record && !record->consumed && event.dwThreadId == record->main_tid &&
          exception->dwFirstChance && exception->ExceptionRecord.ExceptionCode == EXCEPTION_BREAKPOINT &&
          record->initial && (uintptr_t)exception->ExceptionRecord.ExceptionAddress == record->initial;
        if (loader) record->consumed = TRUE;
        else {
          continuation = DBG_EXCEPTION_NOT_HANDLED;
          if (!stopping && record && !record->consumed && exception->ExceptionRecord.ExceptionCode == EXCEPTION_BREAKPOINT)
            error = ERROR_INVALID_ADDRESS;
        }
        uintptr_t address = (uintptr_t)exception->ExceptionRecord.ExceptionAddress;
        BOOL in_native = record && record->native_base && address >= record->native_base && address - record->native_base < image_size;
        fwprintf(stderr, L"debug-exception pid=%lu code=0x%08lx first=%lu address=%p expected=%p consumed=%d tid=%lu main-tid=%lu native-identity=%d in-native=%d native-rva=0x%llx continuation=0x%08lx\n",
          event.dwProcessId, exception->ExceptionRecord.ExceptionCode, exception->dwFirstChance,
          exception->ExceptionRecord.ExceptionAddress, (void *)(record ? record->initial : 0), loader,
          event.dwThreadId, record ? record->main_tid : 0, record && record->native_base != 0, in_native,
          (unsigned long long)(in_native ? address - record->native_base : 0), continuation);
        break;
      }
      case EXIT_PROCESS_DEBUG_EVENT:
        if (!record || record->exited) error = ERROR_INVALID_DATA;
        else { record->exited = TRUE; active--; }
        fwprintf(stderr, L"debug-exit pid=%lu status=%lu active=%d tid=%lu main-tid=%lu\n", event.dwProcessId, event.u.ExitProcess.dwExitCode, active,
          event.dwThreadId, record ? record->main_tid : 0);
        if (event.dwProcessId == root && !stopping) {
          *exit_code = event.u.ExitProcess.dwExitCode; stopping = TRUE;
          deadline = GetTickCount64() + 5000; TerminateJobObject(job, 125);
        }
        break;
      case CREATE_THREAD_DEBUG_EVENT:
        fwprintf(stderr, L"debug-thread-create pid=%lu tid=%lu main-tid=%lu start=%p handle-tid=%lu thread-owner=%lu\n",
          event.dwProcessId, event.dwThreadId, record ? record->main_tid : 0, (void *)event.u.CreateThread.lpStartAddress,
          GetThreadId(event.u.CreateThread.hThread), GetProcessIdOfThread(event.u.CreateThread.hThread));
        if (!stopping && (!record || GetThreadId(event.u.CreateThread.hThread) != event.dwThreadId ||
            GetProcessIdOfThread(event.u.CreateThread.hThread) != event.dwProcessId)) error = ERROR_INVALID_DATA;
        break;
      case EXIT_THREAD_DEBUG_EVENT:
        fwprintf(stderr, L"debug-thread-exit pid=%lu tid=%lu main-tid=%lu status=%lu\n",
          event.dwProcessId, event.dwThreadId, record ? record->main_tid : 0, event.u.ExitThread.dwExitCode);
        break;
      case OUTPUT_DEBUG_STRING_EVENT: break;
      default: error = ERROR_INVALID_DATA; break;
    }
    if (error && !stopping) { stopping = TRUE; deadline = GetTickCount64() + 5000; TerminateJobObject(job, 125); }
    if (!ContinueDebugEvent(event.dwProcessId, event.dwThreadId, continuation)) { if (!error) error = GetLastError(); break; }
    fflush(stderr);
    if (stopping && !active && captured) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
      if (QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL) && !accounting.ActiveProcesses) break;
    }
  }
  fwprintf(stderr, L"debug-drain cleanup=%d captured=%d remaining=%d error=%lu\n", drain, captured, active, error);
  fflush(stderr); return error;
}
