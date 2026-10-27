/* Target creation only moves to this trusted intermediary. Map creation,
 * token setup, confinement verification, assignment and resume stay outside.
 * In particular the intermediary has NO extra job and never resumes a target. */
#include "target-acl.h"
enum { TC_REQUEST = 1, TC_READY, TC_HANDOFF, TC_RELEASED, TC_EXIT, TC_DONE, TC_HOLD, TC_HELD };
typedef struct {
  DWORD version, bytes, phase, error, helper, creator, pid, tid, closed, io_acquired, io_closed;
  ULONGLONG creator_created, process_created, process, thread;
  BYTE nonce[16];
} TC_FRAME;
typedef struct {
  TC_FRAME frame;
  DWORD security_bytes, app_bytes, capability_bytes;
  ULONGLONG inherited[5], helper_created;
  wchar_t profile[256], image[4096], line[32768], cwd[4096], desktop[256];
  BYTE security[2048], app[SECURITY_MAX_SID_SIZE], capability[SECURITY_MAX_SID_SIZE];
} TC_PACKET;
typedef struct {OVERLAPPED operation; BYTE buffer[sizeof(TC_PACKET)];} TC_IO;
static TC_IO *tc_pending;
static unsigned int tc_io_acquired, tc_io_closed;
static int target_creator_mode; /* 1 exited, 2 waiting, 3 helper exited; otherwise original code. */
static HANDLE tc_pipe, tc_process, tc_thread;
static TC_FRAME tc_identity;
static ULONGLONG tc_deadline;
static BOOL tc_released, tc_close_failed;

static DWORD tc_close(HANDLE *handle) {
  if (!*handle || *handle == INVALID_HANDLE_VALUE) return 0;
  HANDLE owned = *handle; *handle = NULL;
  if (!CloseHandle(owned)) {
    DWORD error = GetLastError(); tc_close_failed = TRUE;
    /* Failed closure makes this value undecidable. Never query or retry it. */
    return error ? error : ERROR_INVALID_HANDLE;
  }
  return 0;
}
static DWORD tc_free_io(TC_IO *io) {
  DWORD error = CloseHandle(io->operation.hEvent) ? 0 : GetLastError();
  if (!error) tc_io_closed++;
  HeapFree(GetProcessHeap(), 0, io); return error;
}
static DWORD tc_exchange(HANDLE pipe, HANDLE peer, void *data, DWORD bytes, BOOL write, ULONGLONG deadline) {
  if (!bytes || bytes > sizeof(TC_PACKET) || tc_pending) return ERROR_INVALID_DATA;
  if (!creator_remaining(deadline)) return ERROR_TIMEOUT;
  TC_IO *io = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*io));
  if (!io) return ERROR_NOT_ENOUGH_MEMORY;
  io->operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!io->operation.hEvent) {DWORD e = GetLastError(); HeapFree(GetProcessHeap(), 0, io); return e;}
  tc_io_acquired++;
  if (write) memcpy(io->buffer, data, bytes);
  DWORD used = 0, error = 0; BOOL pending = FALSE;
  BOOL ok = write ? WriteFile(pipe, io->buffer, bytes, &used, &io->operation)
    : ReadFile(pipe, io->buffer, bytes, &used, &io->operation);
  if (!ok) {
    error = GetLastError(); pending = error == ERROR_IO_PENDING;
    if (pending) {
      HANDLE waits[2] = {io->operation.hEvent, peer};
      DWORD waited = WaitForMultipleObjects(peer ? 2 : 1, waits, FALSE, creator_remaining(deadline));
      if (waited == WAIT_OBJECT_0) {
        ok = GetOverlappedResult(pipe, &io->operation, &used, FALSE);
        error = ok ? 0 : GetLastError(); pending = !ok && error == ERROR_IO_INCOMPLETE;
      } else error = waited == WAIT_TIMEOUT ? ERROR_TIMEOUT : waited == WAIT_OBJECT_0 + 1
        ? ERROR_PROCESS_ABORTED : GetLastError();
    }
  }
  if (pending) {
    BOOL cancelled = CancelIoEx(pipe, &io->operation); DWORD cancel_error = cancelled ? 0 : GetLastError();
    DWORD waited = WaitForSingleObject(io->operation.hEvent, 1000);
    fwprintf(stderr, L"target-creator-io cancelled=%d cancel-error=%lu drained=%d\n", cancelled, cancel_error, waited == WAIT_OBJECT_0);
    fflush(stderr);
    if (waited != WAIT_OBJECT_0) {tc_pending = io; return error ? error : ERROR_IO_INCOMPLETE;}
    DWORD drained = 0;
    BOOL done = GetOverlappedResult(pipe, &io->operation, &drained, FALSE);
    if (!done && GetLastError() == ERROR_IO_INCOMPLETE) {tc_pending = io; return ERROR_IO_INCOMPLETE;}
  }
  if (!error && (used != bytes || !creator_remaining(deadline))) error = used != bytes ? ERROR_INVALID_DATA : ERROR_TIMEOUT;
  if (!error && !write) memcpy(data, io->buffer, bytes);
  DWORD closed = tc_free_io(io); return error ? error : closed;
}
static DWORD tc_times(HANDLE process, ULONGLONG *value) {
  FILETIME created, exited, kernel, user; ULARGE_INTEGER v;
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) return GetLastError();
  v.LowPart = created.dwLowDateTime; v.HighPart = created.dwHighDateTime; *value = v.QuadPart;
  return *value ? 0 : ERROR_INVALID_DATA;
}
static BOOL tc_frame(const TC_FRAME *f, const TC_FRAME *identity, DWORD phase, DWORD bytes) {
  return f->version == 1 && f->bytes == bytes && f->phase == phase && !f->error &&
    f->helper == identity->helper && f->creator == identity->creator &&
    f->creator_created == identity->creator_created && !memcmp(f->nonce, identity->nonce, 16);
}
static DWORD tc_parent(HANDLE process, DWORD pid, DWORD parent) {
  struct {NTSTATUS status; PVOID peb; ULONG_PTR affinity; LONG priority; ULONG_PTR pid, parent;} info;
  ULONG used = 0; ZeroMemory(&info, sizeof(info));
  query_process_fn query = (query_process_fn)(void *)nt_api("NtQueryInformationProcess");
  NTSTATUS status = query ? query(process, (PROCESSINFOCLASS)0, &info, sizeof(info), &used) : (NTSTATUS)0xc0000002;
  return status != 0 || used != sizeof(info) || info.pid != pid || info.parent != parent ? ERROR_INVALID_DATA : 0;
}
static DWORD tc_security(HANDLE object, PSECURITY_DESCRIPTOR expected, DWORD all_access,
    const wchar_t *role, BOOL fault) {
  PACL wanted = NULL, actual = NULL; BOOL present = FALSE, defaulted = FALSE;
  if (!GetSecurityDescriptorDacl(expected, &present, &wanted, &defaulted) || !present || !wanted || !IsValidAcl(wanted)) return ERROR_INVALID_ACL;
  PSECURITY_DESCRIPTOR observed = NULL;
  DWORD error = GetSecurityInfo(object, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, &actual, NULL, &observed);
  SECURITY_DESCRIPTOR_CONTROL wanted_control = 0, actual_control = 0; DWORD revision = 0;
  if (!error && (!GetSecurityDescriptorControl(expected, &wanted_control, &revision) ||
      !GetSecurityDescriptorControl(observed, &actual_control, &revision))) error = GetLastError();
  BOOL valid = actual && IsValidAcl(actual);
  BOOL raw_equal = valid && wanted->AclSize == actual->AclSize && !memcmp(wanted, actual, wanted->AclSize);
  BOOL protected_equal = (wanted_control & SE_DACL_PROTECTED) && (actual_control & SE_DACL_PROTECTED);
  // Faults alter only the comparison's expected rights, never either object.
  BOOL exact = !error && valid && protected_equal && target_acl_matches(wanted, wanted->AclSize,
    actual, actual->AclSize, fault ? all_access & ~DELETE : all_access);
  if (!error && !exact) error = ERROR_INVALID_ACL;
  fwprintf(stderr, L"target-creator-security role=%ls mapping=0x%08lx raw-equal=%d exact=%d protected=%d fault=%d error=%lu expected-bytes=%u actual-bytes=%u expected-aces=%u actual-aces=%u\n",
    role, all_access, raw_equal, exact, protected_equal, fault, error,
    wanted->AclSize, valid ? actual->AclSize : 0, wanted->AceCount, valid ? actual->AceCount : 0);
  if (valid) for (DWORD i = 0; i < wanted->AceCount && i < actual->AceCount; i++) {
    PVOID w = NULL, a = NULL;
    if (GetAce(wanted, i, &w) && GetAce(actual, i, &a) &&
        ((ACE_HEADER *)w)->AceSize >= 8 && ((ACE_HEADER *)a)->AceSize >= 8)
      fwprintf(stderr, L"target-creator-ace role=%ls index=%lu expected-mask=0x%08lx actual-mask=0x%08lx\n",
        role, i, ((ACCESS_ALLOWED_ACE *)w)->Mask, ((ACCESS_ALLOWED_ACE *)a)->Mask);
  }
  fflush(stderr);
  if (observed) LocalFree(observed);
  return error;
}
static BOOL tc_sid(const BYTE *data, DWORD bytes) {
  return bytes >= 8 && bytes <= SECURITY_MAX_SID_SIZE && data[1] <= SID_MAX_SUB_AUTHORITIES &&
    bytes == 8 + (DWORD)data[1] * 4 && IsValidSid((PSID)data) && GetLengthSid((PSID)data) == bytes;
}
/* A private synthetic control directory is outside every setup grant. Echo the
 * exact nonce/identities, never accept a bare release file or an ambient PID. */
