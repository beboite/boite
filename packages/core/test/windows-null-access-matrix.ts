/** Read-only native experiment. Does not admit production or alter its source. */
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {release, tmpdir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {Bus} from '../src/bus.ts';
import {ExecutionProtections} from '../src/execution-protection.ts';
import {Journal} from '../src/journal.ts';
import {ProcRegistry} from '../src/procs.ts';
import {protectionRunner} from '../src/protection-runner.ts';
import {capture, type Captured} from '../../../tests/diagnostics/windows-debug-map/capture.ts';
import {selectedEnvironment} from '../../../tests/diagnostics/windows-debug-map/environment.ts';

const sourcePath = join(import.meta.dir, '../../../tests/diagnostics/windows-protected-reference.c');
const sourceHash = '8f414f91eab4ed1e9a846ae3d0bac64eec11e5d924a2a811f998f91567b25f5a';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

const instrumentation = String.raw`
#include <winternl.h>
typedef struct {
  UNICODE_STRING Name; USHORT ValueType, Reserved; ULONG Flags, ValueCount;
  union { ULONGLONG *Uint64; } Values;
} MATRIX_ATTRIBUTE;
typedef struct { USHORT Version, Reserved; ULONG Count; MATRIX_ATTRIBUTE *Attributes; } MATRIX_ATTRIBUTES;
typedef NTSTATUS (NTAPI *matrix_create_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
  PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
typedef NTSTATUS (NTAPI *matrix_query_object_fn)(HANDLE, ULONG, PVOID, ULONG, PULONG);
typedef NTSTATUS (NTAPI *matrix_query_file_fn)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, ULONG);

/* Preserve membership and attributes without publishing a user/domain SID. */
static DWORD matrix_sid(const wchar_t *phase, const wchar_t *set, DWORD index, SID_AND_ATTRIBUTES entry) {
  LPWSTR text = NULL;
  if (!ConvertSidToStringSidW(entry.Sid, &text)) return GetLastError();
  BOOL visible = !wcscmp(text, L"S-1-5-12") || !wcscmp(text, L"S-1-1-0") ||
    !wcsncmp(text, L"S-1-15-2-", 9) || !wcsncmp(text, L"S-1-15-3-", 9);
  fwprintf(stderr, L"NULL_SID phase=%ls set=%ls index=%lu sid=%ls attributes=0x%08lx\n",
    phase, set, index, visible ? text : L"redacted", entry.Attributes);
  LocalFree(text); return 0;
}

static DWORD matrix_open(const wchar_t *phase, const wchar_t *path, const wchar_t *mode,
    const wchar_t *dos_path, ACCESS_MASK desired, ULONG options, BOOL native,
    matrix_create_fn create, matrix_query_object_fn query_object, matrix_query_file_fn query_file) {
  HANDLE file = NULL; NTSTATUS status = (NTSTATUS)0xc0000002; DWORD open_error = 0;
  wchar_t status_text[16] = L"na", error_text[16] = L"na", options_text[16] = L"na";
  if (native) {
    wchar_t object_text[] = L"\\Device\\Null";
    UNICODE_STRING name = {(USHORT)(wcslen(object_text) * 2), (USHORT)sizeof(object_text), object_text};
    OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
    attributes.Length = sizeof(attributes); attributes.ObjectName = &name; attributes.Attributes = 0x40;
    IO_STATUS_BLOCK io; ZeroMemory(&io, sizeof(io));
    status = create(&file, desired, &attributes, &io, NULL, 0,
      FILE_SHARE_READ | FILE_SHARE_WRITE, 1 /* FILE_OPEN */, options, NULL, 0);
    swprintf(status_text, 16, L"0x%08lx", (DWORD)status); swprintf(options_text, 16, L"0x%08lx", options);
  } else {
    file = CreateFileW(dos_path, desired, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    open_error = file == INVALID_HANDLE_VALUE ? GetLastError() : 0;
    swprintf(error_text, 16, L"%lu", open_error);
  }
  BOOL owned = file && file != INVALID_HANDLE_VALUE;
  DWORD type = 0, type_error = 0, close_error = 0, granted = 0, mode_value = 0;
  wchar_t grant_text[16] = L"na", mode_text[16] = L"na";
  NTSTATUS grant_status = 0;
  if (owned) {
    PUBLIC_OBJECT_BASIC_INFORMATION basic; ULONG returned = 0; ZeroMemory(&basic, sizeof(basic));
    grant_status = query_object(file, 0 /* ObjectBasicInformation */, &basic, sizeof(basic), &returned);
    granted = basic.GrantedAccess;
    struct {ULONG Mode;} information; IO_STATUS_BLOCK io;
    ZeroMemory(&information, sizeof(information)); ZeroMemory(&io, sizeof(io));
    NTSTATUS mode_status = query_file(file, &io, &information, sizeof(information), 16 /* FileModeInformation */);
    mode_value = information.Mode;
    swprintf(grant_text, 16, L"0x%08lx", (DWORD)grant_status); swprintf(mode_text, 16, L"0x%08lx", (DWORD)mode_status);
    SetLastError(0); type = GetFileType(file); type_error = type ? 0 : GetLastError();
    if (!CloseHandle(file)) close_error = GetLastError();
  }
  fwprintf(stderr, L"NULL_ACCESS phase=%ls path=%ls access=%ls desired=0x%08lx options=%ls flags=%ls opened=%d error=%ls status=%ls granted=0x%08lx grant-status=%ls mode=0x%08lx mode-status=%ls type=%lu type-error=%lu close-error=%lu\n",
    phase, path, mode, desired, options_text, native ? L"na" : L"0x00000000", owned, error_text, status_text,
    granted, grant_text, mode_value, mode_text, type, type_error, close_error);
  if (owned && grant_status < 0) return ERROR_INVALID_DATA;
  return type_error ? type_error : close_error;
}

/* A namespace open can have different driver security from the bare device.
 * No alias/map, token, ACL, inherited handle or production probe is changed. */
static DWORD suffix_open(const wchar_t *phase, const wchar_t *path, const wchar_t *target,
    const wchar_t *suffix, const wchar_t *mode, ACCESS_MASK rights,
    matrix_create_fn create, matrix_query_file_fn query_volume) {
  BOOL native = !wcscmp(path, L"native-sync");
  ACCESS_MASK desired = rights | (native ? SYNCHRONIZE | FILE_READ_ATTRIBUTES : 0);
  wchar_t object_text[160], status_text[16] = L"na", error_text[16] = L"na";
  wchar_t query_text[16] = L"na", secure_text[4] = L"na";
  BOOL named = !wcscmp(target, L"suffix");
  swprintf(object_text, 160, L"%ls%ls%ls", native ? L"\\Device\\Null" : L"\\\\?\\GLOBALROOT\\Device\\Null",
    named ? L"\\" : L"", named ? suffix : L"");
  HANDLE file = NULL; NTSTATUS status = (NTSTATUS)0xc0000002;
  DWORD open_error = 0, error = 0, type = 0, type_error = 0, close_error = 0;
  ULONG_PTR query_bytes = 0;
  DWORD reads = 0, eof = 0, read_bytes = 0, read_error = 0, writes = 0, written = 0, write_error = 0;
  struct {ULONG DeviceType, Characteristics;} device; ZeroMemory(&device, sizeof(device));
  if (native) {
    UNICODE_STRING name = {(USHORT)(wcslen(object_text) * 2), (USHORT)sizeof(object_text), object_text};
    OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
    attributes.Length = sizeof(attributes); attributes.ObjectName = &name; attributes.Attributes = 0x40;
    IO_STATUS_BLOCK io; ZeroMemory(&io, sizeof(io));
    status = create(&file, desired, &attributes, &io, NULL, 0, FILE_SHARE_READ | FILE_SHARE_WRITE,
      1 /* FILE_OPEN */, 0x60 /* NON_DIRECTORY | SYNCHRONOUS_NONALERT */, NULL, 0);
    swprintf(status_text, 16, L"0x%08lx", (DWORD)status);
  } else {
    file = CreateFileW(object_text, desired, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    open_error = file == INVALID_HANDLE_VALUE ? GetLastError() : 0;
    swprintf(error_text, 16, L"%lu", open_error);
  }
  BOOL opened = file && file != INVALID_HANDLE_VALUE;
  if (opened) {
    SetLastError(0); type = GetFileType(file); type_error = type ? 0 : GetLastError();
    IO_STATUS_BLOCK io; ZeroMemory(&io, sizeof(io));
    NTSTATUS queried = query_volume(file, &io, &device, sizeof(device), 4 /* FileFsDeviceInformation */);
    query_bytes = io.Information;
    swprintf(query_text, 16, L"0x%08lx", (DWORD)queried);
    if (queried >= 0) swprintf(secure_text, 4, L"%d", !!(device.Characteristics & 0x100 /* FILE_DEVICE_SECURE_OPEN */));
    /* Verify the real Null device before any data I/O. Never write a path that
     * only happens to return a character handle or a plausible object name. */
    if (type != FILE_TYPE_CHAR || type_error || queried != 0 || io.Information != sizeof(device) || device.DeviceType != 0x15 /* FILE_DEVICE_NULL */) {
      error = ERROR_INVALID_DATA;
    } else {
      BYTE data[4096]; memset(data, 0x5a, sizeof(data));
      for (int round = 0; round < 2; round++) {
        if (rights & GENERIC_WRITE) {
          DWORD used = 0; BOOL ok = WriteFile(file, data, sizeof(data), &used, NULL);
          DWORD observed = ok ? 0 : GetLastError(); writes++; written += used;
          if (!write_error && observed) write_error = observed;
        }
        if (rights & GENERIC_READ) {
          DWORD used = 0; BOOL ok = ReadFile(file, data, sizeof(data), &used, NULL);
          DWORD observed = ok ? 0 : GetLastError(); reads++; read_bytes += used;
          if (!used && (ok || observed == ERROR_HANDLE_EOF)) eof++;
          else if (!read_error && observed) read_error = observed;
        }
      }
      if (read_bytes || eof != reads || read_error || write_error || written != writes * sizeof(data)) error = ERROR_INVALID_DATA;
    }
    if (!CloseHandle(file)) {close_error = GetLastError(); if (!error) error = close_error;}
  }
  fwprintf(stderr, L"NULL_SUFFIX phase=%ls path=%ls target=%ls access=%ls desired=0x%08lx options=%ls opened=%d error=%ls status=%ls type=%lu type-error=%lu query-status=%ls query-bytes=%llu device-type=0x%08lx characteristics=0x%08lx secure-open=%ls reads=%lu eof=%lu read-bytes=%lu read-error=%lu writes=%lu written=%lu write-error=%lu close-error=%lu\n",
    phase, path, target, mode, desired, native ? L"0x00000060" : L"na", opened, error_text, status_text,
    type, type_error, query_text, (unsigned long long)query_bytes, device.DeviceType, device.Characteristics, secure_text,
    reads, eof, read_bytes, read_error, writes, written, write_error, close_error);
  return error;
}

static DWORD null_suffix(const wchar_t *phase, matrix_create_fn create) {
  matrix_query_file_fn query_volume = (matrix_query_file_fn)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryVolumeInformationFile");
  if (!query_volume) return ERROR_PROC_NOT_FOUND;
  wchar_t suffix[96]; swprintf(suffix, 96, L"boite-null-%lu-%llu", GetCurrentProcessId(), (unsigned long long)GetTickCount64());
  fwprintf(stderr, L"NULL_SUFFIX_BEGIN phase=%ls suffix=%ls\n", phase, suffix);
  const wchar_t *paths[] = {L"native-sync", L"globalroot"}, *targets[] = {L"bare", L"suffix"};
  const wchar_t *modes[] = {L"read", L"write", L"readwrite"};
  const ACCESS_MASK rights[] = {GENERIC_READ, GENERIC_WRITE, GENERIC_READ | GENERIC_WRITE};
  DWORD error = 0;
  for (int p = 0; p < 2; p++) for (int target = 0; target < 2; target++) for (int mode = 0; mode < 3; mode++) {
    DWORD observed = suffix_open(phase, paths[p], targets[target], suffix, modes[mode], rights[mode], create, query_volume);
    if (!error && observed) error = observed;
  }
  fwprintf(stderr, L"NULL_SUFFIX_END phase=%ls error=%lu\n", phase, error);
  return error;
}

/* Query only this process token; close every successful device open. */
static DWORD null_matrix(const wchar_t *phase) {
  HANDLE token = NULL; DWORD bytes = 0, appcontainer = 0, error = 0;
  TOKEN_ACCESS_INFORMATION *access = NULL; TOKEN_GROUPS *restricted = NULL; LPWSTR package = NULL;
  PSID *groups = NULL, *capabilities = NULL; DWORD group_count = 0, capability_count = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return GetLastError();
  if (!GetTokenInformation(token, TokenIsAppContainer, &appcontainer, sizeof(appcontainer), &bytes)) {error = GetLastError(); goto done;}
  GetTokenInformation(token, TokenAccessInformation, NULL, 0, &bytes);
  access = calloc(1, bytes);
  if (!access) {error = ERROR_NOT_ENOUGH_MEMORY; goto done;}
  if (!GetTokenInformation(token, TokenAccessInformation, access, bytes, &bytes)) {error = GetLastError(); goto done;}
  GetTokenInformation(token, TokenRestrictedSids, NULL, 0, &bytes);
  restricted = calloc(1, bytes);
  if (!restricted) {error = ERROR_NOT_ENOUGH_MEMORY; goto done;}
  if (!GetTokenInformation(token, TokenRestrictedSids, restricted, bytes, &bytes)) {error = GetLastError(); goto done;}
  if (access->PackageSid && !ConvertSidToStringSidW(access->PackageSid, &package)) {error = GetLastError(); goto done;}
  DWORD actual_count = access->CapabilitiesHash ? access->CapabilitiesHash->SidCount : 0;
  BOOL registry = FALSE;
  if (appcontainer) {
    typedef BOOL (WINAPI *derive_fn)(LPCWSTR, PSID **, DWORD *, PSID **, DWORD *);
    derive_fn derive = (derive_fn)(void *)GetProcAddress(GetModuleHandleW(L"kernelbase.dll"), "DeriveCapabilitySidsFromName");
    if (!derive || !derive(L"registryRead", &groups, &group_count, &capabilities, &capability_count) || capability_count != 1) {
      error = GetLastError(); if (!error) error = ERROR_NOT_SUPPORTED; goto done;
    }
    registry = actual_count == 1 && EqualSid(access->CapabilitiesHash->SidAttr[0].Sid, capabilities[0]) &&
      (access->CapabilitiesHash->SidAttr[0].Attributes & SE_GROUP_ENABLED);
  }
  fwprintf(stderr, L"NULL_TOKEN phase=%ls appcontainer=%lu flags=0x%08lx capabilities=%lu registry-read=%d package=%ls\n",
    phase, appcontainer, access->Flags, actual_count, registry, package ? package : L"none");
  typedef NTSTATUS (NTAPI *query_attributes_fn)(HANDLE, PUNICODE_STRING, ULONG, PVOID, ULONG, PULONG);
  query_attributes_fn query_attributes = (query_attributes_fn)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQuerySecurityAttributesToken");
  wchar_t attribute_text[] = L"WIN://NOALLAPPPKG";
  UNICODE_STRING attribute_name = {(USHORT)(wcslen(attribute_text) * 2), (USHORT)sizeof(attribute_text), attribute_text};
  union {ULONGLONG align; BYTE data[8192];} attribute_buffer; ZeroMemory(&attribute_buffer, sizeof(attribute_buffer));
  NTSTATUS attribute_status = query_attributes ? query_attributes(token, &attribute_name, 1,
    attribute_buffer.data, sizeof(attribute_buffer.data), &bytes) : (NTSTATUS)0xc0000002;
  MATRIX_ATTRIBUTES *info = (MATRIX_ATTRIBUTES *)attribute_buffer.data;
  BOOL lpac = attribute_status >= 0 && info->Version == 1 && info->Count == 1 && info->Attributes &&
    info->Attributes->ValueCount == 1 && (info->Attributes->ValueType == 2 || info->Attributes->ValueType == 6) &&
    info->Attributes->Values.Uint64 && *info->Attributes->Values.Uint64 == 1;
  fwprintf(stderr, L"NULL_LPAC phase=%ls status=0x%08lx value=%d\n", phase, (DWORD)attribute_status, lpac);
  if (appcontainer && !lpac) {error = ERROR_ACCESS_DENIED; goto done;}
  const wchar_t *sets[] = {L"normal", L"restricted", L"access-restricted", L"capability"};
  DWORD counts[] = {access->SidHash ? access->SidHash->SidCount : 0, restricted->GroupCount,
    access->RestrictedSidHash ? access->RestrictedSidHash->SidCount : 0, actual_count};
  SID_AND_ATTRIBUTES *entries[] = {access->SidHash ? access->SidHash->SidAttr : NULL, restricted->Groups,
    access->RestrictedSidHash ? access->RestrictedSidHash->SidAttr : NULL, access->CapabilitiesHash ? access->CapabilitiesHash->SidAttr : NULL};
  fwprintf(stderr, L"NULL_SIDS phase=%ls normal=%lu restricted=%lu access-restricted=%lu capability=%lu\n",
    phase, counts[0], counts[1], counts[2], counts[3]);
  for (int set = 0; set < 4; set++) for (DWORD i = 0; i < counts[set]; i++) {
    error = matrix_sid(phase, sets[set], i, entries[set][i]); if (error) goto done;
  }
  matrix_create_fn create = (matrix_create_fn)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile");
  matrix_query_object_fn query_object = (matrix_query_object_fn)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryObject");
  matrix_query_file_fn query_file = (matrix_query_file_fn)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationFile");
  if (!create || !query_object || !query_file) {error = ERROR_PROC_NOT_FOUND; goto done;}
  const wchar_t *paths[] = {L"NUL", L"\\\\?\\GLOBALROOT\\Device\\Null", NULL, NULL};
  const wchar_t *path_names[] = {L"dos", L"globalroot", L"native", L"native-sync"};
  const DWORD rights[] = {0, GENERIC_READ, GENERIC_WRITE, GENERIC_READ | GENERIC_WRITE};
  const wchar_t *modes[] = {L"none", L"read", L"write", L"readwrite"};
  for (int p = 0; p < 4; p++) for (int mode = 0; mode < 4; mode++) {
    /* Compare exact rights without implicit synchronization, then the explicit
     * Win32-like synchronous request. Report actual grants, never infer them. */
    ACCESS_MASK desired = rights[mode] | (p == 3 ? SYNCHRONIZE | FILE_READ_ATTRIBUTES : 0);
    ULONG options = p == 3 ? 0x60 /* NON_DIRECTORY | SYNCHRONOUS_NONALERT */ : 0x40 /* NON_DIRECTORY */;
    DWORD observed = matrix_open(phase, path_names[p], modes[mode], paths[p], desired, options, p >= 2, create, query_object, query_file);
    if (!error && observed) error = observed;
  }
  {
    DWORD observed = null_suffix(phase, create);
    if (!error && observed) error = observed;
  }
done:
  if (token && !CloseHandle(token) && !error) error = GetLastError();
  if (package) LocalFree(package);
  if (access) free(access);
  if (restricted) free(restricted);
  for (DWORD i = 0; i < group_count; i++) LocalFree(groups[i]);
  if (groups) LocalFree(groups);
  for (DWORD i = 0; i < capability_count; i++) LocalFree(capabilities[i]);
  if (capabilities) LocalFree(capabilities);
  fflush(stderr); return error;
}
`;

const accessCheckInstrumentation = String.raw`
/* DACL-only counterfactual on the actual suspended child's duplicated token.
 * No token/host ACL mutation. AccessCheck is not a device open or a driver,
 * namespace, MIC or complete SACL evaluation. Read labels separately if allowed. */
static DWORD authz_token(HANDLE token, PSID expected_package, const wchar_t *phase) {
  DWORD bytes = 0, container = 0, kind = 0, level = 0, error = 0;
  TOKEN_APPCONTAINER_INFORMATION *package = NULL; TOKEN_GROUPS *caps = NULL;
  PSID *groups = NULL, *sids = NULL; DWORD group_count = 0, sid_count = 0; LPWSTR text = NULL;
  if (!GetTokenInformation(token, TokenType, &kind, sizeof(kind), &bytes) ||
      !GetTokenInformation(token, TokenImpersonationLevel, &level, sizeof(level), &bytes) ||
      !GetTokenInformation(token, TokenIsAppContainer, &container, sizeof(container), &bytes)) return GetLastError();
  GetTokenInformation(token, TokenCapabilities, NULL, 0, &bytes); caps = calloc(1, bytes);
  if (!caps) return ERROR_NOT_ENOUGH_MEMORY;
  if (!GetTokenInformation(token, TokenCapabilities, caps, bytes, &bytes)) {error = GetLastError(); goto done;}
  BOOL registry = FALSE;
  if (container) {
    GetTokenInformation(token, TokenAppContainerSid, NULL, 0, &bytes); package = calloc(1, bytes);
    if (!package) {error = ERROR_NOT_ENOUGH_MEMORY; goto done;}
    if (!GetTokenInformation(token, TokenAppContainerSid, package, bytes, &bytes)) {error = GetLastError(); goto done;}
    if (!expected_package || !EqualSid(package->TokenAppContainer, expected_package)) {error = ERROR_INVALID_SID; goto done;}
    if (!ConvertSidToStringSidW(package->TokenAppContainer, &text)) {error = GetLastError(); goto done;}
    typedef BOOL (WINAPI *derive_fn)(LPCWSTR, PSID **, DWORD *, PSID **, DWORD *);
    derive_fn derive = (derive_fn)(void *)GetProcAddress(GetModuleHandleW(L"kernelbase.dll"), "DeriveCapabilitySidsFromName");
    if (!derive || !derive(L"registryRead", &groups, &group_count, &sids, &sid_count) || sid_count != 1) {
      error = GetLastError(); if (!error) error = ERROR_NOT_SUPPORTED; goto done;
    }
    registry = caps->GroupCount == 1 && EqualSid(caps->Groups[0].Sid, sids[0]) &&
      (caps->Groups[0].Attributes & SE_GROUP_ENABLED);
  }
  typedef NTSTATUS (NTAPI *query_fn)(HANDLE, PUNICODE_STRING, ULONG, PVOID, ULONG, PULONG);
  query_fn query = (query_fn)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQuerySecurityAttributesToken");
  wchar_t attribute_text[] = L"WIN://NOALLAPPPKG";
  UNICODE_STRING name = {(USHORT)(wcslen(attribute_text) * 2), (USHORT)sizeof(attribute_text), attribute_text};
  union {ULONGLONG align; BYTE data[8192];} buffer; ZeroMemory(&buffer, sizeof(buffer));
  NTSTATUS status = query ? query(token, &name, 1, buffer.data, sizeof(buffer.data), &bytes) : (NTSTATUS)0xc0000002;
  MATRIX_ATTRIBUTES *info = (MATRIX_ATTRIBUTES *)buffer.data;
  BOOL lpac = status >= 0 && info->Version == 1 && info->Count == 1 && info->Attributes &&
    info->Attributes->ValueCount == 1 && (info->Attributes->ValueType == 2 || info->Attributes->ValueType == 6) &&
    info->Attributes->Values.Uint64 && *info->Attributes->Values.Uint64 == 1;
  fwprintf(stderr, L"NULL_AUTHZ_TOKEN phase=%ls source=%ls type=%lu level=%lu appcontainer=%lu lpac=%d status=0x%08lx package=%ls capabilities=%lu registry-read=%d\n",
    phase, expected_package ? L"suspended-child" : L"current-process", kind, level, container, lpac, (DWORD)status,
    text ? text : L"none", caps->GroupCount, registry);
  if (kind != TokenImpersonation || level != SecurityIdentification ||
      (expected_package ? (!container || !lpac || !registry) : (container || lpac || caps->GroupCount))) error = ERROR_INVALID_DATA;
done:
  if (text) LocalFree(text);
  if (package) free(package);
  if (caps) free(caps);
  for (DWORD i = 0; i < group_count; i++) LocalFree(groups[i]);
  if (groups) LocalFree(groups);
  for (DWORD i = 0; i < sid_count; i++) LocalFree(sids[i]);
  if (sids) LocalFree(sids);
  return error;
}

static DWORD authz_checks(HANDLE child_token, PSID app) {
  HANDLE device = NULL, host = NULL, tokens[2] = {NULL, NULL}; DWORD error = 0, bytes = 0, cleanup = 0;
  PSECURITY_DESCRIPTOR original = NULL, label = NULL; PACL dacl = NULL, changed = NULL;
  BYTE *original_copy = NULL; DWORD original_size = 0;
  BOOL present = FALSE, defaulted = FALSE; PSID owner = NULL, group = NULL; LPWSTR app_text = NULL;
  matrix_create_fn create = (matrix_create_fn)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile");
  matrix_query_object_fn query = (matrix_query_object_fn)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryObject");
  if (!create || !query) {error = ERROR_PROC_NOT_FOUND; goto done;}
  wchar_t object_text[] = L"\\Device\\Null";
  UNICODE_STRING name = {(USHORT)(wcslen(object_text) * 2), (USHORT)sizeof(object_text), object_text};
  OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
  attributes.Length = sizeof(attributes); attributes.ObjectName = &name; attributes.Attributes = 0x40;
  IO_STATUS_BLOCK io; ZeroMemory(&io, sizeof(io));
  NTSTATUS status = create(&device, READ_CONTROL | SYNCHRONIZE | FILE_READ_ATTRIBUTES, &attributes, &io,
    NULL, 0, FILE_SHARE_READ | FILE_SHARE_WRITE, 1, 0x60, NULL, 0);
  if (status < 0 || !device || device == INVALID_HANDLE_VALUE) {error = ERROR_ACCESS_DENIED; device = NULL; goto done;}
  union {ULONGLONG align; BYTE data[2048];} object_name; ZeroMemory(&object_name, sizeof(object_name));
  NTSTATUS name_status = query(device, 1 /* ObjectNameInformation */, object_name.data, sizeof(object_name.data), &bytes);
  UNICODE_STRING *actual = (UNICODE_STRING *)object_name.data;
  if (name_status < 0 || !actual->Buffer || actual->Length != name.Length ||
      wcsncmp(actual->Buffer, object_text, name.Length / sizeof(wchar_t))) {error = ERROR_INVALID_NAME; goto done;}
  if (GetFileType(device) != FILE_TYPE_CHAR) {error = ERROR_INVALID_DATA; goto done;}
  error = GetSecurityInfo(device, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner, &group, &dacl, NULL, &original);
  if (error) goto done;
  if (!owner || !group || !GetSecurityDescriptorDacl(original, &present, &dacl, &defaulted) || !present || !dacl) {
    error = ERROR_INVALID_SECURITY_DESCR; goto done;
  }
  original_size = GetSecurityDescriptorLength(original); original_copy = malloc(original_size);
  if (!original_copy) {error = ERROR_NOT_ENOUGH_MEMORY; goto done;}
  memcpy(original_copy, original, original_size);
  fwprintf(stderr, L"NULL_AUTHZ_OBJECT name=DeviceNull verified=1 type=2 desired=0x00120080 options=0x00000060 status=0x%08lx security=0x00000007 owner=1 group=1 dacl-present=1 dacl-null=0 ace-count=%u\n", (DWORD)status, dacl->AceCount);
  for (DWORD i = 0; i < dacl->AceCount; i++) {
    void *entry = NULL; if (!GetAce(dacl, i, &entry)) {error = GetLastError(); goto done;}
    ACE_HEADER *header = entry; LPWSTR sid = NULL; DWORD mask = 0;
    BOOL simple = header->AceType == ACCESS_ALLOWED_ACE_TYPE || header->AceType == ACCESS_DENIED_ACE_TYPE;
    if (simple) {
      ACCESS_ALLOWED_ACE *ace = entry; mask = ace->Mask;
      if (!ConvertSidToStringSidW(&ace->SidStart, &sid)) {error = GetLastError(); goto done;}
    }
    BOOL visible = sid && (!wcscmp(sid, L"S-1-1-0") || !wcscmp(sid, L"S-1-5-12") ||
      !wcscmp(sid, L"S-1-5-18") || !wcscmp(sid, L"S-1-5-32-544") ||
      !wcsncmp(sid, L"S-1-15-2-", 9) || !wcsncmp(sid, L"S-1-15-3-", 9));
    fwprintf(stderr, L"NULL_AUTHZ_ACE index=%lu type=%u flags=0x%08lx mask=0x%08lx sid=%ls\n",
      i, header->AceType, (DWORD)header->AceFlags, mask, simple ? (visible ? sid : L"redacted") : L"unparsed");
    if (sid) LocalFree(sid);
  }
  DWORD label_error = GetSecurityInfo(device, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, NULL, NULL, NULL, NULL, &label);
  PACL sacl = NULL; BOOL label_present = FALSE, label_defaulted = FALSE; DWORD label_count = 0;
  if (!label_error && !GetSecurityDescriptorSacl(label, &label_present, &sacl, &label_defaulted)) label_error = GetLastError();
  if (!label_error && label_present && sacl) for (DWORD i = 0; i < sacl->AceCount; i++) {
    void *entry = NULL; if (!GetAce(sacl, i, &entry)) {label_error = GetLastError(); break;}
    ACE_HEADER *header = entry;
    if (header->AceType == SYSTEM_MANDATORY_LABEL_ACE_TYPE) {
      SYSTEM_MANDATORY_LABEL_ACE *ace = entry; PSID sid = &ace->SidStart;
      DWORD count = *GetSidSubAuthorityCount(sid);
      if (!count) {label_error = ERROR_INVALID_SID; break;}
      fwprintf(stderr, L"NULL_AUTHZ_MANDATORY index=%lu rid=%lu policy=0x%08lx flags=0x%08lx\n",
        label_count++, *GetSidSubAuthority(sid, count - 1), ace->Mask, (DWORD)header->AceFlags);
    }
  }
  fwprintf(stderr, L"NULL_AUTHZ_LABEL error=%lu present=%d count=%lu scope=label-only full-sacl=0 driver=0\n", label_error, label_present, label_count);
  DWORD extra = (DWORD)sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + GetLengthSid(app);
  DWORD size = (DWORD)dacl->AclSize + extra;
  if (size > 65535) {error = ERROR_ALLOTTED_SPACE_EXCEEDED; goto done;}
  changed = calloc(1, size); if (!changed) {error = ERROR_NOT_ENOUGH_MEMORY; goto done;}
  if (!InitializeAcl(changed, size, dacl->AclRevision)) {error = GetLastError(); goto done;}
  BOOL added = FALSE;
  /* Insert the one explicit allow before inherited ACEs; preserve every old ACE. */
  for (DWORD i = 0; i < dacl->AceCount; i++) {
    void *entry = NULL; if (!GetAce(dacl, i, &entry)) {error = GetLastError(); goto done;}
    ACE_HEADER *header = entry;
    if (!added && (header->AceFlags & INHERITED_ACE)) {
      if (!AddAccessAllowedAceEx(changed, dacl->AclRevision, 0, FILE_GENERIC_READ | FILE_GENERIC_WRITE, app)) {error = GetLastError(); goto done;}
      added = TRUE;
    }
    if (!AddAce(changed, dacl->AclRevision, MAXDWORD, entry, header->AceSize)) {error = GetLastError(); goto done;}
  }
  if (!added && !AddAccessAllowedAceEx(changed, dacl->AclRevision, 0, FILE_GENERIC_READ | FILE_GENERIC_WRITE, app)) {error = GetLastError(); goto done;}
  if (!ConvertSidToStringSidW(app, &app_text)) {error = GetLastError(); goto done;}
  SECURITY_DESCRIPTOR descriptors[2];
  for (int v = 0; v < 2; v++) if (!InitializeSecurityDescriptor(&descriptors[v], SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorOwner(&descriptors[v], owner, FALSE) || !SetSecurityDescriptorGroup(&descriptors[v], group, FALSE) ||
      !SetSecurityDescriptorDacl(&descriptors[v], TRUE, v ? changed : dacl, defaulted)) {error = GetLastError(); goto done;}
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &host) ||
      !DuplicateTokenEx(host, TOKEN_QUERY, NULL, SecurityIdentification, TokenImpersonation, &tokens[0]) ||
      !DuplicateTokenEx(child_token, TOKEN_QUERY, NULL, SecurityIdentification, TokenImpersonation, &tokens[1])) {error = GetLastError(); goto done;}
  for (int p = 0; p < 2; p++) {
    const wchar_t *phase = p ? L"lpac" : L"host";
    error = authz_token(tokens[p], p ? app : NULL, phase); if (error) goto done;
    const DWORD rights[] = {GENERIC_READ, GENERIC_WRITE, GENERIC_READ | GENERIC_WRITE};
    const wchar_t *modes[] = {L"read", L"write", L"readwrite"};
    for (int v = 0; v < 2; v++) for (int m = 0; m < 3; m++) {
      GENERIC_MAPPING mapping = {FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS};
      DWORD mapped = rights[m], granted = 0; BOOL allowed = FALSE;
      union {ULONGLONG align; BYTE data[1024];} privileges; ZeroMemory(&privileges, sizeof(privileges));
      DWORD length = sizeof(privileges); MapGenericMask(&mapped, &mapping);
      SetLastError(0);
      BOOL api = AccessCheck(&descriptors[v], tokens[p], mapped, &mapping, (PRIVILEGE_SET *)privileges.data, &length, &granted, &allowed);
      DWORD check_error = api && allowed ? ERROR_SUCCESS : GetLastError();
      fwprintf(stderr, L"NULL_AUTHZ_CHECK phase=%ls variant=%ls access=%ls requested=0x%08lx mapped=0x%08lx api=%d error=%lu allowed=%d granted=0x%08lx privileges=%lu\n",
        phase, v ? L"package" : L"original", modes[m], rights[m], mapped, api, check_error, allowed, granted, ((PRIVILEGE_SET *)privileges.data)->PrivilegeCount);
      if (!api) {error = check_error ? check_error : ERROR_INVALID_DATA; goto done;}
    }
  }
  BOOL unchanged = !memcmp(original_copy, original, original_size);
  fwprintf(stderr, L"NULL_AUTHZ_VARIANT name=package added=%u sid=%ls mask=0x0012019f inherited=0 original-unchanged=%d\n",
    changed->AceCount - dacl->AceCount, app_text, unchanged);
  if (!unchanged) error = ERROR_INVALID_DATA;
done:
  for (int i = 0; i < 2; i++) if (tokens[i] && !CloseHandle(tokens[i]) && !cleanup) cleanup = GetLastError();
  if (host && !CloseHandle(host) && !cleanup) cleanup = GetLastError();
  if (device && !CloseHandle(device) && !cleanup) cleanup = GetLastError();
  if (original) LocalFree(original);
  if (original_copy) free(original_copy);
  if (label) LocalFree(label);
  if (changed) free(changed);
  if (app_text) LocalFree(app_text);
  fwprintf(stderr, L"NULL_AUTHZ_CLEANUP error=%lu\n", cleanup); fflush(stderr);
  return error ? error : cleanup;
}
`;

function once(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error(`matrix substitution must match once: ${before}`);
  return source.replace(before, after);
}

export function matrixSource(source: string): string {
  if (hash(source) !== sourceHash) throw new Error('historical Windows reference changed: review experiment provenance before running');
  source = once(source, 'static int launch(int count, wchar_t **args) {', `${instrumentation}\n${accessCheckInstrumentation}\nstatic int launch(int count, wchar_t **args) {`);
  source = once(source, 'TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, &child_token', 'TOKEN_QUERY | TOKEN_ADJUST_DEFAULT | TOKEN_DUPLICATE, &child_token');
  source = once(source, '  DWORD token_error = checked ? 0 : GetLastError();',
    '  if (checked && is_container) {\n    stage = L"launch.authz-experiment";\n    DWORD authz_error = authz_checks(child_token, app);\n    if (authz_error) {checked = FALSE; SetLastError(authz_error);}\n  }\n  DWORD token_error = checked ? 0 : GetLastError();');
  source = once(source, '  /* Native child runtimes open NUL',
    '  fputws(L"NULL_AMBIENT denied=1\\n", stderr);\n  DWORD matrix_error = null_matrix(L"lpac");\n  if (matrix_error) return failure(L"probe.matrix", matrix_error);\n  /* Native child runtimes open NUL');
  return once(source, '  else if (count == 2 && !wcscmp(args[1], L"--diagnose-null"))',
    '  else if (count == 2 && !wcscmp(args[1], L"--matrix-host")) {DWORD error = null_matrix(L"host"); result = error ? failure(L"matrix.host", error) : 0;}\n  else if (count == 2 && !wcscmp(args[1], L"--diagnose-null"))');
}

export function completeAccessChecks(text: string): boolean {
  if (!completeMatrix(text, 'lpac')) return false;
  const lines = text.split(/\r?\n/).filter(line => line.startsWith('NULL_AUTHZ_'));
  const rows: Record<string, string>[] = [];
  for (const line of lines) {
    const [tag, ...fields] = line.split(' '), entries = fields.map(field => field.split('='));
    if (entries.some(entry => entry.length !== 2 || !entry[0] || !entry[1] || entry[0] === 'tag')
      || new Set(entries.map(entry => entry[0])).size !== entries.length) return false;
    rows.push({tag: tag!, ...Object.fromEntries(entries)});
  }
  const records = (tag: string) => rows.filter(row => row.tag === `NULL_AUTHZ_${tag}`);
  const hex = (value: string | undefined): value is string => !!value && /^0x[0-9a-f]{8}$/.test(value);
  const decimal = (value: string | undefined): number => value && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
  const safeSid = /^(?:redacted|S-1-1-0|S-1-5-12|S-1-5-18|S-1-5-32-544|S-1-15-[23]-\d+(?:-\d+)*)$/;
  const [object] = records('OBJECT'), [variant] = records('VARIANT'), [label] = records('LABEL'), [cleanup] = records('CLEANUP');
  if (['OBJECT', 'VARIANT', 'LABEL', 'CLEANUP'].some(tag => records(tag).length !== 1) || !object || !variant || !label || !cleanup) return false;
  if (object.name !== 'DeviceNull' || object.verified !== '1' || object.type !== '2' || object.desired !== '0x00120080'
    || object.options !== '0x00000060' || object.status !== '0x00000000' || object.security !== '0x00000007'
    || object.owner !== '1' || object.group !== '1' || object['dacl-present'] !== '1' || object['dacl-null'] !== '0' || cleanup.error !== '0') return false;
  const aces = records('ACE'), count = decimal(object['ace-count']);
  if (!Number.isSafeInteger(count) || aces.length !== count || new Set(aces.map(row => row.index)).size !== count
    || aces.some(row => !Number.isSafeInteger(decimal(row.index)) || decimal(row.index) >= count
      || !Number.isSafeInteger(decimal(row.type)) || decimal(row.type) > 255 || !hex(row.flags) || !hex(row.mask)
      || ([0, 1].includes(decimal(row.type)) ? !safeSid.test(row.sid ?? '') : row.sid !== 'unparsed'))) return false;
  if (!Number.isSafeInteger(decimal(label.error)) || !['0', '1'].includes(label.present ?? '') || label.scope !== 'label-only'
    || label['full-sacl'] !== '0' || label.driver !== '0') return false;
  const mandatory = records('MANDATORY'), labels = decimal(label.count);
  if (!Number.isSafeInteger(labels) || mandatory.length !== labels || new Set(mandatory.map(row => row.index)).size !== labels
    || (labels > 0 && label.present !== '1') || mandatory.some(row => !Number.isSafeInteger(decimal(row.index)) || decimal(row.index) >= labels
      || !Number.isSafeInteger(decimal(row.rid)) || !hex(row.policy) || !hex(row.flags))) return false;
  const captureToken = text.split(/\r?\n/).find(line => line.startsWith('NULL_TOKEN phase=lpac '))!;
  const packageSid = Object.fromEntries(captureToken.split(' ').slice(1).map(field => field.split('='))).package;
  if (variant.name !== 'package' || variant.added !== '1' || variant.sid !== packageSid || variant.mask !== '0x0012019f'
    || variant.inherited !== '0' || variant['original-unchanged'] !== '1') return false;
  const tokens = records('TOKEN');
  if (tokens.length !== 2 || new Set(tokens.map(row => row.phase)).size !== 2 || tokens.some(row => row.type !== '2' || row.level !== '1'
    || (row.phase === 'host' ? row.source !== 'current-process' || row.appcontainer !== '0' || row.lpac !== '0' || !hex(row.status)
      || row.package !== 'none' || row.capabilities !== '0' || row['registry-read'] !== '0'
      : row.phase !== 'lpac' || row.source !== 'suspended-child' || row.appcontainer !== '1' || row.lpac !== '1' || row.status !== '0x00000000'
        || row.package !== packageSid || row.capabilities !== '1' || row['registry-read'] !== '1'))) return false;
  const checks = records('CHECK'), rights: Record<string, [string, string]> = {
    read: ['0x80000000', '0x00120089'], write: ['0x40000000', '0x00120116'], readwrite: ['0xc0000000', '0x0012019f'],
  };
  if (checks.length !== 12 || new Set(checks.map(row => `${row.phase}:${row.variant}:${row.access}`)).size !== 12
    || checks.some(row => !['host', 'lpac'].includes(row.phase ?? '') || !['original', 'package'].includes(row.variant ?? '')
      || !rights[row.access ?? ''] || row.requested !== rights[row.access!]![0] || row.mapped !== rights[row.access!]![1]
      || row.api !== '1' || row.privileges !== '0' || !['0', '1'].includes(row.allowed ?? '')
      || (row.allowed === '1' ? row.error !== '0' || row.granted !== row.mapped : row.error !== '5' || row.granted !== '0x00000000')
      || (row.phase === 'host' && row.allowed !== '1'))) return false;
  return rows.every(row => ['OBJECT', 'ACE', 'LABEL', 'MANDATORY', 'VARIANT', 'TOKEN', 'CHECK', 'CLEANUP'].some(tag => row.tag === `NULL_AUTHZ_${tag}`));
}

export function completeSuffix(text: string, phase: 'host' | 'lpac'): boolean {
  if (!completeMatrix(text, phase)) return false;
  const rows: Record<string, string>[] = [];
  for (const line of text.split(/\r?\n/).filter(line => /^NULL_SUFFIX(?: |_)/.test(line))) {
    const [tag, ...fields] = line.split(' '), entries = fields.map(field => field.split('='));
    if (!['NULL_SUFFIX', 'NULL_SUFFIX_BEGIN', 'NULL_SUFFIX_END'].includes(tag!)
      || entries.some(entry => entry.length !== 2 || !entry[0] || !entry[1] || entry[0] === 'tag')
      || new Set(entries.map(entry => entry[0])).size !== entries.length) return false;
    const row = {tag: tag!, ...Object.fromEntries(entries)};
    if (!['host', 'lpac'].includes(row.phase ?? '')) return false;
    if (row.phase === phase) rows.push(row);
  }
  const exactFields = (row: Record<string, string>, names: string[]) => {
    const keys = Object.keys(row).filter(key => key !== 'tag');
    return keys.length === names.length && names.every(name => keys.includes(name));
  };
  const begin = rows.filter(row => row.tag === 'NULL_SUFFIX_BEGIN'), end = rows.filter(row => row.tag === 'NULL_SUFFIX_END');
  if (begin.length !== 1 || end.length !== 1 || !exactFields(begin[0]!, ['phase', 'suffix'])
    || !/^boite-null-[1-9]\d*-\d+$/.test(begin[0]!.suffix ?? '')
    || !exactFields(end[0]!, ['phase', 'error']) || end[0]!.error !== '0') return false;
  const observations = rows.filter(row => row.tag === 'NULL_SUFFIX');
  if (observations.length !== 12 || new Set(observations.map(row => `${row.path}:${row.target}:${row.access}`)).size !== 12) return false;
  const fields = ['phase', 'path', 'target', 'access', 'desired', 'options', 'opened', 'error', 'status', 'type', 'type-error',
    'query-status', 'query-bytes', 'device-type', 'characteristics', 'secure-open', 'reads', 'eof', 'read-bytes', 'read-error', 'writes', 'written', 'write-error', 'close-error'];
  const hex = (value: string | undefined): value is string => !!value && /^0x[0-9a-f]{8}$/.test(value);
  const rights: Record<string, number> = {read: 0x80000000, write: 0x40000000, readwrite: 0xc0000000};
  let characteristics: string | undefined;
  return observations.every(row => {
    if (!exactFields(row, fields) || !['native-sync', 'globalroot'].includes(row.path ?? '')
      || !['bare', 'suffix'].includes(row.target ?? '') || rights[row.access ?? ''] === undefined
      || !hex(row.desired) || !hex(row['device-type']) || !hex(row.characteristics)
      || row['type-error'] !== '0' || row['close-error'] !== '0' || !['0', '1'].includes(row.opened ?? '')) return false;
    const native = row.path === 'native-sync', opened = row.opened === '1';
    if (Number.parseInt(row.desired, 16) !== ((rights[row.access!]! | (native ? 0x100080 : 0)) >>> 0)
      || row.options !== (native ? '0x00000060' : 'na')) return false;
    if (native ? row.error !== 'na' || !hex(row.status) || (opened ? row.status !== '0x00000000' : Number.parseInt(row.status, 16) < 0x80000000)
      : row.status !== 'na' || !/^(?:0|[1-9]\d*)$/.test(row.error ?? '') || (row.error === '0') !== opened) return false;
    if (!opened) return !(phase === 'host' && row.target === 'bare') && row.type === '0' && row['query-status'] === 'na' && row['query-bytes'] === '0'
      && row['device-type'] === '0x00000000' && row.characteristics === '0x00000000' && row['secure-open'] === 'na'
      && ['reads', 'eof', 'read-bytes', 'read-error', 'writes', 'written', 'write-error'].every(field => row[field] === '0');
    if (characteristics !== undefined && row.characteristics !== characteristics) return false;
    characteristics = row.characteristics;
    const reads = row.access === 'write' ? '0' : '2', writes = row.access === 'read' ? '0' : '2';
    return row.type === '2' && row['query-status'] === '0x00000000' && row['query-bytes'] === '8' && row['device-type'] === '0x00000015'
      && row['secure-open'] === ((Number.parseInt(row.characteristics, 16) & 0x100) ? '1' : '0')
      && row.reads === reads && row.eof === reads && row['read-bytes'] === '0' && row['read-error'] === '0'
      && row.writes === writes && row.written === (writes === '2' ? '8192' : '0') && row['write-error'] === '0';
  });
}

export function completeMatrix(text: string, phase: 'host' | 'lpac'): boolean {
  const records = (tag: string): Record<string, string>[] => text.split(/\r?\n/)
    .filter(line => line.startsWith(`${tag} `) && line.includes(` phase=${phase} `))
    .map(line => Object.fromEntries(line.split(' ').slice(1).map(field => field.split('='))));
  const hex = (value: string | undefined): value is string => !!value && /^0x[0-9a-f]{8}$/.test(value);
  const decimal = (value: string | undefined): number => value && /^\d+$/.test(value) ? Number(value) : NaN;
  const tokens = records('NULL_TOKEN'), lpac = records('NULL_LPAC'), counts = records('NULL_SIDS');
  if (tokens.length !== 1 || lpac.length !== 1 || counts.length !== 1) return false;
  const token = tokens[0]!;
  if (!hex(token.flags) || !hex(lpac[0]!.status)) return false;
  if (phase === 'lpac' && (token.appcontainer !== '1' || token.capabilities !== '1' || token['registry-read'] !== '1'
    || !/^S-1-15-2-\d+(?:-\d+)*$/.test(token.package ?? '') || lpac[0]!.status !== '0x00000000' || lpac[0]!.value !== '1')) return false;
  if (phase === 'host' && (token.appcontainer !== '0' || lpac[0]!.value !== '0')) return false;
  const sids = records('NULL_SID');
  for (const set of ['normal', 'restricted', 'access-restricted', 'capability']) {
    const expected = decimal(counts[0]![set]), entries = sids.filter(sid => sid.set === set);
    if (!Number.isSafeInteger(expected) || expected < 0 || entries.length !== expected
      || new Set(entries.map(sid => decimal(sid.index))).size !== expected) return false;
    if (entries.some(sid => !Number.isSafeInteger(decimal(sid.index)) || decimal(sid.index) >= expected || !hex(sid.attributes)
      || !/^(?:redacted|S-1-5-12|S-1-1-0|S-1-15-[23]-\d+(?:-\d+)*)$/.test(sid.sid ?? ''))) return false;
    if (set === 'capability' && (expected !== decimal(token.capabilities)
      || (phase === 'lpac' && (Number.parseInt(entries[0]!.attributes!, 16) & 4) === 0))) return false;
  }
  if (sids.some(sid => !['normal', 'restricted', 'access-restricted', 'capability'].includes(sid.set ?? ''))) return false;
  const rows = records('NULL_ACCESS');
  if (rows.length !== 16 || new Set(rows.map(row => `${row.path}:${row.access}`)).size !== 16) return false;
  const rights: Record<string, number> = {none: 0, read: 0x80000000, write: 0x40000000, readwrite: 0xc0000000};
  return rows.every(row => {
    if (!['dos', 'globalroot', 'native', 'native-sync'].includes(row.path ?? '') || rights[row.access ?? ''] === undefined) return false;
    const native = row.path!.startsWith('native');
    const desired = (rights[row.access!]! | (row.path === 'native-sync' ? 0x100080 : 0)) >>> 0;
    if (!hex(row.desired) || Number.parseInt(row.desired, 16) !== desired || !hex(row.granted) || !hex(row.mode)
      || row['type-error'] !== '0' || row['close-error'] !== '0' || !['0', '1'].includes(row.opened ?? '')) return false;
    if (native) {
      if (row.flags !== 'na' || row.options !== (row.path === 'native-sync' ? '0x00000060' : '0x00000040')
        || row.error !== 'na' || !hex(row.status) || (Number.parseInt(row.status, 16) < 0x80000000) !== (row.opened === '1')) return false;
    } else if (row.flags !== '0x00000000' || row.options !== 'na' || row.status !== 'na'
      || !Number.isSafeInteger(decimal(row.error)) || (decimal(row.error) === 0) !== (row.opened === '1')) return false;
    if (row.opened === '1') return row.type === '2' && row['grant-status'] === '0x00000000' && hex(row['mode-status']);
    // Native Windows also denies the exact asynchronous zero-rights host open.
    // Retain that observation while requiring every other host open to succeed.
    const hostZeroAccessRefusal = phase === 'host' && row.path === 'native' && row.access === 'none' && row.status === '0xc0000022';
    return (phase === 'lpac' || hostZeroAccessRefusal) && row.type === '0' && row.granted === '0x00000000' && row['grant-status'] === 'na'
      && row.mode === '0x00000000' && row['mode-status'] === 'na';
  });
}

if (import.meta.main) {
  const [output, mode] = process.argv.slice(2);
  if (!output || !isAbsolute(output) || (mode && mode !== '--compile-only')) throw new Error('usage: bun packages/core/test/windows-null-access-matrix.ts <fresh absolute artifact directory> [--compile-only]');
  const compileOnly = mode === '--compile-only';
  if (!compileOnly && (process.platform !== 'win32' || process.env.BOITE_TEST_NULL_ACCESS_MATRIX !== '1')) throw new Error('requires Windows and BOITE_TEST_NULL_ACCESS_MATRIX=1; no native fixture allocated');
  if (existsSync(output)) throw new Error('choose a fresh output directory to preserve evidence');
  mkdirSync(output, {recursive: true});
  const source = matrixSource(readFileSync(sourcePath, 'utf8'));
  const generated = join(output, 'null-access-matrix.c'); writeFileSync(generated, source);
  const results: Record<string, unknown>[] = [];
  const manifest = {platform: process.platform, kernel: release(), bun: Bun.version, compileOnly, sourceHash, referenceKind: 'historical-protected-helper-v1', referencePath: 'tests/diagnostics/windows-protected-reference.c',
    generatedSha256: hash(source), runnerSha256: hash(readFileSync(import.meta.path)), results, productionAccepted: false, experimentComplete: false};
  const save = () => writeFileSync(join(output, 'matrix.json'), JSON.stringify(manifest, null, 2) + '\n');
  save();
  const compilers = process.platform === 'win32'
    ? [{name: 'sdk', path: Bun.which('clang')}, {name: 'mingw', path: 'C:\\mingw64\\bin\\gcc.exe'}]
    : [{name: 'mingw-cross', path: Bun.which('x86_64-w64-mingw32-gcc')}];
  let failed = false;
  for (const compiler of compilers) {
    const entry: Record<string, unknown> = {name: compiler.name, compiler: compiler.path}; results.push(entry);
    const scratch = mkdtempSync(join(tmpdir(), 'boite-null-access-'));
    const journal = new Journal(join(scratch, 'journal.db')), procs = new ProcRegistry(journal, new Bus());
    let protection: ExecutionProtections | undefined;
    async function execute(id: string, command: string, args: string[], timeout: number): Promise<Captured> {
      const child = procs.spawnPiped(id, command, args, {cwd: output!, env: selectedEnvironment(), agentRoot: false});
      return capture(procs, id, child, timeout);
    }
    try {
      if (!compiler.path || !existsSync(compiler.path)) throw new Error(`compiler unavailable: ${compiler.name}`);
      const helper = join(output, `null-access-${compiler.name}.exe`);
      const args = ['-O2', '-Wall', '-Wextra', '-Werror', generated, '-o', helper,
        ...(process.platform === 'win32' && /clang/i.test(compiler.path) ? [] : ['-static']), '-luserenv', '-ladvapi32', '-lshell32', '-luser32'];
      entry.compileCommand = [compiler.path, ...args];
      const built = await execute(`compile-${compiler.name}`, compiler.path, args, 90000); entry.compile = built;
      if (built.code || built.timedOut) throw new Error(`strict compile failed: ${compiler.name}`);
      entry.helperSha256 = hash(readFileSync(helper));
      if (!compileOnly) {
        const baseline = await execute(`host-${compiler.name}`, helper, ['--matrix-host'], 10000); entry.host = baseline;
        if (baseline.code || baseline.timedOut || !completeSuffix(baseline.err, 'host')) throw new Error('host matrix or suffix experiment incomplete or unexpected NUL device');
        const {HistoricalWindowsExecutionBoundary} = await import('./fixtures/windows-historical-boundary.ts');
        const calls: Record<string, unknown>[] = []; entry.calls = calls;
        const runner = protectionRunner(procs);
        protection = new ExecutionProtections(new HistoricalWindowsExecutionBoundary(() => helper), async (id, ...args) => {
          const result = await runner(id, ...args); calls.push({command: args[0], args: args[1], ...result}); return result;
        }, id => procs.stopAndWait(id), id => procs.liveCount(id));
        const project = join(scratch, 'project'); mkdirSync(project); writeFileSync(join(project, 'ordinary.txt'), 'synthetic');
        try {
          await protection.install('matrix', {scope: {kind: 'job', id: 'matrix', associationId: 'synthetic', grantRevision: 1},
            route: {providerId: 'synthetic', accountId: 'synthetic', permissionMode: 'default'}, checkout: project,
            credentialPaths: [], executables: [process.execPath], expiresAt: Date.now() + 120000}, () => {});
          entry.admission = 'original probe succeeded';
        } catch (error) {
          entry.admission = String(error);
          try {protection.launch('matrix', process.execPath, [], {cwd: project}); throw new Error('refused install allowed a launch');}
          catch (refusal) {if (!String(refusal).includes('revoked')) throw refusal; entry.refusedLaunch = String(refusal);}
        }
        const probe = calls.find(call => (call.args as string[]).includes('--probe'));
        if (!probe || !completeAccessChecks(String(probe.stderr)) || !completeSuffix(String(probe.stderr), 'lpac')
          || !String(probe.stderr).includes('NULL_AMBIENT denied=1')) throw new Error('LPAC matrix, suffix/DACL experiment or original ambient refusal incomplete');
        const originalSucceeded = probe.code === 0 && probe.stdout === 'boite-windows-protected 1';
        const originalNulDenied = probe.code === 125 && String(probe.stderr).includes('execution.windows.probe.null-device: native call failed (5)');
        if (!originalSucceeded && !originalNulDenied) throw new Error('historical reference probe ended unexpectedly');
        const suffixRows = String(probe.stderr).split(/\r?\n/).filter(line => line.startsWith('NULL_SUFFIX phase=lpac ') && line.includes(' target=suffix '));
        const opened = suffixRows.filter(line => line.includes(' opened=1 ')).length;
        entry.suffix = {experimentComplete: true, lpacOpened: opened, lpacAttempts: 6, allLpacModesOpened: opened === 6};
        entry.experimentComplete = true;
      }
      console.log(`NULL_ACCESS_MATRIX compiler=${compiler.name} compiled=1 native=${!compileOnly} experimentComplete=${entry.experimentComplete === true} productionAccepted=0`);
    } catch (error) {entry.error = String(error); console.error(entry.error); failed = true;}
    finally {
      const cleanupErrors: string[] = [];
      for (const [name, cleanup] of [
        ['protection', () => protection?.close()], ['processes', () => procs.killAll()],
        ['registry', () => procs.close()], ['journal', () => journal.close()],
      ] as const) {
        try {await cleanup();} catch (error) {cleanupErrors.push(`${name}: ${String(error)}`);}
      }
      if (!cleanupErrors.length) {
        try {rmSync(scratch, {recursive: true, force: true});} catch (error) {cleanupErrors.push(`scratch: ${String(error)}`);}
      }
      if (cleanupErrors.length) {entry.cleanupErrors = cleanupErrors; entry.scratchRetained = scratch; entry.experimentComplete = false; failed = true;}
      save();
    }
  }
  manifest.experimentComplete = !failed && !compileOnly && results.length === 2;
  save(); process.exitCode = failed ? 1 : 0;
}
