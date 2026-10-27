#include "native.h"
#define NB_PROCESSES 32
typedef struct {DWORD id; HANDLE handle;} NB_THREAD_HANDLE;
typedef struct {
  DWORD id, parent, first; HANDLE handle, measurement; NB_STEP step; NB_THREAD_HANDLE threads[NB_THREADS];
  uintptr_t ntdll, sites[2]; BYTE originals[2]; DWORD flags; int startup, image, exited;
} NB_PROCESS;
typedef struct {NB_PROCESS processes[NB_PROCESSES]; HANDLE job; PSID package, registry; DWORD root; unsigned events, delegations; int stopping;} NB_DEBUG;
static NB_PROCESS *nb_process(NB_DEBUG *d, DWORD id) {
  for (unsigned i = 0; i < NB_PROCESSES; ++i) if (d->processes[i].id == id && !d->processes[i].exited) return &d->processes[i];
  return NULL;
}
static HANDLE nb_thread_handle(NB_PROCESS *p, DWORD id) {
  for (unsigned i = 0; i < NB_THREADS; ++i) if (p->threads[i].id == id) return p->threads[i].handle;
  return NULL;
}
static int nb_hold(void *ctx, uint32_t id) {
  NB_PROCESS *p = ctx; HANDLE t = nb_thread_handle(p, id); DWORD old = t ? SuspendThread(t) : (DWORD)-1;
  fwprintf(stderr, L"NB_SUSPEND pid=%lu tid=%lu owner=%lu previous=%lu\n", p->id, (DWORD)id, (DWORD)p->step.owner, old);
  return old != (DWORD)-1;
}
static int nb_release(void *ctx, uint32_t id) {
  NB_PROCESS *p = ctx; HANDLE t = nb_thread_handle(p, id); DWORD old = t ? ResumeThread(t) : (DWORD)-1;
  fwprintf(stderr, L"NB_RESUME pid=%lu tid=%lu owner=%lu previous=%lu\n", p->id, (DWORD)id, (DWORD)p->step.owner, old);
  return old != (DWORD)-1 && old > 0;
}
static int nb_add_thread(NB_PROCESS *p, DWORD id, HANDLE kernel_handle) {
  for (unsigned i = 0; i < NB_THREADS; ++i) if (!p->threads[i].id) {
    HANDLE own = NULL;
    if (!DuplicateHandle(GetCurrentProcess(), kernel_handle, GetCurrentProcess(), &own, 0, FALSE, DUPLICATE_SAME_ACCESS)) return 0;
    p->threads[i].id = id; p->threads[i].handle = own;
    fwprintf(stderr, L"NB_HANDLE pid=%lu tid=%lu kind=thread action=own\n", p->id, id);
    return nb_join(&p->step, id, nb_hold, p);
  }
  return 0;
}
static int nb_read(NB_PROCESS *p, uintptr_t address, void *out, SIZE_T size) {
  SIZE_T read = 0;
  if (!address || size > UINTPTR_MAX - address) return 0;
  return ReadProcessMemory(p->handle, (void *)address, out, size, &read) && read == size;
}
static int nb_write(NB_PROCESS *p, uintptr_t address, const void *in, SIZE_T size) {
  SIZE_T written = 0; return WriteProcessMemory(p->handle, (void *)address, in, size, &written) && written == size;
}
static int nb_query_region(void *ctx, uintptr_t address, NB_REGION *r) {
  NB_PROCESS *p = ctx; MEMORY_BASIC_INFORMATION m;
  if (VirtualQueryEx(p->handle, (void *)address, &m, sizeof(m)) != sizeof(m)) return 0;
  DWORD prot = m.Protect & 0xff;
  *r = (NB_REGION){(uintptr_t)m.BaseAddress, m.RegionSize, m.State == MEM_COMMIT,
    prot == PAGE_READWRITE || prot == PAGE_WRITECOPY || prot == PAGE_EXECUTE_READWRITE || prot == PAGE_EXECUTE_WRITECOPY,
    !!(m.Protect & PAGE_GUARD)};
  return 1;
}
static int nb_binding(NB_DEBUG *d, NB_PROCESS *p, int announce) {
  HANDLE token = NULL; DWORD size = 0, container = 0; int ok = 0; BOOL job = FALSE;
  TOKEN_APPCONTAINER_INFORMATION *package = NULL; TOKEN_GROUPS *caps = NULL; LPWSTR text = NULL;
  if (!IsProcessInJob(p->handle, d->job, &job) || !job || !OpenProcessToken(p->handle, TOKEN_QUERY, &token)) goto done;
  if (!GetTokenInformation(token, TokenIsAppContainer, &container, sizeof(container), &size) || container != 1) goto done;
  GetTokenInformation(token, TokenAppContainerSid, NULL, 0, &size); package = calloc(1, size);
  if (!package || !GetTokenInformation(token, TokenAppContainerSid, package, size, &size) || !EqualSid(package->TokenAppContainer, d->package)) goto done;
  GetTokenInformation(token, TokenCapabilities, NULL, 0, &size); caps = calloc(1, size);
  if (!caps || !GetTokenInformation(token, TokenCapabilities, caps, size, &size) || caps->GroupCount != 1 ||
      !EqualSid(caps->Groups[0].Sid, d->registry) || !(caps->Groups[0].Attributes & SE_GROUP_ENABLED) || (caps->Groups[0].Attributes & ~7u)) goto done;
  typedef NTSTATUS (NTAPI *query_attr)(HANDLE, PUNICODE_STRING, ULONG, PVOID, ULONG, PULONG);
  query_attr query = (query_attr)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQuerySecurityAttributesToken");
  wchar_t name_text[] = L"WIN://NOALLAPPPKG";
  UNICODE_STRING name = {sizeof(name_text) - 2, sizeof(name_text), name_text};
  union {ULONGLONG align; BYTE bytes[8192];} attrs; ZeroMemory(&attrs, sizeof(attrs));
  if (!query || query(token, &name, 1, attrs.bytes, sizeof(attrs.bytes), &size) < 0) goto done;
  NB_ATTRS *a = (NB_ATTRS *)attrs.bytes;
  if (a->Version != 1 || a->Count != 1 || !a->Attrs || a->Attrs->Count != 1 ||
      (a->Attrs->Type != 2 && a->Attrs->Type != 6) || !a->Attrs->Values.Integer || *a->Attrs->Values.Integer != 1) goto done;
  NB_BASIC basic;
  if (nb_query_object(p->handle, 0, &basic, sizeof(basic), &size) < 0 ||
      (basic.GrantedAccess & (PROCESS_DUP_HANDLE | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_VM_OPERATION | PROCESS_QUERY_INFORMATION)) !=
      (PROCESS_DUP_HANDLE | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_VM_OPERATION | PROCESS_QUERY_INFORMATION)) goto done;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  if (!QueryInformationJobObject(d->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits), NULL) ||
      !(limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) ||
      (limits.BasicLimitInformation.LimitFlags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK))) goto done;
  if (!ConvertSidToStringSidW(package->TokenAppContainer, &text)) goto done;
  if (announce) fwprintf(stderr, L"NB_BIND pid=%lu parent=%lu generation=%ls package=%ls lpac=1 capabilities=1 registry=1 job=1 dup=1\n",
    p->id, p->parent, p->id == d->root ? L"root" : L"child", text);
  ok = 1;