static DWORD tc_barrier(const wchar_t *phase, const PROCESS_INFORMATION *root) {
  wchar_t prefix[4096], request[4200], release[4200], nonce[33];
  DWORD length = GetEnvironmentVariableW(L"BOITE_TARGET_CREATOR_BARRIER", prefix, 4096);
  if (!length || length >= 4096) return ERROR_INVALID_PARAMETER;
  if (swprintf(request, 4200, L"%ls.%ls.request", prefix, phase) < 0 ||
      swprintf(release, 4200, L"%ls.%ls.release", prefix, phase) < 0) return ERROR_INSUFFICIENT_BUFFER;
  for (int i = 0; i < 16; i++) swprintf(nonce + i * 2, 3, L"%02x", tc_identity.nonce[i]);
  ULONGLONG helper_created = 0, root_created = 0;
  DWORD error = tc_times(GetCurrentProcess(), &helper_created);
  if (!error && root) error = tc_times(root->hProcess, &root_created);
  if (error) return error;
  char text[1024], observed[1024], root_text[128];
  if (!root && !wcscmp(phase, L"closed")) root_created = tc_identity.process_created;
  DWORD root_pid = root ? root->dwProcessId : root_created ? tc_identity.pid : 0;
  if (root_pid) snprintf(root_text, sizeof(root_text), "{\"pid\":%lu,\"created\":\"%llu\"}",
    root_pid, (unsigned long long)root_created);
  else memcpy(root_text, "null", 5);
  int bytes = snprintf(text, sizeof(text), "{\"version\":1,\"phase\":\"%ls\",\"nonce\":\"%ls\",\"waiting\":%s,"
    "\"helper\":{\"pid\":%lu,\"created\":\"%llu\"},\"creator\":{\"pid\":%lu,\"created\":\"%llu\"},\"root\":%s}\n",
    phase, nonce, target_creator_mode >= 2 ? "true" : "false", GetCurrentProcessId(), (unsigned long long)helper_created, tc_identity.creator,
    (unsigned long long)tc_identity.creator_created, root_text);
  if (bytes <= 0 || bytes >= (int)sizeof(text)) return ERROR_INSUFFICIENT_BUFFER;
  HANDLE file = CreateFileW(request, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return GetLastError();
  DWORD used = 0;
  if (!WriteFile(file, text, (DWORD)bytes, &used, NULL) || used != (DWORD)bytes) error = ERROR_WRITE_FAULT;
  DWORD closed = tc_close(&file); if (!error) error = closed;
  ULONGLONG deadline = GetTickCount64() + 5000;
  while (!error && creator_remaining(deadline)) {
    file = CreateFileW(release, GENERIC_READ, 0, NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (file != INVALID_HANDLE_VALUE) {
      BY_HANDLE_FILE_INFORMATION info; used = 0;
      if (!GetFileInformationByHandle(file, &info) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
          !ReadFile(file, observed, sizeof(observed), &used, NULL) || used != (DWORD)bytes || memcmp(observed, text, used))
        error = ERROR_INVALID_DATA;
      closed = tc_close(&file); if (!error) error = closed;
      fwprintf(stderr, L"target-creator-topology phase=%ls helper=%lu creator=%lu root=%lu nonce=1 proved=%d error=%lu\n",
        phase, GetCurrentProcessId(), tc_identity.creator, root_pid, !error, error); fflush(stderr);
      return error;
    }
    DWORD open_error = GetLastError();
    if (open_error != ERROR_FILE_NOT_FOUND && open_error != ERROR_SHARING_VIOLATION) return open_error;
    if (tc_process && WaitForSingleObject(tc_process, 0) != WAIT_TIMEOUT) return ERROR_PROCESS_ABORTED;
    Sleep(10);
  }
  return error ? error : ERROR_TIMEOUT;
}
#include "helper-job.h"

/* Exact pinned image identity and unchanged caller token/session, using only
 * captured process handles. No PID reopening and no privilege changes. */
static DWORD tc_verify_creator(HANDLE process, DWORD pid, const wchar_t *image, HANDLE target_job) {
  wchar_t path[4096]; DWORD length = 4096; BOOL private_member = TRUE, any_member = FALSE;
  DWORD error = tc_parent(process, pid, GetCurrentProcessId());
  HANDLE files[2] = {INVALID_HANDLE_VALUE, INVALID_HANDLE_VALUE}, tokens[2] = {NULL, NULL};
  if (!error && (!QueryFullProcessImageNameW(process, 0, path, &length) ||
      !IsProcessInJob(process, target_job, &private_member) || private_member ||
      !IsProcessInJob(process, NULL, &any_member) || !any_member)) error = ERROR_INVALID_DATA;
  BY_HANDLE_FILE_INFORMATION ids[2];
  if (!error) for (int i = 0; i < 2; i++) {
    files[i] = CreateFileW(i ? path : image, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (files[i] == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(files[i], &ids[i])) {error = GetLastError(); break;}
  }
  if (!error && !same_file(&ids[0], &ids[1])) error = ERROR_INVALID_DATA;
  BYTE a[4096], b[4096]; DWORD na = 0, nb = 0;
  if (!error && (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tokens[0]) ||
      !OpenProcessToken(process, TOKEN_QUERY, &tokens[1]))) error = GetLastError();
  TOKEN_INFORMATION_CLASS classes[] = {TokenUser, TokenIntegrityLevel, TokenPrivileges, TokenIsAppContainer, TokenSessionId, TokenStatistics};
  if (!error) for (unsigned int i = 0; i < sizeof(classes) / sizeof(classes[0]); i++) {
    if (!GetTokenInformation(tokens[0], classes[i], a, sizeof(a), &na) ||
        !GetTokenInformation(tokens[1], classes[i], b, sizeof(b), &nb)) {error = GetLastError(); break;}
    BOOL equal = na == nb;
    if (classes[i] == TokenUser) equal = EqualSid(((TOKEN_USER *)a)->User.Sid, ((TOKEN_USER *)b)->User.Sid);
    else if (classes[i] == TokenIntegrityLevel) equal = EqualSid(((TOKEN_MANDATORY_LABEL *)a)->Label.Sid, ((TOKEN_MANDATORY_LABEL *)b)->Label.Sid);
    else if (classes[i] == TokenStatistics) equal = !memcmp(&((TOKEN_STATISTICS *)a)->AuthenticationId,
      &((TOKEN_STATISTICS *)b)->AuthenticationId, sizeof(LUID));
    else equal = equal && !memcmp(a, b, na);
    if (!equal || (classes[i] == TokenIsAppContainer && *(DWORD *)b)) {error = ERROR_INVALID_DATA; break;}
  }
  for (int i = 0; i < 2; i++) {
    DWORD e = tc_close(&tokens[i]); if (!error) error = e;
    e = tc_close(&files[i]); if (!error) error = e;
  }
  return error;
}
static int target_creator_entry(int count, wchar_t **args) {
  if (count != 10) return 125;
  HANDLE inherited[5] = {NULL, NULL, NULL, NULL, NULL};
  /* Only explicit inherited values can be adopted. Invalid arguments authorize
   * no search or guessed close; process exit closes its actual table. */
  for (int i = 0; i < 5; i++) if (parse_owned_handle(args[2 + i], &inherited[i])) return 125;
  for (int i = 0; i < 5; i++) for (int j = 0; j < i; j++) if (inherited[i] == inherited[j]) return 125;
  DWORD flags = 0, server = 0, error = 0;
  if (GetFileType(inherited[0]) != FILE_TYPE_PIPE ||
      !GetNamedPipeInfo(inherited[0], &flags, NULL, NULL, NULL) || (flags & PIPE_SERVER_END) ||
      !GetNamedPipeServerProcessId(inherited[0], &server)) return 125;
  wchar_t *end = NULL; unsigned long parent = wcstoul(args[7], &end, 10);
  if (!parent || !*args[7] || !end || *end || server != parent) return 125;
  TC_FRAME expected; ZeroMemory(&expected, sizeof(expected));
  expected.version = 1; expected.helper = parent; expected.creator = GetCurrentProcessId();
  if (creator_nonce(args[8], expected.nonce) || tc_times(GetCurrentProcess(), &expected.creator_created) ||
      tc_parent(GetCurrentProcess(), expected.creator, parent)) return 125;
  for (int i = 0; i < 5; i++) if (!SetHandleInformation(inherited[i], HANDLE_FLAG_INHERIT, 0)) return 125;
  ULONGLONG deadline = GetTickCount64() + 5000, lifetime = GetTickCount64() + 30000;
  TC_PACKET *request = calloc(1, sizeof(*request));
  LPPROC_THREAD_ATTRIBUTE_LIST list = NULL; BOOL initialized = FALSE;
  PROCESS_INFORMATION root; ZeroMemory(&root, sizeof(root));
  if (!request) {error = ERROR_NOT_ENOUGH_MEMORY; goto done;}
  error = tc_exchange(inherited[0], NULL, request, sizeof(*request), FALSE, deadline); if (error) goto done;
  if (!tc_frame(&request->frame, &expected, TC_REQUEST, sizeof(*request)) ||
      !wmemchr(request->profile, 0, 256) || !wmemchr(request->image, 0, 4096) ||
      !wmemchr(request->line, 0, 32768) || !wmemchr(request->cwd, 0, 4096) || !wmemchr(request->desktop, 0, 256) ||
      !*request->image || !*request->line || !*request->cwd || !*request->desktop ||
      !creator_security((PSECURITY_DESCRIPTOR)request->security, request->security_bytes) ||
      !tc_sid(request->app, request->app_bytes) || !tc_sid(request->capability, request->capability_bytes)) {
    error = ERROR_INVALID_DATA; goto done;
  }
  for (int i = 0; i < 5; i++) if (request->inherited[i] != (ULONGLONG)(uintptr_t)inherited[i]) {error = ERROR_INVALID_DATA; goto done;}
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  if (!QueryInformationJobObject(inherited[1], JobObjectExtendedLimitInformation, &limits, sizeof(limits), NULL) ||
      !(limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) ||
      (limits.BasicLimitInformation.LimitFlags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK))) {
    error = ERROR_INVALID_DATA; goto done;
  }
  PSID derived = NULL;
  HRESULT hr = DeriveAppContainerSidFromAppContainerName(request->profile, &derived);
  if (FAILED(hr) || !EqualSid(derived, request->app)) error = ERROR_INVALID_SID;
  if (derived) FreeSid(derived);
  if (error) goto done;
  typedef BOOL (WINAPI *derive_fn)(LPCWSTR, PSID **, DWORD *, PSID **, DWORD *);
  derive_fn derive = (derive_fn)(void *)GetProcAddress(GetModuleHandleW(L"kernelbase.dll"), "DeriveCapabilitySidsFromName");
  PSID *groups = NULL, *caps = NULL; DWORD ng = 0, nc = 0;
  if (!derive || !derive(L"registryRead", &groups, &ng, &caps, &nc) || nc != 1 || !EqualSid(caps[0], request->capability)) error = ERROR_INVALID_SID;
  for (DWORD i = 0; i < ng; i++) LocalFree(groups[i]);
  if (groups) LocalFree(groups);
  for (DWORD i = 0; i < nc; i++) LocalFree(caps[i]);
  if (caps) LocalFree(caps);
  if (error) goto done;
  SIZE_T bytes = 0; InitializeProcThreadAttributeList(NULL, 4, 0, &bytes);
  list = malloc(bytes); if (!list) {error = ERROR_NOT_ENOUGH_MEMORY; goto done;}
  if (!InitializeProcThreadAttributeList(list, 4, 0, &bytes)) {error = GetLastError(); goto done;} initialized = TRUE;
  SID_AND_ATTRIBUTES capability = {request->capability, SE_GROUP_ENABLED};
  SECURITY_CAPABILITIES capabilities; ZeroMemory(&capabilities, sizeof(capabilities));
  capabilities.AppContainerSid = request->app; capabilities.Capabilities = &capability; capabilities.CapabilityCount = 1;
  DWORD lpac = 1; HANDLE streams[3] = {inherited[2], inherited[3], inherited[4]};
  for (int i = 0; i < 3; i++) if (GetFileType(streams[i]) != FILE_TYPE_PIPE ||
      !SetHandleInformation(streams[i], HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) {error = ERROR_INVALID_HANDLE; goto done;}
  if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities, sizeof(capabilities), NULL, NULL) ||
      !UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, &lpac, sizeof(lpac), NULL, NULL) ||
      !UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, streams, sizeof(streams), NULL, NULL) ||
      !UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &inherited[1], sizeof(HANDLE), NULL, NULL)) {error = GetLastError(); goto done;}
  STARTUPINFOEXW startup; ZeroMemory(&startup, sizeof(startup)); startup.StartupInfo.cb = sizeof(startup);
  startup.lpAttributeList = list; startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.StartupInfo.wShowWindow = SW_HIDE; startup.StartupInfo.lpDesktop = request->desktop;
  startup.StartupInfo.hStdInput = streams[0]; startup.StartupInfo.hStdOutput = streams[1]; startup.StartupInfo.hStdError = streams[2];
  SECURITY_ATTRIBUTES security = {sizeof(security), request->security, FALSE};
  if (!CreateProcessW(request->image, request->line, &security, &security, TRUE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT,
      NULL, request->cwd, &startup.StartupInfo, &root)) {error = GetLastError(); goto done;}
  expected.pid = root.dwProcessId; expected.tid = root.dwThreadId;
  error = tc_times(root.hProcess, &expected.process_created); if (error) goto done;
  ULONGLONG helper_created = request->helper_created;
  TC_FRAME response = expected; response.bytes = sizeof(response); response.phase = TC_READY;
  response.pid = root.dwProcessId; response.tid = root.dwThreadId;
  response.process = (ULONGLONG)(uintptr_t)root.hProcess; response.thread = (ULONGLONG)(uintptr_t)root.hThread;
  error = tc_times(root.hProcess, &response.process_created); if (error) goto done;
  if (!wcscmp(args[9], L"stall")) Sleep(6000);
  if (!wcscmp(args[9], L"exit")) {error = ERROR_PROCESS_ABORTED; goto done;}
  if (!wcscmp(args[9], L"nonce")) response.nonce[0] ^= 1;
  error = tc_exchange(inherited[0], NULL, &response, sizeof(response), TRUE, deadline); if (error) goto done;
  error = tc_exchange(inherited[0], NULL, &response, sizeof(response), FALSE, deadline); if (error) goto done;
  if (!tc_frame(&response, &expected, TC_HANDOFF, sizeof(response)) || response.pid != root.dwProcessId ||
      response.tid != root.dwThreadId) {error = ERROR_INVALID_DATA; goto done;}
  error = tc_close(&root.hThread); if (error) goto done;
  error = tc_close(&root.hProcess); if (error) goto done;
  DeleteProcThreadAttributeList(list); initialized = FALSE; free(list); list = NULL;
  for (int i = 1; i < 5; i++) {error = tc_close(&inherited[i]); if (error) goto done;}
  free(request); request = NULL;
  response = expected; response.bytes = sizeof(response); response.phase = TC_RELEASED; response.closed = 6;
  response.io_acquired = tc_io_acquired + 1; response.io_closed = tc_io_closed + 1;
  error = tc_exchange(inherited[0], NULL, &response, sizeof(response), TRUE, deadline); if (error) goto done;
  /* Only the control channel and its bounded overlapped event survive among
   * our known resources. No root, map, token, stdio or job anchor. */
  error = tc_exchange(inherited[0], NULL, &response, sizeof(response), FALSE, lifetime); if (error) goto done;
  if (tc_frame(&response, &expected, TC_HOLD, sizeof(response))) {
    error = hj_child(&inherited[0], &response, &expected, helper_created, lifetime); goto done;
  }
  if (!tc_frame(&response, &expected, TC_EXIT, sizeof(response))) {error = ERROR_INVALID_DATA; goto done;}
  response = expected; response.bytes = sizeof(response); response.phase = TC_DONE; response.closed = 6;
  response.io_acquired = tc_io_acquired + 1; response.io_closed = tc_io_closed + 1;
  error = tc_exchange(inherited[0], NULL, &response, sizeof(response), TRUE, lifetime);
