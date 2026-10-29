/* Disposable semantic probe, not a production NUL replacement. Ordinary
 * private handles only: no LPAC, device map, ACL change or foreign process. */
#define _WIN32_WINNT 0x0A00
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>

enum { EOF_READS = 32, WRITE_BLOCKS = 32, BLOCK_BYTES = 65536 };
typedef struct {
  HANDLE server, client, first_written, first_flushed, drain_complete;
  volatile LONG64 received;
  volatile LONG stopping;
  DWORD eof_count, write_count, flush_count, drain_error, eof_error, writer_error;
} PROBE;
typedef struct { OVERLAPPED operation; BYTE bytes[BLOCK_BYTES]; } PENDING_IO;
static volatile LONG io_acquired, io_closed;
static volatile LONG immediate_more_data;
static volatile LONG64 immediate_partial_bytes;

static DWORD WINAPI watchdog(void *unused) {
  (void)unused;
  Sleep(15000);
  fputs("NULL_MESSAGE_PROBE timeout=1 semanticAccepted=0\n", stderr);
  fflush(stderr);
  ExitProcess(124);
}

static DWORD bounded_io(HANDLE pipe, void *buffer, DWORD length, BOOL write, DWORD *used) {
  if (length > BLOCK_BYTES || !used) return ERROR_INVALID_PARAMETER;
  PENDING_IO *io = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*io));
  if (!io) return ERROR_NOT_ENOUGH_MEMORY;
  io->operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!io->operation.hEvent) {DWORD error = GetLastError(); HeapFree(GetProcessHeap(), 0, io); return error;}
  InterlockedIncrement(&io_acquired);
  if (write && length) memcpy(io->bytes, buffer, length);
  *used = 0;
  /* Both handles are overlapped. The synchronous byte-count parameter can be
   * zero even when a message-mode read completed with ERROR_MORE_DATA. */
  BOOL ok = write ? WriteFile(pipe, io->bytes, length, NULL, &io->operation)
    : ReadFile(pipe, io->bytes, length, NULL, &io->operation);
  DWORD error = ok ? 0 : GetLastError();
  BOOL immediate_partial = !write && error == ERROR_MORE_DATA;
  BOOL pending = !ok && error == ERROR_IO_PENDING;
  if (ok || error == ERROR_MORE_DATA) {
    ok = GetOverlappedResult(pipe, &io->operation, used, FALSE);
    error = ok ? 0 : GetLastError(); pending = !ok && error == ERROR_IO_INCOMPLETE;
  }
  if (pending) {
    DWORD waited = WaitForSingleObject(io->operation.hEvent, 1000);
    if (waited == WAIT_OBJECT_0) {
      ok = GetOverlappedResult(pipe, &io->operation, used, FALSE);
      error = ok ? 0 : GetLastError(); pending = !ok && error == ERROR_IO_INCOMPLETE;
    } else error = waited == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError();
  }
  if (pending) {
    CancelIoEx(pipe, &io->operation);
    DWORD waited = WaitForSingleObject(io->operation.hEvent, 1000), drained = 0;
    ok = waited == WAIT_OBJECT_0 && GetOverlappedResult(pipe, &io->operation, &drained, FALSE);
    DWORD drained_error = ok ? 0 : GetLastError();
    if (waited != WAIT_OBJECT_0 || (!ok && drained_error == ERROR_IO_INCOMPLETE)) {
      /* Keep event/buffer alive until termination if completion is undecidable. */
      fputs("NULL_MESSAGE_PROBE io-retained=1 semanticAccepted=0\n", stderr);
      fflush(stderr); ExitProcess(123);
    }
    /* Completion may win the cancellation race. Preserve consumed bytes;
     * returning only TIMEOUT here would silently lose them in the discard loop. */
    if (ok || drained_error == ERROR_MORE_DATA) {error = drained_error; *used = drained;}
    else if (drained_error != ERROR_OPERATION_ABORTED) error = drained_error;
  }
  if (*used > length) error = ERROR_INVALID_DATA;
  if (immediate_partial && error == ERROR_MORE_DATA) {
    InterlockedIncrement(&immediate_more_data);
    InterlockedAdd64(&immediate_partial_bytes, *used);
  }
  if ((!error || error == ERROR_MORE_DATA) && !write && *used) memcpy(buffer, io->bytes, *used);
  if (CloseHandle(io->operation.hEvent)) InterlockedIncrement(&io_closed);
  else if (!error) error = GetLastError();
  HeapFree(GetProcessHeap(), 0, io);
  return error;
}

static DWORD WINAPI eof_server(void *argument) {
  PROBE *probe = argument;
  for (DWORD i = 0; i < EOF_READS; i++) {
    if (InterlockedCompareExchange(&probe->stopping, 0, 0)) break;
    DWORD used = MAXDWORD;
    probe->eof_error = bounded_io(probe->server, NULL, 0, TRUE, &used);
    if (probe->eof_error) break;
    if (used) {probe->eof_error = ERROR_INVALID_DATA; break;}
    probe->eof_count++;
    if (!i && !SetEvent(probe->first_written)) {probe->eof_error = GetLastError(); break;}
    if (!FlushFileBuffers(probe->server)) {probe->eof_error = GetLastError(); break;}
    probe->flush_count++;
    if (!i && !SetEvent(probe->first_flushed)) {probe->eof_error = GetLastError(); break;}
  }
  return probe->eof_error;
}

