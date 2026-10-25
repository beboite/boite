/* Test-only creation-context control. The trusted child receives one pipe,
 * never the target, token, map, job or stdio handles. No process-map assignment
 * occurs until its bounded handoff, exit and owned-resource cleanup succeed. */
enum { CREATOR_REQUEST = 1, CREATOR_READY, CREATOR_HANDOFF, CREATOR_RELEASED, CREATOR_EXIT };
typedef struct {
  DWORD version, bytes, phase, error, parent, child, remaining;
  ULONGLONG created;
  BYTE nonce[16];
} CREATOR_MESSAGE;
typedef struct {
  CREATOR_MESSAGE message;
  DWORD security_bytes;
  wchar_t name[256], target[8192];
  BYTE security[2048];
} CREATOR_PACKET;
typedef struct { OVERLAPPED operation; BYTE buffer[sizeof(CREATOR_PACKET)]; } CREATOR_IO;
/* A cancellation that cannot be drained is fatal. Keep its backing memory
 * alive through process exit rather than return a dangling OVERLAPPED. */
static CREATOR_IO *creator_pending;
static unsigned int creator_io_acquired, creator_io_closed;

static DWORD creator_remaining(ULONGLONG deadline) {
  ULONGLONG now = GetTickCount64();
  return now >= deadline ? 0 : (DWORD)(deadline - now);
}

static DWORD creator_io_free(CREATOR_IO *io) {
  DWORD error = CloseHandle(io->operation.hEvent) ? 0 : GetLastError();
  if (!error) creator_io_closed++;
  HeapFree(GetProcessHeap(), 0, io); return error;
}

static DWORD creator_exchange(HANDLE pipe, HANDLE child, void *buffer, DWORD length,
    BOOL write, ULONGLONG deadline) {
  if (!length || length > sizeof(((CREATOR_IO *)0)->buffer) || creator_pending) return ERROR_INVALID_DATA;
  if (!creator_remaining(deadline)) return ERROR_TIMEOUT;
  CREATOR_IO *io = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*io));
  if (!io) return ERROR_NOT_ENOUGH_MEMORY;
  io->operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!io->operation.hEvent) {DWORD error = GetLastError(); HeapFree(GetProcessHeap(), 0, io); return error;}
  creator_io_acquired++;
  if (write) memcpy(io->buffer, buffer, length);
  DWORD transferred = 0, error = 0; BOOL pending = FALSE;
  BOOL ok = write ? WriteFile(pipe, io->buffer, length, &transferred, &io->operation)
    : ReadFile(pipe, io->buffer, length, &transferred, &io->operation);
  if (!ok) {
    error = GetLastError(); pending = error == ERROR_IO_PENDING;
    if (pending) {
      HANDLE waits[2] = {io->operation.hEvent, child};
      DWORD waited = WaitForMultipleObjects(child ? 2 : 1, waits, FALSE, creator_remaining(deadline));
      if (waited == WAIT_OBJECT_0) {
        ok = GetOverlappedResult(pipe, &io->operation, &transferred, FALSE);
        error = ok ? 0 : GetLastError(); pending = !ok && error == ERROR_IO_INCOMPLETE;
      } else error = waited == WAIT_TIMEOUT ? ERROR_TIMEOUT : waited == WAIT_OBJECT_0 + 1
        ? ERROR_PROCESS_ABORTED : GetLastError();
    }
  }
  if (pending) {
    BOOL cancelled = CancelIoEx(pipe, &io->operation); DWORD cancel_error = cancelled ? 0 : GetLastError();
    DWORD waited = WaitForSingleObject(io->operation.hEvent, 1000);
    fwprintf(stderr, L"creator-io cancelled=%d cancel-error=%lu drained=%d\n", cancelled, cancel_error, waited == WAIT_OBJECT_0);
    fflush(stderr);
    if (waited != WAIT_OBJECT_0) {creator_pending = io; return error ? error : ERROR_IO_INCOMPLETE;}
  }
  if (!error && transferred != length) error = ERROR_INVALID_DATA;
  if (!error && !creator_remaining(deadline)) error = ERROR_TIMEOUT;
  if (!error && !write) memcpy(buffer, io->buffer, length);
  DWORD closed = creator_io_free(io);
  return error ? error : closed;
}