done:
  if (list) {if (initialized) DeleteProcThreadAttributeList(list); free(list);}
  free(request);
  {DWORD e = tc_close(&root.hThread); if (!error) error = e; e = tc_close(&root.hProcess); if (!error) error = e;}
  for (int i = 0; i < 5; i++) {DWORD e = tc_close(&inherited[i]); if (!error) error = e;}
  if ((tc_pending || tc_io_acquired != tc_io_closed) && !error) error = ERROR_IO_INCOMPLETE;
  return (int)error;
}

static DWORD target_creator_finish(BOOL aborting) {
  if (!tc_process) {
    DWORD error = tc_close(&tc_thread), closed = tc_close(&tc_pipe);
    return error ? error : closed ? closed : tc_close_failed ? ERROR_INVALID_HANDLE : 0;
  }
  DWORD error = 0, code = STILL_ACTIVE; BOOL forced = FALSE;
  if (!aborting && tc_released && WaitForSingleObject(tc_process, 0) == WAIT_TIMEOUT) {
    TC_FRAME message = tc_identity; message.bytes = sizeof(message); message.phase = TC_EXIT;
    ULONGLONG deadline = GetTickCount64() + 5000; if (deadline > tc_deadline) deadline = tc_deadline;
    error = tc_exchange(tc_pipe, tc_process, &message, sizeof(message), TRUE, deadline);
    if (!error) error = tc_exchange(tc_pipe, tc_process, &message, sizeof(message), FALSE, deadline);
    if (!error && (!tc_frame(&message, &tc_identity, TC_DONE, sizeof(message)) || message.closed != 6 ||
        !message.io_acquired || message.io_acquired != message.io_closed)) error = ERROR_INVALID_DATA;
    if (!error && WaitForSingleObject(tc_process, creator_remaining(deadline)) != WAIT_OBJECT_0) error = ERROR_TIMEOUT;
    if (!error && (!GetExitCodeProcess(tc_process, &code) || code)) error = code ? code : ERROR_INVALID_DATA;
  } else error = ERROR_PROCESS_ABORTED;
  if (WaitForSingleObject(tc_process, 0) != WAIT_OBJECT_0) {
    forced = TRUE;
    if (!TerminateProcess(tc_process, 125) && !error) error = GetLastError();
    if (WaitForSingleObject(tc_process, 1000) != WAIT_OBJECT_0 && !error) error = ERROR_TIMEOUT;
  }
  if (!GetExitCodeProcess(tc_process, &code) && !error) error = GetLastError();
  DWORD e = tc_close(&tc_thread); if (!error) error = e;
  e = tc_close(&tc_process); if (!error) error = e;
  e = tc_close(&tc_pipe); if (!error) error = e;
  if (tc_pending && WaitForSingleObject(tc_pending->operation.hEvent, 1000) == WAIT_OBJECT_0) {
    e = tc_free_io(tc_pending); tc_pending = NULL; if (!error) error = e;
  }
  if ((tc_pending || tc_io_acquired != tc_io_closed || creator_pending || creator_io_acquired != creator_io_closed) && !error) error = ERROR_IO_INCOMPLETE;
  fwprintf(stderr, L"target-creator-exit pid=%lu created=%llu mode=%d released=%d forced=%d exit=%lu handles-closed=%d io-acquired=%u io-closed=%u retained=%d connect-acquired=%u connect-closed=%u error=%lu\n",
    tc_identity.creator, (unsigned long long)tc_identity.creator_created, target_creator_mode, tc_released, forced, code,
    !tc_process && !tc_thread && !tc_pipe && !tc_close_failed, tc_io_acquired, tc_io_closed, tc_pending != NULL || creator_pending != NULL,
    creator_io_acquired, creator_io_closed, error); fflush(stderr);
  return error;
}

