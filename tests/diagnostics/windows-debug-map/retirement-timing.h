/* Diagnostic only. The cooperative final barrier, not SuspendThread, orders
 * completed inspector work. All I/O below is synchronous and closed at READY. */
typedef struct {
  DWORD magic, version, helper, root, tid, thread_owner, result;
  ULONGLONG helper_created, created, thread_created, started, deadline, ready;
  wchar_t nonce[33];
} RT_FRAME;
static RT_FRAME rt_frame;
static ULONGLONG rt_tick_deadline;
static wchar_t rt_project[4096];
static BOOL retirement_live_done, rt_finished;
static int retirement_timing_mode;

static ULONGLONG rt_created(HANDLE object, BOOL thread) {
  FILETIME created, exited, kernel, user; ULARGE_INTEGER value;
  BOOL ok = thread ? GetThreadTimes(object, &created, &exited, &kernel, &user)
    : GetProcessTimes(object, &created, &exited, &kernel, &user);
  if (!ok) return 0;
  value.LowPart = created.dwLowDateTime; value.HighPart = created.dwHighDateTime;
  return value.QuadPart;
}
static BOOL retirement_enabled(void) {
  wchar_t nonce[34];
  return GetEnvironmentVariableW(L"BOITE_DIAGNOSTIC_RETIRE_NONCE", nonce, 34) != 0;
}
static DWORD rt_nonce(wchar_t *nonce) {
  if (GetEnvironmentVariableW(L"BOITE_DIAGNOSTIC_RETIRE_NONCE", nonce, 34) != 32) return ERROR_INVALID_DATA;
  for (int i = 0; i < 32; i++) if (!((nonce[i] >= L'a' && nonce[i] <= L'f') || (nonce[i] >= L'0' && nonce[i] <= L'9')))
    return ERROR_INVALID_DATA;
  return 0;
}
static DWORD rt_file(const wchar_t *project, const wchar_t *leaf, RT_FRAME *frame, BOOL write) {
  wchar_t path[8192];
  int n = project ? swprintf(path, 8192, L"%ls\\%ls", project, leaf) : swprintf(path, 8192, L"%ls", leaf);
  if (n < 0 || n >= 8192) return ERROR_INSUFFICIENT_BUFFER;
  HANDLE file = CreateFileW(path, write ? GENERIC_WRITE : GENERIC_READ, write ? 0 : FILE_SHARE_READ, NULL,
    write ? CREATE_NEW : OPEN_EXISTING, 0, NULL);
  if (file == INVALID_HANDLE_VALUE) return GetLastError();
  DWORD count = 0, error = 0; LARGE_INTEGER size;
  BOOL ok = write ? WriteFile(file, frame, sizeof(*frame), &count, NULL) : ReadFile(file, frame, sizeof(*frame), &count, NULL);
  if (!ok) {error = GetLastError(); if (!error) error = ERROR_READ_FAULT;}
  else if (count != sizeof(*frame)) error = ERROR_INVALID_DATA;
  if (!error && !write && (!GetFileSizeEx(file, &size) || size.QuadPart != sizeof(*frame))) error = ERROR_INVALID_DATA;
  BOOL closed = CloseHandle(file); DWORD close_error = closed ? 0 : GetLastError();
  if (!closed && !close_error) close_error = ERROR_INVALID_HANDLE;
  return error ? error : close_error;
}
static void rt_log(const wchar_t *phase, DWORD previous, DWORD closed) {
  fwprintf(stderr, L"retirement-timing phase=%ls mode=%ls nonce=%ls helper=%lu helper-created=%llu root=%lu created=%llu tid=%lu thread-owner=%lu thread-created=%llu result=%lu started=%llu deadline=%llu now=%llu previous=%lu closed=%lu error=0\n",
    phase, retirement_timing_mode == 1 ? L"live" : L"exited", rt_frame.nonce, rt_frame.helper, rt_frame.helper_created,
    rt_frame.root, rt_frame.created, rt_frame.tid, rt_frame.thread_owner, rt_frame.thread_created, rt_frame.result,
    rt_frame.started, rt_frame.deadline, ownership_wall_ms(), previous, closed);
  fflush(stderr);
}
static BOOL rt_in_time(void) {
  return GetTickCount64() < rt_tick_deadline && ownership_wall_ms() < rt_frame.deadline;
}
static DWORD rt_identity(PROCESS_INFORMATION *root, BOOL live) {
  DWORD code = STILL_ACTIVE;
  if (GetProcessId(root->hProcess) != rt_frame.root || GetThreadId(root->hThread) != rt_frame.tid ||
      GetProcessIdOfThread(root->hThread) != rt_frame.thread_owner || rt_frame.thread_owner != rt_frame.root || rt_created(root->hProcess, FALSE) != rt_frame.created ||
      rt_created(root->hThread, TRUE) != rt_frame.thread_created) return ERROR_INVALID_DATA;
  DWORD wait = WaitForSingleObject(root->hProcess, 0);
  if (wait != (live ? WAIT_TIMEOUT : WAIT_OBJECT_0) || !GetExitCodeProcess(root->hProcess, &code) ||
      code != (live ? STILL_ACTIVE : rt_frame.result)) return ERROR_INVALID_DATA;
  return rt_in_time() ? 0 : ERROR_TIMEOUT;
}
static DWORD retirement_start(PROCESS_INFORMATION *root, const wchar_t *project) {
  if (!retirement_timing_mode) return 0;
  wchar_t nonce[34]; DWORD error = rt_nonce(nonce);
  if (error || wcslen(project) >= 4096) return error ? error : ERROR_INSUFFICIENT_BUFFER;
  memcpy(rt_project, project, (wcslen(project) + 1) * sizeof(wchar_t));
  ZeroMemory(&rt_frame, sizeof(rt_frame)); rt_frame.magic = 0x5254544d; rt_frame.version = 1;
  rt_frame.helper = GetCurrentProcessId(); rt_frame.helper_created = rt_created(GetCurrentProcess(), FALSE);
  rt_frame.root = root->dwProcessId; rt_frame.tid = root->dwThreadId; rt_frame.thread_owner = GetProcessIdOfThread(root->hThread); rt_frame.result = 1;
  rt_frame.created = rt_created(root->hProcess, FALSE); rt_frame.thread_created = rt_created(root->hThread, TRUE);
  memcpy(rt_frame.nonce, nonce, 33 * sizeof(wchar_t));
  rt_frame.started = ownership_wall_ms(); rt_frame.deadline = rt_frame.started + 15000;
  rt_tick_deadline = GetTickCount64() + 15000;
  if (!rt_frame.helper_created || !rt_frame.created || !rt_frame.thread_created) return ERROR_INVALID_DATA;
  error = rt_identity(root, TRUE); if (error) return error;
  error = rt_file(rt_project, L"retirement.start", &rt_frame, TRUE);
  if (!error) rt_log(L"start", 0, 0);
  return error;
}
static DWORD retirement_inspector_final(int result) {
  if (!retirement_enabled()) return 0;
  RT_FRAME frame; ZeroMemory(&frame, sizeof(frame)); wchar_t nonce[34];
  DWORD error = rt_nonce(nonce); if (error) return error;
  error = rt_file(NULL, L"retirement.start", &frame, FALSE); if (error) return error;
  if (frame.magic != 0x5254544d || frame.version != 1 || frame.nonce[32] || memcmp(frame.nonce, nonce, 33 * sizeof(wchar_t)) ||
      frame.root != GetCurrentProcessId() || frame.thread_owner != frame.root || frame.tid != GetCurrentThreadId() || frame.helper == frame.root ||
      frame.created != rt_created(GetCurrentProcess(), FALSE) || frame.thread_created != rt_created(GetCurrentThread(), TRUE) ||
      frame.result != (DWORD)result || result != 1 || frame.ready || frame.deadline != frame.started + 15000 ||
      ownership_wall_ms() >= frame.deadline) return ERROR_INVALID_DATA;
  ULONGLONG now = ownership_wall_ms();
  if (now >= frame.deadline) return ERROR_TIMEOUT;
  ULONGLONG deadline = GetTickCount64() + (frame.deadline - now);
  frame.ready = ownership_wall_ms();
  error = rt_file(NULL, L"retirement.ready", &frame, TRUE); if (error) return error;
  /* The ready file is closed before the controller can suspend this thread. */
  for (;;) {
    if (GetTickCount64() >= deadline || ownership_wall_ms() >= frame.deadline) return ERROR_TIMEOUT;
    RT_FRAME release; ZeroMemory(&release, sizeof(release));
    error = rt_file(NULL, L"retirement.release", &release, FALSE);
    if (!error) return memcmp(&frame, &release, sizeof(frame)) ? ERROR_INVALID_DATA : 0;
    if (error != ERROR_FILE_NOT_FOUND && error != ERROR_SHARING_VIOLATION) return error;
    Sleep(5);
  }
}