static DWORD creator_connect(HANDLE pipe) {
  CREATOR_IO *io = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*io));
  if (!io) return ERROR_NOT_ENOUGH_MEMORY;
  io->operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!io->operation.hEvent) {DWORD error = GetLastError(); HeapFree(GetProcessHeap(), 0, io); return error;}
  creator_io_acquired++;
  BOOL connected = ConnectNamedPipe(pipe, &io->operation);
  DWORD error = connected ? 0 : GetLastError();
  if (error == ERROR_PIPE_CONNECTED) error = 0;
  else if (error == ERROR_IO_PENDING) {
    DWORD waited = WaitForSingleObject(io->operation.hEvent, 5000), used = 0;
    if (waited == WAIT_OBJECT_0) error = GetOverlappedResult(pipe, &io->operation, &used, FALSE) ? 0 : GetLastError();
    else {
      error = waited == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError();
      CancelIoEx(pipe, &io->operation);
      if (WaitForSingleObject(io->operation.hEvent, 1000) != WAIT_OBJECT_0) {creator_pending = io; return error;}
    }
  }
  DWORD closed = creator_io_free(io); return error ? error : closed;
}

/* Validate a received self-relative descriptor against its actual byte extent
 * before any API is allowed to follow offsets within it. */
static BOOL creator_security(PSECURITY_DESCRIPTOR descriptor, DWORD bytes) {
  typedef BOOLEAN (NTAPI *valid_relative_fn)(PSECURITY_DESCRIPTOR, ULONG, SECURITY_INFORMATION);
  valid_relative_fn valid = (valid_relative_fn)(void *)nt_api("RtlValidRelativeSecurityDescriptor");
  SECURITY_DESCRIPTOR_CONTROL control = 0; DWORD revision = 0;
  return bytes >= sizeof(SECURITY_DESCRIPTOR_RELATIVE) && bytes <= 2048 && valid &&
    valid(descriptor, bytes, DACL_SECURITY_INFORMATION | SACL_SECURITY_INFORMATION) &&
    GetSecurityDescriptorControl(descriptor, &control, &revision) &&
    revision == SECURITY_DESCRIPTOR_REVISION && (control & SE_SELF_RELATIVE) &&
    (control & SE_DACL_PRESENT) && GetSecurityDescriptorLength(descriptor) == bytes;
}

static BOOL creator_message(const CREATOR_MESSAGE *actual, const CREATOR_MESSAGE *expected,
    DWORD phase, DWORD bytes, DWORD remaining) {
  return actual->version == 1 && actual->bytes == bytes && actual->phase == phase &&
    actual->parent == expected->parent && actual->child == expected->child &&
    actual->created == expected->created && actual->remaining == remaining &&
    !memcmp(actual->nonce, expected->nonce, sizeof(actual->nonce));
}

static DWORD creator_nonce(const wchar_t *text, BYTE nonce[16]) {
  if (wcslen(text) != 32) return ERROR_INVALID_DATA;
  for (int i = 0; i < 16; i++) {
    unsigned int value = 0;
    for (int j = 0; j < 2; j++) {
      wchar_t c = text[i * 2 + j];
      if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'))) return ERROR_INVALID_DATA;
      value = value * 16 + (unsigned int)(c <= L'9' ? c - L'0' : c - L'a' + 10);
    }
    nonce[i] = (BYTE)value;
  }
  return 0;
}

static DWORD creator_name(DWORD parent, wchar_t *name, size_t length) {
  DWORD session = 0;
  if (!ProcessIdToSessionId(GetCurrentProcessId(), &session)) return GetLastError();
  int written = session ? swprintf(name, length, L"\\Sessions\\%lu\\BaseNamedObjects\\boite.route.%lu", session, parent)
    : swprintf(name, length, L"\\BaseNamedObjects\\boite.route.%lu", parent);
  return written < 0 || (size_t)written >= length ? ERROR_INSUFFICIENT_BUFFER : 0;
}

