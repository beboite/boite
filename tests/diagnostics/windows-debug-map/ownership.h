/* Read-only ProcessHandleInformation of this helper only. Compare candidates
 * with our live directory handle; never query foreign tables or close matches.
 * A second exact match is evidence, not permission to close an unknown owner. */
typedef struct {
  HANDLE value; ULONG_PTR handles, pointers;
  ACCESS_MASK granted; ULONG type, attributes, reserved;
} ROUTE_HANDLE_ENTRY;
typedef struct { ULONG_PTR count, reserved; ROUTE_HANDLE_ENTRY entries[1]; } ROUTE_HANDLE_SNAPSHOT;

static DWORD map_lifetime(const wchar_t *phase, const wchar_t *subject) {
  if (!observe_owned_handles || !probe_map) return 0;
  typedef NTSTATUS (NTAPI *compare_objects_fn)(HANDLE, HANDLE);
  query_process_fn query = (query_process_fn)(void *)nt_api("NtQueryInformationProcess");
  compare_objects_fn compare = (compare_objects_fn)(void *)nt_api("NtCompareObjects");
  if (!query || !compare) return ERROR_PROC_NOT_FOUND;
  ULONG capacity = 16384, used = 0; NTSTATUS status;
  ROUTE_HANDLE_SNAPSHOT *snapshot = NULL;
  for (;;) {
    snapshot = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, capacity);
    if (!snapshot) return ERROR_NOT_ENOUGH_MEMORY;
    handle_snapshot_queries++;
    status = query(GetCurrentProcess(), (PROCESSINFOCLASS)51, snapshot, capacity, &used);
    if (status != (NTSTATUS)0xc0000004) break;
    HeapFree(GetProcessHeap(), 0, snapshot); snapshot = NULL;
    if (capacity >= 1048576 || used > 1048576) return ERROR_INSUFFICIENT_BUFFER;
    capacity = used > capacity ? used : capacity * 2;
    if (capacity > 1048576) capacity = 1048576;
  }
  DWORD error = 0; ULONG type = 0; BOOL found = FALSE; unsigned int matches = 0;
  size_t header = FIELD_OFFSET(ROUTE_HANDLE_SNAPSHOT, entries);
  if (status < 0) error = (DWORD)status;
  else if (used < header || used > capacity || snapshot->count > (used - header) / sizeof(ROUTE_HANDLE_ENTRY))
    error = ERROR_INVALID_DATA;
  if (!error) for (ULONG_PTR i = 0; i < snapshot->count; i++) {
    if (snapshot->entries[i].value == probe_map) { type = snapshot->entries[i].type; found = TRUE; break; }
  }
  if (!error && !found) error = ERROR_INVALID_HANDLE;
  if (!error) for (ULONG_PTR i = 0; i < snapshot->count; i++) {
    ROUTE_HANDLE_ENTRY *entry = &snapshot->entries[i];
    if (entry->type != type) continue;
    NTSTATUS same = compare(probe_map, entry->value);
    if (!same) {
      matches++;
      fwprintf(stderr, L"map-owned phase=%ls subject=%ls pid=%lu handle=%p anchor=%d granted=0x%08lx attributes=0x%08lx same=0x00000000\n",
        phase, subject, GetCurrentProcessId(), entry->value, entry->value == probe_map, entry->granted, entry->attributes);
    } else if (same != (NTSTATUS)0xc00001ac && !error) error = (DWORD)same; /* STATUS_NOT_SAME_OBJECT */
  }
  fwprintf(stderr, L"map-lifetime phase=%ls subject=%ls pid=%lu query=0x%08lx matches=%u error=%lu\n",
    phase, subject, GetCurrentProcessId(), (unsigned long)status, matches, error);
  HeapFree(GetProcessHeap(), 0, snapshot); fflush(stderr);
  if (!error) error = object_counts(L"map-lifetime", probe_map);
  return error;
}
