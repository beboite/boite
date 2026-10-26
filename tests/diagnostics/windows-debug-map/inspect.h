/* Synthetic native target: ordinary CreateProcessW for child and grandchild. */
static int observe(const wchar_t *root) {
  CALLER_STATE state;
  DWORD error = read_caller(root, &state);
  if (error) return failure(L"observer", error);
  fwprintf(stdout, L"observer NUL=%ls drive=%ls map=%ls\n", state.nul, state.drive, state.map);
  return 0;
}

/* No process/handle search. The parent supplies the exact name emitted by its
 * completed helper, and records this separately from immediate in-helper cleanup. */
static int observe_map(const wchar_t *path) {
  const wchar_t *tail = path;
  if (!wcsncmp(tail, L"\\Sessions\\", 10)) {
    tail += 10; const wchar_t *start = tail;
    while (*tail >= L'0' && *tail <= L'9') tail++;
    if (tail == start || tail - start > 10) return failure(L"observer-map.path", ERROR_INVALID_NAME);
  }
  const wchar_t prefix[] = L"\\BaseNamedObjects\\boite.route.";
  if (wcsncmp(tail, prefix, wcslen(prefix))) return failure(L"observer-map.path", ERROR_INVALID_NAME);
  tail += wcslen(prefix); const wchar_t *start = tail;
  while (*tail >= L'0' && *tail <= L'9') tail++;
  if (tail == start || tail - start > 10 || (*tail && wcscmp(tail, L".swap") && wcscmp(tail, L".retired") && wcscmp(tail, L".unused")) || wcslen(path) >= 256) return failure(L"observer-map.path", ERROR_INVALID_NAME);
  open_directory_fn open = (open_directory_fn)(void *)nt_api("NtOpenDirectoryObject");
  if (!open) return failure(L"observer-map.api", ERROR_PROC_NOT_FOUND);
  UNICODE_STRING name = {(USHORT)(wcslen(path) * 2), (USHORT)((wcslen(path) + 1) * 2), (PWSTR)path};
  OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
  attributes.Length = sizeof(attributes); attributes.ObjectName = &name; attributes.Attributes = 0x40;
  HANDLE map = NULL; NTSTATUS status = open(&map, 1, &attributes); DWORD error = 0;
  if (map) error = close_owned(L"map-post-exit-observer", &map);
  fwprintf(stdout, L"map-after-helper-exit path=%ls open=0x%08lx absent=%d closed=%d error=%lu\n",
    path, (unsigned long)status, status == (NTSTATUS)0xc0000034, !map, error);
  fflush(stdout);
  if (status != 0 && status != (NTSTATUS)0xc0000034 && !error) error = (DWORD)status;
  return error ? failure(L"observer-map", error) : 0;
}

static int cleanup_profile(const wchar_t *name) {
  HRESULT deleted = DeleteAppContainerProfile(name);
  fwprintf(stdout, L"profile delete=0x%08lx\n", (unsigned long)deleted);
  if (FAILED(deleted) && deleted != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) return 125;
  PSID sid = NULL;
  HRESULT recreated = CreateAppContainerProfile(name, name, L"Synthetic cleanup check", NULL, 0, &sid);
  fwprintf(stdout, L"profile recreate=0x%08lx\n", (unsigned long)recreated);
  if (sid) FreeSid(sid);
  if (FAILED(recreated)) return 125;
  HRESULT final = DeleteAppContainerProfile(name);
  fwprintf(stdout, L"profile final-delete=0x%08lx\n", (unsigned long)final);
  return FAILED(final) ? 125 : 0;
}

static volatile LONG application_pending, application_handled;
#define APPLICATION_EXCEPTION_CODE ((DWORD)0xe0424f49UL)
#define APPLICATION_EXCEPTION_MARKER ((ULONG_PTR)0x626f6974)
static LONG CALLBACK application_exception(EXCEPTION_POINTERS *exception) {
  if (application_pending && exception->ExceptionRecord->ExceptionCode == APPLICATION_EXCEPTION_CODE &&
      !(exception->ExceptionRecord->ExceptionFlags & EXCEPTION_NONCONTINUABLE) &&
      exception->ExceptionRecord->NumberParameters == 2 &&
      exception->ExceptionRecord->ExceptionInformation[0] == APPLICATION_EXCEPTION_MARKER &&
      exception->ExceptionRecord->ExceptionInformation[1] == GetCurrentProcessId()) {
    InterlockedIncrement(&application_handled);
    return EXCEPTION_CONTINUE_EXECUTION;
  }
  return EXCEPTION_CONTINUE_SEARCH;
}

