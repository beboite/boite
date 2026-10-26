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
typedef struct {
  DWORD pid, main_tid, parent; uintptr_t initial, native_base;
  BOOL consumed, exited, auxiliary, child_seen, console_seen;
} ROUTE_RECORD;
static BOOL retirement_enabled(void);
static DWORD retirement_inspector_final(int result);
static HANDLE probe_map, probe_link;
static wchar_t probe_name[256];
static DWORD probe_root_pid;
static BOOL debug_mode;
/* QUIET differs from DIRECT only in these optional ownership observations. */
static BOOL observe_owned_handles = TRUE;
/* REOPEN matches DIRECT after replacing creation handles with verified opens. */
static BOOL reopen_owned_map;
static BOOL external_map_creator;
/* RETIRE changes only a signaled, owned root after its job reaches zero. */
static BOOL retire_owned_map;
/* Separate control: name the empty replacement to expose relocated retention. */
static BOOL retire_named_map, retired_created;
static wchar_t retired_name[280];
static BOOL directory_twin_mode;
static int anchor_overlap_mode; /* 1 exclusive handoff, 2 helper anchor overlaps Set. */
static DWORD directory_twin_absence(const wchar_t *phase);
static DWORD creator_prepare(PSECURITY_DESCRIPTOR security, const wchar_t *target, const wchar_t *root);
static unsigned int object_count_queries, handle_snapshot_queries;
/* 0 retains the original RED roundtrip, 1 omits it as a control, 2 also moves
 * assignment into a trusted child that exits before the target resumes. */
static int assignment_scope;
static DWORD setter_assign(HANDLE process, HANDLE directory);
static ROUTE_RECORD records[32];
static int captured, active;
static int target_captured, auxiliary_captured;
static BOOL root_exited;

static FARPROC nt_api(const char *name) { return GetProcAddress(GetModuleHandleW(L"ntdll.dll"), name); }

/* Read-only snapshots through our live handle. Counts alone do not identify
 * which kernel component owns a remaining reference. */
static DWORD object_counts(const wchar_t *label, HANDLE object) {
  if (!observe_owned_handles) return 0;
  struct { ULONG attributes, granted, handles, pointers; ULONG reserved[10]; } info;
  ZeroMemory(&info, sizeof(info)); ULONG used = 0;
  query_object_fn query = (query_object_fn)(void *)nt_api("NtQueryObject");
  object_count_queries++;
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
  NTSTATUS status = assignment_scope == 2 ? (NTSTATUS)setter_assign(process, probe_map)
    : set(process, (PROCESSINFOCLASS)23, &probe_map, sizeof(probe_map));
  fwprintf(stderr, L"private-map pid=%lu set=0x%08lx\n", GetProcessId(process), (unsigned long)status);
  fflush(stderr);
  observed = map_lifetime(L"after-assign", L"process");
  return status != 0 ? (DWORD)status : observed;
}

/* Keep DIRECT's original routing and exit. After all execution has stopped,
 * replace only that captured root's map with an empty, unnamed directory.
 * This never restores an inferred ambient map or resumes any process. The
 * unnamed map may still have kernel references: this is not rundown proof. */
