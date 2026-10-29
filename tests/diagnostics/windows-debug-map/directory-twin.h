/* Diagnostic only: identical empty siblings, only the first reaches a map set.
 * All anchors are returned directly by successful create/open calls below. */
static wchar_t twin_unused_name[280];
static BOOL twin_unused_created;

static void twin_log(const wchar_t *phase, int role, NTSTATUS status, BOOL closed,
    BOOL verified, DWORD granted, DWORD attributes, DWORD flags, DWORD error) {
  fwprintf(stderr, L"directory-twin phase=%ls role=%ls nonce=%ls helper=%lu helper-created=%llu root=%lu created=%llu path=%ls now=%llu status=0x%08lx closed=%d verified=%d granted=0x%08lx attributes=0x%08lx flags=%lu absent=%d error=%lu\n",
    phase, role ? L"unused" : L"attached", rt_frame.nonce, rt_frame.helper, rt_frame.helper_created,
    rt_frame.root, rt_frame.created, role ? twin_unused_name : retired_name, ownership_wall_ms(),
    (unsigned long)status, closed, verified, granted, attributes, flags, status == (NTSTATUS)0xc0000034, error);
  fflush(stderr);
}

/* Both the object name and type query return embedded pointers. Bounds-check
 * those buffers before comparing their exact strings. No foreign table read. */
static DWORD twin_string(HANDLE object, OBJECT_INFORMATION_CLASS kind, const wchar_t *expected) {
  BYTE buffer[8192]; ULONG used = 0;
  query_object_fn query = (query_object_fn)(void *)nt_api("NtQueryObject");
  if (!query) return ERROR_PROC_NOT_FOUND;
  NTSTATUS status = query(object, kind, buffer, sizeof(buffer), &used);
  if (status != 0) return (DWORD)status;
  if (used < sizeof(UNICODE_STRING) || used > sizeof(buffer)) return ERROR_INVALID_DATA;
  UNICODE_STRING *text = (UNICODE_STRING *)buffer;
  uintptr_t first = (uintptr_t)buffer, end = first + used, value = (uintptr_t)text->Buffer;
  size_t length = wcslen(expected) * sizeof(wchar_t);
  if (text->Length != length || value < first + sizeof(*text) || value > end || length > end - value ||
      memcmp(text->Buffer, expected, length)) return ERROR_INVALID_DATA;
  return 0;
}
static DWORD twin_verify(HANDLE object, int role, const wchar_t *phase) {
  struct { ULONG attributes, granted, handles, pointers; ULONG reserved[10]; } info;
  ZeroMemory(&info, sizeof(info)); ULONG used = 0; DWORD flags = 0;
  query_object_fn query = (query_object_fn)(void *)nt_api("NtQueryObject");
  DWORD error = twin_string(object, (OBJECT_INFORMATION_CLASS)1, role ? twin_unused_name : retired_name);
  if (!error) error = twin_string(object, (OBJECT_INFORMATION_CLASS)2, L"Directory");
  if (!error && !GetHandleInformation(object, &flags)) {error = GetLastError(); if (!error) error = ERROR_INVALID_HANDLE;}
  if (!error) {
    NTSTATUS status = query ? query(object, (OBJECT_INFORMATION_CLASS)0, &info, sizeof(info), &used) : (NTSTATUS)0xc0000002;
    if (status != 0) error = (DWORD)status;
    else if (used != sizeof(info) || info.attributes || info.granted != 0xf000f || flags)
      error = ERROR_INVALID_DATA;
  }
  twin_log(phase, role, (NTSTATUS)error, FALSE, !error, info.granted, info.attributes, flags, 0);
  return error;
}