static int creator_entry(int count, wchar_t **args) {
  if (count != 7) return 125;
  HANDLE pipe = NULL;
  DWORD error = parse_owned_handle(args[2], &pipe), flags = 0;
  if (error || GetFileType(pipe) != FILE_TYPE_PIPE ||
      !GetNamedPipeInfo(pipe, &flags, NULL, NULL, NULL) || (flags & PIPE_SERVER_END)) return 125;
  /* It is now an identified inherited pipe, not an arbitrary numeric handle. */
  if (!SetHandleInformation(pipe, HANDLE_FLAG_INHERIT, 0)) return 125;
  ULONGLONG deadline = GetTickCount64() + 5000;
  CREATOR_PACKET request; ZeroMemory(&request, sizeof(request));
  CREATOR_MESSAGE expected; ZeroMemory(&expected, sizeof(expected));
  HANDLE directory = NULL, link = NULL;
  wchar_t *end = NULL, name[256];
  unsigned long parent = wcstoul(args[3], &end, 10);
  if (!*args[3] || !end || *end || !parent) {error = ERROR_INVALID_DATA; goto done;}
  expected.version = 1; expected.parent = parent; expected.child = GetCurrentProcessId();
  error = creator_nonce(args[4], expected.nonce); if (error) goto done;
  FILETIME created, exited, kernel, user; ULARGE_INTEGER identity;
  if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) {error = GetLastError(); goto done;}
  identity.LowPart = created.dwLowDateTime; identity.HighPart = created.dwHighDateTime; expected.created = identity.QuadPart;
  struct {NTSTATUS exit_status; PVOID peb; ULONG_PTR affinity; LONG priority; ULONG_PTR pid, parent;} basic;
  ULONG used = 0; ZeroMemory(&basic, sizeof(basic));
  query_process_fn query = (query_process_fn)(void *)nt_api("NtQueryInformationProcess");
  NTSTATUS status = query ? query(GetCurrentProcess(), (PROCESSINFOCLASS)0, &basic, sizeof(basic), &used) : (NTSTATUS)0xc0000002;
  if (status != 0 || used != sizeof(basic) || basic.pid != expected.child || basic.parent != parent) {
    error = ERROR_INVALID_DATA; goto done;
  }
  error = creator_name(parent, name, 256); if (error) goto done;
  error = creator_exchange(pipe, NULL, &request, sizeof(request), FALSE, deadline); if (error) goto done;
  if (!creator_message(&request.message, &expected, CREATOR_REQUEST, sizeof(request), 0) || request.message.error ||
      !wmemchr(request.name, 0, 256) || !wmemchr(request.target, 0, 8192) ||
      wcscmp(request.name, name) || wcscmp(request.target, args[5]) ||
      !creator_security((PSECURITY_DESCRIPTOR)request.security, request.security_bytes)) {
    error = ERROR_INVALID_DATA; goto done;
  }
  typedef NTSTATUS (NTAPI *create_directory_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, HANDLE, ULONG);
  typedef NTSTATUS (NTAPI *create_link_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PUNICODE_STRING);
  create_directory_fn create = (create_directory_fn)(void *)nt_api("NtCreateDirectoryObjectEx");
  create_link_fn create_link = (create_link_fn)(void *)nt_api("NtCreateSymbolicLinkObject");
  if (!create || !create_link) {error = ERROR_PROC_NOT_FOUND; goto done;}
  UNICODE_STRING object = {(USHORT)(wcslen(name) * 2), (USHORT)sizeof(name), name};
  OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
  attributes.Length = sizeof(attributes); attributes.ObjectName = &object;
  attributes.Attributes = 0x40; attributes.SecurityDescriptor = (PSECURITY_DESCRIPTOR)request.security;
  status = create(&directory, 0xf000f, &attributes, NULL, 0);
  if (status != 0) {error = (DWORD)status; goto done;}
  wchar_t leaf_text[] = L"NUL"; UNICODE_STRING leaf = {6, 8, leaf_text};
  UNICODE_STRING destination = {(USHORT)(wcslen(request.target) * 2), (USHORT)sizeof(request.target), request.target};
  attributes.RootDirectory = directory; attributes.ObjectName = &leaf;
  status = create_link(&link, 0xf0001, &attributes, &destination);
  if (status != 0) {error = (DWORD)status; goto done;}
  CREATOR_MESSAGE response = expected; response.bytes = sizeof(response); response.phase = CREATOR_READY; response.remaining = 2;
  if (!wcscmp(args[6], L"stall")) Sleep(6000); /* Deliberate native watchdog probe. */
  if (!wcscmp(args[6], L"exit")) {error = ERROR_PROCESS_ABORTED; goto done;}
  if (!wcscmp(args[6], L"nonce")) response.nonce[0] ^= 1;
  error = creator_exchange(pipe, NULL, &response, sizeof(response), TRUE, deadline); if (error) goto done;
  error = creator_exchange(pipe, NULL, &response, sizeof(response), FALSE, deadline); if (error) goto done;
  if (!creator_message(&response, &expected, CREATOR_HANDOFF, sizeof(response), 2) || response.error) {
    error = ERROR_INVALID_DATA; goto done;
  }
  if (!CloseHandle(link)) {error = GetLastError(); goto done;} link = NULL;
  if (!CloseHandle(directory)) {error = GetLastError(); goto done;} directory = NULL;
  response = expected; response.bytes = sizeof(response); response.phase = CREATOR_RELEASED; response.remaining = 0;
  error = creator_exchange(pipe, NULL, &response, sizeof(response), TRUE, deadline); if (error) goto done;
  error = creator_exchange(pipe, NULL, &response, sizeof(response), FALSE, deadline); if (error) goto done;
  if (!creator_message(&response, &expected, CREATOR_EXIT, sizeof(response), 0) || response.error) error = ERROR_INVALID_DATA;