static DWORD WINAPI discard_server(void *argument) {
  PROBE *probe = argument;
  BYTE bytes[16384];
  while (!InterlockedCompareExchange(&probe->stopping, 0, 0)) {
    DWORD used = 0;
    DWORD error = bounded_io(probe->server, bytes, sizeof(bytes), FALSE, &used);
    if (used && InterlockedAdd64(&probe->received, used) == (LONG64)WRITE_BLOCKS * BLOCK_BYTES)
      if (!SetEvent(probe->drain_complete)) {probe->drain_error = GetLastError(); return probe->drain_error;}
    if (!error || error == ERROR_MORE_DATA || error == ERROR_TIMEOUT) continue;
    if (error != ERROR_BROKEN_PIPE && error != ERROR_PIPE_NOT_CONNECTED && error != ERROR_OPERATION_ABORTED)
      probe->drain_error = error;
    return probe->drain_error;
  }
  return probe->drain_error;
}

static DWORD WINAPI native_writer(void *argument) {
  PROBE *probe = argument;
  BYTE bytes[BLOCK_BYTES]; memset(bytes, 0x67, sizeof(bytes));
  for (DWORD i = 0; i < WRITE_BLOCKS; i++) {
    if (InterlockedCompareExchange(&probe->stopping, 0, 0)) break;
    DWORD used = 0;
    DWORD error = bounded_io(probe->client, bytes, sizeof(bytes), TRUE, &used);
    if (error || used != sizeof(bytes)) {probe->writer_error = error ? error : ERROR_INVALID_DATA; break;}
    probe->write_count++;
  }
  return probe->writer_error;
}

int main(void) {
  HANDLE timer = CreateThread(NULL, 0, watchdog, NULL, 0, NULL);
  if (!timer) return 1;
  PROBE probe; ZeroMemory(&probe, sizeof(probe));
  HANDLE eof_thread = NULL, drain_thread = NULL, writer_thread = NULL;
  DWORD error = 0, reads = 0, joined = 0, closed = 0;
  BOOL connected = FALSE, flush_pending = FALSE, partial = FALSE;
  const char *stage = "pipe-create";
  wchar_t name[160];
  swprintf(name, 160, L"\\\\.\\pipe\\boite.null-message.%lu.%llu", GetCurrentProcessId(), (unsigned long long)GetTickCount64());
  probe.server = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
    PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT, 1, 0, 4096, 0, NULL);
  if (probe.server == INVALID_HANDLE_VALUE) {probe.server = NULL; error = GetLastError(); goto done;}
  stage = "pipe-open";
  probe.client = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
  if (probe.client == INVALID_HANDLE_VALUE) {probe.client = NULL; error = GetLastError(); goto done;}
  OVERLAPPED connection; ZeroMemory(&connection, sizeof(connection));
  connected = ConnectNamedPipe(probe.server, &connection);
  if (!connected && GetLastError() != ERROR_PIPE_CONNECTED) {error = GetLastError(); goto done;}
  connected = TRUE;
  /* Keep the client's default byte-read mode, as an unmodified CreateFile user. */
  stage = "pipe-mode";
  DWORD mode = MAXDWORD;
  if (!GetNamedPipeHandleStateW(probe.client, &mode, NULL, NULL, NULL, NULL, 0) || (mode & PIPE_READMODE_MESSAGE)) {
    error = ERROR_INVALID_DATA; goto done;
  }
  /* Queue a small whole message before any server reader exists. The first
   * seven-byte read must report MORE_DATA and preserve its bytes; the next
   * read must return the exact remaining 25 bytes. This cannot pass by only
   * counting the final fragment of each later 64-KiB write. */
  BYTE message[32], fragment[32]; DWORD used = 0;
  memset(message, 0x57, sizeof(message)); ZeroMemory(fragment, sizeof(fragment));
  stage = "partial-write";
  error = bounded_io(probe.client, message, sizeof(message), TRUE, &used);
  if (error || used != sizeof(message)) {if (!error) error = ERROR_INVALID_DATA; goto done;}
  stage = "partial-head";
  DWORD read_error = bounded_io(probe.server, fragment, 7, FALSE, &used);
  if (read_error != ERROR_MORE_DATA || used != 7 || memcmp(fragment, message, 7) || !immediate_more_data) {
    error = read_error ? read_error : ERROR_INVALID_DATA; goto done;
  }
  stage = "partial-tail";
  error = bounded_io(probe.server, fragment, sizeof(fragment), FALSE, &used);
  if (error || used != 25 || memcmp(fragment, message + 7, 25)) {if (!error) error = ERROR_INVALID_DATA; goto done;}
  partial = TRUE;
  stage = "workers-start";
  probe.first_written = CreateEventW(NULL, TRUE, FALSE, NULL);
  probe.first_flushed = CreateEventW(NULL, TRUE, FALSE, NULL);
  probe.drain_complete = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!probe.first_written || !probe.first_flushed || !probe.drain_complete) {error = GetLastError(); goto done;}
  eof_thread = CreateThread(NULL, 0, eof_server, &probe, 0, NULL);
  drain_thread = CreateThread(NULL, 0, discard_server, &probe, 0, NULL);
  if (!eof_thread || !drain_thread) {error = GetLastError(); goto done;}
  stage = "first-write-wait";
  if (WaitForSingleObject(probe.first_written, 1000) != WAIT_OBJECT_0) {error = ERROR_TIMEOUT; goto done;}
  stage = "pre-read-flush";
  flush_pending = WaitForSingleObject(probe.first_flushed, 50) == WAIT_TIMEOUT;
  if (!flush_pending) {error = ERROR_INVALID_DATA; goto done;}
  writer_thread = CreateThread(NULL, 0, native_writer, &probe, 0, NULL);
  if (!writer_thread) {error = GetLastError(); goto done;}
  stage = "eof-reads";
  for (DWORD i = 0; i < EOF_READS; i++) {
    BYTE bytes[7]; memset(bytes, 0x3c, sizeof(bytes)); DWORD used = MAXDWORD;
    error = bounded_io(probe.client, bytes, sizeof(bytes), FALSE, &used);
    if (error || used || bytes[0] != 0x3c) {if (!error) error = ERROR_INVALID_DATA; goto done;}
    reads++;
  }
  stage = "worker-join";
  if (WaitForSingleObject(eof_thread, 2000) != WAIT_OBJECT_0 ||
      WaitForSingleObject(writer_thread, 2000) != WAIT_OBJECT_0) {error = ERROR_TIMEOUT; goto done;}
  if (probe.eof_error || probe.writer_error) {error = probe.eof_error ? probe.eof_error : probe.writer_error; goto done;}
  stage = "client-flush";
  if (!FlushFileBuffers(probe.client)) {error = GetLastError(); goto done;}
  stage = "drain-wait";
  if (WaitForSingleObject(probe.drain_complete, 1000) != WAIT_OBJECT_0) {error = ERROR_TIMEOUT; goto done;}
  stage = "discard-count";
  if (probe.received != (LONG64)WRITE_BLOCKS * BLOCK_BYTES) {error = ERROR_INVALID_DATA; goto done;}
  stage = "complete";