/* Same named-directory creation/validation as map_retire. Only this new arm
 * permits assignment before normal root exit; the old function is unchanged. */
static DWORD rt_live_replace(PROCESS_INFORMATION *root, PSECURITY_DESCRIPTOR security) {
  typedef NTSTATUS (NTAPI *create_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, HANDLE, ULONG);
  typedef NTSTATUS (NTAPI *set_fn)(HANDLE, PROCESSINFOCLASS, PVOID, ULONG);
  create_fn create = (create_fn)(void *)nt_api("NtCreateDirectoryObjectEx");
  set_fn set = (set_fn)(void *)nt_api("NtSetInformationProcess");
  query_object_fn query = (query_object_fn)(void *)nt_api("NtQueryObject");
  if (!create || !set || !query || retirement_live_done || !probe_map || rt_identity(root, TRUE)) return ERROR_INVALID_DATA;
  if (wcslen(probe_name) + 9 > sizeof(retired_name) / sizeof(*retired_name)) return ERROR_INSUFFICIENT_BUFFER;
  memcpy(retired_name, probe_name, (wcslen(probe_name) + 1) * sizeof(wchar_t));
  memcpy(retired_name + wcslen(probe_name), L".retired", sizeof(L".retired"));
  UNICODE_STRING name = {(USHORT)(wcslen(retired_name) * sizeof(wchar_t)), (USHORT)sizeof(retired_name), retired_name};
  OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
  attributes.Length = sizeof(attributes); attributes.ObjectName = &name; attributes.Attributes = 0x40; attributes.SecurityDescriptor = security;
  HANDLE empty = NULL; DWORD error = 0, flags = 0; ULONG used = 0; BYTE buffer[8192];
  NTSTATUS status = create(&empty, 0xf000f, &attributes, NULL, 0);
  fwprintf(stderr, L"map-retire named path=%ls create=0x%08lx\n", retired_name, (unsigned long)status); fflush(stderr);
  if (status != 0) return (DWORD)status;
  retired_created = TRUE;
  status = query(empty, (OBJECT_INFORMATION_CLASS)1, buffer, sizeof(buffer), &used);
  if (status != 0) {error = (DWORD)status; goto end;}
  if (used < sizeof(UNICODE_STRING) || used > sizeof(buffer)) {error = ERROR_INVALID_DATA; goto end;}
  UNICODE_STRING *actual = (UNICODE_STRING *)buffer;
  uintptr_t begin = (uintptr_t)buffer, finish = begin + used, text = (uintptr_t)actual->Buffer;
  if (actual->Length != name.Length || text < begin + sizeof(*actual) || text > finish || actual->Length > finish - text ||
      memcmp(actual->Buffer, name.Buffer, name.Length)) {error = ERROR_INVALID_NAME; goto end;}
  if (!GetHandleInformation(empty, &flags) || flags) {error = ERROR_INVALID_DATA; goto end;}
  error = rt_identity(root, TRUE); if (error) goto end;
  status = set(root->hProcess, (PROCESSINFOCLASS)23, &empty, sizeof(empty));
  fwprintf(stderr, L"map-retire live pid=%lu set=0x%08lx named=1 inherited=0 links=0\n", rt_frame.root, (unsigned long)status); fflush(stderr);
  if (status != 0) {error = (DWORD)status; goto end;}
  error = rt_identity(root, TRUE);
end:
  { DWORD closed = close_owned(L"retire-named-map", &empty); if (closed && !error) error = closed; }
  if (!error) {retirement_live_done = TRUE; rt_log(L"assign", 0, 1);}
  return error;
}
#include "directory-twin.h"
static DWORD retirement_final(PROCESS_INFORMATION *root, HANDLE job, PSECURITY_DESCRIPTOR security, PSID app, PSID capability) {
  if (!retirement_timing_mode) return 0;
  RT_FRAME ready; DWORD error;
  for (;;) {
    error = rt_identity(root, TRUE); if (error) return error;
    ZeroMemory(&ready, sizeof(ready)); error = rt_file(rt_project, L"retirement.ready", &ready, FALSE);
    if (!error) break;
    if (error != ERROR_FILE_NOT_FOUND && error != ERROR_SHARING_VIOLATION) return error;
    Sleep(5);
  }
  ULONGLONG when = ready.ready; ready.ready = 0;
  if (memcmp(&ready, &rt_frame, sizeof(ready)) || when < rt_frame.started || when >= rt_frame.deadline) return ERROR_INVALID_DATA;
  rt_frame.ready = when;
  if (!lowbox_verify(root->hProcess, job, app, capability)) return ERROR_ACCESS_DENIED;
  error = rt_identity(root, TRUE); if (error) return error;
  rt_log(L"ready", 0, 1);
  DWORD previous = SuspendThread(root->hThread);
  if (previous != 0) return previous == (DWORD)-1 ? GetLastError() : ERROR_INVALID_DATA;
  error = rt_identity(root, TRUE); if (error) return error;
  rt_log(L"suspend", previous, 1);
  if (retirement_timing_mode == 1) {
    error = directory_twin_mode ? directory_twin_replace(root, job, security) : rt_live_replace(root, security);
    if (error) return error;
  }
  previous = ResumeThread(root->hThread);
  if (previous != 1) return previous == (DWORD)-1 ? GetLastError() : ERROR_INVALID_DATA;
  error = rt_identity(root, TRUE); if (error) return error;
  rt_log(L"resume", previous, 1);
  error = rt_file(rt_project, L"retirement.release", &rt_frame, TRUE);
  if (!error && !rt_in_time()) error = ERROR_TIMEOUT;
  if (!error) rt_log(L"release", 0, 1);
  return error;
}
static DWORD retirement_remaining(void) {
  ULONGLONG now = GetTickCount64();
  return now < rt_tick_deadline ? (DWORD)(rt_tick_deadline - now) : 0;
}
static DWORD retirement_exited(PROCESS_INFORMATION *root) {
  if (!retirement_timing_mode) return 0;
  DWORD error = rt_identity(root, FALSE);
  if (!error) rt_log(L"exit", 0, 1);
  return error;
}
static DWORD retirement_assigned(DWORD error) {
  if (retirement_timing_mode != 2) return error;
  if (!error && rt_in_time() && rt_frame.ready && retired_created) {rt_log(L"assign", 0, 1); rt_finished = TRUE; return 0;}
  return error ? error : ERROR_INVALID_DATA;
}
static void retirement_complete(void) {
  if (retirement_timing_mode && (retirement_live_done || rt_finished)) rt_log(L"complete", 0, 1);
}
