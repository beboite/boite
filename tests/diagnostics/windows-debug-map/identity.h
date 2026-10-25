/* Native file IDs establish identity. Paths, basenames and PE ranges alone do
 * not authorize an exception. All process/thread handles here came from events. */
#include "startup-site.h"
static BY_HANDLE_FILE_INFORMATION target_file, console_file;
static BOOL target_known, console_known;

static BOOL same_file(const BY_HANDLE_FILE_INFORMATION *a, const BY_HANDLE_FILE_INFORMATION *b) {
  return a->dwVolumeSerialNumber == b->dwVolumeSerialNumber &&
    a->nFileIndexHigh == b->nFileIndexHigh && a->nFileIndexLow == b->nFileIndexLow;
}

static DWORD file_identity(const wchar_t *label, DWORD pid, HANDLE file, BY_HANDLE_FILE_INFORMATION *info) {
  wchar_t path[4096]; ZeroMemory(info, sizeof(*info));
  if (!file || file == INVALID_HANDLE_VALUE) return ERROR_INVALID_HANDLE;
  DWORD length = GetFinalPathNameByHandleW(file, path, 4096, VOLUME_NAME_NT);
  if (!length || length >= 4096 || !GetFileInformationByHandle(file, info)) {
    DWORD error = GetLastError(); return error ? error : ERROR_INVALID_DATA;
  }
  fwprintf(stderr, L"debug-file label=%ls pid=%lu path=%ls volume=0x%08lx file=%08lx:%08lx size=%08lx:%08lx write=%08lx:%08lx\n",
    label, pid, path, info->dwVolumeSerialNumber, info->nFileIndexHigh, info->nFileIndexLow,
    info->nFileSizeHigh, info->nFileSizeLow, info->ftLastWriteTime.dwHighDateTime, info->ftLastWriteTime.dwLowDateTime);
  fflush(stderr); return 0;
}

static DWORD prepare_target(const wchar_t *path) {
  HANDLE file = CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL, OPEN_EXISTING, 0, NULL);
  if (file == INVALID_HANDLE_VALUE) return GetLastError();
  DWORD error = file_identity(L"synthetic-target", GetCurrentProcessId(), file, &target_file);
  if (!CloseHandle(file) && !error) error = GetLastError();
  target_known = !error;
  if (error) return error;
  wchar_t system[4096]; UINT length = GetSystemDirectoryW(system, 4096);
  if (!length || length + 13 >= 4096) return ERROR_INSUFFICIENT_BUFFER;
  memcpy(system + length, L"\\conhost.exe", sizeof(L"\\conhost.exe"));
  file = CreateFileW(system, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL, OPEN_EXISTING, 0, NULL);
  if (file == INVALID_HANDLE_VALUE) return GetLastError();
  error = file_identity(L"trusted-conhost", GetCurrentProcessId(), file, &console_file);
  if (!CloseHandle(file) && !error) error = GetLastError();
  console_known = !error; return error;
}

static DWORD event_image(const DEBUG_EVENT *event, DWORD root, BOOL *auxiliary, DWORD *parent) {
  const CREATE_PROCESS_DEBUG_INFO *created = &event->u.CreateProcessInfo;
  BY_HANDLE_FILE_INFORMATION image, process_image;
  DWORD error = file_identity(L"create-image", event->dwProcessId, created->hFile, &image);
  wchar_t path[4096]; DWORD length = 4096;
  if (!error && !QueryFullProcessImageNameW(created->hProcess, 0, path, &length)) error = GetLastError();
  HANDLE file = INVALID_HANDLE_VALUE;
  if (!error) {
    file = CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE) error = GetLastError();
    else error = file_identity(L"process-image", event->dwProcessId, file, &process_image);
  }
  if (file != INVALID_HANDLE_VALUE && !CloseHandle(file) && !error) error = GetLastError();
  if (!error && (!target_known || !same_file(&image, &process_image))) error = ERROR_INVALID_DATA;
  BOOL target = !error && same_file(&image, &target_file);
  *auxiliary = !error && console_known && same_file(&image, &console_file);
  if (!error && !target && !*auxiliary) error = ERROR_INVALID_DATA;
  DWORD tid = GetThreadId(created->hThread), owner = GetProcessIdOfThread(created->hThread);
  /* Read only the process supplied by this owned creation event. Its parent
   * must bind to an already captured target; never open that other PID.
   * File identity, LPAC/job checks and per-parent role limits remain required. */
  struct {
    NTSTATUS exit_status; PVOID peb; ULONG_PTR affinity; LONG priority;
    ULONG_PTR pid, parent;
  } basic;
  ZeroMemory(&basic, sizeof(basic)); ULONG used = 0;
  query_process_fn query = (query_process_fn)(void *)nt_api("NtQueryInformationProcess");
  NTSTATUS lineage = query ? query(created->hProcess, (PROCESSINFOCLASS)0, &basic, sizeof(basic), &used) : (NTSTATUS)0xc0000002;
  BOOL parent_known = lineage >= 0 && used == sizeof(basic) && basic.pid == event->dwProcessId;
  fwprintf(stderr, L"debug-parent pid=%lu query=0x%08lx bytes=%lu known=%d reported-pid=%llu parent=%llu\n",
    event->dwProcessId, (unsigned long)lineage, used, parent_known,
    (unsigned long long)basic.pid, (unsigned long long)basic.parent);
  if (!error && (!parent_known || basic.parent > MAXDWORD)) error = lineage < 0 ? (DWORD)lineage : ERROR_INVALID_DATA;
  *parent = !error ? (DWORD)basic.parent : 0;
  if (!error && (tid != event->dwThreadId || owner != event->dwProcessId ||
      GetProcessId(created->hProcess) != event->dwProcessId || (event->dwProcessId == root && !target))) error = ERROR_INVALID_DATA;
  fwprintf(stderr, L"debug-image pid=%lu tid=%lu handle-tid=%lu thread-owner=%lu root=%d role=%ls identity=%d base=%p start=%p error=%lu\n",
    event->dwProcessId, event->dwThreadId, tid, owner, event->dwProcessId == root,
    error ? L"unknown" : target ? L"target" : L"auxiliary", !error, created->lpBaseOfImage, (void *)created->lpStartAddress, error);
  fflush(stderr); return error;
}