done:
  /* Keep every pipe value and shared buffer live until its worker has joined.
   * Never close/reuse a handle while another worker can start an operation. */
  InterlockedExchange(&probe.stopping, 1);
  if (probe.client) CancelIoEx(probe.client, NULL);
  if (probe.server) CancelIoEx(probe.server, NULL);
  HANDLE threads[] = {eof_thread, drain_thread, writer_thread};
  for (DWORD i = 0; i < 3; i++) if (threads[i]) {
    CancelSynchronousIo(threads[i]);
    if (WaitForSingleObject(threads[i], 3000) == WAIT_OBJECT_0) joined++;
    else if (!error) error = ERROR_TIMEOUT;
  }
  /* On failed joining, no stack lifetime is allowed to end underneath a worker. */
  if (joined != (DWORD)((eof_thread != NULL) + (drain_thread != NULL) + (writer_thread != NULL))) {
    fprintf(stderr, "NULL_MESSAGE_PROBE joined=%lu error=%lu semanticAccepted=0\n", joined, error);
    fflush(stderr); ExitProcess(1);
  }
  if (connected && !DisconnectNamedPipe(probe.server) && !error) error = GetLastError();
  HANDLE owned[] = {probe.server, probe.client, probe.first_written, probe.first_flushed, probe.drain_complete,
    eof_thread, drain_thread, writer_thread, timer};
  for (DWORD i = 0; i < 9; i++) if (owned[i]) {
    if (CloseHandle(owned[i])) closed++; else if (!error) error = GetLastError();
  }
  if (probe.drain_error && !error) {error = probe.drain_error; stage = "drain-io";}
  if (!error && (reads != EOF_READS || probe.eof_count != EOF_READS || probe.flush_count != EOF_READS ||
      probe.write_count != WRITE_BLOCKS || !partial || joined != 3 || closed != 9 || !io_acquired || io_acquired != io_closed)) error = ERROR_INVALID_DATA;
  printf("NULL_MESSAGE_PROBE reads=%lu eof-writes=%lu flushes=%lu write-blocks=%lu received=%lld pre-read-flush-pending=%d partial=%d immediate-more-data=%ld immediate-partial-bytes=%lld joined=%lu closed=%lu io-acquired=%ld io-closed=%ld retained=0 stage=%s error=%lu semanticAccepted=%d productionAccepted=0\n",
    reads, probe.eof_count, probe.flush_count, probe.write_count, (long long)probe.received,
    flush_pending, partial, immediate_more_data, (long long)immediate_partial_bytes,
    joined, closed, io_acquired, io_closed, stage, error, error == 0);
  fflush(stdout);
  ExitProcess(error ? 1 : 0);
}
