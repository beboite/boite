/* Diagnostic only. Two inherited handles, regular private files, one absolute
 * five-second handshake inside the unchanged final root deadline. */
enum { AO_REQUEST = 1, AO_READY, AO_GO, AO_ASSIGNED, AO_RELEASE, AO_CLOSED };
typedef struct {
  DWORD magic, version, bytes, phase, mode, setter;
  ULONGLONG setter_created, started, deadline;
  RT_FRAME root;
  wchar_t directory[280];
  NTSTATUS status;
  DWORD error, verified, process_access, map_access, flags, directory_closed, process_closed, directory_error, process_error;
  ULONGLONG now, set_at, directory_close_at, process_close_at;
} AO_FRAME;
static unsigned int ao_files_acquired, ao_files_closed;

static DWORD ao_remaining(const AO_FRAME *frame, ULONGLONG tick_deadline) {
  ULONGLONG now = ownership_wall_ms(), tick = GetTickCount64();
  if (now >= frame->deadline || tick >= tick_deadline) return 0;
  ULONGLONG wall_left = frame->deadline - now, tick_left = tick_deadline - tick;
  return (DWORD)(wall_left < tick_left ? wall_left : tick_left);
}
static DWORD ao_file(const wchar_t *prefix, const wchar_t *phase, AO_FRAME *frame, BOOL write) {
  wchar_t path[4300]; int n = swprintf(path, 4300, L"%ls.anchor.%ls", prefix, phase);
  if (n < 0 || n >= 4300) return ERROR_INSUFFICIENT_BUFFER;
  HANDLE file = CreateFileW(path, write ? GENERIC_WRITE : GENERIC_READ, write ? 0 : FILE_SHARE_READ,
    NULL, write ? CREATE_NEW : OPEN_EXISTING, 0, NULL);
  if (file == INVALID_HANDLE_VALUE) return GetLastError();
  ao_files_acquired++;
  DWORD used = 0, error = 0; LARGE_INTEGER size;
  BOOL ok = write ? WriteFile(file, frame, sizeof(*frame), &used, NULL) : ReadFile(file, frame, sizeof(*frame), &used, NULL);
  if (!ok) {error = GetLastError(); if (!error) error = ERROR_READ_FAULT;}
  else if (used != sizeof(*frame)) error = ERROR_INVALID_DATA;
  if (!error && !write && (!GetFileSizeEx(file, &size) || size.QuadPart != sizeof(*frame))) error = ERROR_INVALID_DATA;
  BOOL closed = CloseHandle(file); DWORD close_error = closed ? 0 : GetLastError();
  if (closed) ao_files_closed++;
  return error ? error : closed ? 0 : close_error ? close_error : ERROR_INVALID_HANDLE;
}
static DWORD ao_wait(const wchar_t *prefix, const wchar_t *phase, AO_FRAME *message,
    const AO_FRAME *identity, HANDLE peer, ULONGLONG tick_deadline) {
  for (;;) {
    if (!ao_remaining(identity, tick_deadline)) return ERROR_TIMEOUT;
    DWORD error = ao_file(prefix, phase, message, FALSE);
    if (!error) return ao_remaining(identity, tick_deadline) ? 0 : ERROR_TIMEOUT;
    if (error != ERROR_FILE_NOT_FOUND && error != ERROR_SHARING_VIOLATION) return error;
    if (peer && WaitForSingleObject(peer, 0) != WAIT_TIMEOUT) {
      /* The peer can close its final proof and exit between our failed open
       * and this wait. Consume that completed file once before rejecting. */
      error = ao_file(prefix, phase, message, FALSE);
      return !error && ao_remaining(identity, tick_deadline) ? 0 : error ? error : ERROR_TIMEOUT;
    }
    Sleep(5);
  }
}
static BOOL ao_message(const AO_FRAME *message, const AO_FRAME *identity, DWORD phase) {
  AO_FRAME a = *message, b = *identity;
  if (a.phase != phase || a.error || a.directory_error || a.process_error || a.now < identity->started || a.now >= identity->deadline) return FALSE;
  if (phase == AO_READY) {
    if (a.status || a.verified != 1 || a.process_access != (PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE) ||
        a.map_access != 3 || a.flags || a.directory_closed || a.process_closed || a.set_at || a.directory_close_at || a.process_close_at) return FALSE;
  } else {
    if (a.verified || a.process_access || a.map_access || a.flags) return FALSE;
    if (phase == AO_GO || phase == AO_RELEASE) {
      if (a.status || a.directory_closed || a.process_closed || a.set_at || a.directory_close_at || a.process_close_at) return FALSE;
    } else if (phase == AO_ASSIGNED) {
      if (a.now != a.set_at || a.directory_closed || a.process_closed || a.directory_close_at || a.process_close_at) return FALSE;
    } else if (phase != AO_CLOSED || a.status || a.directory_closed != 1 || a.process_closed != 1) return FALSE;
  }
  a.phase = b.phase = 0; a.status = b.status = 0; a.error = b.error = 0;
  a.verified = b.verified = a.process_access = b.process_access = a.map_access = b.map_access = 0;
  a.flags = b.flags = a.directory_closed = b.directory_closed = a.process_closed = b.process_closed = 0;
  a.now = b.now = a.set_at = b.set_at = a.directory_close_at = b.directory_close_at = a.process_close_at = b.process_close_at = 0;
  return !memcmp(&a, &b, sizeof(a));
}
static void ao_log(const AO_FRAME *frame, const wchar_t *phase, ULONGLONG now,
    NTSTATUS status, DWORD closed, DWORD verified, DWORD flags, DWORD error) {
  fwprintf(stderr, L"anchor-overlap phase=%ls mode=%ls nonce=%ls helper=%lu helper-created=%llu setter=%lu setter-created=%llu root=%lu created=%llu tid=%lu thread-created=%llu path=%ls now=%llu started=%llu deadline=%llu status=0x%08lx closed=%lu verified=%lu process-access=0x%08lx map-access=0x%08lx flags=%lu error=%lu\n",
    phase, frame->mode == 1 ? L"exclusive" : L"held", frame->root.nonce, frame->root.helper, frame->root.helper_created,
    frame->setter, frame->setter_created, frame->root.root, frame->root.created, frame->root.tid, frame->root.thread_created,
    frame->directory, now, frame->started, frame->deadline, (unsigned long)status, closed, verified,
    (unsigned long)(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE), 3UL, flags, error);
  fflush(stderr);
}
/* One attempt per known slot. Clear before close so an undecidable failure
 * cannot be retried by any later error cleanup. */