done:
  if (text) LocalFree(text);
  free(package); free(caps); if (token) CloseHandle(token); return ok;
}
static int nb_patch(NB_PROCESS *p, uintptr_t address, BYTE byte) {
  DWORD protection = 0, ignored = 0;
  if (!VirtualProtectEx(p->handle, (void *)address, 1, PAGE_EXECUTE_READWRITE, &protection)) return 0;
  int ok = nb_write(p, address, &byte, 1) && FlushInstructionCache(p->handle, (void *)address, 1);
  if (!VirtualProtectEx(p->handle, (void *)address, 1, protection, &ignored)) ok = 0;
  return ok;
}
static int nb_export(NB_PROCESS *p, const IMAGE_NT_HEADERS64 *nt, const char *wanted, uintptr_t *out) {
  IMAGE_DATA_DIRECTORY range = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT]; IMAGE_EXPORT_DIRECTORY exports;
  if (!range.VirtualAddress || range.Size < sizeof(exports) || range.VirtualAddress > 0x264000 - range.Size ||
      !nb_read(p, p->ntdll + range.VirtualAddress, &exports, sizeof(exports)) || exports.NumberOfNames > 4096 || exports.NumberOfFunctions > 4096) return 0;
  for (DWORD i = 0; i < exports.NumberOfNames; ++i) {
    DWORD name_rva = 0, fn_rva = 0; WORD ordinal = 0; char name[64];
    if (!nb_read(p, p->ntdll + exports.AddressOfNames + i * 4, &name_rva, 4) || name_rva > 0x264000 - sizeof(name) ||
        !nb_read(p, p->ntdll + name_rva, name, sizeof(name)) || !memchr(name, 0, sizeof(name))) return 0;
    if (strcmp(name, wanted)) continue;
    if (!nb_read(p, p->ntdll + exports.AddressOfNameOrdinals + i * 2, &ordinal, 2) || ordinal >= exports.NumberOfFunctions ||
        !nb_read(p, p->ntdll + exports.AddressOfFunctions + ordinal * 4, &fn_rva, 4) || fn_rva >= 0x264000 ||
        (fn_rva >= range.VirtualAddress && fn_rva < range.VirtualAddress + range.Size)) return 0;
    *out = p->ntdll + fn_rva; return 1;
  }
  return 0;
}
static int nb_image(NB_PROCESS *p, HANDLE file, void *base) {
  /* Basename is only a candidate filter. Kernel file identity AND full hash are
   * checked before the sole supported startup site is used. */
  wchar_t path[32768], system[MAX_PATH];
  if (!file) return 1; /* Missing ntdll provenance still fails at startup. */
  if (!GetFinalPathNameByHandleW(file, path, 32768, FILE_NAME_NORMALIZED)) return 0;
  wchar_t *leaf = wcsrchr(path, L'\\');
  if (!leaf || _wcsicmp(leaf + 1, L"ntdll.dll")) return 1;
  if (p->ntdll || !GetSystemDirectoryW(system, MAX_PATH) || wcslen(system) + 11 >= MAX_PATH) return 0;
  memcpy(system + wcslen(system), L"\\ntdll.dll", sizeof(L"\\ntdll.dll"));
  HANDLE reference = CreateFileW(system, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL);
  BY_HANDLE_FILE_INFORMATION a, b; char sha[65]; int verified = reference != INVALID_HANDLE_VALUE &&
    GetFileInformationByHandle(file, &a) && GetFileInformationByHandle(reference, &b) && a.dwVolumeSerialNumber == b.dwVolumeSerialNumber &&
    a.nFileIndexHigh == b.nFileIndexHigh && a.nFileIndexLow == b.nFileIndexLow && nb_file_sha(file, sha) && !strcmp(sha, NB_NTDLL_SHA);
  if (reference != INVALID_HANDLE_VALUE) CloseHandle(reference);
  if (!verified) return 0;
  p->ntdll = (uintptr_t)base;
  IMAGE_DOS_HEADER dos; IMAGE_NT_HEADERS64 nt; BYTE loader[sizeof(route_loader_code)];
  if (!nb_read(p, p->ntdll, &dos, sizeof(dos)) || dos.e_magic != IMAGE_DOS_SIGNATURE || dos.e_lfanew < 0 || dos.e_lfanew > 4096 ||
      !nb_read(p, p->ntdll + dos.e_lfanew, &nt, sizeof(nt)) || nt.Signature != IMAGE_NT_SIGNATURE || nt.FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64 ||
      nt.FileHeader.TimeDateStamp != 0x64d8ddf5 || nt.OptionalHeader.SizeOfImage != 0x264000 || nt.OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC ||
      !nb_read(p, p->ntdll + ROUTE_LOADER_START, loader, sizeof(loader)) || memcmp(loader, route_loader_code, sizeof(loader))) return 0;
  /* RSDS matches the provenance header in addition to the full file hash. */
  IMAGE_DATA_DIRECTORY dd = nt.OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_DEBUG]; int guid = 0;
  if (dd.Size > 4096 || dd.Size % sizeof(IMAGE_DEBUG_DIRECTORY)) return 0;
  for (DWORD i = 0; i < dd.Size / sizeof(IMAGE_DEBUG_DIRECTORY); ++i) {
    IMAGE_DEBUG_DIRECTORY debug;
    struct {DWORD magic; GUID guid; DWORD age;} rsds;
    if (!nb_read(p, p->ntdll + dd.VirtualAddress + i * sizeof(debug), &debug, sizeof(debug))) return 0;
    if (debug.Type == IMAGE_DEBUG_TYPE_CODEVIEW && debug.SizeOfData >= sizeof(rsds) &&
        nb_read(p, p->ntdll + debug.AddressOfRawData, &rsds, sizeof(rsds)) && rsds.magic == 0x53445352 &&
        !memcmp(&rsds.guid, &route_native_guid, sizeof(GUID)) && rsds.age == 1) guid = 1;
  }
  if (!guid || !nb_export(p, &nt, "NtCreateFile", &p->sites[0]) || !nb_export(p, &nt, "NtOpenFile", &p->sites[1]) || p->sites[0] == p->sites[1]) return 0;
  const char *names[] = {"NtCreateFile", "NtOpenFile"};
  for (unsigned i = 0; i < 2; ++i) {
    BYTE code[8]; void *host = (void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), names[i]);
    if (!nb_read(p, p->sites[i], code, sizeof(code)) || memcmp(code, "\x4c\x8b\xd1\xb8", 4) || memcmp(code, host, sizeof(code)) ||
        p->sites[i] - p->ntdll != (uintptr_t)host - (uintptr_t)GetModuleHandleW(L"ntdll.dll")) return 0;
    p->originals[i] = code[0];
    if (nb_enabled && !nb_patch(p, p->sites[i], 0xcc)) return 0;
  }
  p->image = 1; return 1;
}