static DWORD map_retire(HANDLE process, HANDLE job, PSECURITY_DESCRIPTOR security) {
  if (!retire_owned_map || !probe_map) return 0;
  typedef NTSTATUS (NTAPI *create_directory_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, HANDLE, ULONG);
  typedef NTSTATUS (NTAPI *set_process_fn)(HANDLE, PROCESSINFOCLASS, PVOID, ULONG);
  create_directory_fn create = (create_directory_fn)(void *)nt_api("NtCreateDirectoryObjectEx");
  set_process_fn set = (set_process_fn)(void *)nt_api("NtSetInformationProcess");
  query_object_fn query = (query_object_fn)(void *)nt_api("NtQueryObject");
  if (!create || !set || !query) return ERROR_PROC_NOT_FOUND;
  DWORD pid = GetProcessId(process), before = STILL_ACTIVE, after = STILL_ACTIVE;
  DWORD waited = WaitForSingleObject(process, 0), error = 0;
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting; ZeroMemory(&accounting, sizeof(accounting));
  if (!pid || pid != probe_root_pid) return ERROR_INVALID_DATA;
  if (waited != WAIT_OBJECT_0) return waited == WAIT_TIMEOUT ? ERROR_BUSY : GetLastError();
  if (!GetExitCodeProcess(process, &before)) return GetLastError();
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL))
    return GetLastError();
  if (accounting.ActiveProcesses || before == STILL_ACTIVE) return ERROR_BUSY;
  fwprintf(stderr, L"map-retire ready pid=%lu signaled=1 job-active=0 exit=%lu\n", pid, before); fflush(stderr);
  HANDLE empty = NULL;
  OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
  attributes.Length = sizeof(attributes); attributes.SecurityDescriptor = security;
  UNICODE_STRING named; ZeroMemory(&named, sizeof(named));
  if (retire_named_map) {
    if (wcslen(probe_name) + 9 > sizeof(retired_name) / sizeof(*retired_name)) return ERROR_INSUFFICIENT_BUFFER;
    memcpy(retired_name, probe_name, (wcslen(probe_name) + 1) * sizeof(wchar_t));
    memcpy(retired_name + wcslen(probe_name), L".retired", sizeof(L".retired"));
    named.Buffer = retired_name; named.Length = (USHORT)(wcslen(retired_name) * sizeof(wchar_t));
    named.MaximumLength = (USHORT)sizeof(retired_name); attributes.ObjectName = &named;
    attributes.Attributes = 0x40;
  }
  NTSTATUS status = create(&empty, 0xf000f, &attributes, NULL, 0);
  fwprintf(stderr, L"map-retire create=0x%08lx\n", (unsigned long)status); fflush(stderr);
  if (retire_named_map) {
    fwprintf(stderr, L"map-retire named path=%ls create=0x%08lx\n", retired_name, (unsigned long)status); fflush(stderr);
  }
  if (status != 0) return (DWORD)status;
  if (retire_named_map) retired_created = TRUE;
  BYTE buffer[8192]; ULONG used = 0; DWORD flags = 0;
  status = query(empty, (OBJECT_INFORMATION_CLASS)1, buffer, sizeof(buffer), &used);
  if (status != 0) { error = (DWORD)status; goto end; }
  if (used < sizeof(UNICODE_STRING) || used > sizeof(buffer)) { error = ERROR_INVALID_NAME; goto end; }
  UNICODE_STRING *returned_name = (UNICODE_STRING *)buffer;
  uintptr_t first = (uintptr_t)buffer, end = first + used, text = (uintptr_t)returned_name->Buffer;
  BOOL valid_name = retire_named_map
    ? returned_name->Length == named.Length && text >= first + sizeof(UNICODE_STRING) &&
      text <= end && returned_name->Length <= end - text && !memcmp(returned_name->Buffer, named.Buffer, named.Length)
    : returned_name->Length == 0;
  if (!valid_name) {
    error = ERROR_INVALID_NAME; goto end;
  }
  if (!GetHandleInformation(empty, &flags)) { error = GetLastError(); goto end; }
  if (flags) { error = ERROR_INVALID_DATA; goto end; }
  fputws(retire_named_map ? L"map-retire named=1 inherited=0 links=0\n"
    : L"map-retire unnamed=1 inherited=0 links=0\n", stderr); fflush(stderr);
  error = map_lifetime(L"before-retire", L"exited-root");
  if (error) goto end;
  status = set(process, (PROCESSINFOCLASS)23, &empty, sizeof(empty));
  fwprintf(stderr, L"map-retire pid=%lu set=0x%08lx\n", pid, (unsigned long)status); fflush(stderr);
  if (status != 0) { error = (DWORD)status; goto end; }
  error = map_lifetime(L"after-retire", L"exited-root");
  if (error) goto end;
  waited = WaitForSingleObject(process, 0);
  if (waited != WAIT_OBJECT_0) { error = waited == WAIT_TIMEOUT ? ERROR_BUSY : GetLastError(); goto end; }
  if (!GetExitCodeProcess(process, &after)) { error = GetLastError(); goto end; }
  if (after != before) { error = ERROR_INVALID_DATA; goto end; }
  fwprintf(stderr, L"map-retire preserved pid=%lu signaled=1 exit=%lu unchanged=1\n", pid, after); fflush(stderr);