static DWORD ao_close(HANDLE *slot, const AO_FRAME *frame, const wchar_t *phase) {
  if (!*slot) return 0;
  HANDLE owned = *slot; *slot = NULL;
  BOOL ok = CloseHandle(owned); DWORD error = ok ? 0 : GetLastError();
  if (!ok && !error) error = ERROR_INVALID_HANDLE;
  ao_log(frame, phase, ownership_wall_ms(), 0, ok, 1, 0, error); return error;
}
static DWORD ao_anchor_close(HANDLE *slot, const AO_FRAME *frame) {
  if (!*slot) return ERROR_INVALID_HANDLE;
  HANDLE owned = *slot; *slot = NULL;
  BOOL ok = CloseHandle(owned); DWORD error = ok ? 0 : GetLastError();
  if (!ok && !error) error = ERROR_INVALID_HANDLE;
  /* No optional object/table query moves with this close. The pair changes
   * this call's overlap only; validation already happened before handoff. */
  fwprintf(stderr,L"cleanup close=retire-named-map closed=%d error=%lu\n",ok,error); fflush(stderr);
  twin_log(L"close-create",0,(NTSTATUS)error,ok,FALSE,0,0,0,0);
  ao_log(frame,L"helper-close",ownership_wall_ms(),0,ok,1,0,error); return error;
}
static DWORD ao_access(HANDLE handle, DWORD access, DWORD flags, const wchar_t *type) {
  struct { ULONG attributes, granted, handles, pointers; ULONG reserved[10]; } info;
  ULONG used = 0; DWORD actual_flags = 0;
  DWORD expected_access = access;
  /* Native Server 26100 grants SET_LIMITED with this exact SET_INFORMATION
   * request. Keep DuplicateHandle's requested mask unchanged and compare the
   * complete observed mask, including this implied right. */
  if (access == (PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE) && !wcscmp(type, L"Process"))
    expected_access |= PROCESS_SET_LIMITED_INFORMATION;
  query_object_fn query = (query_object_fn)(void *)nt_api("NtQueryObject");
  ZeroMemory(&info, sizeof(info));
  NTSTATUS status = query ? query(handle, (OBJECT_INFORMATION_CLASS)0, &info, sizeof(info), &used) : (NTSTATUS)0xc0000002;
  DWORD error = 0, flags_error = 0; BOOL flags_queried = FALSE;
  const wchar_t *check = L"query";
  if (status != 0) error = (DWORD)status;
  else if (used != sizeof(info)) {check = L"size"; error = ERROR_INVALID_DATA;}
  else if (info.granted != expected_access) {check = L"access"; error = ERROR_INVALID_DATA;}
  else {
    flags_queried = TRUE;
    if (!GetHandleInformation(handle, &actual_flags)) {
      flags_error = GetLastError(); check = L"flags-query"; error = ERROR_INVALID_DATA;
    } else if (actual_flags != flags) {check = L"flags"; error = ERROR_INVALID_DATA;}
    else {check = L"type"; error = twin_string(handle, (OBJECT_INFORMATION_CLASS)2, type);}
  }
  /* Keep the exact guard and its short-circuit query order. A failed duplicate
   * must expose the measured mismatch before any setter exists. */
  if (error) {
    fwprintf(stderr, L"anchor-handle-check type=%ls check=%ls query=0x%08lx bytes=%lu expected-bytes=%lu requested=0x%08lx expected-granted=0x%08lx granted=0x%08lx attributes=0x%08lx flags-queried=%d flags=%lu expected-flags=%lu flags-error=%lu error=0x%08lx\n",
      type, check, (unsigned long)status, used, (unsigned long)sizeof(info), access, expected_access, info.granted,
      info.attributes, flags_queried, actual_flags, flags, flags_error, error); fflush(stderr);
  }
  return error;
}
static DWORD ao_topology(const wchar_t *prefix, const wchar_t *phase, const AO_FRAME *frame, ULONGLONG tick_deadline) {
  wchar_t request[4300], release[4300];
  if (swprintf(request, 4300, L"%ls.%ls.request", prefix, phase) < 0 ||
      swprintf(release, 4300, L"%ls.%ls.release", prefix, phase) < 0) return ERROR_INSUFFICIENT_BUFFER;
  char text[1024], root[128], observed[1024];
  if (!wcscmp(phase, L"creator")) memcpy(root, "null", 5);
  else snprintf(root, sizeof(root), "{\"pid\":%lu,\"created\":\"%llu\"}", frame->root.root, frame->root.created);
  int length = snprintf(text, sizeof(text), "{\"version\":1,\"phase\":\"%ls\",\"nonce\":\"%ls\",\"waiting\":%s,\"helper\":{\"pid\":%lu,\"created\":\"%llu\"},\"creator\":{\"pid\":%lu,\"created\":\"%llu\"},\"root\":%s}",
    phase, frame->root.nonce, frame->mode == 2 ? "true" : "false", frame->root.helper, frame->root.helper_created, frame->setter, frame->setter_created, root);
  if (length <= 0 || length >= (int)sizeof(text)) return ERROR_INSUFFICIENT_BUFFER;
  HANDLE file = CreateFileW(request, GENERIC_WRITE, 0, NULL, CREATE_NEW, 0, NULL);
  if (file == INVALID_HANDLE_VALUE) return GetLastError();
  ao_files_acquired++; DWORD bytes = 0, error = 0;
  if (!WriteFile(file, text, (DWORD)length, &bytes, NULL)) error = GetLastError();
  else if (bytes != (DWORD)length) error = ERROR_INVALID_DATA;
  if (CloseHandle(file)) ao_files_closed++; else if (!error) error = GetLastError();
  while (!error && ao_remaining(frame, tick_deadline)) {
    file = CreateFileW(release, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE) {
      DWORD e = GetLastError(); if (e != ERROR_FILE_NOT_FOUND && e != ERROR_SHARING_VIOLATION) {error = e; break;}
      Sleep(5); continue;
    }
    ao_files_acquired++; LARGE_INTEGER size;
    if (!ReadFile(file, observed, sizeof(observed), &bytes, NULL)) error = GetLastError();
    else if (bytes != (DWORD)length || memcmp(text, observed, bytes) || !GetFileSizeEx(file, &size) || size.QuadPart != length) error = ERROR_INVALID_DATA;
    if (CloseHandle(file)) ao_files_closed++; else if (!error) error = GetLastError();
    if (!error && !ao_remaining(frame, tick_deadline)) error = ERROR_TIMEOUT;
    fwprintf(stderr, L"anchor-topology phase=%ls setter=%lu created=%llu proved=%d error=%lu\n", phase, frame->setter, frame->setter_created, !error, error); fflush(stderr);
    return error;
  }
  return error ? error : ERROR_TIMEOUT;
}