#include "anchor-overlap.h"
static DWORD directory_twin_replace(PROCESS_INFORMATION *root, HANDLE job, PSECURITY_DESCRIPTOR security) {
  typedef NTSTATUS (NTAPI *create_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, HANDLE, ULONG);
  typedef NTSTATUS (NTAPI *set_fn)(HANDLE, PROCESSINFOCLASS, PVOID, ULONG);
  typedef NTSTATUS (NTAPI *compare_fn)(HANDLE, HANDLE);
  create_fn create = (create_fn)(void *)nt_api("NtCreateDirectoryObjectEx");
  open_directory_fn open = (open_directory_fn)(void *)nt_api("NtOpenDirectoryObject");
  set_fn set = (set_fn)(void *)nt_api("NtSetInformationProcess");
  compare_fn compare = (compare_fn)(void *)nt_api("NtCompareObjects");
  if (!create || !open || !set || !compare || !directory_twin_mode || retirement_live_done || !probe_map ||
      rt_identity(root, TRUE)) return ERROR_INVALID_DATA;
  int a = swprintf(retired_name, 280, L"%ls.retired", probe_name);
  int b = swprintf(twin_unused_name, 280, L"%ls.unused", probe_name);
  if (a < 0 || a >= 280 || b < 0 || b >= 280) return ERROR_INSUFFICIENT_BUFFER;
  HANDLE anchors[2] = {NULL, NULL}, opened[2] = {NULL, NULL};
  BOOL open_close_attempted[2] = {FALSE, FALSE};
  DWORD error = 0;
  for (int role = 0; role < 2; role++) {
    wchar_t *path = role ? twin_unused_name : retired_name;
    UNICODE_STRING name = {(USHORT)(wcslen(path) * sizeof(wchar_t)), (USHORT)((wcslen(path) + 1) * sizeof(wchar_t)), path};
    OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
    attributes.Length = sizeof(attributes); attributes.ObjectName = &name;
    attributes.Attributes = 0x40; attributes.SecurityDescriptor = security;
    NTSTATUS status = create(&anchors[role], 0xf000f, &attributes, NULL, 0);
    twin_log(L"create", role, status, FALSE, FALSE, 0, 0, 0, 0);
    if (!role) {
      fwprintf(stderr, L"map-retire named path=%ls create=0x%08lx\n", retired_name, (unsigned long)status); fflush(stderr);
    }
    if (status != 0) {anchors[role] = NULL; error = (DWORD)status; goto end;}
    if (role) twin_unused_created = TRUE; else retired_created = TRUE;
    error = twin_verify(anchors[role], role, L"verify-create"); if (error) goto end;
    if (!rt_in_time()) {error = ERROR_TIMEOUT; goto end;}
  }
  /* Keep BOTH creation anchors until both same-object opens are verified. */
  for (int role = 0; role < 2; role++) {
    wchar_t *path = role ? twin_unused_name : retired_name;
    UNICODE_STRING name = {(USHORT)(wcslen(path) * sizeof(wchar_t)), (USHORT)((wcslen(path) + 1) * sizeof(wchar_t)), path};
    OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
    attributes.Length = sizeof(attributes); attributes.ObjectName = &name; attributes.Attributes = 0x40;
    NTSTATUS status = open(&opened[role], 0xf000f, &attributes);
    twin_log(L"open", role, status, FALSE, FALSE, 0, 0, 0, 0);
    if (status != 0) {opened[role] = NULL; error = (DWORD)status; goto end;}
    error = twin_verify(opened[role], role, L"verify-open"); if (error) goto end;
    status = compare(anchors[role], opened[role]);
    twin_log(L"same", role, status, FALSE, FALSE, 0, 0, 0, 0);
    if (status != 0) {error = (DWORD)status; goto end;}
    if (!rt_in_time()) {error = ERROR_TIMEOUT; goto end;}
  }
  for (int role = 0; role < 2; role++) {
    open_close_attempted[role] = TRUE;
    error = close_owned(role ? L"twin-unused-open" : L"twin-attached-open", &opened[role]);
    twin_log(L"close-open", role, (NTSTATUS)error, !opened[role], FALSE, 0, 0, 0, 0);
    if (error) goto end;
  }
  error = rt_identity(root, TRUE); if (error) goto end;
  if (anchor_overlap_mode) {
    /* The unused control and every explicit open are closed before either GO.
     * Only the attached creation anchor's overlap with Set differs. */
    error = close_owned(L"twin-unused-map", &anchors[1]);
    twin_log(L"close-create", 1, (NTSTATUS)error, !anchors[1], FALSE, 0, 0, 0, 0);
    anchors[1] = NULL; /* Never retry an undecidable failed close. */
    if (!error) error = anchor_overlap_assign(root, job, &anchors[0]);
    goto end;
  }
  /* The unused anchor is never passed to a process attribute or map API. */
  {
    NTSTATUS status = set(root->hProcess, (PROCESSINFOCLASS)23, &anchors[0], sizeof(anchors[0]));
    twin_log(L"set", 0, status, FALSE, FALSE, 0, 0, 0, 0);
    fwprintf(stderr, L"map-retire live pid=%lu set=0x%08lx named=1 inherited=0 links=0\n", rt_frame.root, (unsigned long)status); fflush(stderr);
    if (status != 0) {error = (DWORD)status; goto end;}
  }
  error = rt_identity(root, TRUE);
end:
  for (int role = 0; role < 2; role++) {
    /* Each acquired handle gets one close attempt. An undecidable failure is
     * fatal; never retry a numeric value or claim complete anchors afterward. */
    if (opened[role] && !open_close_attempted[role]) {
      DWORD closed = close_owned(role ? L"twin-unused-open" : L"twin-attached-open", &opened[role]);
      twin_log(L"abort-close-open", role, (NTSTATUS)closed, !opened[role], FALSE, 0, 0, 0, 0);
      if (!error) error = closed;
    }
    if (anchors[role]) {
      DWORD closed = close_owned(role ? L"twin-unused-map" : L"retire-named-map", &anchors[role]);
      twin_log(L"close-create", role, (NTSTATUS)closed, !anchors[role], FALSE, 0, 0, 0, 0);
      if (!error) error = closed;
    }
  }
  if (!error) {retirement_live_done = TRUE; rt_log(L"assign", 0, 1);}
  return error;
}

static DWORD directory_twin_absence(const wchar_t *phase) {
  if (!directory_twin_mode || !twin_unused_created) return 0;
  open_directory_fn open = (open_directory_fn)(void *)nt_api("NtOpenDirectoryObject");
  if (!open) return ERROR_PROC_NOT_FOUND;
  UNICODE_STRING name = {(USHORT)(wcslen(twin_unused_name) * sizeof(wchar_t)), (USHORT)sizeof(twin_unused_name), twin_unused_name};
  OBJECT_ATTRIBUTES attributes; ZeroMemory(&attributes, sizeof(attributes));
  attributes.Length = sizeof(attributes); attributes.ObjectName = &name; attributes.Attributes = 0x40;
  HANDLE observer = NULL; NTSTATUS status = open(&observer, 1, &attributes);
  BOOL closed = !observer || CloseHandle(observer); DWORD error = closed ? 0 : GetLastError();
  twin_log(phase, 1, status, closed, FALSE, 0, 0, 0, error);
  return error ? error : status == (NTSTATUS)0xc0000034 ? 0 : ERROR_INVALID_DATA;
}
