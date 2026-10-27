/* RED-only lifetime experiment, while its already verified LPAC root remains
 * suspended. A -> owned empty B -> known A. Never restore an inferred ambient
 * map. Failure to restore A aborts launch and terminates the owned job. */
static HANDLE swap_map;
static wchar_t swap_name[256];
static DWORD swap_cleanup_error;

static DWORD swap_absence(const wchar_t *phase) {
  if (!*swap_name) return 0;
  open_directory_fn open = (open_directory_fn)(void *)nt_api("NtOpenDirectoryObject");
  if (!open) return ERROR_PROC_NOT_FOUND;
  UNICODE_STRING name = {(USHORT)(wcslen(swap_name) * 2), (USHORT)sizeof(swap_name), swap_name};
  OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
  attributes.Length = sizeof(attributes); attributes.ObjectName = &name; attributes.Attributes = 0x40;
  HANDLE observer = NULL; NTSTATUS status = open(&observer, 1, &attributes);
  DWORD error = observer ? close_owned(L"swap-observer", &observer) : 0;
  fwprintf(stderr, L"cleanup swap-open phase=%ls status=0x%08lx absent=%d closed=%d error=%lu\n",
    phase, (unsigned long)status, status == (NTSTATUS)0xc0000034, !observer, error); fflush(stderr);
  return error ? error : status == (NTSTATUS)0xc0000034 ? 0 : ERROR_INVALID_DATA;
}

static DWORD map_roundtrip(HANDLE process, PSECURITY_DESCRIPTOR security) {
  typedef NTSTATUS (NTAPI *create_directory_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, HANDLE, ULONG);
  typedef NTSTATUS (NTAPI *set_process_fn)(HANDLE, PROCESSINFOCLASS, PVOID, ULONG);
  create_directory_fn create = (create_directory_fn)(void *)nt_api("NtCreateDirectoryObjectEx");
  set_process_fn set = (set_process_fn)(void *)nt_api("NtSetInformationProcess");
  if (!create || !set) return ERROR_PROC_NOT_FOUND;
  if (swprintf(swap_name, 256, L"%ls.swap", probe_name) < 0) return ERROR_INSUFFICIENT_BUFFER;
  UNICODE_STRING name = {(USHORT)(wcslen(swap_name) * 2), (USHORT)sizeof(swap_name), swap_name};
  OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
  attributes.Length = sizeof(attributes); attributes.ObjectName = &name;
  attributes.Attributes = 0x40; attributes.SecurityDescriptor = security;
  NTSTATUS created = create(&swap_map, 0xf000f, &attributes, NULL, 0);
  fwprintf(stderr, L"private-swap path=%ls create=0x%08lx\n", swap_name, (unsigned long)created); fflush(stderr);
  if (created < 0) { *swap_name = 0; return (DWORD)created; }
  DWORD error = object_counts(L"swap-before-assign", swap_map);
  if (error) return error; /* launch end closes our B handle after killing job */
  NTSTATUS changed = set(process, (PROCESSINFOCLASS)23, &swap_map, sizeof(swap_map));
  fwprintf(stderr, L"map-swap pid=%lu step=A-to-B set=0x%08lx\n", GetProcessId(process), (unsigned long)changed);
  DWORD observed = object_counts(L"primary-after-swap-away", probe_map); if (observed && !error) error = observed;
  observed = object_counts(L"swap-after-assign", swap_map); if (observed && !error) error = observed;
  /* Always restore the explicit A handle even when B assignment/observation
   * fails. The root's user thread stays suspended between these calls. */
  NTSTATUS restored = set(process, (PROCESSINFOCLASS)23, &probe_map, sizeof(probe_map));
  fwprintf(stderr, L"map-swap pid=%lu step=B-to-A set=0x%08lx\n", GetProcessId(process), (unsigned long)restored);
  if (restored < 0) return (DWORD)restored;
  observed = object_counts(L"primary-after-swap-back", probe_map); if (observed && !error) error = observed;
  observed = object_counts(L"swap-after-restore", swap_map); if (observed && !error) error = observed;
  DWORD closed = close_owned(L"swap-map", &swap_map); if (closed && !error) error = closed;
  swap_cleanup_error = swap_absence(L"after-restore");
  /* Namespace-retention failures stay fatal at final cleanup, but do not hide
   * RED's boundary/routing evidence or block independently safe A/B diagnosis. */
  return changed < 0 ? (DWORD)changed : error;
}