done:
  if (link && !CloseHandle(link) && !error) error = GetLastError();
  if (directory && !CloseHandle(directory) && !error) error = GetLastError();
  if (!CloseHandle(pipe) && !error) error = GetLastError();
  if (creator_pending && !error) error = ERROR_IO_INCOMPLETE;
  return (int)error;
}

/* Match REOPEN's exact opens, access, attributes and link destination, without
 * importing a handle from the creator or accepting an existing collision. */
static DWORD creator_open(const wchar_t *target) {
  typedef NTSTATUS (NTAPI *open_link_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES);
  typedef NTSTATUS (NTAPI *query_link_fn)(HANDLE, PUNICODE_STRING, PULONG);
  open_directory_fn open = (open_directory_fn)(void *)nt_api("NtOpenDirectoryObject");
  open_link_fn open_link = (open_link_fn)(void *)nt_api("NtOpenSymbolicLinkObject");
  query_link_fn query_link = (query_link_fn)(void *)nt_api("NtQuerySymbolicLinkObject");
  query_object_fn query = (query_object_fn)(void *)nt_api("NtQueryObject");
  if (!open || !open_link || !query_link || !query) return ERROR_PROC_NOT_FOUND;
  UNICODE_STRING name = {(USHORT)(wcslen(probe_name) * 2), (USHORT)sizeof(probe_name), probe_name};
  OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
  attributes.Length = sizeof(attributes); attributes.ObjectName = &name; attributes.Attributes = 0x40;
  NTSTATUS status = open(&probe_map, 0xf000f, &attributes);
  if (status != 0) return (DWORD)status;
  wchar_t leaf_text[] = L"NUL"; UNICODE_STRING leaf = {6, 8, leaf_text};
  attributes.RootDirectory = probe_map; attributes.ObjectName = &leaf;
  status = open_link(&probe_link, 0xf0001, &attributes);
  if (status != 0) return (DWORD)status;
  wchar_t link_name[512]; int length = swprintf(link_name, 512, L"%ls\\NUL", probe_name);
  if (length < 0 || length >= 512) return ERROR_INSUFFICIENT_BUFFER;
  for (int i = 0; i < 2; i++) {
    HANDLE handle = i ? probe_link : probe_map; wchar_t actual[512]; DWORD flags = 0, error = 0; ULONG used = 0;
    struct {ULONG attributes, granted, handles, pointers; ULONG reserved[10];} info;
    ZeroMemory(&info, sizeof(info));
    error = object_name(handle, actual, 512); if (error) return error;
    if (wcscmp(actual, i ? link_name : probe_name)) return ERROR_INVALID_NAME;
    if (!GetHandleInformation(handle, &flags)) return GetLastError();
    object_count_queries++;
    status = query(handle, (OBJECT_INFORMATION_CLASS)0, &info, sizeof(info), &used);
    if (status != 0) return (DWORD)status;
    if (flags || info.attributes || info.granted != (i ? 0xf0001UL : 0xf000fUL)) return ERROR_INVALID_DATA;
    fwprintf(stderr, L"creator-open object=%ls name=1 granted=0x%08lx attributes=0x%08lx flags=%lu\n",
      i ? L"link" : L"directory", info.granted, info.attributes, flags); fflush(stderr);
  }
  wchar_t destination[8192]; UNICODE_STRING value = {0, (USHORT)sizeof(destination), destination}; ULONG used = 0;
  status = query_link(probe_link, &value, &used);
  if (status != 0) return (DWORD)status;
  if (value.Length != wcslen(target) * sizeof(wchar_t) || value.Length > sizeof(destination) ||
      used > sizeof(destination) || memcmp(destination, target, value.Length)) return ERROR_INVALID_DATA;
  fputws(L"creator-open link-target=1\n", stderr); fflush(stderr);
  return map_lifetime(L"after-open", L"directory-link");
}