static int anchor_setter_entry(int count, wchar_t **args) {
  if (count != 6) return 125;
  HANDLE process = NULL, directory = NULL;
  DWORD error = parse_owned_handle(args[2], &process);
  if (!error) error = parse_owned_handle(args[3], &directory);
  if (error || process == directory) return 125;
  AO_FRAME identity; ZeroMemory(&identity, sizeof(identity));
  error = ao_file(args[4], L"request", &identity, FALSE);
  if (error || identity.magic != 0x414f564c || identity.version != 1 || identity.bytes != sizeof(identity) || identity.phase != AO_REQUEST ||
      identity.mode < 1 || identity.mode > 2 || identity.setter != GetCurrentProcessId() || identity.setter_created != rt_created(GetCurrentProcess(), FALSE) ||
      identity.root.helper == identity.setter || identity.root.root == identity.setter || identity.root.root == identity.root.helper ||
      identity.root.nonce[32] || wcslen(args[5]) != 32 || memcmp(identity.root.nonce, args[5], 33 * sizeof(wchar_t)) ||
      !wmemchr(identity.directory, 0, 280) || identity.deadline != (identity.started + 5000 < identity.root.deadline ? identity.started + 5000 : identity.root.deadline) ||
      identity.status || identity.error || identity.verified || identity.process_access || identity.map_access || identity.flags || identity.directory_closed ||
      identity.process_closed || identity.directory_error || identity.process_error || identity.set_at || identity.directory_close_at || identity.process_close_at ||
      identity.root.magic != 0x5254544d || identity.root.version != 1 || !identity.root.helper_created || !identity.root.thread_created ||
      identity.root.result != 1 || identity.root.thread_owner != identity.root.root || identity.root.deadline != identity.root.started + 15000 ||
      tc_parent(GetCurrentProcess(), identity.setter, identity.root.helper)) return 125;
  wchar_t nonce[34], expected_name[280]; DWORD session = 0;
  if (rt_nonce(nonce) || memcmp(nonce, identity.root.nonce, sizeof(identity.root.nonce)) ||
      !ProcessIdToSessionId(GetCurrentProcessId(), &session)) return 125;
  if (session) swprintf(expected_name, 280, L"\\Sessions\\%lu\\BaseNamedObjects\\boite.route.%lu.retired", session, identity.root.helper);
  else swprintf(expected_name, 280, L"\\BaseNamedObjects\\boite.route.%lu.retired", identity.root.helper);
  if (wcscmp(expected_name, identity.directory) || GetProcessId(process) != identity.root.root || rt_created(process, FALSE) != identity.root.created ||
      WaitForSingleObject(process, 0) != WAIT_TIMEOUT || twin_string(directory, (OBJECT_INFORMATION_CLASS)1, identity.directory) ||
      ao_access(process, PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, HANDLE_FLAG_INHERIT, L"Process") ||
      ao_access(directory, 3, HANDLE_FLAG_INHERIT, L"Directory")) return 125;
  /* All explicit closes below are now authorized by captured identity/type/name.
   * Invalid pre-validation requests exit without touching numeric arguments. */
  ULONGLONG wall = ownership_wall_ms(), tick_deadline = GetTickCount64() + (wall < identity.deadline ? identity.deadline - wall : 0);
  AO_FRAME message = identity;
  if (!SetHandleInformation(process, HANDLE_FLAG_INHERIT, 0) || !SetHandleInformation(directory, HANDLE_FLAG_INHERIT, 0)) error = GetLastError();
  if (!error) error = ao_access(process, PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, L"Process");
  if (!error) error = ao_access(directory, 3, 0, L"Directory");
  if (!error) {
    message.phase = AO_READY; message.now = ownership_wall_ms(); message.verified = 1;
    message.process_access = PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE; message.map_access = 3;
    error = ao_file(args[4], L"ready", &message, TRUE);
  }
  wchar_t fault[32] = {0}; GetEnvironmentVariableW(L"BOITE_DIAGNOSTIC_ANCHOR_FAULT", fault, 32);
  if (!error && !wcscmp(fault, L"stall")) {
    while (ao_remaining(&identity, tick_deadline)) Sleep(5);
    error = ERROR_TIMEOUT;
  }
  if (!error) error = ao_wait(args[4], L"go", &message, &identity, process, tick_deadline);
  if (!error && (!ao_message(&message, &identity, AO_GO) || message.status || message.directory_closed || message.process_closed)) error = ERROR_INVALID_DATA;
  if (!error && (!ao_remaining(&identity, tick_deadline) || GetProcessId(process) != identity.root.root ||
      rt_created(process, FALSE) != identity.root.created || WaitForSingleObject(process, 0) != WAIT_TIMEOUT)) error = ERROR_INVALID_DATA;
  if (!error) {
    typedef NTSTATUS (NTAPI *set_fn)(HANDLE, PROCESSINFOCLASS, PVOID, ULONG);
    set_fn set = (set_fn)(void *)nt_api("NtSetInformationProcess");
    if (!set) error = ERROR_PROC_NOT_FOUND;
    else {
      message = identity; message.phase = AO_ASSIGNED;
      message.status = set(process, (PROCESSINFOCLASS)23, &directory, sizeof(directory));
      message.now = message.set_at = ownership_wall_ms();
      if (!wcscmp(fault, L"assigned")) message.root.nonce[0] = message.root.nonce[0] == L'a' ? L'b' : L'a';
      error = ao_file(args[4], L"assigned", &message, TRUE);
      if (!error && message.status) error = (DWORD)message.status;
    }
  }
  ULONGLONG set_at = message.set_at;
  if (!error) error = ao_wait(args[4], L"release", &message, &identity, process, tick_deadline);
  if (!error && (!ao_message(&message, &identity, AO_RELEASE) || message.status || message.directory_closed || message.process_closed)) error = ERROR_INVALID_DATA;
  message = identity; message.phase = AO_CLOSED; message.set_at = set_at;
  BOOL closed = CloseHandle(directory); DWORD e = closed ? 0 : GetLastError(); directory = NULL;
  message.directory_closed = closed; message.directory_error = closed ? 0 : e ? e : ERROR_INVALID_HANDLE;
  message.directory_close_at = ownership_wall_ms(); if (!error && !closed) error = message.directory_error;
  closed = CloseHandle(process); e = closed ? 0 : GetLastError(); process = NULL;
  message.process_closed = closed; message.process_error = closed ? 0 : e ? e : ERROR_INVALID_HANDLE;
  message.process_close_at = ownership_wall_ms(); if (!error && !closed) error = message.process_error;
  message.now = ownership_wall_ms(); message.error = error;
  DWORD written = ao_file(args[4], L"closed", &message, TRUE); if (!error) error = written;
  if (ao_files_acquired != ao_files_closed && !error) error = ERROR_INVALID_HANDLE;
  return error ? 125 : 0;
}