static void target_creator_failure_absence(void) {
  wchar_t name[256]; DWORD error = creator_name(GetCurrentProcessId(), name, 256);
  if (error) {fwprintf(stderr, L"target-creator-failure-map name-error=%lu\n", error); fflush(stderr); return;}
  open_directory_fn open = (open_directory_fn)(void *)nt_api("NtOpenDirectoryObject");
  UNICODE_STRING text = {(USHORT)(wcslen(name) * 2), (USHORT)sizeof(name), name};
  OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
  attributes.Length = sizeof(attributes); attributes.ObjectName = &text; attributes.Attributes = 0x40;
  HANDLE observer = NULL; NTSTATUS status = open ? open(&observer, 1, &attributes) : (NTSTATUS)0xc0000002;
  error = tc_close(&observer);
  fwprintf(stderr, L"target-creator-failure-map path=%ls open=0x%08lx absent=%d closed=%d error=%lu\n",
    name, (unsigned long)status, status == (NTSTATUS)0xc0000034, !error, error); fflush(stderr);
}

static DWORD target_creator_start(const wchar_t *profile, const wchar_t *image, const wchar_t *line,
    const wchar_t *cwd, const wchar_t *desktop, PSECURITY_DESCRIPTOR security, PSID app, PSID capability,
    HANDLE job, HANDLE streams[3], PROCESS_INFORMATION *root) {
  TC_PACKET *packet = calloc(1, sizeof(*packet));
  if (!packet) return ERROR_NOT_ENOUGH_MEMORY;
  DWORD error = 0, flags = PIPE_READMODE_MESSAGE;
  HANDLE inherited[5] = {NULL, NULL, NULL, NULL, NULL};
  PSECURITY_DESCRIPTOR pipe_sd = NULL; LPPROC_THREAD_ATTRIBUTE_LIST list = NULL; BOOL initialized = FALSE;
  wchar_t self[4096], pipe_name[256], nonce[33], texts[5][32], parent[16], fault[16] = L"none";
  wchar_t *creator_line = NULL;
  ZeroMemory(&tc_identity, sizeof(tc_identity)); tc_identity.version = 1; tc_identity.helper = GetCurrentProcessId();
  typedef BOOLEAN (WINAPI *random_fn)(PVOID, ULONG);
  random_fn random = (random_fn)(void *)GetProcAddress(GetModuleHandleW(L"advapi32.dll"), "SystemFunction036");
  if (!random || !random(tc_identity.nonce, 16)) {error = ERROR_GEN_FAILURE; goto end;}
  for (int i = 0; i < 16; i++) swprintf(nonce + i * 2, 3, L"%02x", tc_identity.nonce[i]);
  DWORD length = GetModuleFileNameW(NULL, self, 4096);
  if (!length || length >= 4096 || wcslen(profile) >= 256 || wcslen(image) >= 4096 || wcslen(line) >= 32768 ||
      wcslen(cwd) >= 4096 || wcslen(desktop) >= 256) {error = ERROR_INSUFFICIENT_BUFFER; goto end;}
  error = tc_times(GetCurrentProcess(), &packet->helper_created); if (error) goto end;
  packet->security_bytes = GetSecurityDescriptorLength(security);
  packet->app_bytes = GetLengthSid(app); packet->capability_bytes = GetLengthSid(capability);
  if (!creator_security(security, packet->security_bytes) || packet->app_bytes > SECURITY_MAX_SID_SIZE ||
      packet->capability_bytes > SECURITY_MAX_SID_SIZE) {error = ERROR_INVALID_SECURITY_DESCR; goto end;}
  memcpy(packet->profile, profile, (wcslen(profile) + 1) * sizeof(*profile));
  memcpy(packet->image, image, (wcslen(image) + 1) * sizeof(*image));
  memcpy(packet->line, line, (wcslen(line) + 1) * sizeof(*line));
  memcpy(packet->cwd, cwd, (wcslen(cwd) + 1) * sizeof(*cwd));
  memcpy(packet->desktop, desktop, (wcslen(desktop) + 1) * sizeof(*desktop));
  memcpy(packet->security, security, packet->security_bytes); memcpy(packet->app, app, packet->app_bytes);
  memcpy(packet->capability, capability, packet->capability_bytes);
  /* Caller-only pipe ACL, independent from the target's descriptor. */
  HANDLE token = NULL; BYTE user[4096]; DWORD used = 0; LPWSTR sid = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {error = GetLastError(); goto end;}
  BOOL ok = GetTokenInformation(token, TokenUser, user, sizeof(user), &used) &&
    ConvertSidToStringSidW(((TOKEN_USER *)user)->User.Sid, &sid);
  error = ok ? 0 : GetLastError(); DWORD e = tc_close(&token); if (!error) error = e;
  if (error) {if (sid) LocalFree(sid); goto end;}
  wchar_t sddl[512]; int written = swprintf(sddl, 512, L"D:P(A;;GA;;;%ls)", sid); LocalFree(sid);
  if (written < 0 || written >= 512 || !ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &pipe_sd, NULL)) {
    error = ERROR_INVALID_SECURITY_DESCR; goto end;
  }
  SECURITY_ATTRIBUTES pipe_security = {sizeof(pipe_security), pipe_sd, FALSE};
  swprintf(pipe_name, 256, L"\\\\.\\pipe\\boite.target-creator.%lu.%ls", GetCurrentProcessId(), nonce);
  tc_pipe = CreateNamedPipeW(pipe_name, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, sizeof(TC_PACKET), sizeof(TC_PACKET), 0, &pipe_security);
  if (tc_pipe == INVALID_HANDLE_VALUE) {tc_pipe = NULL; error = GetLastError(); goto end;}
  pipe_security.bInheritHandle = TRUE;
  inherited[0] = CreateFileW(pipe_name, GENERIC_READ | GENERIC_WRITE, 0, &pipe_security, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
  if (inherited[0] == INVALID_HANDLE_VALUE) {error = GetLastError(); goto end;}
  /* The client is already connected; no pending connect backing is needed. */
  error = creator_connect(tc_pipe); if (error || creator_pending) {if (!error) error = ERROR_IO_INCOMPLETE; goto end;}
  if (!SetNamedPipeHandleState(inherited[0], &flags, NULL, NULL)) {error = GetLastError(); goto end;}
  for (int i = 1; i < 5; i++) if (!DuplicateHandle(GetCurrentProcess(), i == 1 ? job : streams[i - 2], GetCurrentProcess(),
      &inherited[i], i == 1 ? JOB_OBJECT_QUERY | JOB_OBJECT_ASSIGN_PROCESS : 0, TRUE, i == 1 ? 0 : DUPLICATE_SAME_ACCESS)) {
    error = GetLastError(); goto end;
  }
  for (int i = 0; i < 5; i++) {
    packet->inherited[i] = (ULONGLONG)(uintptr_t)inherited[i]; swprintf(texts[i], 32, L"%llu", (unsigned long long)packet->inherited[i]);
  }
  DWORD fault_length = GetEnvironmentVariableW(L"BOITE_DIAGNOSTIC_TARGET_CREATOR_FAULT", fault, 16);
  if (fault_length >= 16 || (fault_length && wcscmp(fault, L"nonce") && wcscmp(fault, L"descriptor") &&
      wcscmp(fault, L"frame") && wcscmp(fault, L"exit") && wcscmp(fault, L"stall") &&
      wcscmp(fault, L"process-acl") && wcscmp(fault, L"thread-acl"))) {error = ERROR_INVALID_PARAMETER; goto end;}
  swprintf(parent, 16, L"%lu", GetCurrentProcessId());
  wchar_t *argv[] = {self, L"create-target", texts[0], texts[1], texts[2], texts[3], texts[4], parent, nonce, fault};
  creator_line = command_line(10, argv); if (!creator_line) {error = ERROR_NOT_ENOUGH_MEMORY; goto end;}
  SIZE_T bytes = 0; InitializeProcThreadAttributeList(NULL, 1, 0, &bytes); list = malloc(bytes);
  if (!list) {error = ERROR_NOT_ENOUGH_MEMORY; goto end;}
  if (!InitializeProcThreadAttributeList(list, 1, 0, &bytes)) {error = GetLastError(); goto end;} initialized = TRUE;
  if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), NULL, NULL)) {error = GetLastError(); goto end;}
  STARTUPINFOEXW startup; ZeroMemory(&startup, sizeof(startup)); startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = list;
  PROCESS_INFORMATION creator; ZeroMemory(&creator, sizeof(creator));
  if (!CreateProcessW(self, creator_line, NULL, NULL, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
      NULL, NULL, &startup.StartupInfo, &creator)) {error = GetLastError(); goto end;}
  tc_process = creator.hProcess; tc_thread = creator.hThread; tc_identity.creator = creator.dwProcessId;
  error = tc_times(tc_process, &tc_identity.creator_created); if (error) goto end;
  error = tc_verify_creator(tc_process, tc_identity.creator, self, job); if (error) goto end;
  for (int i = 0; i < 5; i++) {error = tc_close(&inherited[i]); if (error) goto end;}
  error = tc_barrier(L"creator", NULL); if (error) goto end;
  fwprintf(stderr, L"target-creator-start pid=%lu created=%llu inherited=5 parent-copies-closed=5 image=1 token=1 private-job=0 extra-job=0 mode=%d\n",
    tc_identity.creator, (unsigned long long)tc_identity.creator_created, target_creator_mode); fflush(stderr);
  if (ResumeThread(tc_thread) != 1) {error = ERROR_INVALID_DATA; goto end;}
  tc_deadline = GetTickCount64() + 30000;
  ULONGLONG deadline = GetTickCount64() + 5000;
  packet->frame = tc_identity; packet->frame.bytes = sizeof(*packet); packet->frame.phase = TC_REQUEST;
  if (!wcscmp(fault, L"descriptor")) packet->security_bytes--;
  error = tc_exchange(tc_pipe, tc_process, packet, sizeof(*packet) - (!wcscmp(fault, L"frame") ? 1 : 0), TRUE, deadline); if (error) goto end;
  TC_FRAME response;
  error = tc_exchange(tc_pipe, tc_process, &response, sizeof(response), FALSE, deadline); if (error) goto end;
  if (!tc_frame(&response, &tc_identity, TC_READY, sizeof(response)) || !response.pid || !response.tid ||
      !response.process_created || !response.process || !response.thread || response.process == response.thread ||
      response.process >= INTPTR_MAX || response.thread >= INTPTR_MAX) {error = ERROR_INVALID_DATA; goto end;}
  /* Copy ONLY the two explicit CreateProcess results held until HANDOFF. This
   * never enumerates the creator's table or closes a remote numeric value. */
  if (!DuplicateHandle(tc_process, (HANDLE)(uintptr_t)response.process, GetCurrentProcess(), &root->hProcess,
      PROCESS_QUERY_INFORMATION | PROCESS_SET_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE | READ_CONTROL, FALSE, 0) ||
      !DuplicateHandle(tc_process, (HANDLE)(uintptr_t)response.thread, GetCurrentProcess(), &root->hThread,
      THREAD_QUERY_INFORMATION | THREAD_SUSPEND_RESUME | SYNCHRONIZE | READ_CONTROL, FALSE, 0)) {error = GetLastError(); goto end;}
  root->dwProcessId = response.pid; root->dwThreadId = response.tid;
  ULONGLONG created = 0; BOOL member = FALSE; DWORD process_flags = 0, thread_flags = 0;
  error = tc_times(root->hProcess, &created);
  if (!error && (created != response.process_created || GetProcessId(root->hProcess) != response.pid ||
      GetThreadId(root->hThread) != response.tid || GetProcessIdOfThread(root->hThread) != response.pid ||
      WaitForSingleObject(root->hProcess, 0) != WAIT_TIMEOUT || !IsProcessInJob(root->hProcess, job, &member) || !member ||
      !GetHandleInformation(root->hProcess, &process_flags) || !GetHandleInformation(root->hThread, &thread_flags) ||
      process_flags || thread_flags)) error = ERROR_INVALID_DATA;
  if (!error) error = tc_parent(root->hProcess, response.pid, tc_identity.creator);
  if (!error) error = tc_security(root->hProcess, security, PROCESS_ALL_ACCESS, L"process", !wcscmp(fault, L"process-acl"));
  if (!error) error = tc_security(root->hThread, security, THREAD_ALL_ACCESS, L"thread", !wcscmp(fault, L"thread-acl"));
  if (!error) {tc_identity.pid = response.pid; tc_identity.tid = response.tid; tc_identity.process_created = created;}
  /* The target image is independently matched before accepting either handle. */
  wchar_t root_image[4096]; DWORD root_length = 4096; HANDLE images[2] = {INVALID_HANDLE_VALUE, INVALID_HANDLE_VALUE};
  BY_HANDLE_FILE_INFORMATION image_ids[2];
  if (!error && !QueryFullProcessImageNameW(root->hProcess, 0, root_image, &root_length)) error = GetLastError();
  if (!error) for (int i = 0; i < 2; i++) {
    images[i] = CreateFileW(i ? root_image : image, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (images[i] == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(images[i], &image_ids[i])) {error = GetLastError(); break;}
  }
  if (!error && !same_file(&image_ids[0], &image_ids[1])) error = ERROR_INVALID_DATA;
  for (int i = 0; i < 2; i++) {e = tc_close(&images[i]); if (!error) error = e;}
  if (error) goto end;
  error = tc_barrier(L"root", root); if (error) goto end;
  response.phase = TC_HANDOFF;
  error = tc_exchange(tc_pipe, tc_process, &response, sizeof(response), TRUE, deadline); if (error) goto end;
  error = tc_exchange(tc_pipe, tc_process, &response, sizeof(response), FALSE, deadline); if (error) goto end;
  if (!tc_frame(&response, &tc_identity, TC_RELEASED, sizeof(response)) || response.closed != 6 ||
      !response.io_acquired || response.io_acquired != response.io_closed) {error = ERROR_INVALID_DATA; goto end;}
  tc_released = TRUE; error = tc_close(&tc_thread); if (error) goto end;
  fwprintf(stderr, L"target-creator-released pid=%lu root=%lu created=%llu sources-closed=6 known-target-anchors=0 control-only=1 target-inherit=3 controller-flags=0 image=1 security=1 child-io-acquired=%lu child-io-closed=%lu\n",
    tc_identity.creator, root->dwProcessId, (unsigned long long)created, response.io_acquired, response.io_closed); fflush(stderr);
  if (target_creator_mode == 1) {
    error = target_creator_finish(FALSE);
    if (!error) error = tc_barrier(L"closed", NULL);
  }
end:
  if (list) {if (initialized) DeleteProcThreadAttributeList(list); free(list);}
  for (int i = 0; i < 5; i++) {DWORD closed = tc_close(&inherited[i]); if (!error) error = closed;}
  if (pipe_sd) LocalFree(pipe_sd);
  free(creator_line); free(packet);
  if (error) {target_creator_finish(TRUE); target_creator_failure_absence();}
  return error;
}