static DWORD creator_prepare(PSECURITY_DESCRIPTOR security, const wchar_t *target, const wchar_t *root) {
  HANDLE pipe = INVALID_HANDLE_VALUE, passed = INVALID_HANDLE_VALUE, job = NULL, image_file = INVALID_HANDLE_VALUE;
  PROCESS_INFORMATION child; STARTUPINFOEXW startup;
  ZeroMemory(&child, sizeof(child)); ZeroMemory(&startup, sizeof(startup)); startup.StartupInfo.cb = sizeof(startup);
  BOOL initialized = FALSE, member = FALSE, resumed = FALSE, forced = FALSE, released = FALSE;
  DWORD error = 0, code = STILL_ACTIVE, waited = WAIT_FAILED, flags = 0;
  SIZE_T bytes = 0; wchar_t image[4096], pipe_name[256], nonce_text[33], parent_text[16], pipe_text[32], fault[16] = L"none";
  wchar_t *line = NULL; PSECURITY_DESCRIPTOR pipe_security = NULL;
  CREATOR_PACKET request; ZeroMemory(&request, sizeof(request));
  request.message.version = 1; request.message.bytes = sizeof(request); request.message.phase = CREATOR_REQUEST;
  request.message.parent = GetCurrentProcessId(); request.security_bytes = GetSecurityDescriptorLength(security);
  if (!creator_security(security, request.security_bytes) || wcslen(probe_name) >= 256 || wcslen(target) >= 8192)
    return ERROR_INVALID_SECURITY_DESCR;
  memcpy(request.security, security, request.security_bytes);
  memcpy(request.name, probe_name, (wcslen(probe_name) + 1) * sizeof(wchar_t));
  memcpy(request.target, target, (wcslen(target) + 1) * sizeof(wchar_t));
  fwprintf(stderr, L"creator-attempt path=%ls\n", probe_name); fflush(stderr);
  typedef BOOLEAN (WINAPI *random_fn)(PVOID, ULONG);
  random_fn random = (random_fn)(void *)GetProcAddress(GetModuleHandleW(L"advapi32.dll"), "SystemFunction036");
  if (!random || !random(request.message.nonce, sizeof(request.message.nonce))) return ERROR_GEN_FAILURE;
  for (int i = 0; i < 16; i++) swprintf(nonce_text + i * 2, 3, L"%02x", request.message.nonce[i]);
  swprintf(pipe_name, 256, L"\\\\.\\pipe\\boite.creator.%lu.%ls", GetCurrentProcessId(), nonce_text);
  DWORD length = GetModuleFileNameW(NULL, image, 4096);
  if (!length || length >= 4096) {error = ERROR_INSUFFICIENT_BUFFER; goto end;}
  image_file = CreateFileW(image, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
  if (image_file == INVALID_HANDLE_VALUE) {error = GetLastError(); goto end;}
  BY_HANDLE_FILE_INFORMATION pinned;
  error = file_identity(L"creator-pinned", GetCurrentProcessId(), image_file, &pinned); if (error) goto end;
  /* This pipe admits only the existing caller user, not the target package. */
  HANDLE token = NULL; BYTE token_user[4096]; DWORD used = 0; LPWSTR sid = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {error = GetLastError(); goto end;}
  BOOL ok = GetTokenInformation(token, TokenUser, token_user, sizeof(token_user), &used) &&
    ConvertSidToStringSidW(((TOKEN_USER *)token_user)->User.Sid, &sid);
  error = ok ? 0 : GetLastError(); if (!CloseHandle(token) && !error) error = GetLastError();
  if (error) {if (sid) LocalFree(sid); goto end;}
  wchar_t sddl[512]; int count = swprintf(sddl, 512, L"D:P(A;;GA;;;%ls)", sid); LocalFree(sid);
  if (count < 0 || count >= 512) {error = ERROR_INSUFFICIENT_BUFFER; goto end;}
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &pipe_security, NULL)) {error = GetLastError(); goto end;}
  SECURITY_ATTRIBUTES attributes = {sizeof(attributes), pipe_security, FALSE};
  pipe = CreateNamedPipeW(pipe_name, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1,
    sizeof(CREATOR_PACKET), sizeof(CREATOR_PACKET), 0, &attributes);
  if (pipe == INVALID_HANDLE_VALUE) {error = GetLastError(); goto end;}
  attributes.bInheritHandle = TRUE;
  passed = CreateFileW(pipe_name, GENERIC_READ | GENERIC_WRITE, 0, &attributes, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
  if (passed == INVALID_HANDLE_VALUE) {error = GetLastError(); goto end;}
  error = creator_connect(pipe); if (error) goto end;
  flags = PIPE_READMODE_MESSAGE;
  if (!SetNamedPipeHandleState(passed, &flags, NULL, NULL)) {error = GetLastError(); goto end;}
  swprintf(parent_text, 16, L"%lu", GetCurrentProcessId());
  swprintf(pipe_text, 32, L"%llu", (unsigned long long)(uintptr_t)passed);
  DWORD fault_length = GetEnvironmentVariableW(L"BOITE_DIAGNOSTIC_CREATOR_FAULT", fault, 16);
  if (fault_length >= 16 || (fault_length && wcscmp(fault, L"stall") && wcscmp(fault, L"nonce") &&
      wcscmp(fault, L"exit") && wcscmp(fault, L"descriptor") && wcscmp(fault, L"frame"))) {
    error = ERROR_INVALID_PARAMETER; goto end;
  }
  if (!fault_length) memcpy(fault, L"none", sizeof(L"none"));
  wchar_t *argv[] = {image, L"create-map", pipe_text, parent_text, nonce_text, (wchar_t *)target, fault};
  line = command_line(7, argv); if (!line) {error = ERROR_NOT_ENOUGH_MEMORY; goto end;}
  InitializeProcThreadAttributeList(NULL, 2, 0, &bytes); startup.lpAttributeList = malloc(bytes);
  if (!startup.lpAttributeList) {error = ERROR_NOT_ENOUGH_MEMORY; goto end;}
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 2, 0, &bytes)) {error = GetLastError(); goto end;}
  initialized = TRUE;
  job = CreateJobObjectW(NULL, NULL); if (!job) {error = GetLastError(); goto end;}
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits; ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
      !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &passed, sizeof(passed), NULL, NULL) ||
      !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job), NULL, NULL)) {
    error = GetLastError(); goto end;
  }
  if (!CreateProcessW(image, line, NULL, NULL, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
      NULL, NULL, &startup.StartupInfo, &child)) {error = GetLastError(); goto end;}
  if (!CloseHandle(passed)) {error = GetLastError(); goto end;} passed = INVALID_HANDLE_VALUE;
  FILETIME created, exited, kernel, user; ULARGE_INTEGER identity;
  wchar_t child_image[4096]; DWORD child_length = 4096, parent_session = 0, child_session = 0;
  HANDLE queried_file = INVALID_HANDLE_VALUE; BY_HANDLE_FILE_INFORMATION observed;
  if (GetProcessId(child.hProcess) != child.dwProcessId || !GetProcessTimes(child.hProcess, &created, &exited, &kernel, &user) ||
      !IsProcessInJob(child.hProcess, job, &member) || !member ||
      !ProcessIdToSessionId(GetCurrentProcessId(), &parent_session) || !ProcessIdToSessionId(child.dwProcessId, &child_session) ||
      parent_session != child_session || !QueryFullProcessImageNameW(child.hProcess, 0, child_image, &child_length)) {
    error = GetLastError(); if (!error) error = ERROR_INVALID_DATA; goto end;
  }
  queried_file = CreateFileW(child_image, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
  if (queried_file == INVALID_HANDLE_VALUE) {error = GetLastError(); goto end;}
  error = file_identity(L"creator-process", child.dwProcessId, queried_file, &observed);
  if (!CloseHandle(queried_file) && !error) error = GetLastError();
  if (!error && !same_file(&pinned, &observed)) error = ERROR_INVALID_DATA;
  if (error) goto end;
  identity.LowPart = created.dwLowDateTime; identity.HighPart = created.dwHighDateTime;
  request.message.child = child.dwProcessId; request.message.created = identity.QuadPart;
  fwprintf(stderr, L"creator-identity pid=%lu created=%llu image=1 session=%lu member=1 inherited=1 parent-transfer-closed=1 fault=%ls\n",
    child.dwProcessId, (unsigned long long)identity.QuadPart, child_session, fault); fflush(stderr);
  if (ResumeThread(child.hThread) != 1) {error = ERROR_INVALID_DATA; goto end;} resumed = TRUE;
  ULONGLONG deadline = GetTickCount64() + 5000;
  if (!wcscmp(fault, L"descriptor")) request.security_bytes--;
  error = creator_exchange(pipe, child.hProcess, &request,
    (DWORD)sizeof(request) - (!wcscmp(fault, L"frame") ? 1 : 0), TRUE, deadline); if (error) goto end;
  CREATOR_MESSAGE response;
  error = creator_exchange(pipe, child.hProcess, &response, sizeof(response), FALSE, deadline); if (error) goto end;
  if (!creator_message(&response, &request.message, CREATOR_READY, sizeof(response), 2) || response.error) {
    error = ERROR_INVALID_DATA; goto end;
  }
  fwprintf(stderr, L"private-map path=%ls create=0x00000000\ncreator-ready pid=%lu anchors=2 nonce=1 security-bytes=%lu\n",
    probe_name, child.dwProcessId, request.security_bytes); fflush(stderr);
  error = creator_open(target); if (error) goto end;
  response = request.message; response.bytes = sizeof(response); response.phase = CREATOR_HANDOFF; response.remaining = 2;
  error = creator_exchange(pipe, child.hProcess, &response, sizeof(response), TRUE, deadline); if (error) goto end;
  error = creator_exchange(pipe, child.hProcess, &response, sizeof(response), FALSE, deadline); if (error) goto end;
  if (!creator_message(&response, &request.message, CREATOR_RELEASED, sizeof(response), 0) || response.error) {
    error = ERROR_INVALID_DATA; goto end;
  }
  released = TRUE;
  fwprintf(stderr, L"creator-released pid=%lu anchors=0 nonce=1\n", child.dwProcessId); fflush(stderr);
  response = request.message; response.bytes = sizeof(response); response.phase = CREATOR_EXIT; response.remaining = 0;
  error = creator_exchange(pipe, child.hProcess, &response, sizeof(response), TRUE, deadline); if (error) goto end;
  waited = WaitForSingleObject(child.hProcess, creator_remaining(deadline));
  if (waited != WAIT_OBJECT_0 || !GetExitCodeProcess(child.hProcess, &code)) {
    error = waited == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError(); if (!error) error = ERROR_INVALID_DATA; goto end;
  }
  if (code) error = code;
  fwprintf(stderr, L"creator-exit pid=%lu created=%llu wall-ms=%llu exit=0x%08lx\n",
    child.dwProcessId, (unsigned long long)request.message.created, ownership_wall_ms(), code); fflush(stderr);
end:
  if (child.hProcess && WaitForSingleObject(child.hProcess, 0) != WAIT_OBJECT_0) {
    forced = TRUE;
    BOOL killed = member ? TerminateJobObject(job, 125) : TerminateProcess(child.hProcess, 125);
    if (!killed && !error) error = GetLastError();
    if (WaitForSingleObject(child.hProcess, 1000) != WAIT_OBJECT_0 && !error) error = ERROR_TIMEOUT;
    if (!error) error = ERROR_OPERATION_ABORTED;
  }
  HANDLE owned[] = {pipe, passed, child.hThread, child.hProcess, job, image_file};
  unsigned int present = 0, closed = 0; DWORD close_error = 0;
  for (unsigned int i = 0; i < sizeof(owned) / sizeof(owned[0]); i++) if (owned[i] && owned[i] != INVALID_HANDLE_VALUE) {
    present++; if (CloseHandle(owned[i])) closed++; else if (!close_error) close_error = GetLastError();
  }
  if (creator_pending && WaitForSingleObject(creator_pending->operation.hEvent, 1000) == WAIT_OBJECT_0) {
    DWORD drained = creator_io_free(creator_pending); creator_pending = NULL;
    if (drained && !close_error) close_error = drained;
  }
  if (close_error && !error) error = close_error;
  if (creator_io_closed != creator_io_acquired && !error) error = ERROR_INVALID_DATA;
  if (creator_pending && !error) error = ERROR_IO_INCOMPLETE;
  if (startup.lpAttributeList) {
    if (initialized) DeleteProcThreadAttributeList(startup.lpAttributeList);
    free(startup.lpAttributeList);
  }
  if (pipe_security) LocalFree(pipe_security);
  free(line);
  fwprintf(stderr, L"creator-cleanup pid=%lu member=%d resumed=%d released=%d wait=%lu exit=0x%08lx forced=%d handles=%u closed=%u io-retained=%d error=%lu\n",
    child.dwProcessId, member, resumed, released, waited, code, forced, present, closed, creator_pending != NULL, error); fflush(stderr);
  fwprintf(stderr, L"creator-io-cleanup acquired=%u closed=%u retained=%d\n", creator_io_acquired, creator_io_closed, creator_pending != NULL); fflush(stderr);
  if (error) {
    open_directory_fn open = (open_directory_fn)(void *)nt_api("NtOpenDirectoryObject");
    UNICODE_STRING name = {(USHORT)(wcslen(probe_name) * 2), (USHORT)sizeof(probe_name), probe_name};
    OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
    attributes.Length = sizeof(attributes); attributes.ObjectName = &name; attributes.Attributes = 0x40;
    HANDLE observer = NULL; NTSTATUS status = open ? open(&observer, 1, &attributes) : (NTSTATUS)0xc0000002;
    BOOL closed_observer = !observer || CloseHandle(observer); DWORD observer_error = closed_observer ? 0 : GetLastError();
    fwprintf(stderr, L"creator-failure-map open=0x%08lx absent=%d closed=%d error=%lu\n",
      (unsigned long)status, status == (NTSTATUS)0xc0000034, closed_observer, observer_error); fflush(stderr);
  }
  if (!error) {
    CALLER_STATE caller; error = read_caller(root, &caller);
    if (!error && memcmp(&caller, &caller_before, sizeof(caller))) error = ERROR_INVALID_DATA;
    fwprintf(stderr, L"creator-caller unchanged=%d error=%lu\n", !error, error); fflush(stderr);
    if (!error) error = map_lifetime(L"after-creator-exit", L"directory-link");
  }
  return error;
}