/* Metadata of the helper's already loaded native image, never another kernel's
 * offsets. Emitted for matching symbol research, not used as an address range
 * acceptance rule. Only the exact checked instruction from startup-site.json
 * can authorize the first loader exception on the initial event thread. */
static DWORD native_metadata(uintptr_t base, uintptr_t exported, DWORD *image_size, DWORD *loader_rva) {
  const IMAGE_DOS_HEADER *dos = (const IMAGE_DOS_HEADER *)base;
  if (dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew < 0 || dos->e_lfanew > 1048576) return ERROR_BAD_EXE_FORMAT;
  const IMAGE_NT_HEADERS64 *nt = (const IMAGE_NT_HEADERS64 *)(base + (uintptr_t)dos->e_lfanew);
  if (nt->Signature != IMAGE_NT_SIGNATURE || nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC ||
      exported < base || exported - base >= nt->OptionalHeader.SizeOfImage) return ERROR_BAD_EXE_FORMAT;
  *image_size = nt->OptionalHeader.SizeOfImage;
  fwprintf(stderr, L"debug-native machine=0x%04x timestamp=0x%08lx image-size=0x%08lx exported-rva=0x%llx\n",
    nt->FileHeader.Machine, nt->FileHeader.TimeDateStamp, *image_size, (unsigned long long)(exported - base));
  BOOL pdb_known = FALSE, pinned_pdb = FALSE;
  if (nt->OptionalHeader.NumberOfRvaAndSizes > IMAGE_DIRECTORY_ENTRY_DEBUG) {
    IMAGE_DATA_DIRECTORY directory = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_DEBUG];
    if (directory.VirtualAddress && directory.VirtualAddress < *image_size && directory.Size <= *image_size - directory.VirtualAddress &&
        directory.Size % sizeof(IMAGE_DEBUG_DIRECTORY) == 0) {
      const IMAGE_DEBUG_DIRECTORY *entries = (const IMAGE_DEBUG_DIRECTORY *)(base + directory.VirtualAddress);
      for (DWORD i = 0; i < directory.Size / sizeof(*entries); i++) {
        const IMAGE_DEBUG_DIRECTORY *entry = &entries[i];
        if (entry->Type != IMAGE_DEBUG_TYPE_CODEVIEW || !entry->AddressOfRawData || entry->AddressOfRawData >= *image_size ||
            entry->SizeOfData < 25 || entry->SizeOfData > *image_size - entry->AddressOfRawData) continue;
        const BYTE *data = (const BYTE *)(base + entry->AddressOfRawData);
        if (memcmp(data, "RSDS", 4) || !memchr(data + 24, 0, entry->SizeOfData - 24)) continue;
        GUID guid; DWORD age; memcpy(&guid, data + 4, sizeof(guid)); memcpy(&age, data + 20, sizeof(age));
        fwprintf(stderr, L"debug-native-symbol pdb=%hs key=%08lx%04x%04x%02x%02x%02x%02x%02x%02x%02x%02x%lx age=%lu\n",
          (const char *)(data + 24), guid.Data1, guid.Data2, guid.Data3,
          guid.Data4[0], guid.Data4[1], guid.Data4[2], guid.Data4[3], guid.Data4[4], guid.Data4[5], guid.Data4[6], guid.Data4[7], age, age);
        pdb_known = TRUE;
        if (!memcmp(&guid, &route_native_guid, sizeof(guid)) && age == 1 && !strcmp((const char *)(data + 24), "ntdll.pdb")) pinned_pdb = TRUE;
      }
    }
  }
  fwprintf(stderr, L"debug-native-symbol known=%d\n", pdb_known);
  BOOL pinned = pinned_pdb && nt->FileHeader.Machine == IMAGE_FILE_MACHINE_AMD64 &&
    nt->FileHeader.TimeDateStamp == 0x64d8ddf5 && *image_size == 0x264000 && exported - base == 0x120570 &&
    ROUTE_LOADER_START + sizeof(route_loader_code) <= *image_size &&
    !memcmp((const void *)(base + ROUTE_LOADER_START), route_loader_code, sizeof(route_loader_code));
  if (pinned) *loader_rva = ROUTE_LOADER_BREAK;
  fwprintf(stderr, L"debug-startup-rule pinned=%d site-rva=0x%08lx symbol=LdrpDoDebuggerBreak+0x35 code-bytes=%u\n",
    pinned, *loader_rva, (unsigned int)sizeof(route_loader_code));
  fflush(stderr); return pinned ? 0 : ERROR_INVALID_DATA;
}
