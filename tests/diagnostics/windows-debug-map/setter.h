/* Test-only assignment caller experiment. The target stays suspended until
 * this trusted, separately job-owned setter exits and its handles close. */
static DWORD setter_assign(HANDLE process, HANDLE directory);

static DWORD parse_owned_handle(const wchar_t *text, HANDLE *handle) {
  if (!*text) return ERROR_INVALID_HANDLE;
  for (const wchar_t *c = text; *c; c++) if (*c < L'0' || *c > L'9') return ERROR_INVALID_HANDLE;
  wchar_t *end = NULL;
  unsigned long long value = _wcstoui64(text, &end, 10);
  if (!end || *end || !value || value >= (unsigned long long)INTPTR_MAX) return ERROR_INVALID_HANDLE;
  HANDLE candidate = (HANDLE)(uintptr_t)value;
  DWORD flags = 0;
  if (!GetHandleInformation(candidate, &flags) || !(flags & HANDLE_FLAG_INHERIT)) return ERROR_INVALID_HANDLE;
  *handle = candidate; return 0;
}

static int setter_entry(int count, wchar_t **args) {
  if (count != 7) return 125;
  HANDLE process = NULL, directory = NULL;
  DWORD error = parse_owned_handle(args[2], &process);
  if (!error) error = parse_owned_handle(args[3], &directory);
  wchar_t *end = NULL;
  unsigned long long expected = _wcstoui64(args[4], &end, 10);
  if (!error && (!*args[4] || !end || *end || !expected || expected > MAXDWORD ||
      process == directory || GetProcessId(process) != (DWORD)expected ||
      WaitForSingleObject(process, 0) != WAIT_TIMEOUT)) error = ERROR_INVALID_DATA;
  unsigned long long expected_created = _wcstoui64(args[6], &end, 10);
  FILETIME created, exited, kernel, user; ULARGE_INTEGER identity;
  if (!error && (!*args[6] || !end || *end || !expected_created ||
      !GetProcessTimes(process, &created, &exited, &kernel, &user))) error = ERROR_INVALID_DATA;
  if (!error) {
    identity.LowPart = created.dwLowDateTime; identity.HighPart = created.dwHighDateTime;
    if (identity.QuadPart != expected_created) error = ERROR_INVALID_DATA;
  }
  wchar_t name[256];
  if (!error) error = object_name(directory, name, 256);
  if (!error && wcscmp(name, args[5])) error = ERROR_INVALID_NAME;
  BYTE buffer[4096]; ULONG used = 0;
  query_object_fn query = (query_object_fn)(void *)nt_api("NtQueryObject");
  if (!error && !query) error = ERROR_PROC_NOT_FOUND;
  if (error) return 125; /* Invalid arguments never authorize an explicit close. */
  {
    NTSTATUS status = query(directory, (OBJECT_INFORMATION_CLASS)2, buffer, sizeof(buffer), &used);
    UNICODE_STRING *type = (UNICODE_STRING *)buffer;
    if (status < 0 || !type->Buffer || type->Length != 18 || wcsncmp(type->Buffer, L"Directory", 9))
      error = ERROR_INVALID_HANDLE;
  }
  if (error) return 125;
  if (!SetHandleInformation(process, HANDLE_FLAG_INHERIT, 0) ||
      !SetHandleInformation(directory, HANDLE_FLAG_INHERIT, 0)) return 125;
  if (!error) {
    typedef NTSTATUS (NTAPI *set_process_fn)(HANDLE, PROCESSINFOCLASS, PVOID, ULONG);
    set_process_fn set = (set_process_fn)(void *)nt_api("NtSetInformationProcess");
    if (!set) error = ERROR_PROC_NOT_FOUND;
    else {
      NTSTATUS status = set(process, (PROCESSINFOCLASS)23, &directory, sizeof(directory));
      if (status != 0) error = (DWORD)status;
    }
  }
  /* Only validated inherited handles, never a handle search or foreign table. */
  if (directory && !CloseHandle(directory) && !error) error = GetLastError();
  if (process && !CloseHandle(process) && !error) error = GetLastError();
  return (int)error;
}