typedef struct {uintptr_t handle, iosb, ret; ACCESS_MASK access; OBJECT_ATTRIBUTES oa; ULONG share, disposition, options, file_attributes; int unsupported;} NB_REQUEST;
/* Separate signatures: stack[5..6] for NtOpenFile, stack[5..11] for NtCreateFile.
 * The 32-byte register shadow space starts at rsp+8, argument five at rsp+40. */
static int nb_decode_open(NB_PROCESS *p, const CONTEXT *c, NB_REQUEST *r) {
  ULONGLONG args[2];
  if (!nb_read(p, c->Rsp + 40, args, sizeof(args))) return 0;
  r->share = (ULONG)args[0]; r->options = (ULONG)args[1]; r->disposition = 1; return 1;
}
static int nb_decode_create(NB_PROCESS *p, const CONTEXT *c, NB_REQUEST *r) {
  ULONGLONG args[7];
  if (!nb_read(p, c->Rsp + 40, args, sizeof(args))) return 0;
  r->file_attributes = (ULONG)args[1]; r->share = (ULONG)args[2]; r->disposition = (ULONG)args[3]; r->options = (ULONG)args[4];
  r->unsupported = (!!args[0]) | ((!!args[5]) << 1) | ((!!args[6]) << 2); return 1;
}
static int nb_rollback(NB_PROCESS *p, HANDLE target) {
  HANDLE local = NULL;
  if (!DuplicateHandle(p->handle, target, GetCurrentProcess(), &local, 0, FALSE, DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS)) return 0;
  return CloseHandle(local);
}
/* Returns 0 for ordinary pass-through, 1 for completed broker request, -1 fatal. */
static int nb_delegate(NB_DEBUG *d, NB_PROCESS *p, DWORD tid, CONTEXT *c, int api) {
  NB_REQUEST r; ZeroMemory(&r, sizeof(r)); UNICODE_STRING us; wchar_t name[64];
  r.handle = c->Rcx; r.access = (ACCESS_MASK)c->Rdx; r.iosb = c->R9;
  if (!nb_read(p, c->R8, &r.oa, sizeof(r.oa)) || r.oa.Length != sizeof(r.oa) || r.oa.RootDirectory || !r.oa.ObjectName ||
      !nb_read(p, (uintptr_t)r.oa.ObjectName, &us, sizeof(us)) || us.Length == 0 || us.Length % 2 || us.Length > sizeof(name) - 2 || us.MaximumLength < us.Length ||
      !nb_read(p, (uintptr_t)us.Buffer, name, us.Length)) return 0;
  name[us.Length / 2] = 0;
  if (wcslen(name) * 2 != us.Length || (_wcsicmp(name, L"\\??\\NUL") && _wcsicmp(name, L"\\Device\\Null"))) return 0;
  if (!nb_binding(d, p, 0) || d->stopping || (c->EFlags & 0x100) || c->Rsp % 8 || c->Rsp > UINTPTR_MAX - 96 ||
      !nb_read(p, c->Rsp, &r.ret, 8) || !r.ret || (api ? !nb_decode_open(p, c, &r) : !nb_decode_create(p, c, &r))) return -1;
  const ACCESS_MASK allowed = FILE_READ_DATA | FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_READ_EA | FILE_WRITE_EA |
    FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE | GENERIC_READ | GENERIC_WRITE;
  fwprintf(stderr, L"NB_INPUT pid=%lu api=%ls attributes=0x%08lx security=%d qos=%d extra=%d fileAttributes=0x%08lx share=%lu\n",
    p->id, api ? L"open" : L"create", r.oa.Attributes, !!r.oa.SecurityDescriptor, !!r.oa.SecurityQualityOfService, r.unsupported, r.file_attributes, r.share);
  NTSTATUS status; IO_STATUS_BLOCK io; ZeroMemory(&io, sizeof(io)); HANDLE host = NULL, target = NULL;
  NB_BASIC basic; NB_DEVICE device; ULONG mode = 0; int opened = 0, closed = 1, rollback = 1;
  BYTE old_handle[8], old_io[16]; int valid = nb_outputs(r.handle, r.iosb, nb_query_region, p);
  if (!valid) status = NB_BAD_POINTER;
  else if (!nb_read(p, r.handle, old_handle, sizeof(old_handle)) || !nb_read(p, r.iosb, old_io, sizeof(old_io))) return -1;
  else if ((r.access & ~allowed) || (r.oa.Attributes & ~(0x40u | 2u)) || r.oa.SecurityDescriptor || r.oa.SecurityQualityOfService ||
      r.unsupported || (r.file_attributes & ~0x80u) || (r.share & ~7u) || r.disposition > 5 ||
      (r.options & ~(0x2u | 0x4u | 0x8u | 0x10u | 0x20u | 0x40u | 0x800u | 0x4000u | 0x100000u | 0x200000u))) status = NB_UNSUPPORTED;
  else {
    memcpy(&io, old_io, sizeof(io));
    status = nb_host_open(&host, &io, r.access, r.share, r.disposition, r.options, r.oa.Attributes, r.file_attributes, api);
    if (status == 0x103) {if (host && host != INVALID_HANDLE_VALUE) CloseHandle(host); return -1;}
    if (status >= 0) {
      opened = 1;
      if (!host || host == INVALID_HANDLE_VALUE || !nb_measure(host, &basic, &mode, &device) ||
          !DuplicateHandle(GetCurrentProcess(), host, p->handle, &target, 0, !!(r.oa.Attributes & 2), DUPLICATE_SAME_ACCESS)) {
        if (host && host != INVALID_HANDLE_VALUE) CloseHandle(host);
        return -1;
      }
    }
    if (host && host != INVALID_HANDLE_VALUE) closed = CloseHandle(host);
    if (!closed) {if (target) nb_rollback(p, target); return -1;}
    if (target) {
      HANDLE back = NULL, same = NULL; NB_BASIC actual; NB_DEVICE actual_device; ULONG actual_mode = 0;
      int measured = DuplicateHandle(p->handle, target, GetCurrentProcess(), &back, 0, FALSE, DUPLICATE_SAME_ACCESS) &&
        DuplicateHandle(GetCurrentProcess(), back, GetCurrentProcess(), &same, 0, FALSE, DUPLICATE_SAME_ACCESS) &&
        nb_compare(back, same) == 0 && nb_measure(back, &actual, &actual_mode, &actual_device) &&
        actual.GrantedAccess == basic.GrantedAccess && actual_mode == mode;
      NTSTATUS different = p->measurement && back ? nb_compare(p->measurement, back) : (NTSTATUS)0xc00001ac;
      if (p->measurement && different != (NTSTATUS)0xc00001ac) measured = 0;
      fwprintf(stderr, L"NB_MEASUREMENT pid=%lu sequence=%u same=0x%08lx different=0x%08lx previous=%d ok=%d\n", p->id, d->delegations + 1, same && back ? (DWORD)nb_compare(back, same) : (DWORD)NB_INVALID, (DWORD)different, !!p->measurement, measured);
      if (same && !CloseHandle(same)) measured = 0;
      if (p->measurement && !CloseHandle(p->measurement)) measured = 0;
      p->measurement = back;
      if (!measured) {nb_rollback(p, target); return -1;}
    }
  }
  /* Validate before either output is written. Invalid output must leave both
   * sentinels intact. The debugger's ability to overwrite RO pages is irrelevant. */
  int injected = 0;
  if (target && nb_fault_transfer) {
    injected = 1; nb_fault_transfer = 0; rollback = nb_rollback(p, target); target = NULL; status = NB_BAD_POINTER;
    fwprintf(stderr, L"NB_TRANSFER pid=%lu remoteClosed=%d hostClosed=%d injected=1\n", p->id, rollback, closed);
    if (!rollback) return -1;
  }
  if (valid && !injected && status != NB_UNSUPPORTED) {
    if (!nb_outputs(r.handle, r.iosb, nb_query_region, p)) {
      if (target) rollback = nb_rollback(p, target);
      target = NULL; status = NB_BAD_POINTER;
      if (!rollback) return -1;
    } else {
      if ((target && !nb_write(p, r.handle, &target, sizeof(target))) || !nb_write(p, r.iosb, &io, sizeof(io))) {
        if (target) rollback = nb_rollback(p, target);
        int restored = nb_write(p, r.handle, old_handle, sizeof(old_handle)) && nb_write(p, r.iosb, old_io, sizeof(old_io));
        if (!rollback || !restored) return -1;
        target = NULL; status = NB_BAD_POINTER;
      }
    }
  }
  c->Rip = r.ret; c->Rsp += 8; c->Rax = (DWORD)status;
  HANDLE thread = nb_thread_handle(p, tid);
  if (!thread || !SetThreadContext(thread, c)) {if (target) nb_rollback(p, target); return -1;}
  fwprintf(stderr, L"NB_DELEGATE pid=%lu sequence=%u api=%ls requested=0x%08lx options=0x%08lx disposition=%lu status=0x%08lx information=%llu opened=%d hostClosed=%d remoteClosed=%d valid=%d granted=0x%08lx mode=0x%08lx type=%u device=%lu\n",
    p->id, ++d->delegations, api ? L"open" : L"create", r.access, r.options, r.disposition, (DWORD)status,
    (unsigned long long)io.Information, opened, closed, rollback, valid, opened ? basic.GrantedAccess : 0, mode, opened ? 2u : 0u, opened ? device.Type : 0);
  if (status < 0 && valid && status != NB_UNSUPPORTED && status != NB_BAD_POINTER)
    fwprintf(stderr, L"NB_PRIMITIVE pid=%lu status=0x%08lx opened=0 hostClosed=%d remoteClosed=%d\n", p->id, (DWORD)status, closed, rollback);
  return 1;
}