static DWORD target_creator_absence(void) {
  if (!retired_created) return ERROR_INVALID_DATA;
  open_directory_fn open = (open_directory_fn)(void *)nt_api("NtOpenDirectoryObject");
  UNICODE_STRING name = {(USHORT)(wcslen(probe_name) * 2), (USHORT)sizeof(probe_name), probe_name};
  OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
  attributes.Length = sizeof(attributes); attributes.ObjectName = &name; attributes.Attributes = 0x40;
  HANDLE observer = NULL;
  NTSTATUS status = open ? open(&observer, 1, &attributes) : (NTSTATUS)0xc0000002;
  DWORD error = tc_close(&observer);
  fwprintf(stderr, L"cleanup creator-exited-original open=0x%08lx absent=%d closed=%d error=%lu\n",
    (unsigned long)status, status == (NTSTATUS)0xc0000034, !error, error); fflush(stderr);
  DWORD retired = retired_absence(L"creator-exited");
  return error ? error : status != (NTSTATUS)0xc0000034 ? ERROR_BUSY : retired;
}

static DWORD target_creator_before_resume(DWORD root) {
  if (!target_creator_mode) return 0;
  BOOL waiting = target_creator_mode >= 2;
  BOOL live = tc_process && WaitForSingleObject(tc_process, 0) == WAIT_TIMEOUT && creator_remaining(tc_deadline);
  if (!tc_released || root != tc_identity.pid || (waiting ? !live : tc_process || tc_thread || tc_pipe)) return ERROR_INVALID_DATA;
  fwprintf(stderr, L"target-creator-root-resume root=%lu creator=%lu mode=%d creator-live=%d\n",
    root, tc_identity.creator, target_creator_mode, live); fflush(stderr); return 0;
}
