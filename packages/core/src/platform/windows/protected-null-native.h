/* Supported x64 native ABI; the device path below is always host-owned. */
#include <winternl.h>
#include <tlhelp32.h>
#include <stdint.h>
#include <stddef.h>
#include <wincrypt.h>
#include "protected-null-contracts.h"
#include "protected-null-startup.h"
_Static_assert(sizeof(void *) == 8, "native x64 required");
_Static_assert(sizeof(OBJECT_ATTRIBUTES) == 48 && offsetof(OBJECT_ATTRIBUTES, ObjectName) == 16, "OBJECT_ATTRIBUTES ABI");
_Static_assert(sizeof(UNICODE_STRING) == 16 && offsetof(UNICODE_STRING, Buffer) == 8, "UNICODE_STRING ABI");
_Static_assert(sizeof(IO_STATUS_BLOCK) == 16 && offsetof(IO_STATUS_BLOCK, Information) == 8, "IOSB ABI");
_Static_assert(sizeof(SECURITY_QUALITY_OF_SERVICE) == sizeof(NB_QOS) && sizeof(NB_QOS) == 12 &&
  offsetof(SECURITY_QUALITY_OF_SERVICE, ImpersonationLevel) == offsetof(NB_QOS, level) &&
  offsetof(SECURITY_QUALITY_OF_SERVICE, ContextTrackingMode) == offsetof(NB_QOS, tracking) &&
  offsetof(SECURITY_QUALITY_OF_SERVICE, EffectiveOnly) == offsetof(NB_QOS, effective), "SQOS ABI");
typedef NTSTATUS (NTAPI *NB_CREATE)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK,
  PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
typedef NTSTATUS (NTAPI *NB_OPEN)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, ULONG, ULONG);
typedef NTSTATUS (NTAPI *NB_QUERY_FILE)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, ULONG);
typedef NTSTATUS (NTAPI *NB_QUERY_OBJECT)(HANDLE, ULONG, PVOID, ULONG, PULONG);
typedef NTSTATUS (NTAPI *NB_QUERY_VOLUME)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, ULONG);
typedef NTSTATUS (NTAPI *NB_COMPARE)(HANDLE, HANDLE);
typedef struct {ULONG Attributes; ACCESS_MASK GrantedAccess; ULONG HandleCount, PointerCount; ULONG Reserved[10];} NB_BASIC;
typedef struct {ULONG Type, Characteristics;} NB_DEVICE;
typedef struct {UNICODE_STRING Name; USHORT Type, Reserved; ULONG Flags, Count; union {ULONGLONG *Integer;} Values;} NB_ATTR;
typedef struct {USHORT Version, Reserved; ULONG Count; NB_ATTR *Attrs;} NB_ATTRS;
#define NB_DENIED ((NTSTATUS)0xc0000022)
#define NB_BAD_POINTER ((NTSTATUS)0xc0000005)
#define NB_INVALID ((NTSTATUS)0xc000000d)
#define NB_UNSUPPORTED ((NTSTATUS)0xc00000bb)
#define NB_NTDLL_SHA "160ef9b82e2895ef48fa031cb1cf683a8b123febf7cf7d5590cd3104864424b3"
static NB_CREATE nb_create;
static NB_OPEN nb_open;
static NB_QUERY_FILE nb_query_file;
static NB_QUERY_OBJECT nb_query_object;
static NB_QUERY_VOLUME nb_query_volume;
static NB_COMPARE nb_compare;
static int nb_resolve(void) {
  HMODULE n = GetModuleHandleW(L"ntdll.dll");
  nb_create = (NB_CREATE)(void *)GetProcAddress(n, "NtCreateFile");
  nb_open = (NB_OPEN)(void *)GetProcAddress(n, "NtOpenFile");
  nb_query_file = (NB_QUERY_FILE)(void *)GetProcAddress(n, "NtQueryInformationFile");
  nb_query_object = (NB_QUERY_OBJECT)(void *)GetProcAddress(n, "NtQueryObject");
  nb_query_volume = (NB_QUERY_VOLUME)(void *)GetProcAddress(n, "NtQueryVolumeInformationFile");
  nb_compare = (NB_COMPARE)(void *)GetProcAddress(n, "NtCompareObjects");
  return nb_create && nb_open && nb_query_file && nb_query_object && nb_query_volume && nb_compare;
}
static NTSTATUS nb_host_open(HANDLE *h, IO_STATUS_BLOCK *io, ACCESS_MASK access, ULONG share, ULONG disposition, ULONG options, ULONG attributes, ULONG file_attributes, int open_api, SECURITY_QUALITY_OF_SERVICE *qos) {
  wchar_t text[] = L"\\Device\\Null";
  UNICODE_STRING name = {(USHORT)(sizeof(text) - 2), sizeof(text), text};
  OBJECT_ATTRIBUTES oa; ZeroMemory(&oa, sizeof(oa)); oa.Length = sizeof(oa); oa.ObjectName = &name; oa.Attributes = attributes & 0x40;
  oa.SecurityQualityOfService = qos;
  return open_api ? nb_open(h, access, &oa, io, share, options) : nb_create(h, access, &oa, io, NULL, file_attributes, share, disposition, options, NULL, 0);
}
static int nb_file_sha(HANDLE file, char text[65]) {
  HCRYPTPROV provider = 0; HCRYPTHASH hash = 0; BYTE buffer[16384], digest[32]; DWORD size = 32, used = 0;
  LARGE_INTEGER start, zero; zero.QuadPart = 0; int ok = 0, positioned = 0;
  if (!SetFilePointerEx(file, zero, &start, FILE_CURRENT) || !SetFilePointerEx(file, zero, NULL, FILE_BEGIN)) goto done;
  positioned = 1;
  if (!CryptAcquireContextW(&provider, NULL, NULL, PROV_RSA_AES, CRYPT_VERIFYCONTEXT) || !CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash)) goto done;
  do {if (!ReadFile(file, buffer, sizeof(buffer), &used, NULL) || (used && !CryptHashData(hash, buffer, used, 0))) goto done;} while (used);
  if (!CryptGetHashParam(hash, HP_HASHVAL, digest, &size, 0) || size != 32) goto done;
  const char digits[] = "0123456789abcdef";
  for (unsigned i = 0; i < 32; ++i) {text[2 * i] = digits[digest[i] >> 4]; text[2 * i + 1] = digits[digest[i] & 15];}
  text[64] = 0; ok = 1;
done:
  if (hash) CryptDestroyHash(hash);
  if (provider) CryptReleaseContext(provider, 0);
  if (positioned && !SetFilePointerEx(file, start, NULL, FILE_BEGIN)) ok = 0;
  return ok;
}
static int nb_measure(HANDLE h, NB_BASIC *basic, ULONG *mode, NB_DEVICE *device) {
  IO_STATUS_BLOCK io; ULONG bytes = 0;
  ZeroMemory(basic, sizeof(*basic)); ZeroMemory(device, sizeof(*device)); *mode = 0;
  return GetFileType(h) == FILE_TYPE_CHAR &&
    nb_query_object(h, 0, basic, sizeof(*basic), &bytes) == 0 &&
    nb_query_file(h, &io, mode, sizeof(*mode), 16) == 0 &&
    nb_query_volume(h, &io, device, sizeof(*device), 4) == 0 && io.Information == sizeof(*device) && device->Type == 0x15;
}
