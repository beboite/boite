/* Only the new arm closes the existing control pipe and hands its already
 * verified creator to private files. No process/job/stdio anchor survives. */
static ULONGLONG hj_wall(void) {
  FILETIME time; ULARGE_INTEGER value; GetSystemTimeAsFileTime(&time);
  value.LowPart = time.dwLowDateTime; value.HighPart = time.dwHighDateTime;
  return value.QuadPart / 10000 - 11644473600000ULL;
}
static DWORD hj_path(const wchar_t *suffix, wchar_t path[4200]) {
  wchar_t prefix[4096]; DWORD n = GetEnvironmentVariableW(L"BOITE_TARGET_CREATOR_BARRIER", prefix, 4096);
  if (!n || n >= 4096 || swprintf(path, 4200, L"%ls.hold.%ls", prefix, suffix) < 0) return ERROR_INVALID_PARAMETER;
  return 0;
}
static DWORD hj_file(const wchar_t *suffix, char *text, DWORD bytes, BOOL write) {
  wchar_t path[4200]; DWORD error = hj_path(suffix, path); if (error) return error;
  HANDLE file = CreateFileW(path, write ? GENERIC_WRITE : GENERIC_READ, 0, NULL,
    write ? CREATE_NEW : OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (file == INVALID_HANDLE_VALUE) return GetLastError();
  BY_HANDLE_FILE_INFORMATION info; char observed[1024]; DWORD used = 0;
  if (!GetFileInformationByHandle(file, &info) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) error = ERROR_INVALID_DATA;
  if (!error && write && (!WriteFile(file, text, bytes, &used, NULL) || used != bytes)) error = ERROR_WRITE_FAULT;
  if (!error && !write && (!ReadFile(file, observed, sizeof(observed), &used, NULL) || used != bytes || memcmp(text, observed, bytes)))
    error = ERROR_INVALID_DATA;
  DWORD closed = tc_close(&file); return error ? error : closed;
}
static DWORD hj_text(const TC_FRAME *f, ULONGLONG helper_created, char text[1024], DWORD *bytes) {
  char nonce[33]; for (int i = 0; i < 16; i++) snprintf(nonce + i * 2, 3, "%02x", f->nonce[i]);
  int n = snprintf(text, 1024, "{\"version\":1,\"phase\":\"hold\",\"nonce\":\"%s\","
    "\"helper\":{\"pid\":%lu,\"created\":\"%llu\"},\"creator\":{\"pid\":%lu,\"created\":\"%llu\"},"
    "\"root\":{\"pid\":%lu,\"created\":\"%llu\"},\"deadlineWallMs\":%llu,\"closed\":7,\"ioAcquired\":%lu,\"ioClosed\":%lu}\n",
    nonce, f->helper, (unsigned long long)helper_created, f->creator, (unsigned long long)f->creator_created,
    f->pid, (unsigned long long)f->process_created, (unsigned long long)f->thread, f->io_acquired, f->io_closed);
  if (n <= 0 || n >= 1024) return ERROR_INSUFFICIENT_BUFFER;
  *bytes = (DWORD)n; return 0;
}
static DWORD hj_child(HANDLE *pipe, TC_FRAME *message, const TC_FRAME *expected,
    ULONGLONG helper_created, ULONGLONG lifetime) {
  ULONGLONG now = GetTickCount64(), wall = hj_wall();
  if (message->pid != expected->pid || message->process_created != expected->process_created ||
      !helper_created || message->process <= now || message->process > now + 3000 ||
      message->thread <= wall || message->thread > wall + 3000 || message->process > lifetime) return ERROR_INVALID_DATA;
  ULONGLONG deadline = message->process;
  message->phase = TC_HELD; message->closed = 7;
  message->io_acquired = tc_io_acquired + 1; message->io_closed = tc_io_closed + 1;
  DWORD error = tc_exchange(*pipe, NULL, message, sizeof(*message), TRUE, deadline);
  if (!error) error = tc_close(pipe);
  if (!error && (tc_pending || tc_close_failed || tc_io_acquired != tc_io_closed)) error = ERROR_IO_INCOMPLETE;
  char text[1024]; DWORD bytes = 0;
  if (!error) error = hj_text(message, helper_created, text, &bytes);
  if (!error) error = hj_file(L"ready", text, bytes, TRUE);
  while (!error && creator_remaining(deadline)) {
    DWORD read = hj_file(L"release", text, bytes, FALSE);
    if (!read) return hj_file(L"done", text, bytes, TRUE);
    if (read != ERROR_FILE_NOT_FOUND && read != ERROR_SHARING_VIOLATION) return read;
    Sleep(5);
  }
  return error ? error : ERROR_TIMEOUT;
}
static DWORD hj_parent(void) {
  if (!tc_process || !tc_released || !retired_created || tc_pending || tc_close_failed) return ERROR_INVALID_DATA;
  TC_FRAME message = tc_identity; message.bytes = sizeof(message); message.phase = TC_HOLD;
  message.process = GetTickCount64() + 3000; message.thread = hj_wall() + 3000;
  if (message.process > tc_deadline) return ERROR_TIMEOUT;
  ULONGLONG deadline = message.process, wall_deadline = message.thread, helper_created = 0;
  DWORD error = tc_times(GetCurrentProcess(), &helper_created);
  if (!error) error = tc_exchange(tc_pipe, tc_process, &message, sizeof(message), TRUE, deadline);
  if (!error) error = tc_exchange(tc_pipe, tc_process, &message, sizeof(message), FALSE, deadline);
  if (!error && (!tc_frame(&message, &tc_identity, TC_HELD, sizeof(message)) || message.closed != 7 ||
      message.pid != tc_identity.pid || message.process_created != tc_identity.process_created ||
      message.process != deadline || message.thread != wall_deadline || !message.io_acquired || message.io_acquired != message.io_closed)) error = ERROR_INVALID_DATA;
  char text[1024]; DWORD bytes = 0;
  if (!error) error = hj_text(&message, helper_created, text, &bytes);
  while (!error && creator_remaining(deadline)) {
    DWORD read = hj_file(L"ready", text, bytes, FALSE);
    if (!read) break;
    if (read != ERROR_FILE_NOT_FOUND && read != ERROR_SHARING_VIOLATION) {error = read; break;}
    Sleep(5);
  }
  if (!error && (!creator_remaining(deadline) || WaitForSingleObject(tc_process, 0) != WAIT_TIMEOUT)) error = ERROR_TIMEOUT;
  if (!error) error = tc_close(&tc_pipe);
  if (!error) error = tc_close(&tc_thread);
  if (!error) error = tc_close(&tc_process);
  if (!error && (tc_pending || tc_io_acquired != tc_io_closed || creator_pending || creator_io_acquired != creator_io_closed)) error = ERROR_IO_INCOMPLETE;
  fwprintf(stderr, L"helper-job-parked creator=%lu pipe=0 process=0 thread=0 child-closed=7 io-acquired=%u io-closed=%u error=%lu\n",
    tc_identity.creator, tc_io_acquired, tc_io_closed, error); fflush(stderr);
  return error;
}
