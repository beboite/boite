/* Diagnostic normal DEBUG cleanup. Existing selectors never enter this path. */
static DWORD debug_pipe_mode;
static DWORD debug_pipe_cleanup(DWORD root) {
  if (!debug_pipe_mode) return 0;
  if (debug_pipe_mode > 2 || !root || !debug_mode || assignment_scope || retire_owned_map ||
      retirement_timing_mode || directory_twin_mode || lf_cleanup_mask != 0x1ff ||
      captured != 6 || active || target_captured != 3 || auxiliary_captured != 3 ||
      records[0].pid != root || !root_exited) return ERROR_INVALID_DATA;
  for (int i = 0; i < captured; i++) if (!records[i].exited) return ERROR_INVALID_DATA;
  SF_FRAME f; ZeroMemory(&f, sizeof(f)); f.base.role = debug_pipe_mode;
  ULONGLONG begin = ownership_wall_ms(); wchar_t marker[256];
  int n = swprintf(marker, 256, L"debug-pipe barrier helper=%lu root=%lu role=%lu at=%llu\n",
    GetCurrentProcessId(), root, debug_pipe_mode, begin);
  if (n < 0 || n >= 256) return ERROR_INSUFFICIENT_BUFFER;
  DWORD error = sf_streams(&f, marker, 4);
  for (int i = 0; i < 3; i++) {
    SF_STREAM *s = &f.streams[i];
    fwprintf(stderr, L"debug-pipe stream=%d original=%llu crt=%llu fd=%lu type=%lu flush-attempted=%lu flush-result=%ld close-attempted=%lu close-result=%ld invalid=%lu invalid-error=%lu close-at=%llu\n",
      i, s->original, s->crt, s->fd, s->type, s->flush_attempted, s->flush_result,
      s->close_attempted, s->close_result, s->invalid, s->invalid_error, s->close_at);
  }
  fwprintf(stderr, L"debug-pipe result helper=%lu root=%lu role=%lu mask=%lu begin=%llu at=%llu error=%lu\n",
    GetCurrentProcessId(), root, debug_pipe_mode, lf_cleanup_mask, begin, ownership_wall_ms(), error);
  fflush(stderr); return error;
}