end:
  { DWORD closed = close_owned(retire_named_map ? L"retire-named-map" : L"retire-unnamed-map", &empty); if (closed && !error) error = closed; }
  fwprintf(stderr, L"map-retire result=%lu\n", error); fflush(stderr);
  return error;
}

/* Observe only our exact replacement name after closing its known handle.
 * Existence is a fatal gate, even when the original working map disappeared. */
static DWORD retired_absence(const wchar_t *phase) {
  DWORD twin_error = directory_twin_absence(phase);
  if (!retire_named_map || !retired_created) return twin_error;
  open_directory_fn open = (open_directory_fn)(void *)nt_api("NtOpenDirectoryObject");
  if (!open) return ERROR_PROC_NOT_FOUND;
  UNICODE_STRING name = {(USHORT)(wcslen(retired_name) * 2), (USHORT)sizeof(retired_name), retired_name};
  OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
  attributes.Length = sizeof(attributes); attributes.ObjectName = &name; attributes.Attributes = 0x40;
  HANDLE remaining = NULL; NTSTATUS status = open(&remaining, 1, &attributes);
  BOOL closed = !remaining || CloseHandle(remaining); DWORD error = closed ? 0 : GetLastError();
  fwprintf(stderr, L"cleanup retired-open phase=%ls status=0x%08lx absent=%d closed=%d error=%lu path=%ls\n",
    phase, (unsigned long)status, status == (NTSTATUS)0xc0000034, closed, error, retired_name); fflush(stderr);
  return error ? error : status == (NTSTATUS)0xc0000034 ? twin_error : ERROR_INVALID_DATA;
}

#include "roundtrip.h"

/* Open the exact live objects before releasing either creation anchor. This
 * tests handle acquisition without changing the creating/assigning process. */
