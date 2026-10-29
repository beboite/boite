/* Diagnostic-only final pre-return fence. No process handles or map changes. */
typedef struct {
  DWORD magic, version, bytes, phase, role, result, helper, root;
  ULONGLONG helper_created, root_created, ready, deadline, root_deadline, at;
  wchar_t nonce[33], compiler_nonce[33];
  DWORD acquired, closed, error, session, cleanup;
} LF_FRAME;
typedef char lf_fixed_size[(sizeof(LF_FRAME) == 232) ? 1 : -1];
static DWORD lf_acquired, lf_closed, lf_cleanup_mask;
static DWORD lf_file(const wchar_t *directory, const wchar_t *label, const wchar_t *phase, LF_FRAME *frame, BOOL write) {
  wchar_t path[4300], pending[4300];
  int n = swprintf(path, 4300, L"%ls\\%ls.%ls.bin", directory, label, phase);
  if (n < 0 || n >= 4300) return ERROR_INSUFFICIENT_BUFFER;
  int m = swprintf(pending, 4300, L"%ls.pending", path);
  if (n < 0 || n >= 4300 || m < 0 || m >= 4300) return ERROR_INSUFFICIENT_BUFFER;
  HANDLE file = CreateFileW(write ? pending : path, write ? GENERIC_WRITE : GENERIC_READ, write ? 0 : FILE_SHARE_READ,
    NULL, write ? CREATE_NEW : OPEN_EXISTING, 0, NULL);
  if (file == INVALID_HANDLE_VALUE) return GetLastError();
  lf_acquired++; DWORD used = 0, error = 0; LARGE_INTEGER size;
  BOOL ok = write ? WriteFile(file, frame, sizeof(*frame), &used, NULL) : ReadFile(file, frame, sizeof(*frame), &used, NULL);
  if (!ok) {error = GetLastError(); if (!error) error = ERROR_READ_FAULT;}
  else if (used != sizeof(*frame)) error = ERROR_INVALID_DATA;
  if (!error && !write && (!GetFileSizeEx(file, &size) || size.QuadPart != sizeof(*frame))) error = ERROR_INVALID_DATA;
  BOOL closed = CloseHandle(file); DWORD close_error = closed ? 0 : GetLastError();
  if (closed) lf_closed++; else if (!close_error) close_error = ERROR_INVALID_HANDLE;
  fwprintf(stderr, L"live-fence io=%ls write=%d acquired=%lu closed=%lu error=%lu\n", phase, write, lf_acquired, lf_closed, error ? error : close_error); fflush(stderr);
  if (!error && close_error) error = close_error;
  /* Publication follows successful closure. No reader observes a partial file. */
  if (!error && write && !MoveFileExW(pending, path, 0)) error = GetLastError();
  return error;
}
static BOOL lf_hex(wchar_t *value, const wchar_t *key) {
  if (GetEnvironmentVariableW(key, value, 33) != 32) return FALSE;
  for (int i = 0; i < 32; i++) if (!((value[i] >= L'a' && value[i] <= L'f') || (value[i] >= L'0' && value[i] <= L'9'))) return FALSE;
  return TRUE;
}
static DWORD live_root_fence(int result) {
  wchar_t label[40], directory[4096], fault[32];
  DWORD length = GetEnvironmentVariableW(L"BOITE_LIVE_ROOT_FENCE_LABEL", label, 40);
  if (!length) return 0;
  if (length >= 40) return ERROR_INVALID_DATA;
  DWORD error = 0, role = !wcscmp(label,L"ASSIGNED-LIVE-HELD") ? 1 : !wcscmp(label,L"ASSIGNED-LIVE-RELEASED") ? 2 : 0;
  LF_FRAME ready; ZeroMemory(&ready,sizeof(ready));
  if (length >= 40 || !role || result != 125 || anchor_overlap_mode != 1 || retirement_timing_mode != 1 ||
      GetEnvironmentVariableW(L"BOITE_DIAGNOSTIC_ANCHOR_FAULT",fault,32) != 8 || wcscmp(fault,L"assigned") ||
      !lf_hex(ready.compiler_nonce,L"BOITE_LIVE_ROOT_FENCE_NONCE") || rt_nonce(ready.nonce) ||
      !rt_frame.root || rt_frame.helper != GetCurrentProcessId() || rt_frame.helper_created != rt_created(GetCurrentProcess(),FALSE) ||
      probe_map || probe_link || swap_map || lf_cleanup_mask != 0x1ff || ao_files_acquired != ao_files_closed) error = ERROR_INVALID_DATA;
  DWORD count = GetEnvironmentVariableW(L"BOITE_LIVE_ROOT_FENCE_DIRECTORY",directory,4096);
  if (!count || count >= 4096) error = ERROR_INVALID_NAME;
  if (!ProcessIdToSessionId(GetCurrentProcessId(),&ready.session)) error=GetLastError();
  if (error) goto end;
  ready.cleanup=lf_cleanup_mask; ready.magic=0x4c524631; ready.version=1; ready.bytes=sizeof(ready); ready.phase=1; ready.role=role; ready.result=(DWORD)result;
  ready.helper=rt_frame.helper; ready.root=rt_frame.root; ready.helper_created=rt_frame.helper_created; ready.root_created=rt_frame.created;
  ready.ready=ready.at=ownership_wall_ms(); ready.root_deadline=rt_frame.deadline;
  ready.deadline=ready.ready+3000 < ready.root_deadline ? ready.ready+3000 : ready.root_deadline;
  if (!rt_in_time() || ready.deadline <= ready.ready) {error=ERROR_TIMEOUT; goto end;}
  ULONGLONG tick_deadline=GetTickCount64()+(ready.deadline-ready.ready);
  error=lf_file(directory,label,L"ready",&ready,TRUE); if (error) goto end;
  fwprintf(stderr,L"live-fence phase=ready label=%ls nonce=%ls helper=%lu helper-created=%llu root=%lu created=%llu result=%lu ready=%llu deadline=%llu root-deadline=%llu\n",
    label,ready.nonce,ready.helper,ready.helper_created,ready.root,ready.root_created,ready.result,ready.ready,ready.deadline,ready.root_deadline); fflush(stderr);
  for (;;) {
    if (ownership_wall_ms() >= ready.deadline || GetTickCount64() >= tick_deadline || !rt_in_time()) {error=ERROR_TIMEOUT; break;}
    LF_FRAME release; ZeroMemory(&release,sizeof(release));
    error=lf_file(directory,label,L"release",&release,FALSE);
    if (error==ERROR_FILE_NOT_FOUND || error==ERROR_SHARING_VIOLATION) {Sleep(5); continue;}
    if (error) break;
    LF_FRAME identity=release; identity.phase=1; identity.at=ready.at;
    if (release.phase!=2 || release.at<ready.ready || release.at>=ready.deadline || memcmp(&identity,&ready,sizeof(ready))) {error=ERROR_INVALID_DATA; break;}
    if (ownership_wall_ms()>=ready.deadline || GetTickCount64()>=tick_deadline || lf_acquired!=lf_closed) {error=ERROR_TIMEOUT; break;}
    LF_FRAME returned=ready; returned.phase=3; returned.at=ownership_wall_ms(); returned.acquired=lf_acquired; returned.closed=lf_closed;
    error=lf_file(directory,label,L"return",&returned,TRUE);
    if (!error && (ownership_wall_ms()>=ready.deadline || GetTickCount64()>=tick_deadline || lf_acquired!=lf_closed)) error=ERROR_TIMEOUT;
    if (!error) {fwprintf(stderr,L"live-fence phase=return label=%ls nonce=%ls helper=%lu helper-created=%llu root=%lu created=%llu result=%lu now=%llu acquired=%lu closed=%lu error=0\n",
      label,ready.nonce,ready.helper,ready.helper_created,ready.root,ready.root_created,ready.result,returned.at,lf_acquired,lf_closed); fflush(stderr);}
    break;
  }
end:
  if (error) {fwprintf(stderr,L"live-fence phase=failed label=%ls result=%d acquired=%lu closed=%lu error=%lu\n",label,result,lf_acquired,lf_closed,error); fflush(stderr);}
  /* Preserve the complete body's original failure result on every fence path. */
  return error;
}