static DWORD anchor_overlap_assign(PROCESS_INFORMATION *root, HANDLE target_job, HANDLE *anchor) {
  AO_FRAME identity; ZeroMemory(&identity, sizeof(identity));
  identity.magic = 0x414f564c; identity.version = 1; identity.bytes = sizeof(identity); identity.phase = AO_REQUEST;
  identity.mode = (DWORD)anchor_overlap_mode; identity.root = rt_frame;
  memcpy(identity.directory, retired_name, sizeof(retired_name));
  identity.started = ownership_wall_ms(); identity.deadline = identity.started + 5000;
  if (identity.deadline > rt_frame.deadline) identity.deadline = rt_frame.deadline;
  ULONGLONG tick_deadline = GetTickCount64() + (identity.started < identity.deadline ? identity.deadline - identity.started : 0);
  wchar_t prefix[4096], image[4096], process_text[32], map_text[32], fault[32] = {0};
  DWORD prefix_size = GetEnvironmentVariableW(L"BOITE_ANCHOR_CONTROL", prefix, 4096);
  DWORD image_size = GetModuleFileNameW(NULL, image, 4096);
  if (!prefix_size || prefix_size >= 4096 || !image_size || image_size >= 4096 || !ao_remaining(&identity, tick_deadline)) return ERROR_INVALID_DATA;
  GetEnvironmentVariableW(L"BOITE_DIAGNOSTIC_ANCHOR_FAULT", fault, 32);
  HANDLE passed[2] = {NULL,NULL}, job = NULL; PROCESS_INFORMATION child; STARTUPINFOEXW startup;
  ZeroMemory(&child, sizeof(child)); ZeroMemory(&startup, sizeof(startup)); startup.StartupInfo.cb = sizeof(startup);
  SIZE_T bytes = 0; wchar_t *line = NULL; BOOL initialized = FALSE, member = FALSE, forced = FALSE;
  DWORD error = 0, code = STILL_ACTIVE, acquired = 0, closed_count = 0; ULONGLONG duplicated_at[2] = {0,0};
  typedef NTSTATUS (NTAPI *compare_fn)(HANDLE,HANDLE);
  compare_fn compare = (compare_fn)(void *)nt_api("NtCompareObjects");
  if (!compare) return ERROR_PROC_NOT_FOUND;
  for (int i = 0; i < 2; i++) {
    DWORD access = i ? 3 : PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE;
    if (!DuplicateHandle(GetCurrentProcess(), i ? *anchor : root->hProcess, GetCurrentProcess(), &passed[i], access, TRUE, 0)) {
      error = GetLastError(); passed[i] = NULL; if (!error) error = ERROR_INVALID_HANDLE; goto end;
    }
    acquired++; duplicated_at[i] = ownership_wall_ms();
    error = ao_access(passed[i], access, HANDLE_FLAG_INHERIT, i ? L"Directory" : L"Process");
    if (!error) {
      NTSTATUS compared = compare(passed[i], i ? *anchor : root->hProcess);
      if (compared) {
        error = ERROR_INVALID_DATA;
        fwprintf(stderr, L"anchor-handle-compare type=%ls status=0x%08lx error=%lu\n",
          i ? L"Directory" : L"Process", (unsigned long)compared, error); fflush(stderr);
      }
    }
    if (error) goto end;
  }
  swprintf(process_text, 32, L"%llu", (unsigned long long)(uintptr_t)passed[0]);
  swprintf(map_text, 32, L"%llu", (unsigned long long)(uintptr_t)passed[1]);
  wchar_t *argv[] = {image, L"anchor-setter", process_text, map_text, prefix, rt_frame.nonce};
  line = command_line(6, argv); if (!line) {error = ERROR_NOT_ENOUGH_MEMORY; goto end;}
  InitializeProcThreadAttributeList(NULL, 1, 0, &bytes);
  startup.lpAttributeList = malloc(bytes); if (!startup.lpAttributeList) {error = ERROR_NOT_ENOUGH_MEMORY; goto end;}
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes)) {error = GetLastError(); goto end;}
  initialized = TRUE;
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, passed, sizeof(passed), NULL, NULL)) {error = GetLastError(); goto end;}
  job = CreateJobObjectW(NULL,NULL); if (!job) {error = GetLastError(); goto end;} acquired++;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits; ZeroMemory(&limits, sizeof(limits)); limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {error = GetLastError(); goto end;}
  if (!CreateProcessW(image, line, NULL, NULL, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
      NULL, NULL, &startup.StartupInfo, &child)) {
    error = GetLastError(); ZeroMemory(&child,sizeof(child)); if (!error) error = ERROR_PROCESS_ABORTED; goto end;
  }
  acquired += 2; identity.setter = child.dwProcessId; identity.setter_created = rt_created(child.hProcess, FALSE);
  error = tc_verify_creator(child.hProcess, child.dwProcessId, image, target_job);
  if (!error && (!identity.setter_created || !AssignProcessToJobObject(job, child.hProcess) || !IsProcessInJob(child.hProcess, job, &member) || !member)) error = ERROR_INVALID_DATA;
  BOOL target_member = TRUE;
  if (!error && (!IsProcessInJob(root->hProcess, job, &target_member) || target_member)) error = ERROR_INVALID_DATA;
  if (error) goto end;
  ao_log(&identity,L"duplicate-process",duplicated_at[0],0,0,1,1,0);
  ao_log(&identity,L"duplicate-directory",duplicated_at[1],0,0,1,1,0);
  ao_log(&identity,L"start",ownership_wall_ms(),0,0,1,0,0);
  fwprintf(stderr,L"anchor-confinement setter=%lu inherited=2 member=1 private=0 image=1 token=1\n",identity.setter); fflush(stderr);
  for (int i = 0; i < 2; i++) {
    DWORD e = ao_close(&passed[i],&identity,i ? L"close-transfer-directory" : L"close-transfer-process");
    if (!e) closed_count++; else if (!error) error = e;
  }
  if (error) goto end;
  error = ao_topology(prefix,L"creator",&identity,tick_deadline);
  if (!error) error = ao_topology(prefix,L"root",&identity,tick_deadline);
  if (error) goto end;
  AO_FRAME message = identity; message.now = ownership_wall_ms();
  if (!wcscmp(fault,L"nonce")) message.root.nonce[0] = message.root.nonce[0] == L'a' ? L'b' : L'a';
  error = ao_file(prefix,L"request",&message,TRUE); if (error) goto end;
  ao_log(&identity,L"request",message.now,0,0,1,0,0);
  if (ResumeThread(child.hThread) != 1) {error = ERROR_INVALID_DATA; goto end;}
  error = ao_wait(prefix,L"ready",&message,&identity,child.hProcess,tick_deadline);
  if (!error && (!ao_message(&message,&identity,AO_READY) || !message.verified || message.status || message.process_access != (PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE) || message.map_access != 3 || message.flags || message.directory_closed || message.process_closed)) error = ERROR_INVALID_DATA;
  if (error) goto end;
  ao_log(&identity,L"child-ready",message.now,0,0,1,0,0);
  if (anchor_overlap_mode == 1) {
    error = ao_anchor_close(anchor,&identity); if (error) goto end;
  }
  message = identity; message.phase = !wcscmp(fault,L"early-release") ? AO_RELEASE : AO_GO; message.now = ownership_wall_ms();
  error = ao_file(prefix,L"go",&message,TRUE); if (error) goto end;
  ao_log(&identity,L"go",message.now,0,0,1,0,0);
  error = ao_wait(prefix,L"assigned",&message,&identity,child.hProcess,tick_deadline);
  if (!error && (!ao_message(&message,&identity,AO_ASSIGNED) || message.status || message.now != message.set_at || message.directory_closed || message.process_closed)) error = ERROR_INVALID_DATA;
  if (error) goto end;
  ao_log(&identity,L"child-set",message.set_at,message.status,0,1,0,0);
  twin_log(L"set",0,message.status,FALSE,FALSE,0,0,0,0);
  fwprintf(stderr,L"map-retire live pid=%lu set=0x%08lx named=1 inherited=0 links=0\n",root->dwProcessId,(unsigned long)message.status); fflush(stderr);
  ULONGLONG set_at = message.set_at;
  if (anchor_overlap_mode == 2) {
    error = ao_anchor_close(anchor,&identity); if (error) goto end;
  }
  message = identity; message.phase = AO_RELEASE; message.now = ownership_wall_ms();
  if (!wcscmp(fault,L"release")) message.root.nonce[0] = message.root.nonce[0] == L'a' ? L'b' : L'a';
  error = ao_file(prefix,L"release",&message,TRUE); if (error) goto end;
  ao_log(&identity,L"release",message.now,0,0,1,0,0);
  error = ao_wait(prefix,L"closed",&message,&identity,child.hProcess,tick_deadline);
  if (!error && (!ao_message(&message,&identity,AO_CLOSED) || message.status || message.set_at != set_at || !message.directory_closed || !message.process_closed ||
      message.directory_close_at < set_at || message.process_close_at < message.directory_close_at || message.now < message.process_close_at)) error = ERROR_INVALID_DATA;
  if (error) goto end;
  ao_log(&identity,L"child-close-directory",message.directory_close_at,0,message.directory_closed,1,0,0);
  ao_log(&identity,L"child-close-process",message.process_close_at,0,message.process_closed,1,0,0);
  DWORD waited = WaitForSingleObject(child.hProcess,ao_remaining(&identity,tick_deadline));
  if (waited != WAIT_OBJECT_0 || !GetExitCodeProcess(child.hProcess,&code) || code || !ao_remaining(&identity,tick_deadline)) {error = ERROR_PROCESS_ABORTED; goto end;}
  ao_log(&identity,L"child-exit",ownership_wall_ms(),0,0,1,0,0);