static DWORD map_reopen(const wchar_t *target) {
  typedef NTSTATUS (NTAPI *open_link_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES);
  typedef NTSTATUS (NTAPI *query_link_fn)(HANDLE, PUNICODE_STRING, PULONG);
  typedef NTSTATUS (NTAPI *compare_fn)(HANDLE, HANDLE);
  open_directory_fn open = (open_directory_fn)(void *)nt_api("NtOpenDirectoryObject");
  open_link_fn open_link = (open_link_fn)(void *)nt_api("NtOpenSymbolicLinkObject");
  query_link_fn query_link = (query_link_fn)(void *)nt_api("NtQuerySymbolicLinkObject");
  query_object_fn query = (query_object_fn)(void *)nt_api("NtQueryObject");
  compare_fn compare = (compare_fn)(void *)nt_api("NtCompareObjects");
  if (!open || !open_link || !query_link || !query || !compare) return ERROR_PROC_NOT_FOUND;
  HANDLE reopened[2] = {NULL, NULL}; DWORD error = 0;
  UNICODE_STRING name = {(USHORT)(wcslen(probe_name) * 2), (USHORT)sizeof(probe_name), probe_name};
  OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
  attributes.Length = sizeof(attributes); attributes.ObjectName = &name; attributes.Attributes = 0x40;
  NTSTATUS status = open(&reopened[0], 0xf000f, &attributes);
  if (status != 0) {error = (DWORD)status; goto end;}
  wchar_t leaf_text[] = L"NUL"; UNICODE_STRING leaf = {6, 8, leaf_text};
  attributes.RootDirectory = reopened[0]; attributes.ObjectName = &leaf;
  status = open_link(&reopened[1], 0xf0001, &attributes);
  if (status != 0) {error = (DWORD)status; goto end;}
  wchar_t link_name[512];
  int length = swprintf(link_name, 512, L"%ls\\NUL", probe_name);
  if (length < 0 || length >= 512) {error = ERROR_INSUFFICIENT_BUFFER; goto end;}
  for (int i = 0; i < 2; i++) {
    wchar_t actual[512]; DWORD flags = 0; ULONG used = 0;
    struct { ULONG attributes, granted, handles, pointers; ULONG reserved[10]; } info;
    ZeroMemory(&info, sizeof(info));
    status = compare(i ? probe_link : probe_map, reopened[i]);
    if (status != 0) {error = (DWORD)status; goto end;}
    error = object_name(reopened[i], actual, 512);
    if (error) goto end;
    if (wcscmp(actual, i ? link_name : probe_name)) {error = ERROR_INVALID_NAME; goto end;}
    if (!GetHandleInformation(reopened[i], &flags)) {error = GetLastError(); goto end;}
    object_count_queries++;
    status = query(reopened[i], (OBJECT_INFORMATION_CLASS)0, &info, sizeof(info), &used);
    if (status != 0) {error = (DWORD)status; goto end;}
    if (flags || info.attributes || info.granted != (i ? 0xf0001UL : 0xf000fUL)) {
      error = ERROR_INVALID_DATA; goto end;
    }
    fwprintf(stderr, L"map-reopen object=%ls same=1 name=1 granted=0x%08lx attributes=0x%08lx flags=%lu\n",
      i ? L"link" : L"directory", info.granted, info.attributes, flags); fflush(stderr);
  }
  wchar_t destination[8192];
  UNICODE_STRING value = {0, (USHORT)sizeof(destination), destination}; ULONG used = 0;
  status = query_link(reopened[1], &value, &used);
  if (status != 0) {error = (DWORD)status; goto end;}
  if (value.Length != wcslen(target) * sizeof(wchar_t) || value.Length > sizeof(destination) ||
      used > sizeof(destination) || memcmp(destination, target, value.Length)) {
    error = ERROR_INVALID_DATA; goto end;
  }
  fputws(L"map-reopen link-target=1\n", stderr); fflush(stderr);
  error = map_lifetime(L"after-reopen", L"before-handoff");
  if (error) goto end;
  error = close_owned(L"creation-link", &probe_link);
  if (error) goto end;
  error = close_owned(L"creation-map", &probe_map);
  if (error) goto end;
  probe_map = reopened[0]; probe_link = reopened[1];
  reopened[0] = NULL; reopened[1] = NULL;
  fputws(L"map-reopen handoff=1 originals-closed=2\n", stderr); fflush(stderr);
  error = map_lifetime(L"after-reopen", L"handoff");
end:
  for (int i = 1; i >= 0; i--) {
    DWORD closed = close_owned(i ? L"unadopted-reopen-link" : L"unadopted-reopen-map", &reopened[i]);
    if (closed && !error) error = closed;
  }
  fwprintf(stderr, L"map-reopen result=%lu\n", error); fflush(stderr);
  return error;
}