static DWORD setter_assign(HANDLE process, HANDLE directory) {
  HANDLE passed[2] = {NULL, NULL}, job = NULL;
  PROCESS_INFORMATION child; STARTUPINFOEXW startup;
  ZeroMemory(&child, sizeof(child)); ZeroMemory(&startup, sizeof(startup));
  startup.StartupInfo.cb = sizeof(startup);
  DWORD error = 0, exit_code = STILL_ACTIVE, waited = WAIT_FAILED;
  BOOL forced = FALSE, member = FALSE, resumed = FALSE;
  wchar_t image[4096], process_text[32], map_text[32], pid_text[16], created_text[32];
  wchar_t *line = NULL; SIZE_T bytes = 0;
  DWORD length = GetModuleFileNameW(NULL, image, 4096);
  if (!length || length >= 4096) {error = ERROR_INSUFFICIENT_BUFFER; goto end;}
  FILETIME created, exited, kernel, user; ULARGE_INTEGER identity;
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) {error = GetLastError(); goto end;}
  identity.LowPart = created.dwLowDateTime; identity.HighPart = created.dwHighDateTime;
  swprintf(created_text, 32, L"%llu", (unsigned long long)identity.QuadPart);
  for (int i = 0; i < 2; i++) if (!DuplicateHandle(GetCurrentProcess(), i ? directory : process,
      GetCurrentProcess(), &passed[i], i ? 3 : PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
      TRUE, 0)) {error = GetLastError(); goto end;}
  swprintf(process_text, 32, L"%llu", (unsigned long long)(uintptr_t)passed[0]);
  swprintf(map_text, 32, L"%llu", (unsigned long long)(uintptr_t)passed[1]);
  swprintf(pid_text, 16, L"%lu", GetProcessId(process));
  wchar_t *argv[] = {image, L"assign-map", process_text, map_text, pid_text, probe_name, created_text};
  line = command_line(7, argv); if (!line) {error = ERROR_NOT_ENOUGH_MEMORY; goto end;}
  InitializeProcThreadAttributeList(NULL, 1, 0, &bytes);
  startup.lpAttributeList = malloc(bytes);
  if (!startup.lpAttributeList) {error = ERROR_NOT_ENOUGH_MEMORY; goto end;}
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes)) {
    error = GetLastError(); free(startup.lpAttributeList); startup.lpAttributeList = NULL; goto end;
  }
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
      passed, sizeof(passed), NULL, NULL)) {error = GetLastError(); goto end;}
  job = CreateJobObjectW(NULL, NULL); if (!job) {error = GetLastError(); goto end;}
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits; ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    error = GetLastError(); goto end;
  }
  if (!CreateProcessW(image, line, NULL, NULL, TRUE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
      NULL, NULL, &startup.StartupInfo, &child)) {error = GetLastError(); goto end;}
  unsigned int transferred = 0;
  for (int i = 0; i < 2; i++) {
    if (CloseHandle(passed[i])) {passed[i] = NULL; transferred++;}
    else if (!error) error = GetLastError();
  }
  fwprintf(stderr, L"setter-transfer target=%lu created=%llu parent-closed=%u error=%lu process-access=0x%08lx map-access=0x00000003\n",
    GetProcessId(process), (unsigned long long)identity.QuadPart, transferred, error,
    (unsigned long)(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE)); fflush(stderr);
  if (error) goto end;
  if (!AssignProcessToJobObject(job, child.hProcess) ||
      !IsProcessInJob(child.hProcess, job, &member) || !member) {error = GetLastError(); if (!error) error = ERROR_INVALID_DATA; goto end;}
  if (ResumeThread(child.hThread) != 1) {error = ERROR_INVALID_DATA; goto end;}
  resumed = TRUE;
  waited = WaitForSingleObject(child.hProcess, 5000);
  if (waited != WAIT_OBJECT_0) {error = waited == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError(); goto end;}
  if (!GetExitCodeProcess(child.hProcess, &exit_code)) {error = GetLastError(); goto end;}
  if (exit_code) error = exit_code;
end:
  if (child.hProcess && WaitForSingleObject(child.hProcess, 0) != WAIT_OBJECT_0) {
    forced = TRUE;
    if (job && member) TerminateJobObject(job, 125); else TerminateProcess(child.hProcess, 125);
    if (WaitForSingleObject(child.hProcess, 1000) != WAIT_OBJECT_0 && !error) error = ERROR_TIMEOUT;
    if (!error) error = ERROR_OPERATION_ABORTED;
  }
  fwprintf(stderr, L"setter-assignment target=%lu setter=%lu inherited=2 member=%d resumed=%d wait=%lu exit=0x%08lx forced=%d error=%lu\n",
    GetProcessId(process), child.dwProcessId, member, resumed, waited, exit_code, forced, error); fflush(stderr);
  HANDLE owned[] = {child.hThread, child.hProcess, job, passed[0], passed[1]};
  unsigned int present = 0, closed = 0; DWORD close_error = 0;
  for (unsigned int i = 0; i < sizeof(owned) / sizeof(owned[0]); i++) if (owned[i]) {
    present++;
    if (CloseHandle(owned[i])) closed++;
    else if (!close_error) close_error = GetLastError();
  }
  fwprintf(stderr, L"setter-cleanup handles=%u closed=%u error=%lu\n", present, closed, close_error); fflush(stderr);
  if (close_error && !error) error = close_error;
  if (startup.lpAttributeList) {DeleteProcThreadAttributeList(startup.lpAttributeList); free(startup.lpAttributeList);}
  free(line);
  return error;
}