static int nb_exception(NB_DEBUG *d, NB_PROCESS *p, DEBUG_EVENT *e, DWORD *continuation) {
  DWORD code = e->u.Exception.ExceptionRecord.ExceptionCode; uintptr_t address = (uintptr_t)e->u.Exception.ExceptionRecord.ExceptionAddress;
  HANDLE thread = nb_thread_handle(p, e->dwThreadId); CONTEXT c; ZeroMemory(&c, sizeof(c)); c.ContextFlags = CONTEXT_FULL;
  *continuation = DBG_EXCEPTION_NOT_HANDLED;
  if (code == EXCEPTION_BREAKPOINT && p->image && !p->startup && e->dwThreadId == p->first && address == p->ntdll + ROUTE_LOADER_BREAK) {
    BYTE code_bytes[sizeof(route_loader_code)];
    if (!nb_read(p, p->ntdll + ROUTE_LOADER_START, code_bytes, sizeof(code_bytes)) || memcmp(code_bytes, route_loader_code, sizeof(code_bytes))) return 0;
    p->startup = 1; *continuation = DBG_CONTINUE;
    fwprintf(stderr, L"NB_IMAGE pid=%lu sha=%hs exports=1 startup=1\n", p->id, NB_NTDLL_SHA); return 1;
  }
  int site = address == p->sites[0] ? 0 : address == p->sites[1] ? 1 : -1;
  if (nb_enabled && code == EXCEPTION_BREAKPOINT && site >= 0 && p->image) {
    if (!thread || !GetThreadContext(thread, &c) || c.Rip != address + 1 || (c.EFlags & 0x100)) return 0;
    if (p->step.owner) {
      if (!nb_defer(&p->step, e->dwThreadId)) return 0;
      c.Rip = address;
      if (!SetThreadContext(thread, &c)) return 0;
      fwprintf(stderr, L"NB_DEFER pid=%lu tid=%lu owner=%lu\n", p->id, e->dwThreadId, (DWORD)p->step.owner);
    } else {
      int delegated = nb_delegate(d, p, e->dwThreadId, &c, site);
      if (delegated < 0) return 0;
      if (!delegated) {
        if (!nb_begin(&p->step, e->dwThreadId, address, nb_hold, p)) return 0;
        p->flags = c.EFlags; c.Rip = address; c.EFlags |= 0x100;
        if (!nb_patch(p, address, p->originals[site]) || !SetThreadContext(thread, &c)) return 0;
      }
    }
    *continuation = DBG_CONTINUE; return 1;
  }
  if (code == EXCEPTION_SINGLE_STEP && p->step.owner == e->dwThreadId) {
    if (!thread || !GetThreadContext(thread, &c) || c.Rip != p->step.site + 3 ||
        !nb_patch(p, p->step.site, 0xcc)) return 0;
    c.EFlags = p->flags;
    if (!SetThreadContext(thread, &c) || !nb_finish(&p->step, e->dwThreadId, nb_release, p)) return 0;
    *continuation = DBG_CONTINUE; return 1;
  }
  if (p->step.owner == e->dwThreadId) return 0;
  fwprintf(stderr, L"NB_EXCEPTION pid=%lu tid=%lu code=0x%08lx first=%lu forwarded=1\n", p->id, e->dwThreadId, code, e->u.Exception.dwFirstChance);
  return 1;
}
static int nb_console_image(HANDLE image, const char *image_sha) {
  wchar_t system[MAX_PATH]; UINT size = GetSystemDirectoryW(system, MAX_PATH);
  if (!size || size + 13 >= MAX_PATH) return -1;
  memcpy(system + size, L"\\conhost.exe", sizeof(L"\\conhost.exe"));
  HANDLE reference = CreateFileW(system, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL);
  if (reference == INVALID_HANDLE_VALUE) return -1;
  BY_HANDLE_FILE_INFORMATION a, b; char sha[65];
  int ok = GetFileInformationByHandle(image, &a) && GetFileInformationByHandle(reference, &b) && nb_file_sha(reference, sha);
  int same = ok && a.dwVolumeSerialNumber == b.dwVolumeSerialNumber && a.nFileIndexHigh == b.nFileIndexHigh && a.nFileIndexLow == b.nFileIndexLow;
  if (same && strcmp(image_sha, sha)) ok = 0;
  if (!CloseHandle(reference)) ok = 0;
  return !ok ? -1 : same;
}
static DWORD nb_parent(HANDLE process) {
  typedef NTSTATUS (NTAPI *query_process)(HANDLE, ULONG, PVOID, ULONG, PULONG);
  struct {NTSTATUS status; PVOID peb; ULONG_PTR affinity; LONG priority; ULONG_PTR pid, parent;} basic;
  query_process query = (query_process)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess");
  if (!query || query(process, 0, &basic, sizeof(basic), NULL) < 0) return 0;
  return (DWORD)basic.parent;
}
static int nb_close_process(NB_PROCESS *p) {
  int ok = 1;
  for (unsigned i = 0; i < NB_THREADS; ++i) if (p->threads[i].handle) {
    if (!CloseHandle(p->threads[i].handle)) ok = 0;
    else fwprintf(stderr, L"NB_HANDLE pid=%lu tid=%lu kind=thread action=close\n", p->id, p->threads[i].id);
    p->threads[i].handle = NULL; p->threads[i].id = 0;
  }
  if (p->handle) {
    if (!CloseHandle(p->handle)) ok = 0;
    else fwprintf(stderr, L"NB_HANDLE pid=%lu tid=0 kind=process action=close\n", p->id);
  }
  if (p->measurement && !CloseHandle(p->measurement)) ok = 0;
  p->measurement = NULL;
  p->handle = NULL; p->exited = 1; ZeroMemory(&p->step, sizeof(p->step)); return ok;
}
static DWORD nb_debug_loop(HANDLE job, PROCESS_INFORMATION *root, PSID package, PSID registry, DWORD *root_exit) {
  NB_DEBUG d; ZeroMemory(&d, sizeof(d)); d.job = job; d.package = package; d.registry = registry; d.root = root->dwProcessId;
  DWORD error = 0; int pending = 0; ULONGLONG deadline = GetTickCount64() + 45000, drain_deadline = 0;
  if (!nb_resolve() || !DebugSetProcessKillOnExit(TRUE)) return ERROR_NOT_SUPPORTED;
  for (;;) {
    if (!d.stopping && GetTickCount64() > deadline) {
      error = ERROR_TIMEOUT; d.stopping = 1; drain_deadline = GetTickCount64() + 8000; TerminateJobObject(job, 125);
      fputws(L"NB_FAILURE kind=timeout code=1460\n", stderr);
    }
    DEBUG_EVENT e; ZeroMemory(&e, sizeof(e));
    if (!WaitForDebugEvent(&e, 100)) {
      DWORD wait_error = GetLastError();
      if (wait_error != ERROR_SEM_TIMEOUT) {error = wait_error; break;}
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION a;
      if (d.stopping && QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &a, sizeof(a), NULL) && !a.ActiveProcesses) break;
      if (GetTickCount64() > (d.stopping ? drain_deadline : deadline)) {
        if (d.stopping) {error = ERROR_TIMEOUT; break;}
        error = ERROR_TIMEOUT; d.stopping = 1; drain_deadline = GetTickCount64() + 8000; TerminateJobObject(job, 125);
        fputws(L"NB_FAILURE kind=timeout code=1460\n", stderr);
      }
      continue;
    }
    ++d.events;
    pending = 1;
    fwprintf(stderr, L"NB_EVENT number=%u pid=%lu tid=%lu code=%lu\n", d.events, e.dwProcessId, e.dwThreadId, e.dwDebugEventCode);
    NB_PROCESS *p = nb_process(&d, e.dwProcessId); DWORD continuation = DBG_CONTINUE; int ok = 1, retire = 0;
    if (e.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT) {
      if (p || d.stopping) ok = 0;
      else {
        for (unsigned i = 0; i < NB_PROCESSES; ++i) if (!d.processes[i].id) {p = &d.processes[i]; break;}
        if (!p) ok = 0;
        else {
          p->id = e.dwProcessId; p->first = e.dwThreadId;
          HANDLE source = p->id == d.root ? root->hProcess : e.u.CreateProcessInfo.hProcess;
          ok = DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &p->handle, 0, FALSE, DUPLICATE_SAME_ACCESS);
          if (ok) fwprintf(stderr, L"NB_HANDLE pid=%lu tid=0 kind=process action=own\n", p->id);
          if (p->id == d.root) {
            if (root->hProcess == e.u.CreateProcessInfo.hProcess) root->hProcess = NULL;
            if (root->hThread == e.u.CreateProcessInfo.hThread) root->hThread = NULL;
          }
          p->parent = ok ? nb_parent(p->handle) : 0;
          if (!p->parent || (p->id == d.root ? p->parent != GetCurrentProcessId() : !nb_process(&d, p->parent))) ok = 0;
          if (ok) ok = nb_binding(&d, p, 1) && nb_add_thread(p, e.dwThreadId, e.u.CreateProcessInfo.hThread);
          char sha[65];
          if (ok) ok = e.u.CreateProcessInfo.hFile && nb_file_sha(e.u.CreateProcessInfo.hFile, sha);
          if (ok) {
            int console = nb_console_image(e.u.CreateProcessInfo.hFile, sha);
            if (console < 0 || (console && p->id == d.root)) ok = 0;
            else fwprintf(stderr, L"NB_PROCESS_IMAGE pid=%lu sha=%hs role=%ls identity=1\n", p->id, sha, console ? L"console" : L"target");
          }
        }
      }
      if (e.u.CreateProcessInfo.hFile && !CloseHandle(e.u.CreateProcessInfo.hFile)) ok = 0;
    } else if (!p) ok = 0;
    else switch (e.dwDebugEventCode) {
      case CREATE_THREAD_DEBUG_EVENT: ok = !d.stopping && nb_add_thread(p, e.dwThreadId, e.u.CreateThread.hThread); break;
      case LOAD_DLL_DEBUG_EVENT:
        if (!d.stopping) ok = nb_image(p, e.u.LoadDll.hFile, e.u.LoadDll.lpBaseOfDll);
        if (e.u.LoadDll.hFile && !CloseHandle(e.u.LoadDll.hFile)) ok = 0;
        break;
      case EXCEPTION_DEBUG_EVENT:
        if (d.stopping) continuation = DBG_EXCEPTION_NOT_HANDLED;
        else ok = nb_exception(&d, p, &e, &continuation);
        break;
      case EXIT_THREAD_DEBUG_EVENT: {
        NB_THREAD_STATE *t = nb_thread(&p->step, e.dwThreadId);
        if (!d.stopping && (!t || t->held || p->step.owner == e.dwThreadId)) ok = 0;
        if (t) t->live = 0;
        for (unsigned i = 0; i < NB_THREADS; ++i) if (p->threads[i].id == e.dwThreadId) {
          if (!CloseHandle(p->threads[i].handle)) ok = 0;
          else fwprintf(stderr, L"NB_HANDLE pid=%lu tid=%lu kind=thread action=close\n", p->id, p->threads[i].id);
          p->threads[i].handle = NULL; p->threads[i].id = 0;
        }
        break;
      }
      case EXIT_PROCESS_DEBUG_EVENT:
        fwprintf(stderr, L"NB_EXIT pid=%lu code=0x%08lx\n", p->id, e.u.ExitProcess.dwExitCode);
        if (!d.stopping && (!p->startup || !p->image || p->step.owner)) ok = 0;
        if (p->id == d.root) {
          *root_exit = e.u.ExitProcess.dwExitCode; d.stopping = 1; drain_deadline = GetTickCount64() + 8000;
          BOOL drained = TerminateJobObject(job, 125);
          fwprintf(stderr, L"NB_DRAIN pid=%lu code=125 ok=%d\n", p->id, !!drained);
          if (!drained) {error = GetLastError(); ok = 0;}
        }
        retire = 1; break;
      case UNLOAD_DLL_DEBUG_EVENT: if ((uintptr_t)e.u.UnloadDll.lpBaseOfDll == p->ntdll) ok = 0; break;
      case OUTPUT_DEBUG_STRING_EVENT: break;
      default: ok = 0;
    }
    /* Always continue an exit event before waiting or retiring owned duplicates.
     * Kernel debug process/thread handles are NEVER closed by this adapter. */
    if (!ContinueDebugEvent(e.dwProcessId, e.dwThreadId, continuation)) {error = GetLastError(); break;}
    pending = 0;
    if (retire && p && !nb_close_process(p)) ok = 0;
    if (!ok && !d.stopping) {
      error = ERROR_NOT_SUPPORTED; d.stopping = 1; drain_deadline = GetTickCount64() + 8000;
      fwprintf(stderr, L"NB_FAILURE kind=unsupported code=%lu\n", error); TerminateJobObject(job, 125);
    } else if (!ok && !error) error = ERROR_INVALID_DATA;
    fflush(stderr);
  }
  /* An error still drains: no wait on a process whose exit event is pending. */
  if (error) TerminateJobObject(job, 125);
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION a; ZeroMemory(&a, sizeof(a));
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &a, sizeof(a), NULL)) error = GetLastError();
  unsigned owned = 0, suspended = 0;
  for (unsigned i = 0; i < NB_PROCESSES; ++i) if (d.processes[i].handle) {
    ++owned;
    for (unsigned t = 0; t < NB_THREADS; ++t) suspended += d.processes[i].step.threads[t].held;
    if (!nb_close_process(&d.processes[i])) error = ERROR_INVALID_HANDLE;
  }
  if (owned || a.ActiveProcesses) {if (!error) error = ERROR_BUSY;}
  fwprintf(stderr, L"NB_END error=%lu active=%lu owned=%u suspended=%u pending=%d delegations=%u\n", error, a.ActiveProcesses, owned, suspended, pending, d.delegations);
  fflush(stderr); return error;
}