static int inspect(int count, wchar_t **args) {
  if (count != 4 && (count != 5 || wcscmp(args[4], L"forward-check"))) return 125;
  BOOL forward_check = count == 5;
  int depth = _wtoi(args[2]);
  if (depth < 0 || depth > 2 || wcslen(args[3]) > 96) return 125;
  wchar_t label[128]; swprintf(label, 128, L"%ls.generation-%d", args[3], depth);
  fwprintf(stdout, L"inspect-start=%ls pid=%lu\n", label, GetCurrentProcessId());
  HANDLE token = NULL; DWORD is_app = 0, used = 0; BOOL in_job = FALSE;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 125;
  BOOL queried = GetTokenInformation(token, TokenIsAppContainer, &is_app, sizeof(is_app), &used); CloseHandle(token);
  if (!queried || !IsProcessInJob(GetCurrentProcess(), NULL, &in_job)) return 125;

  HANDLE nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
  char bytes[256] = {0}; DWORD size = 0; BOOL read = FALSE;
  DWORD open_error = nul == INVALID_HANDLE_VALUE ? GetLastError() : 0;
  if (nul != INVALID_HANDLE_VALUE) { read = ReadFile(nul, bytes, 255, &size, NULL); CloseHandle(nul); }
  char expected[256];
  if (!WideCharToMultiByte(CP_UTF8, 0, args[3], -1, expected, sizeof(expected), NULL, NULL)) return 125;
  BOOL routed = read && !strcmp(bytes, expected);
  fwprintf(stdout, L"%ls appcontainer=%lu in-job=%d routing=%d bytes=%lu open-error=%lu marker=%hs\n",
    label, is_app, in_job, routed, size, open_error, bytes);

  wchar_t ambient[4096]; DWORD length = GetCurrentDirectoryW(4096, ambient);
  if (!length || length >= 4096) return 125;
  wchar_t *last = wcsrchr(ambient, L'\\'); if (!last) return 125; *last = 0;
  size_t prefix = wcslen(ambient);
  if (swprintf(ambient + prefix, 4096 - prefix, L"\\ambient-probe") < 0) return 125;
  HANDLE file = CreateFileW(ambient, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
  DWORD denial = file == INVALID_HANDLE_VALUE ? GetLastError() : 0;
  if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
  fwprintf(stdout, L"%ls ambient-denial=%lu\n", label, denial);

  query_process_fn query = (query_process_fn)(void *)nt_api("NtQueryInformationProcess");
  query_object_fn query_object = (query_object_fn)(void *)nt_api("NtQueryObject");
  if (!query || !query_object) return 125;
  HANDLE debug = NULL;
  NTSTATUS status = query(GetCurrentProcess(), (PROCESSINFOCLASS)30, &debug, sizeof(debug), NULL);
  BOOL control = FALSE, debug_known = FALSE;
  fwprintf(stdout, L"%ls debug-object-query=0x%08lx handle=%p\n", label, (unsigned long)status, debug);
  if (status >= 0 && debug) {
    struct { ULONG attributes, granted, handles, pointers; ULONG reserved[10]; } info;
    ZeroMemory(&info, sizeof(info)); ULONG returned = 0;
    NTSTATUS basic = query_object(debug, (OBJECT_INFORMATION_CLASS)0, &info, sizeof(info), &returned);
    BYTE type_buffer[4096]; ZeroMemory(type_buffer, sizeof(type_buffer));
    NTSTATUS typed = query_object(debug, (OBJECT_INFORMATION_CLASS)2, type_buffer, sizeof(type_buffer), &returned);
    UNICODE_STRING *type = (UNICODE_STRING *)type_buffer;
    debug_known = basic >= 0 && typed >= 0 && type->Buffer &&
      type->Length == 22 && !wcsncmp(type->Buffer, L"DebugObject", 11);
    /* WAIT_STATE_CHANGE, ADD_REMOVE_PROCESS and SET_INFORMATION each control
     * the host debugger. An undecodable returned handle also fails closed. */
    control = !debug_known || !!(info.granted & (1 | 2 | 4));
    fwprintf(stdout, L"%ls debug-object-basic=0x%08lx granted=0x%08lx type-status=0x%08lx known=%d\n",
      label, (unsigned long)basic, info.granted, (unsigned long)typed, debug_known);
    CloseHandle(debug);
  } else {
    /* STATUS_PORT_NOT_SET is the documented no-debug-object result. Access
     * denial also establishes this self-query did not deliver host authority. */
    debug_known = (status == (NTSTATUS)0xc0000353 || status == (NTSTATUS)0xc0000022) && !debug;
    control = !debug_known;
  }
  fwprintf(stdout, L"%ls host-debug-control=%d known=%d\n", label, control, debug_known); fflush(stdout);
  if (forward_check) {
    /* Use an application-defined code: Windows gives breakpoint exceptions
     * special instruction-pointer semantics, including when raised in software.
     * Our handler must return without changing the supplied context. */
    ULONG_PTR arguments[2] = {APPLICATION_EXCEPTION_MARKER, GetCurrentProcessId()};
    PVOID handler = AddVectoredExceptionHandler(1, application_exception);
    if (!handler) return 125;
    application_pending = 1;
    RaiseException(APPLICATION_EXCEPTION_CODE, 0, 2, arguments);
    application_pending = 0;
    BOOL removed = RemoveVectoredExceptionHandler(handler) != 0;
    fwprintf(stdout, L"%ls application-exception-forwarded=%ld handler-removed=%d\n", label, application_handled, removed); fflush(stdout);
    if (application_handled != 1 || !removed) return 125;
  }
  if (depth == 0) {
    HANDLE ready = CreateFileW(L"ready", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, CREATE_NEW, 0, NULL);
    if (ready == INVALID_HANDLE_VALUE) return 125;
    CloseHandle(ready);
    ULONGLONG deadline = GetTickCount64() + 6000;
    while (GetFileAttributesW(L"release") == INVALID_FILE_ATTRIBUTES) {
      if (GetTickCount64() >= deadline) return 125;
      Sleep(10);
    }
  }
  int child_code = 0; BOOL forced = FALSE;
  if (depth < 2) {
    wchar_t image[4096], next[16]; DWORD image_length = GetModuleFileNameW(NULL, image, 4096);
    if (!image_length || image_length >= 4096) return 125;
    swprintf(next, 16, L"%d", depth + 1);
    wchar_t *argv[] = {image, L"inspect", next, args[3], L"forward-check"}; wchar_t *line = command_line(forward_check ? 5 : 4, argv);
    if (!line) return 125;
    STARTUPINFOW startup; PROCESS_INFORMATION child;
    ZeroMemory(&startup, sizeof(startup)); ZeroMemory(&child, sizeof(child));
    startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE); startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    BOOL created = CreateProcessW(image, line, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, NULL, &startup, &child);
    fwprintf(stdout, L"%ls child-created=%d pid=%lu error=%lu\n", label, created, child.dwProcessId, created ? 0 : GetLastError()); fflush(stdout);
    if (created) {
      DWORD result = 125;
      if (WaitForSingleObject(child.hProcess, 10000) != WAIT_OBJECT_0) {
        forced = TRUE;
        TerminateProcess(child.hProcess, 125); WaitForSingleObject(child.hProcess, 1000);
      }
      if (!GetExitCodeProcess(child.hProcess, &result) || result == STILL_ACTIVE) result = 125;
      child_code = (int)result;
      BOOL thread_closed = CloseHandle(child.hThread), process_closed = CloseHandle(child.hProcess);
      if (retirement_enabled()) {
        fwprintf(stderr, L"retirement-child-closed pid=%lu depth=%d child=%lu thread=%d process=%d\n", GetCurrentProcessId(), depth, child.dwProcessId, thread_closed, process_closed); fflush(stderr);
        if (!thread_closed || !process_closed) return 125;
      }
    } else child_code = 125;
    free(line);
  }
  int result = routed && is_app == 1 && in_job && denial == ERROR_ACCESS_DENIED && !control && !child_code && !forced ? 0 : 1;
  fwprintf(stdout, L"%ls inspect-exit=%d child-exit=%d forced=%d\n", label, result, child_code, forced); fflush(stdout);
  if (depth == 0 && retirement_inspector_final(result)) return 125;
  return result;
}
