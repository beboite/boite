/* Test-only matched DIRECT execution-thread lifetime control. */
#include <process.h>
typedef struct {
  LONG ready, release;
  int count, body;
  wchar_t **args;
  DWORD pid, main_tid, tid, callback_error;
  ULONGLONG process_created, thread_created, ready_at, released_at;
  wchar_t nonce[33], name[256];
} WL_CONTEXT;

static DWORD wl_thread_time(HANDLE thread, ULONGLONG *created) {
  FILETIME start, end, kernel, user; ULARGE_INTEGER value;
  if (!GetThreadTimes(thread, &start, &end, &kernel, &user)) return GetLastError();
  value.LowPart = start.dwLowDateTime; value.HighPart = start.dwHighDateTime;
  *created = value.QuadPart; return *created ? 0 : ERROR_INVALID_DATA;
}
static DWORD wl_identity(WL_CONTEXT *c, HANDLE thread) {
  ULONGLONG process_created = 0, thread_created = 0;
  DWORD error = tc_times(GetCurrentProcess(), &process_created);
  if (!error && (GetCurrentProcessId() != c->pid || GetCurrentThreadId() != c->main_tid ||
      process_created != c->process_created)) error = ERROR_INVALID_DATA;
  if (!error && thread) {
    error = wl_thread_time(thread, &thread_created);
    if (!error && (GetThreadId(thread) != c->tid || GetProcessIdOfThread(thread) != c->pid ||
        thread_created != c->thread_created)) error = ERROR_INVALID_DATA;
  }
  return error;
}
static BOOL wl_budget(const WL_CONTEXT *c) {
  return GetTickCount64() < c->ready_at + 5000;
}
static void wl_frame(const WL_CONTEXT *c, const wchar_t *mode, const wchar_t *phase,
    DWORD pre, DWORD post, DWORD code, NTSTATUS status, BOOL observer_closed, BOOL thread_closed) {
  fwprintf(stderr, L"worker-lifetime phase=%ls mode=%ls nonce=%ls pid=%lu process-created=%llu main-tid=%lu tid=%lu thread-created=%llu body=%d ready=%llu now=%llu released=%llu pre=%lu post=%lu code=%lu status=0x%08lx absent=%d observer-closed=%d thread-closed=%d callback-error=%lu path=%ls\n",
    phase, mode, c->nonce, c->pid, (unsigned long long)c->process_created, c->main_tid, c->tid,
    (unsigned long long)c->thread_created, c->body, (unsigned long long)c->ready_at,
    (unsigned long long)GetTickCount64(), (unsigned long long)c->released_at,
    pre, post, code, (unsigned long)status, status == (NTSTATUS)0xc0000034,
    observer_closed, thread_closed, c->callback_error, *c->name ? c->name : L"-");
  fflush(stderr);
}
static unsigned __stdcall wl_callback(void *argument) {
  WL_CONTEXT *c = argument;
  if (GetCurrentThreadId() != c->tid || GetCurrentProcessId() != c->pid) return ERROR_INVALID_DATA;
  c->body = direct_body(c->count, c->args);
  if (probe_map || probe_link || swap_map || tc_pending || creator_pending || tc_process || tc_pipe || tc_thread)
    c->callback_error = ERROR_IO_INCOMPLETE;
  if (wcslen(probe_name) >= 256 || !*probe_name) c->callback_error = ERROR_INVALID_NAME;
  else memcpy(c->name, probe_name, (wcslen(probe_name) + 1) * sizeof(wchar_t));
  if (fflush(stdout) || fflush(stderr)) c->callback_error = ERROR_WRITE_FAULT;
  c->ready_at = GetTickCount64();
  InterlockedExchange(&c->ready, 1);
  while (!InterlockedCompareExchange(&c->release, 0, 0)) {
    if (GetTickCount64() >= c->ready_at + 3000) return ERROR_TIMEOUT;
    Sleep(1);
  }
  if (GetTickCount64() >= c->ready_at + 3000 || c->callback_error) return c->callback_error ? c->callback_error : ERROR_TIMEOUT;
  return 0; /* _endthreadex runs through the CRT callback trampoline. */
}
static DWORD wl_observe(WL_CONTEXT *c, HANDLE thread, BOOL live, const wchar_t *mode, const wchar_t *phase) {
  if (!wl_budget(c)) return ERROR_TIMEOUT;
  DWORD error = wl_identity(c, thread), code = 0, pre = WAIT_OBJECT_0, post = WAIT_OBJECT_0;
  if (thread) {
    pre = WaitForSingleObject(thread, 0);
    if (!GetExitCodeThread(thread, &code) && !error) error = GetLastError();
    if (!error && (pre != (live ? WAIT_TIMEOUT : WAIT_OBJECT_0) || code != (live ? STILL_ACTIVE : 0))) error = ERROR_INVALID_DATA;
  }
  if (error || !wl_budget(c)) return error ? error : ERROR_TIMEOUT;
  open_directory_fn open = (open_directory_fn)(void *)nt_api("NtOpenDirectoryObject");
  if (!open) return ERROR_PROC_NOT_FOUND;
  UNICODE_STRING name = {(USHORT)(wcslen(c->name) * 2), (USHORT)sizeof(c->name), c->name};
  OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
  attributes.Length = sizeof(attributes); attributes.ObjectName = &name; attributes.Attributes = 0x40;
  HANDLE map = NULL; NTSTATUS status = open(&map, 1, &attributes);
  BOOL closed = !map || CloseHandle(map); if (!closed) error = GetLastError();
  if (!error && status != 0 && status != (NTSTATUS)0xc0000034) error = (DWORD)status;
  if (!error) error = wl_identity(c, thread);
  if (thread) {
    post = WaitForSingleObject(thread, 0);
    if (!GetExitCodeThread(thread, &code) && !error) error = GetLastError();
    if (!error && (post != pre || code != (live ? STILL_ACTIVE : 0))) error = ERROR_INVALID_DATA;
  }
  if (!error && !wl_budget(c)) error = ERROR_TIMEOUT;
  if (!error) wl_frame(c, mode, phase, pre, post, code, status, closed, !thread);
  return error;
}
static DWORD wl_join(WL_CONTEXT *c, HANDLE thread) {
  if (GetTickCount64() >= c->ready_at + 3000 || !wl_budget(c)) return ERROR_TIMEOUT;
  c->released_at = GetTickCount64();
  InterlockedExchange(&c->release, 1);
  DWORD waited = WaitForSingleObject(thread, creator_remaining(c->ready_at + 5000));
  if (waited != WAIT_OBJECT_0 || !wl_budget(c)) return waited == WAIT_FAILED ? GetLastError() : ERROR_TIMEOUT;
  DWORD code = STILL_ACTIVE;
  if (!GetExitCodeThread(thread, &code)) return GetLastError();
  return code ? code : wl_identity(c, thread);
}
static int worker_lifetime_run(int count, wchar_t **args, BOOL waiting) {
  /* Defaults match DIRECT. Only its assignment selector differs from RED. */
  if (debug_mode || reopen_owned_map || external_map_creator || target_creator_mode || retire_owned_map ||
      retire_named_map || !observe_owned_handles || assignment_scope) return failure(L"worker.settings", ERROR_INVALID_DATA);
  assignment_scope = 1;
  WL_CONTEXT *c = calloc(1, sizeof(*c)); if (!c) return failure(L"worker.allocate", ERROR_NOT_ENOUGH_MEMORY);
  c->count = count; c->args = args; c->body = -1; c->pid = GetCurrentProcessId(); c->main_tid = GetCurrentThreadId();
  HANDLE thread = NULL; BOOL joined = FALSE;
  const wchar_t *mode = waiting ? L"waiting" : L"exited";
  DWORD error = tc_times(GetCurrentProcess(), &c->process_created);
  DWORD n = GetEnvironmentVariableW(L"BOITE_DIAGNOSTIC_WORKER_NONCE", c->nonce, 33); BYTE nonce[16];
  if (!error && (n != 32 || creator_nonce(c->nonce, nonce))) error = ERROR_INVALID_DATA;
  if (error) goto end;
  unsigned int tid = 0;
  uintptr_t started = _beginthreadex(NULL, 0, wl_callback, c, CREATE_SUSPENDED, &tid);
  if (!started) {error = ERROR_NOT_ENOUGH_MEMORY; goto end;}
  thread = (HANDLE)started; c->tid = tid;
  error = wl_thread_time(thread, &c->thread_created); if (!error) error = wl_identity(c, thread);
  if (error) goto end;
  wl_frame(c, mode, L"start", WAIT_TIMEOUT, WAIT_TIMEOUT, STILL_ACTIVE, 0, TRUE, FALSE);
  if (ResumeThread(thread) != 1) {error = ERROR_INVALID_DATA; goto end;}
  /* The original body retains its own waits and the whole-helper capture bound.
   * Main touches neither stdio nor USER32 until READY publishes full cleanup. */
  ULONGLONG body_deadline = GetTickCount64() + 35000;
  while (!InterlockedCompareExchange(&c->ready, 0, 0)) {
    if (WaitForSingleObject(thread, 0) != WAIT_TIMEOUT) {error = ERROR_PROCESS_ABORTED; goto end;}
    if (!creator_remaining(body_deadline)) {error = ERROR_TIMEOUT; goto end;}
    Sleep(1);
  }
  if (c->callback_error) {error = c->callback_error; goto end;}
  error = wl_observe(c, thread, TRUE, mode, L"ready"); if (error) goto end;
  if (!waiting) {error = wl_join(c, thread); if (error) goto end; joined = TRUE;}
  /* Hold comparison placement fixed at >=100ms after READY in both arms.
   * Actual timestamps remain evidence; scheduling is not a causal guarantee. */
  while (GetTickCount64() < c->ready_at + 100) {
    if (!wl_budget(c) || WaitForSingleObject(thread, 0) != (waiting ? WAIT_TIMEOUT : WAIT_OBJECT_0)) {error = ERROR_TIMEOUT; goto end;}
    Sleep(1);
  }
  if (waiting) {
    error = wl_observe(c, thread, TRUE, mode, L"waiting"); if (error) goto end;
    error = wl_join(c, thread); if (error) goto end; joined = TRUE;
  }
  error = wl_observe(c, thread, FALSE, mode, waiting ? L"released-held" : L"exited-held"); if (error) goto end;
  {HANDLE owned = thread; thread = NULL; if (!CloseHandle(owned)) {error = GetLastError(); goto end;}}
  error = wl_observe(c, NULL, FALSE, mode, waiting ? L"released-closed" : L"exited-closed"); if (error) goto end;
  wl_frame(c, mode, L"complete", WAIT_OBJECT_0, WAIT_OBJECT_0, 0, 0, TRUE, TRUE);
end:
  if (thread && !joined) {
    /* Never return main/free argv/context while the callback may still use them.
     * The existing owner kills this captured helper at 40s. Late join is failure.
     * A failed owner watchdog ends only this helper without CRT teardown. */
    if (WaitForSingleObject(thread, 45000) != WAIT_OBJECT_0) {
      TerminateProcess(GetCurrentProcess(), 125);
      /* TerminateProcess on self does not return on success. No CRT unwinding
       * or live-thread handle close is permitted even if that call fails. */
      RaiseFailFastException(NULL, NULL, 0);
    }
    joined = TRUE;
  }
  if (thread) {HANDLE owned = thread; thread = NULL; if (!CloseHandle(owned) && !error) error = GetLastError();}
  int result = c->body;
  free(c);
  return error ? failure(L"worker.protocol", error) : result;
}