static DWORD map_prepare(HANDLE process, PSECURITY_DESCRIPTOR security, const wchar_t *root, const wchar_t *image) {
  typedef NTSTATUS (NTAPI *create_directory_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, HANDLE, ULONG);
  typedef NTSTATUS (NTAPI *create_link_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PUNICODE_STRING);
  create_directory_fn create = (create_directory_fn)(void *)nt_api("NtCreateDirectoryObjectEx");
  create_link_fn link = (create_link_fn)(void *)nt_api("NtCreateSymbolicLinkObject");
  if (!create || !link) return ERROR_PROC_NOT_FOUND;
  probe_root_pid = GetProcessId(process);
  if (debug_mode) { DWORD error = prepare_target(image); if (error) return error; }
  DWORD session = 0;
  if (!ProcessIdToSessionId(GetCurrentProcessId(), &session)) return GetLastError();
  if (session) swprintf(probe_name, 256, L"\\Sessions\\%lu\\BaseNamedObjects\\boite.route.%lu", session, GetCurrentProcessId());
  else swprintf(probe_name, 256, L"\\BaseNamedObjects\\boite.route.%lu", GetCurrentProcessId());
  UNICODE_STRING name = {(USHORT)(wcslen(probe_name) * 2), (USHORT)sizeof(probe_name), probe_name};
  OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
  attributes.Length = sizeof(attributes); attributes.ObjectName = &name;
  attributes.Attributes = 0x40; attributes.SecurityDescriptor = security;
  if (external_map_creator) {
    wchar_t drive[3] = {root[0], L':', 0}, device[4096], target[8192];
    if (!QueryDosDeviceW(drive, device, 4096)) return GetLastError();
    int length = swprintf(target, 8192, L"%ls%ls\\null-map-marker", device, root + 2);
    if (length < 0 || length >= 8192) return ERROR_INSUFFICIENT_BUFFER;
    DWORD error = creator_prepare(security, target, root);
    return error ? error : map_apply(process);
  }
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
  if (reopen_owned_map) { DWORD error = map_reopen(target); if (error) return error; }
  if (debug_mode) return 0;
  DWORD error = map_apply(process);
  return error ? error : assignment_scope ? 0 : map_roundtrip(process, security);
}

static ULONGLONG ownership_wall_ms(void) {
  FILETIME time; ULARGE_INTEGER value; GetSystemTimeAsFileTime(&time);
  value.LowPart = time.dwLowDateTime; value.HighPart = time.dwHighDateTime;
  return (value.QuadPart - 116444736000000000ULL) / 10000ULL;
}

/* Observe only after preserving both original absence results. No flush,
 * reassignment, borrowed-handle closure or new process access occurs here. */
static DWORD map_checkpoint(open_directory_fn open, POBJECT_ATTRIBUTES attributes) {
  wchar_t enabled[2];
  if (GetEnvironmentVariableW(L"BOITE_DEBUG_MAP_OWNERSHIP", enabled, 2) != 1 || enabled[0] != L'1') return 0;
  fwprintf(stderr, L"ownership-checkpoint helper=%lu wall-ms=%llu targets=", GetCurrentProcessId(), ownership_wall_ms());
  if (!debug_mode) fwprintf(stderr, L"%lu", probe_root_pid);
  else {
    unsigned int emitted = 0;
    for (int i = 0; i < captured; i++) if (!records[i].auxiliary && records[i].consumed)
      fwprintf(stderr, L"%ls%lu", emitted++ ? L"," : L"", records[i].pid);
  }
  fputws(L" hold-ms=3000\n", stderr); fflush(stderr);
  Sleep(3000); /* At most 5 seconds; original fatal cleanup status remains set. */
  HANDLE observer = NULL; NTSTATUS status = open(&observer, 1, attributes);
  DWORD error = 0; BOOL closed = TRUE;
  if (observer) {closed = CloseHandle(observer); if (!closed) error = GetLastError();}
  fwprintf(stderr, L"cleanup checkpoint-map-open=0x%08lx absent=%d closed=%d error=%lu wall-ms=%llu path=%ls\n",
    (unsigned long)status, status == (NTSTATUS)0xc0000034, closed, error, ownership_wall_ms(), probe_name); fflush(stderr);
  return error ? error : status < 0 && status != (NTSTATUS)0xc0000034 ? (DWORD)status : 0;
}

