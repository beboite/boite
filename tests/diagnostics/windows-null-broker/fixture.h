/* No broker client calls: ordinary Win32/native APIs in the captured process. */
static LONG CALLBACK nb_application_handler(PEXCEPTION_POINTERS exception) {
  if (exception->ExceptionRecord->ExceptionCode != 0xe0424242) return EXCEPTION_CONTINUE_SEARCH;
  fwprintf(stderr, L"NB_CHECK pid=%lu name=handled ok=1\n", GetCurrentProcessId());
  return EXCEPTION_CONTINUE_EXECUTION;
}
static NB_CREATE nb_direct_create(void) {
  BYTE *code = VirtualAlloc(NULL, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE); DWORD old = 0;
  if (!code) return NULL;
  memcpy(code, (void *)nb_create, 32); code[0] = 0x4c;
  if (memcmp(code, "\x4c\x8b\xd1\xb8", 4) || !VirtualProtect(code, 4096, PAGE_EXECUTE_READ, &old) || !FlushInstructionCache(GetCurrentProcess(), code, 32)) {
    VirtualFree(code, 0, MEM_RELEASE); return NULL;
  }
  return (NB_CREATE)(void *)code;
}
static NTSTATUS nb_fixture_native(NB_CREATE create, HANDLE *h, IO_STATUS_BLOCK *io, DWORD access, ULONG options, ULONG disposition) {
  wchar_t text[] = L"\\Device\\Null"; UNICODE_STRING name = {sizeof(text) - 2, sizeof(text), text};
  OBJECT_ATTRIBUTES oa; ZeroMemory(&oa, sizeof(oa)); oa.Length = sizeof(oa); oa.ObjectName = &name; oa.Attributes = 0x40;
  return create(h, access, &oa, io, NULL, 0, 3, disposition, options, NULL, 0);
}
static int nb_pointer_controls(void) {
  NB_CREATE direct = nb_direct_create(); SYSTEM_INFO system; GetSystemInfo(&system); int ok = !!direct;
  if (!direct) return 0;
  for (unsigned variant = 0; variant < 7 && ok; ++variant) {
    int kind = variant / 2, on = variant % 2;
    if (variant == 6) {kind = 3; on = 1;}
    BYTE *handles = VirtualAlloc(NULL, system.dwPageSize, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    BYTE *iosbs = VirtualAlloc(NULL, system.dwPageSize * 2, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!handles || !iosbs) {if (handles) VirtualFree(handles, 0, MEM_RELEASE); if (iosbs) VirtualFree(iosbs, 0, MEM_RELEASE); ok = 0; break;}
    HANDLE *h = (HANDLE *)handles; IO_STATUS_BLOCK *io = (IO_STATUS_BLOCK *)(kind == 2 ? iosbs + system.dwPageSize - 8 : iosbs);
    memset(handles, 0x5a, 8); memset(io, 0x5a, kind == 2 ? 8 : 16);
    DWORD old = 0, before = 0, after = 0;
    if (kind == 0) ok = VirtualProtect(handles, system.dwPageSize, PAGE_READONLY, &old);
    if (kind == 1) ok = VirtualProtect(iosbs, system.dwPageSize, PAGE_READONLY, &old);
    if (kind == 2) ok = VirtualProtect(iosbs + system.dwPageSize, system.dwPageSize, PAGE_NOACCESS, &old);
    if (!GetProcessHandleCount(GetCurrentProcess(), &before)) ok = 0;
    NTSTATUS status = ok ? nb_fixture_native(on ? nb_create : direct, h, io, GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE, 0x60, 1) : NB_INVALID;
    int opened = (uintptr_t)*h != UINT64_C(0x5a5a5a5a5a5a5a5a), unchanged = 1;
    for (unsigned i = 0; i < 8; ++i) if (handles[i] != 0x5a) unchanged = 0;
    for (unsigned i = 0; i < (kind == 2 ? 8u : 16u); ++i) if (((BYTE *)io)[i] != 0x5a) unchanged = 0;
    if (status >= 0 && opened && !CloseHandle(*h)) ok = 0;
    if (!GetProcessHandleCount(GetCurrentProcess(), &after)) ok = 0;
    const wchar_t *names[] = {L"readonly-handle", L"readonly-iosb", L"boundary", L"writable"};
    fwprintf(stderr, L"NB_POINTER pid=%lu transport=%ls name=%ls status=0x%08lx unchanged=%d handles=%ld opened=%d\n",
      GetCurrentProcessId(), on ? L"on" : L"off", names[kind], (DWORD)status, unchanged, (LONG)after - (LONG)before, opened);
    if (kind < 3 ? status >= 0 || !unchanged || opened || after != before : status < 0 || !opened || after != before) ok = 0;
    VirtualFree(handles, 0, MEM_RELEASE); VirtualFree(iosbs, 0, MEM_RELEASE);
  }
  VirtualFree((void *)direct, 0, MEM_RELEASE); return ok;
}
static int nb_io(HANDLE h, int read, int write, int async) {
  BYTE bytes[4096]; memset(bytes, 0x42, sizeof(bytes)); int ok = 1;
  for (unsigned i = 0; i < 2 && ok; ++i) {
    OVERLAPPED overlap; ZeroMemory(&overlap, sizeof(overlap));
    if (async) {overlap.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL); if (!overlap.hEvent) return 0;}
    DWORD used = 0;
    if (read) {
      BOOL done = ReadFile(h, bytes, sizeof(bytes), &used, async ? &overlap : NULL); DWORD error = done ? 0 : GetLastError();
      if (!done && error == ERROR_IO_PENDING) done = GetOverlappedResult(h, &overlap, &used, TRUE);
      if ((!done && error != ERROR_HANDLE_EOF) || used) ok = 0;
    }
    if (async) {ResetEvent(overlap.hEvent); overlap.Internal = 0; overlap.InternalHigh = 0;}
    used = 0;
    if (write) {
      BOOL done = WriteFile(h, bytes, sizeof(bytes), &used, async ? &overlap : NULL); DWORD error = done ? 0 : GetLastError();
      if (!done && error == ERROR_IO_PENDING) done = GetOverlappedResult(h, &overlap, &used, TRUE);
      if (!done || used != sizeof(bytes)) ok = 0;
    }
    if (async && !CloseHandle(overlap.hEvent)) ok = 0;
  }
  return ok;
}
static int nb_open_cases(void) {
  HANDLE independent[2] = {NULL, NULL}; int ok = 1;
  for (unsigned api = 0; api < 3 && ok; ++api) for (unsigned mode = 0; mode < 3 && ok; ++mode) {
    HANDLE h = NULL; IO_STATUS_BLOCK io; ZeroMemory(&io, sizeof(io));
    DWORD rights[] = {GENERIC_READ, GENERIC_WRITE, GENERIC_READ | GENERIC_WRITE};
    DWORD access = rights[mode] | SYNCHRONIZE, win32_error = 0; NTSTATUS status = 0;
    if (!api) {
      h = CreateFileW(L"NUL", rights[mode], 3, NULL, OPEN_EXISTING, 0, NULL);
      if (h == INVALID_HANDLE_VALUE) {win32_error = GetLastError(); h = NULL; status = NB_INVALID;}
    } else if (api == 1) {
      wchar_t text[] = L"\\Device\\Null"; UNICODE_STRING name = {sizeof(text) - 2, sizeof(text), text};
      OBJECT_ATTRIBUTES oa; ZeroMemory(&oa, sizeof(oa)); oa.Length = sizeof(oa); oa.ObjectName = &name; oa.Attributes = 0x40;
      status = nb_open(&h, access, &oa, &io, 3, 0x60);
    } else status = nb_fixture_native(nb_create, &h, &io, access, 0x60, 1);
    NB_BASIC basic; NB_DEVICE device; ULONG actual_mode = 0;
    ok = status >= 0 && h && nb_measure(h, &basic, &actual_mode, &device) && nb_io(h, mode != 1, mode != 0, 0);
    fwprintf(stderr, L"NB_OPEN pid=%lu api=%u access=%u async=0 disposition=1 status=0x%08lx statusKnown=%d win32Error=%lu type=%u device=%lu granted=0x%08lx mode=0x%08lx eof=%u written=%u ok=%d\n",
      GetCurrentProcessId(), api, mode, (DWORD)status, !win32_error, win32_error, ok ? 2u : 0u, ok ? device.Type : 0, ok ? basic.GrantedAccess : 0,
      actual_mode, mode == 1 ? 0u : 2u, mode == 0 ? 0u : 8192u, ok);
    if (h && !CloseHandle(h)) ok = 0;
  }
  if (!ok) return 0;
  for (unsigned i = 0; i < 2 && ok; ++i) {
    IO_STATUS_BLOCK io; NTSTATUS status = nb_fixture_native(nb_create, &independent[i], &io,
      GENERIC_READ | GENERIC_WRITE | (i ? 0 : SYNCHRONIZE), i ? 0x40 : 0x60, 1);
    NB_BASIC basic; NB_DEVICE device; ULONG mode = 0;
    ok = status >= 0 && nb_measure(independent[i], &basic, &mode, &device) && !!(mode & 0x20) == !i && nb_io(independent[i], 1, 1, i);
    fwprintf(stderr, L"NB_MODE pid=%lu async=%u status=0x%08lx mode=0x%08lx granted=0x%08lx ok=%d\n", GetCurrentProcessId(), i, (DWORD)status, mode, ok ? basic.GrantedAccess : 0, ok);
  }
  if (ok) {
    HANDLE duplicate = NULL; ok = DuplicateHandle(GetCurrentProcess(), independent[0], GetCurrentProcess(), &duplicate, 0, FALSE, DUPLICATE_SAME_ACCESS);
    NTSTATUS same = ok ? nb_compare(independent[0], duplicate) : NB_INVALID, different = nb_compare(independent[0], independent[1]);
    ok = ok && same == 0 && different == (NTSTATUS)0xc00001ac;
    fwprintf(stderr, L"NB_OBJECT pid=%lu same=0x%08lx different=0x%08lx ok=%d\n", GetCurrentProcessId(), (DWORD)same, (DWORD)different, ok);
    if (duplicate && !CloseHandle(duplicate)) ok = 0;
  }
  for (unsigned i = 0; i < 2; ++i) if (independent[i] && !CloseHandle(independent[i])) ok = 0;
  HANDLE redirection = CreateFileW(L"NUL", GENERIC_WRITE, 3, NULL, CREATE_ALWAYS, 0, NULL);
  int redirected = redirection != INVALID_HANDLE_VALUE && nb_io(redirection, 0, 1, 0);
  if (redirection != INVALID_HANDLE_VALUE && !CloseHandle(redirection)) redirected = 0;
  fwprintf(stderr, L"NB_CHECK pid=%lu name=redirection ok=%d\n", GetCurrentProcessId(), redirected);
  return ok && redirected;
}
static DWORD WINAPI nb_concurrent(void *context) {
  HANDLE gate = context;
  if (WaitForSingleObject(gate, 5000) != WAIT_OBJECT_0) return 1;
  for (unsigned i = 0; i < 8; ++i) {
    HANDLE h = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, 3, NULL, OPEN_EXISTING, 0, NULL);
    if (h == INVALID_HANDLE_VALUE || !nb_io(h, 1, 1, 0) || !CloseHandle(h)) return 1;
    /* Force non-Null pass-through in both threads as well. */
    h = CreateFileW(L"ordinary.txt", GENERIC_READ, 3, NULL, OPEN_EXISTING, 0, NULL);
    if (h == INVALID_HANDLE_VALUE || !CloseHandle(h)) return 1;
  }
  return 0;
}
static int nb_two_threads(void) {
  HANDLE gate = CreateEventW(NULL, TRUE, FALSE, NULL), threads[2] = {NULL, NULL}; int ok = !!gate;
  for (unsigned i = 0; i < 2 && ok; ++i) {threads[i] = CreateThread(NULL, 0, nb_concurrent, gate, 0, NULL); ok = !!threads[i];}
  if (gate) SetEvent(gate);
  for (unsigned i = 0; i < 2; ++i) if (threads[i]) {
    DWORD code = 1; if (WaitForSingleObject(threads[i], 10000) != WAIT_OBJECT_0 || !GetExitCodeThread(threads[i], &code) || code) ok = 0;
    CloseHandle(threads[i]);
  }
  if (gate) CloseHandle(gate);
  fwprintf(stderr, L"NB_CHECK pid=%lu name=two-threads ok=%d\n", GetCurrentProcessId(), ok); return ok;
}
static int nb_control_handles(void) {
  typedef NTSTATUS (NTAPI *query_process)(HANDLE, ULONG, PVOID, ULONG, PULONG);
  typedef struct {HANDLE Value; ULONG_PTR Handles, Pointers; ACCESS_MASK Access; ULONG Type, Attributes, Reserved;} ENTRY;
  typedef struct {ULONG_PTR Count, Reserved; ENTRY Entries[1];} SNAPSHOT;
  query_process query = (query_process)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess");
  BYTE *buffer = calloc(1, 65536); ULONG size = 0; int ok = query && buffer && query(GetCurrentProcess(), 51, buffer, 65536, &size) >= 0;
  SNAPSHOT *snapshot = (SNAPSHOT *)buffer;
  if (ok && (snapshot->Count > (65536 - offsetof(SNAPSHOT, Entries)) / sizeof(ENTRY))) ok = 0;
  for (ULONG_PTR i = 0; ok && i < snapshot->Count; ++i) {
    union {ULONGLONG align; BYTE bytes[1024];} type;
    if (nb_query_object(snapshot->Entries[i].Value, 2, type.bytes, sizeof(type.bytes), &size) < 0) {ok = 0; break;}
    UNICODE_STRING *name = (UNICODE_STRING *)type.bytes;
    if (!name->Buffer || name->Length > 128) {ok = 0; break;}
    if ((name->Length == 6 && !wcsncmp(name->Buffer, L"Job", 3)) || (name->Length == 22 && !wcsncmp(name->Buffer, L"DebugObject", 11))) ok = 0;
    if (name->Length == 14 && !wcsncmp(name->Buffer, L"Process", 7)) {
      BOOL job = FALSE;
      if (!IsProcessInJob(snapshot->Entries[i].Value, NULL, &job) || !job) ok = 0;
    }
  }
  free(buffer); fwprintf(stderr, L"NB_CHECK pid=%lu name=control-handles ok=%d\n", GetCurrentProcessId(), ok); return ok;
}
/* The host control and LPAC refusal use this exact same NT object name. */
static int nb_host_name(const wchar_t *dos, wchar_t text[32768], UNICODE_STRING *name) {
  size_t length = wcslen(dos);
  if (length < 3 || length > 32762 || dos[1] != L':' || dos[2] != L'\\') return 0;
  memcpy(text, L"\\??\\", 4 * sizeof(wchar_t));
  memcpy(text + 4, dos, (length + 1) * sizeof(wchar_t));
  *name = (UNICODE_STRING){(USHORT)((length + 4) * 2), (USHORT)((length + 5) * 2), text};
  return 1;
}
static NTSTATUS nb_host_path(const wchar_t *dos, HANDLE *handle) {
  wchar_t text[32768]; UNICODE_STRING name;
  if (!nb_host_name(dos, text, &name)) return NB_INVALID;
  OBJECT_ATTRIBUTES oa; ZeroMemory(&oa, sizeof(oa)); oa.Length = sizeof(oa); oa.ObjectName = &name; oa.Attributes = 0x40;
  IO_STATUS_BLOCK io;
  return nb_create(handle, GENERIC_READ | SYNCHRONIZE, &oa, &io, NULL, 0, 3, 1, 0x60, NULL, 0);
}
static int nb_denials(int count, wchar_t **args) {
  if (count != 11) return 0;
  int ok = 1; const wchar_t *names[] = {L"ambient", L"excluded", L"hostfile"};
  for (unsigned i = 0; i < 3; ++i) {
    HANDLE h = CreateFileW(args[4 + i], GENERIC_READ, 3, NULL, OPEN_EXISTING, 0, NULL);
    DWORD error = h == INVALID_HANDLE_VALUE ? GetLastError() : 0;
    int denied = h == INVALID_HANDLE_VALUE && error == ERROR_ACCESS_DENIED;
    if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
    fwprintf(stderr, L"NB_DENY pid=%lu name=%ls denied=%d error=%lu\n", GetCurrentProcessId(), names[i], denied, error); ok = ok && denied;
  }
  HANDLE credential = (HANDLE)(uintptr_t)_wcstoui64(args[7], NULL, 10); BYTE bytes[32]; DWORD used = 0;
  BOOL read = ReadFile(credential, bytes, sizeof(bytes), &used, NULL); DWORD error = read ? 0 : GetLastError();
  fwprintf(stderr, L"NB_DENY pid=%lu name=credential denied=%d error=%lu\n", GetCurrentProcessId(), !read && error == ERROR_INVALID_HANDLE, error);
  ok = ok && !read && error == ERROR_INVALID_HANDLE;
  HANDLE host = OpenProcess(PROCESS_VM_READ | PROCESS_DUP_HANDLE, FALSE, wcstoul(args[8], NULL, 10));
  error = host ? 0 : GetLastError();
  fwprintf(stderr, L"NB_DENY pid=%lu name=hostprocess denied=%d error=%lu\n", GetCurrentProcessId(), !host && error == ERROR_ACCESS_DENIED, error);
  if (host) CloseHandle(host);
  ok = ok && !host && error == ERROR_ACCESS_DENIED;
  NB_CREATE direct = nb_direct_create(); HANDLE h = NULL; IO_STATUS_BLOCK io;
  NTSTATUS status = direct ? nb_fixture_native(direct, &h, &io, GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE, 0x60, 1) : NB_INVALID;
  if (direct) VirtualFree((void *)direct, 0, MEM_RELEASE);
  fwprintf(stderr, L"NB_DENY pid=%lu name=direct denied=%d error=%lu\n", GetCurrentProcessId(), status == NB_DENIED && !h, (DWORD)status);
  if (h) CloseHandle(h);
  ok = ok && status == NB_DENIED && !h;
  h = NULL; status = nb_fixture_native(nb_create, &h, &io, WRITE_DAC | SYNCHRONIZE, 0x60, 1);
  fwprintf(stderr, L"NB_DENY pid=%lu name=acl denied=%d error=%lu\n", GetCurrentProcessId(), status == NB_UNSUPPORTED && !h, (DWORD)status);
  if (h) CloseHandle(h);
  ok = ok && status == NB_UNSUPPORTED && !h;
  /* A forged request at an owned export still receives ordinary LPAC lookup.
   * Neither the supplied pathname nor an arbitrary host handle enters host I/O. */
  h = NULL; status = nb_host_path(args[6], &h);
  fwprintf(stderr, L"NB_DENY pid=%lu name=forged-path denied=%d error=%lu\n", GetCurrentProcessId(), status == NB_DENIED && !h, (DWORD)status);
  if (h) CloseHandle(h);
  ok = ok && status == NB_DENIED && !h;
  wchar_t image[32768]; GetModuleFileNameW(NULL, image, 32768);
  wchar_t *line = command_line(1, &args[0]); STARTUPINFOW startup; PROCESS_INFORMATION child;
  ZeroMemory(&startup, sizeof(startup)); startup.cb = sizeof(startup); ZeroMemory(&child, sizeof(child));
  BOOL created = line && CreateProcessW(image, line, NULL, NULL, FALSE, CREATE_BREAKAWAY_FROM_JOB | CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL, NULL, &startup, &child);
  error = created ? 0 : GetLastError();
  fwprintf(stderr, L"NB_DENY pid=%lu name=breakaway denied=%d error=%lu\n", GetCurrentProcessId(), !created && error == ERROR_ACCESS_DENIED, error);
  if (created) {TerminateProcess(child.hProcess, 125); CloseHandle(child.hThread); CloseHandle(child.hProcess);}
  free(line); ok = ok && !created && error == ERROR_ACCESS_DENIED;
  WSADATA data; int startup_error = WSAStartup(MAKEWORD(2, 2), &data), network_denied = startup_error != 0, net_error = startup_error;
  SOCKET socket_handle = INVALID_SOCKET;
  if (!startup_error) {
    socket_handle = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (socket_handle == INVALID_SOCKET) {network_denied = 1; net_error = WSAGetLastError();}
    else {
      u_long nonblocking = 1; ioctlsocket(socket_handle, FIONBIO, &nonblocking);
      struct sockaddr_in address; ZeroMemory(&address, sizeof(address)); address.sin_family = AF_INET;
      address.sin_addr.s_addr = htonl(INADDR_LOOPBACK); address.sin_port = htons((u_short)wcstoul(args[9], NULL, 10));
      int connected = connect(socket_handle, (struct sockaddr *)&address, sizeof(address)); net_error = connected ? WSAGetLastError() : 0;
      if (connected && net_error == WSAEWOULDBLOCK) {
        fd_set writes, errors; FD_ZERO(&writes); FD_ZERO(&errors); FD_SET(socket_handle, &writes); FD_SET(socket_handle, &errors);
        struct timeval timeout = {1, 500000}; int ready = select(0, NULL, &writes, &errors, &timeout);
        if (ready > 0) {int length = sizeof(net_error); getsockopt(socket_handle, SOL_SOCKET, SO_ERROR, (char *)&net_error, &length); connected = net_error != 0;}
        else {connected = -1; net_error = ready == 0 ? WSAETIMEDOUT : WSAGetLastError();}
      }
      network_denied = connected != 0;
    }
    if (socket_handle != INVALID_SOCKET) closesocket(socket_handle);
    WSACleanup();
  }
  fwprintf(stderr, L"NB_DENY pid=%lu name=network denied=%d error=%d\n", GetCurrentProcessId(), network_denied, net_error);
  return ok && network_denied;
}
static int nb_fixture(int count, wchar_t **args) {
  if (count < 4 || !nb_resolve()) return 125;
  const wchar_t *scenario = args[2];
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  if (!wcscmp(scenario, L"host-path")) {
    if (count != 11) return 125;
    HANDLE h = NULL; NTSTATUS status = nb_host_path(args[6], &h); char bytes[64]; DWORD used = 0;
    const char expected[] = "SYNTHETIC_HOST";
    int content = status >= 0 && h && ReadFile(h, bytes, sizeof(bytes), &used, NULL) && used == sizeof(expected) - 1 && !memcmp(bytes, expected, sizeof(expected) - 1);
    if (h && !CloseHandle(h)) content = 0;
    fwprintf(stderr, L"NB_HOST_PATH status=0x%08lx content=%d\n", (DWORD)status, content);
    return content ? 0 : 1;
  }
  if (!wcscmp(scenario, L"off")) {
    if (count != 11) return 125;
    HANDLE ambient = CreateFileW(args[4], GENERIC_READ, 3, NULL, OPEN_EXISTING, 0, NULL);
    DWORD ambient_error = ambient == INVALID_HANDLE_VALUE ? GetLastError() : 0;
    if (ambient != INVALID_HANDLE_VALUE) CloseHandle(ambient);
    fwprintf(stderr, L"NB_DENY pid=%lu name=ambient denied=%d error=%lu\n", GetCurrentProcessId(), ambient_error == ERROR_ACCESS_DENIED, ambient_error);
    HANDLE h = NULL; IO_STATUS_BLOCK io; NTSTATUS status = nb_fixture_native(nb_create, &h, &io, GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE, 0x60, 1);
    fwprintf(stderr, L"NB_OFF pid=%lu status=0x%08lx opened=%d\n", GetCurrentProcessId(), (DWORD)status, !!h);
    if (h) CloseHandle(h);
    return status == NB_DENIED && !h && ambient_error == ERROR_ACCESS_DENIED ? 0 : 1;
  }
  if (!wcscmp(scenario, L"pointers")) return nb_pointer_controls() ? 0 : 1;
  if (!wcscmp(scenario, L"rollback")) {
    HANDLE h = (HANDLE)(uintptr_t)UINT64_C(0x5a5a5a5a5a5a5a5a); IO_STATUS_BLOCK io, original; memset(&io, 0x5a, sizeof(io)); original = io;
    DWORD before = 0, after = 0; if (!GetProcessHandleCount(GetCurrentProcess(), &before)) return 1;
    NTSTATUS status = nb_fixture_native(nb_create, &h, &io, GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE, 0x60, 1);
    if (!GetProcessHandleCount(GetCurrentProcess(), &after)) return 1;
    int unchanged = (uintptr_t)h == UINT64_C(0x5a5a5a5a5a5a5a5a) && !memcmp(&io, &original, sizeof(io));
    fwprintf(stderr, L"NB_ROLLBACK pid=%lu remoteClosed=1 unchanged=%d handles=%ld\n", GetCurrentProcessId(), unchanged, (LONG)after - (LONG)before);
    return status == NB_BAD_POINTER && unchanged && before == after ? 0 : 1;
  }
  if (!wcscmp(scenario, L"handled")) {
    PVOID handler = AddVectoredExceptionHandler(1, nb_application_handler); if (!handler) return 1;
    RaiseException(0xe0424242, 0, 0, NULL); return RemoveVectoredExceptionHandler(handler) ? 0 : 1;
  }
  if (!wcscmp(scenario, L"unhandled")) {RaiseException(0xe0434343, EXCEPTION_NONCONTINUABLE, 0, NULL); return 1;}
  if (!wcscmp(scenario, L"wait")) {
    if (count != 12) return 125;
    HANDLE ready = (HANDLE)(uintptr_t)_wcstoui64(args[11], NULL, 10);
    fwprintf(stderr, L"NB_READY wait=1 pid=%lu\n", GetCurrentProcessId()); fflush(stderr);
    if (!ready || !SetEvent(ready) || !CloseHandle(ready)) return 1;
    Sleep(INFINITE); return 1;
  }
  if (!wcscmp(scenario, L"native") || !wcscmp(scenario, L"child") || !wcscmp(scenario, L"root-exit") || !wcscmp(scenario, L"lifetime")) {
    int ok = nb_open_cases() && nb_denials(count, args) && nb_two_threads() && nb_control_handles();
    if (!ok || !wcscmp(scenario, L"child")) return ok ? 0 : 1;
    int waiting = !wcscmp(scenario, L"root-exit") || !wcscmp(scenario, L"lifetime");
    SECURITY_ATTRIBUTES security = {sizeof(security), NULL, TRUE};
    HANDLE ready = waiting ? CreateEventW(&security, TRUE, FALSE, NULL) : NULL;
    if (waiting && !ready) return 1;
    wchar_t ready_text[32]; swprintf(ready_text, 32, L"%llu", (unsigned long long)(uintptr_t)ready);
    wchar_t **child_args = calloc((size_t)count + 1, sizeof(wchar_t *)); if (!child_args) {if (ready) CloseHandle(ready); return 1;}
    for (int i = 0; i < count; ++i) child_args[i] = args[i];
    child_args[2] = waiting ? L"wait" : L"child";
    if (waiting) child_args[count] = ready_text;
    wchar_t *line = command_line(count + waiting, child_args); free(child_args);
    STARTUPINFOW startup; PROCESS_INFORMATION child; ZeroMemory(&startup, sizeof(startup)); ZeroMemory(&child, sizeof(child)); startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES; startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE); startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE); startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    BOOL created = line && CreateProcessW(args[0], line, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, NULL, &startup, &child);
    free(line); DWORD code = 1;
    if (created) {
      int acknowledged = !waiting || WaitForSingleObject(ready, 20000) == WAIT_OBJECT_0;
      if (ready) {CloseHandle(ready); ready = NULL;}
      if (!acknowledged) {TerminateProcess(child.hProcess, 125); CloseHandle(child.hThread); CloseHandle(child.hProcess); return 1;}
      if (!wcscmp(scenario, L"lifetime")) {fwprintf(stderr, L"NB_READY root=1 child=%lu\n", child.dwProcessId); fflush(stderr); Sleep(INFINITE);}
      if (!wcscmp(scenario, L"root-exit")) {fwprintf(stderr, L"NB_DETACHED pid=%lu\n", child.dwProcessId); code = 0;}
      else if (WaitForSingleObject(child.hProcess, 20000) == WAIT_OBJECT_0) GetExitCodeProcess(child.hProcess, &code);
      CloseHandle(child.hThread); CloseHandle(child.hProcess);
    }
    if (ready) CloseHandle(ready);
    fwprintf(stderr, L"NB_CHECK pid=%lu name=ordinary-child ok=%d\n", GetCurrentProcessId(), created && code == 0); return created && code == 0 ? 0 : 1;
  }
  return 125;
}
