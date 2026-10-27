#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

/* Query-result replay only. This does not emulate kernel access mapping. */
typedef uint32_t DWORD, ULONG;
typedef int32_t NTSTATUS;
typedef int BOOL, OBJECT_INFORMATION_CLASS;
typedef void *HANDLE;
typedef NTSTATUS (*query_object_fn)(HANDLE, OBJECT_INFORMATION_CLASS, void *, ULONG, ULONG *);
#define FALSE 0
#define TRUE 1
#define ERROR_INVALID_DATA 13
#define PROCESS_SET_INFORMATION UINT32_C(0x200)
#define PROCESS_QUERY_LIMITED_INFORMATION UINT32_C(0x1000)
#define PROCESS_SET_LIMITED_INFORMATION UINT32_C(0x2000)
#define SYNCHRONIZE UINT32_C(0x100000)
#define ZeroMemory(buffer, size) memset(buffer, 0, size)
typedef struct {ULONG attributes, granted, handles, pointers, reserved[10];} BASIC;
_Static_assert(sizeof(BASIC) == 56, "Windows object basic information size");
static BASIC observed;
static ULONG returned;
static DWORD observed_flags, type_error;
static NTSTATUS query_status;
static BOOL flags_ok;
static unsigned int query_calls, flags_calls, type_calls, cases;
static NTSTATUS query(HANDLE handle, OBJECT_INFORMATION_CLASS kind, void *buffer, ULONG size, ULONG *used) {
  (void)handle;
  query_calls++;
  if (kind || size != sizeof(observed)) return (NTSTATUS)0xc0000004;
  memcpy(buffer, &observed, sizeof(observed)); *used = returned; return query_status;
}
static void *nt_api(const char *name) {(void)name; return (void *)query;}
static BOOL GetHandleInformation(HANDLE handle, DWORD *flags) {
  (void)handle; flags_calls++; *flags = observed_flags; return flags_ok;
}
static DWORD GetLastError(void) {return 5;}
static DWORD twin_string(HANDLE handle, OBJECT_INFORMATION_CLASS kind, const wchar_t *type) {
  (void)handle; (void)type; type_calls++; return kind == 2 ? type_error : ERROR_INVALID_DATA;
}
/* Windows uses a different printf ABI; real format checking belongs to MinGW/SDK. */
static int ignore_log(FILE *stream, const wchar_t *format, ...) {(void)stream; (void)format; return 0;}
#define fwprintf ignore_log
#include "anchor-access-function.h"

static void fixture(DWORD granted, DWORD flags) {
  memset(&observed, 0, sizeof(observed)); observed.granted = granted;
  returned = sizeof(observed); observed_flags = flags; flags_ok = TRUE;
  query_status = 0; type_error = 0; query_calls = flags_calls = type_calls = 0;
}
#define CHECK(name, expression) do {cases++; if (!(expression)) { \
  fprintf(stderr, "anchor access case failed: %s\n", name); return 1; } } while (0)
int main(void) {
  const DWORD requested = UINT32_C(0x00101200), granted = UINT32_C(0x00103200);
  for (DWORD flags = 0; flags <= 1; flags++) {
    fixture(granted, flags);
    CHECK("measured process grant survives inherited and cleared flags", ao_access(NULL, requested, flags, L"Process") == 0);
    CHECK("successful guard still checks query, flags and type", query_calls == 1 && flags_calls == 1 && type_calls == 1);
    fixture(3, flags);
    CHECK("directory grant stays exact", ao_access(NULL, 3, flags, L"Directory") == 0);
  }
  for (unsigned int bit = 0; bit < 32; bit++) {
    DWORD right = UINT32_C(1) << bit;
    fixture(granted ^ right, 1);
    CHECK("every missing or additional process right refuses", ao_access(NULL, requested, 1, L"Process") == ERROR_INVALID_DATA);
    fixture(3 ^ right, 1);
    CHECK("every missing or additional directory right refuses", ao_access(NULL, 3, 1, L"Directory") == ERROR_INVALID_DATA);
  }
  fixture(granted, 1);
  CHECK("process normalization cannot apply to a directory", ao_access(NULL, requested, 1, L"Directory") == ERROR_INVALID_DATA);
  fixture(granted, 1);
  CHECK("different process request cannot gain an implied right", ao_access(NULL, requested & ~PROCESS_SET_INFORMATION, 1, L"Process") == ERROR_INVALID_DATA);
  fixture(granted, 0);
  CHECK("missing inheritance refuses", ao_access(NULL, requested, 1, L"Process") == ERROR_INVALID_DATA);
  fixture(granted, 3);
  CHECK("unexpected handle flag refuses", ao_access(NULL, requested, 1, L"Process") == ERROR_INVALID_DATA);
  fixture(granted, 1); query_status = (NTSTATUS)0xc0000022;
  CHECK("query failure preserves status and short circuits", ao_access(NULL, requested, 1, L"Process") == (DWORD)query_status && !flags_calls && !type_calls);
  fixture(granted, 1); returned--;
  CHECK("query size mismatch short circuits", ao_access(NULL, requested, 1, L"Process") == ERROR_INVALID_DATA && !flags_calls && !type_calls);
  fixture(granted, 1); flags_ok = FALSE;
  CHECK("failed flag query short circuits", ao_access(NULL, requested, 1, L"Process") == ERROR_INVALID_DATA && flags_calls == 1 && !type_calls);
  fixture(granted, 1); type_error = 6;
  CHECK("type failure preserves its status", ao_access(NULL, requested, 1, L"Process") == 6 && type_calls == 1);
  printf("ANCHOR_ACCESS_CASES_PASS: %u cases\n", cases); return 0;
}