static DWORD map_close(void) {
  DWORD error = probe_map ? object_counts(L"map-before-link-close", probe_map) : 0;
  DWORD swap_closed = close_owned(L"swap-map", &swap_map); if (swap_closed && !error) error = swap_closed;
  DWORD swap_final = swap_absence(L"final");
  if (!error) error = swap_cleanup_error ? swap_cleanup_error : swap_final;
  DWORD closed = close_owned(L"link", &probe_link); if (closed && !error) error = closed;
  if (!probe_map) return error;
  closed = close_owned(L"map", &probe_map); if (closed && !error) error = closed;
  DWORD retired = retired_absence(L"immediate"); if (retired && !error) error = retired;
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
  DWORD checkpoint = map_checkpoint(open, &attributes); if (checkpoint && !error) error = checkpoint;
  retired = retired_absence(L"checkpoint"); if (retired && !error) error = retired;
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
  BOOL token_closed = CloseHandle(token); DWORD close_error = token_closed ? 0 : GetLastError();
  fwprintf(stderr, L"token-cleanup role=boundary pid=%lu success=%d error=%lu\n", GetProcessId(process), token_closed, close_error);
  fwprintf(stderr, L"debug-create pid=%lu job=%d nonbreakaway=%d package/capability=%d lpac=%d attribute=0x%08lx\n",
    GetProcessId(process), in_job, confined, ok, lpac, (unsigned long)status);
  fflush(stderr); return ok && lpac && confined && token_closed;
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
  uintptr_t exported = (uintptr_t)nt_api("DbgBreakPoint"); DWORD image_size = 0, loader_rva = 0;
  /* The basename alone is not identity. Require the same volume/file id as
   * the trusted helper's actual loaded ntdll before using the pinned site. */
  BY_HANDLE_FILE_INFORMATION trusted; ZeroMemory(&trusted, sizeof(trusted));
  wchar_t local_path[4096]; DWORD local_length = GetModuleFileNameW((HMODULE)local, local_path, 4096);
  HANDLE local_file = local_length && local_length < 4096 ? CreateFileW(local_path, FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL) : INVALID_HANDLE_VALUE;
  BOOL identified = local_file != INVALID_HANDLE_VALUE && !file_identity(L"trusted-ntdll", GetCurrentProcessId(), local_file, &trusted);
  if (local_file != INVALID_HANDLE_VALUE && !CloseHandle(local_file)) identified = FALSE;
  if (identified && exported && native_metadata(local, exported, &image_size, &loader_rva)) identified = FALSE;
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
      if ((stopping || root_exited) && !active && QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL) && !accounting.ActiveProcesses) break;
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
            error = event_image(&event, root, &record->auxiliary, &record->parent);
            BOOL boundary = !error && lowbox_verify(limited, job, app, capability);
            if (!error && !boundary) error = ERROR_ACCESS_DENIED;
            if (!error) {
              ROUTE_RECORD *parent = NULL;
              for (int i = 0; i < captured; i++) if (records[i].pid == record->parent) parent = &records[i];
              if (event.dwProcessId == root) {
                if (record->auxiliary || record->parent != GetCurrentProcessId()) error = ERROR_INVALID_DATA;
              } else if (!parent || parent == record || parent->exited || parent->auxiliary) error = ERROR_INVALID_DATA;
              if (!error && record->auxiliary) {
                if (parent->console_seen || auxiliary_captured >= 3) error = ERROR_INVALID_DATA;
                else { parent->console_seen = TRUE; auxiliary_captured++; }
              } else if (!error) {
                if (target_captured >= 3 || (parent && parent->child_seen)) error = ERROR_INVALID_DATA;
                else { if (parent) parent->child_seen = TRUE; target_captured++; }
              }
              fwprintf(stderr, L"debug-role pid=%lu target-count=%d auxiliary-count=%d error=%lu parent=%lu\n",
                event.dwProcessId, target_captured, auxiliary_captured, error, record->parent);
            }
            fwprintf(stderr, L"debug-event-boundary pid=%lu tid=%lu verified=%d error=%lu\n", event.dwProcessId, event.dwThreadId, boundary, error);
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
                record->initial = record->native_base + loader_rva;
              }
            }
          }
          if (!CloseHandle(file) && !error) error = GetLastError();
        }
        break;
      }
      case UNLOAD_DLL_DEBUG_EVENT: {
        BOOL native = record && record->native_base &&
          (uintptr_t)event.u.UnloadDll.lpBaseOfDll == record->native_base;
        fwprintf(stderr, L"debug-unload pid=%lu tid=%lu base=%p trusted-native=%d\n",
          event.dwProcessId, event.dwThreadId, event.u.UnloadDll.lpBaseOfDll, native);
        if (!stopping && (!record || record->exited || native)) error = ERROR_INVALID_DATA;
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
        fwprintf(stderr, L"debug-exception pid=%lu code=0x%08lx first=%lu address=%p expected=%p consumed=%d tid=%lu main-tid=%lu native-identity=%d in-native=%d native-rva=0x%llx continuation=0x%08lx parameters=%lu payload=0x%llx owner=%llu\n",
          event.dwProcessId, exception->ExceptionRecord.ExceptionCode, exception->dwFirstChance,
          exception->ExceptionRecord.ExceptionAddress, (void *)(record ? record->initial : 0), loader,
          event.dwThreadId, record ? record->main_tid : 0, record && record->native_base != 0, in_native,
          (unsigned long long)(in_native ? address - record->native_base : 0), continuation,
          exception->ExceptionRecord.NumberParameters,
          (unsigned long long)(exception->ExceptionRecord.NumberParameters >= 1 ? exception->ExceptionRecord.ExceptionInformation[0] : 0),
          (unsigned long long)(exception->ExceptionRecord.NumberParameters >= 2 ? exception->ExceptionRecord.ExceptionInformation[1] : 0));
        break;
      }
      case EXIT_PROCESS_DEBUG_EVENT:
        if (!record || record->exited) error = ERROR_INVALID_DATA;
        else { record->exited = TRUE; active--; }
        fwprintf(stderr, L"debug-exit pid=%lu status=%lu active=%d tid=%lu main-tid=%lu\n", event.dwProcessId, event.u.ExitProcess.dwExitCode, active,
          event.dwThreadId, record ? record->main_tid : 0);
        if (event.dwProcessId == root && !stopping) {
          *exit_code = event.u.ExitProcess.dwExitCode; root_exited = TRUE;
          deadline = GetTickCount64() + 5000;
          /* A known console helper can outlive its last client until this exit
           * event is continued. Give it the same bounded orderly drain; a
           * timeout still terminates the job and remains a fatal error. */
          if (*exit_code) { stopping = TRUE; TerminateJobObject(job, 125); }
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
      case RIP_EVENT:
        fwprintf(stderr, L"debug-rip pid=%lu tid=%lu native-error=%lu type=%lu\n",
          event.dwProcessId, event.dwThreadId, event.u.RipInfo.dwError, event.u.RipInfo.dwType);
        error = ERROR_INVALID_DATA;
        break;
      default: error = ERROR_INVALID_DATA; break;
    }
    if (error && !stopping) {
      fwprintf(stderr, L"debug-event-failure pid=%lu tid=%lu kind=%lu error=%lu\n",
        event.dwProcessId, event.dwThreadId, event.dwDebugEventCode, error);
      stopping = TRUE; deadline = GetTickCount64() + 5000; TerminateJobObject(job, 125);
    }
    if (!ContinueDebugEvent(event.dwProcessId, event.dwThreadId, continuation)) { if (!error) error = GetLastError(); break; }
    fflush(stderr);
    if ((stopping || root_exited) && !active && captured) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
      if (QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL) && !accounting.ActiveProcesses) break;
    }
  }
  fwprintf(stderr, L"debug-drain cleanup=%d captured=%d remaining=%d error=%lu\n", drain, captured, active, error);
  fflush(stderr); return error;
}