end:
  if (child.hProcess && WaitForSingleObject(child.hProcess,0) != WAIT_OBJECT_0) {
    forced = TRUE;
    BOOL killed = member ? TerminateJobObject(job,125) : TerminateProcess(child.hProcess,125);
    DWORD e = killed ? 0 : GetLastError();
    DWORD waited = WaitForSingleObject(child.hProcess,1000);
    if (!error) error = e ? e : waited != WAIT_OBJECT_0 ? ERROR_TIMEOUT : ERROR_OPERATION_ABORTED;
    if (waited != WAIT_OBJECT_0) {fputws(L"anchor-forced-incomplete joined=0\n",stderr); fflush(stderr);}
  }
  if (child.hProcess && WaitForSingleObject(child.hProcess,0) == WAIT_OBJECT_0 && !GetExitCodeProcess(child.hProcess,&code) && !error) error = GetLastError();
  HANDLE *slots[] = {&passed[0],&passed[1],&child.hThread,&child.hProcess,&job};
  const wchar_t *labels[] = {L"close-transfer-process",L"close-transfer-directory",L"close-parent-thread",L"close-parent-process",L"close-parent-job"};
  for (int i = 0; i < 5; i++) if (*slots[i]) {
    DWORD e = ao_close(slots[i],&identity,labels[i]); if (!e) closed_count++; else if (!error) error = e;
  }
  if (initialized) DeleteProcThreadAttributeList(startup.lpAttributeList);
  free(startup.lpAttributeList); free(line);
  if (!error) error = ao_topology(prefix,L"closed",&identity,tick_deadline);
  if (!error) ao_log(&identity,L"registry-closed",ownership_wall_ms(),0,0,1,0,0);
  if (!error && (acquired != closed_count || ao_files_acquired != ao_files_closed)) error = ERROR_INVALID_HANDLE;
  fwprintf(stderr,L"anchor-cleanup setter=%lu created=%llu acquired=%lu closed=%lu files-acquired=%u files-closed=%u forced=%d exit=%lu error=%lu\n",
    identity.setter,identity.setter_created,acquired,closed_count,ao_files_acquired,ao_files_closed,forced,code,error); fflush(stderr);
  if (!error) error = rt_identity(root,TRUE);
  return error;
}
