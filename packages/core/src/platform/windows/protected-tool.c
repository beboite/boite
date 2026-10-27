/* Trusted launcher. No command interpreter, elevation, global ACL or firewall changes.
 * Build: Windows SDK clang, or x86_64-w64-mingw32-gcc, with userenv/advapi32/shell32/user32.
 * Only this process owns the non-inherited private job handle. */
#define _CRT_SECURE_NO_WARNINGS
#define _WIN32_WINNT 0x0A00
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <userenv.h>
#include <aclapi.h>
#include <sddl.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

#include "protected-null.h"

#define VERSION L"boite-windows-protected 2"
#ifndef PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY
#define PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY 0x2000f
#endif
#ifndef PROC_THREAD_ATTRIBUTE_JOB_LIST
#define PROC_THREAD_ATTRIBUTE_JOB_LIST 0x2000d
#endif

static int failure(const wchar_t *field, DWORD code) {
  fwprintf(stderr, L"execution.windows.%ls: native call failed (%lu); no unprotected fallback\n", field, code);
  return 125;
}

/* The owner retains cleanup rights. The package gets no WRITE_DAC/WRITE_OWNER,
 * including through the implicit rights normally granted to an object's owner. */
static DWORD set_acl(const wchar_t *path, PSID app, PSID user, DWORD rights, BOOL directory) {
  EXPLICIT_ACCESSW entries[3]; PACL acl = NULL;
  ZeroMemory(entries, sizeof(entries));
  for (int i = 0; i < 3; i++) {
    entries[i].grfInheritance = directory ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE;
    entries[i].Trustee.TrusteeForm = TRUSTEE_IS_SID;
    entries[i].Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
  }
  entries[0].grfAccessMode = DENY_ACCESS;
  entries[0].grfAccessPermissions = WRITE_DAC | WRITE_OWNER;
  entries[0].Trustee.ptstrName = (LPWSTR)app;
  entries[1].grfAccessMode = SET_ACCESS;
  entries[1].grfAccessPermissions = FILE_ALL_ACCESS;
  entries[1].Trustee.ptstrName = (LPWSTR)user;
  entries[2].grfAccessMode = SET_ACCESS;
  entries[2].grfAccessPermissions = rights;
  entries[2].Trustee.ptstrName = (LPWSTR)app;
  DWORD result = SetEntriesInAclW(3, entries, NULL, &acl);
  if (!result) result = SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, NULL, NULL, acl, NULL);
  if (acl) LocalFree(acl);
  return result;
}

static DWORD tree_acl(const wchar_t *path, PSID app, PSID user, DWORD rights,
    int override_count, wchar_t **overrides) {
  DWORD attributes = GetFileAttributesW(path);
  if (attributes == INVALID_FILE_ATTRIBUTES) return GetLastError();
  if (attributes & FILE_ATTRIBUTE_REPARSE_POINT) return ERROR_REPARSE_TAG_INVALID;
  BOOL directory = !!(attributes & FILE_ATTRIBUTE_DIRECTORY);
  DWORD effective = rights;
  for (int i = 0; i < override_count; i++) if (!_wcsicmp(path, overrides[i])) effective = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
  DWORD result = set_acl(path, app, user, effective, directory);
  if (result || !directory) return result;
  size_t length = wcslen(path);
  wchar_t *child = calloc(length + MAX_PATH + 4, sizeof(wchar_t));
  if (!child) return ERROR_NOT_ENOUGH_MEMORY;
  swprintf(child, length + MAX_PATH + 4, L"%ls\\*", path);
  WIN32_FIND_DATAW data;
  HANDLE find = FindFirstFileW(child, &data);
  if (find == INVALID_HANDLE_VALUE) {free(child); return GetLastError() == ERROR_FILE_NOT_FOUND ? 0 : GetLastError();}
  do {
    if (!wcscmp(data.cFileName, L".") || !wcscmp(data.cFileName, L"..")) continue;
    swprintf(child, length + MAX_PATH + 4, L"%ls\\%ls", path, data.cFileName);
    result = tree_acl(child, app, user, rights, override_count, overrides);
    if (result) break;
  } while (FindNextFileW(find, &data));
  if (!result && GetLastError() != ERROR_NO_MORE_FILES) result = GetLastError();
  FindClose(find); free(child); return result;
}

static int setup(int count, wchar_t **args) {
  if (count < 7) return failure(L"setup.arguments", ERROR_INVALID_PARAMETER);
  PSID app = NULL; HANDLE token = NULL; TOKEN_USER *user = NULL; DWORD bytes = 0;
  HRESULT hr = CreateAppContainerProfile(args[2], args[2], L"Temporary Boite protected tool", NULL, 0, &app);
  if (FAILED(hr)) return failure(L"profile.create", (DWORD)hr);
  DWORD error = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {error = GetLastError(); goto end;}
  GetTokenInformation(token, TokenUser, NULL, 0, &bytes);
  user = calloc(1, bytes);
  if (!user || !GetTokenInformation(token, TokenUser, user, bytes, &bytes)) {error = GetLastError(); goto end;}
  /* The capability can traverse scratch, but cannot list/read its control files. */
  error = set_acl(args[3], app, user->User.Sid, FILE_TRAVERSE | SYNCHRONIZE, FALSE);
  if (!error) error = tree_acl(args[4], app, user->User.Sid,
    FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE, count - 7, args + 7);
  if (!error) error = tree_acl(args[5], app, user->User.Sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, 0, NULL);
  if (!error) error = tree_acl(args[6], app, user->User.Sid,
    FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE, 0, NULL);
  if (!error) {
    /* A real access probe distinguishes LPAC from ordinary AppContainer even on
     * kernels where TokenIsLessPrivilegedAppContainer is not a public query. */
    size_t size = wcslen(args[3]) + 32;
    wchar_t *path = calloc(size, sizeof(wchar_t)); PSID packages = NULL;
    if (!path) {error = ERROR_NOT_ENOUGH_MEMORY; goto end;}
    swprintf(path, size, L"%ls\\ambient-probe", args[3]);
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) error = GetLastError();
    else CloseHandle(file);
    if (!error && !ConvertStringSidToSidW(L"S-1-15-2-1", &packages)) error = GetLastError();
    if (!error) error = set_acl(path, packages, user->User.Sid, FILE_GENERIC_READ, FALSE);
    if (packages) LocalFree(packages);
    free(path);
  }
end:
  if (token) CloseHandle(token);
  if (user) free(user);
  if (app) FreeSid(app);
  if (error) {DeleteAppContainerProfile(args[2]); return failure(L"private-acl", error);}
  fputws(L"protected-native-prepared", stdout); return 0;
}

/* Quote precisely for CommandLineToArgvW/CRT; no shell ever sees these bytes. */
static wchar_t *command_line(int count, wchar_t **args) {
  size_t size = 1;
  for (int i = 0; i < count; i++) size += wcslen(args[i]) * 2 + 4;
  wchar_t *result = calloc(size, sizeof(wchar_t)), *out = result;
  if (!result) return NULL;
  for (int i = 0; i < count; i++) {
    if (i) *out++ = L' ';
    *out++ = L'"';
    const wchar_t *in = args[i];
    while (*in) {
      size_t slashes = 0;
      while (*in == L'\\') {slashes++; in++;}
      if (*in == L'"' || !*in) slashes *= 2;
      while (slashes--) *out++ = L'\\';
      if (*in == L'"') *out++ = L'\\';
      if (*in) *out++ = *in++;
    }
    *out++ = L'"';
  }
  *out = 0; return result;
}

/* A service/SSH window station does not admit lowbox processes. Give the tool
 * its own invisible station and desktop; never edit the host station's ACL. */
static DWORD private_desktop(PSID app, const wchar_t *profile, HWINSTA *station, HDESK *desktop,
    wchar_t *name, size_t size, PSECURITY_DESCRIPTOR *object_security) {
  HANDLE token = NULL; TOKEN_USER *user = NULL; DWORD bytes = 0, error = 0;
  LPWSTR app_text = NULL, user_text = NULL; PSECURITY_DESCRIPTOR descriptor = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return GetLastError();
  GetTokenInformation(token, TokenUser, NULL, 0, &bytes); user = calloc(1, bytes);
  if (!user || !GetTokenInformation(token, TokenUser, user, bytes, &bytes) ||
      !ConvertSidToStringSidW(app, &app_text) || !ConvertSidToStringSidW(user->User.Sid, &user_text)) {error = GetLastError(); goto end;}
  wchar_t sddl[512]; swprintf(sddl, 512, L"D:P(A;;GA;;;%ls)(A;;GA;;;%ls)S:(ML;;NW;;;LW)", user_text, app_text);
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &descriptor, NULL)) {error = GetLastError(); goto end;}
  SECURITY_ATTRIBUTES attributes = {sizeof(attributes), descriptor, FALSE};
  int length = swprintf(name, size, L"%ls.%lu", profile, GetCurrentProcessId());
  if (length < 0 || (size_t)length >= size) {error = ERROR_INSUFFICIENT_BUFFER; goto end;}
  *station = CreateWindowStationW(name, 1 /* CWF_CREATE_ONLY */, WINSTA_ALL_ACCESS, &attributes);
  if (!*station || !SetProcessWindowStation(*station)) {error = GetLastError(); goto end;}
  *desktop = CreateDesktopW(L"default", NULL, NULL, 0, GENERIC_ALL, &attributes);
  if (!*desktop) {error = GetLastError(); goto end;}
  size_t remaining = size - (size_t)length;
  int appended = swprintf(name + length, remaining, L"\\default");
  if (appended < 0 || (size_t)appended >= remaining) {error = ERROR_INSUFFICIENT_BUFFER; goto end;}
  *object_security = descriptor; descriptor = NULL;
end:
  if (descriptor) LocalFree(descriptor);
  if (app_text) LocalFree(app_text);
  if (user_text) LocalFree(user_text);
  if (user) free(user);
  CloseHandle(token); return error;
}

static int launch(int count, wchar_t **args, BOOL null_broker) {
  if (count < 5) return failure(L"launch.arguments", ERROR_INVALID_PARAMETER);
  PSID app = NULL; HANDLE job = NULL, streams[3] = {NULL, NULL, NULL};
  PSID *groups = NULL, *capability_sids = NULL; DWORD group_count = 0, capability_count = 0;
  SID_AND_ATTRIBUTES registry_read;
  LPPROC_THREAD_ATTRIBUTE_LIST list = NULL; PROCESS_INFORMATION child; ZeroMemory(&child, sizeof(child));
  DWORD error = 0, exit_code = 125; wchar_t *line = NULL; BOOL initialized = FALSE, broker_started = FALSE;
  const wchar_t *stage = L"launch.job";
  HWINSTA original_station = GetProcessWindowStation(), station = NULL; HDESK desktop = NULL;
  PSECURITY_DESCRIPTOR object_security = NULL;
  wchar_t desktop_name[256];
  HRESULT hr = DeriveAppContainerSidFromAppContainerName(args[2], &app);
  if (FAILED(hr)) return failure(L"profile.derive", (DWORD)hr);
  job = CreateJobObjectW(NULL, NULL);
  if (!job) {error = GetLastError(); goto end;}
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits; ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {error = GetLastError(); goto end;}
  stage = L"launch.desktop";
  error = private_desktop(app, args[2], &station, &desktop, desktop_name, 256, &object_security);
  if (error) goto end;
  DWORD ids[3] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
  stage = L"launch.streams";
  for (int i = 0; i < 3; i++) {
    HANDLE original = GetStdHandle(ids[i]);
    if (!original || original == INVALID_HANDLE_VALUE || !DuplicateHandle(GetCurrentProcess(), original,
        GetCurrentProcess(), &streams[i], 0, TRUE, DUPLICATE_SAME_ACCESS)) {error = GetLastError(); goto end;}
  }
  SIZE_T bytes = 0;
  stage = L"launch.attributes";
  InitializeProcThreadAttributeList(NULL, 4, 0, &bytes);
  list = HeapAlloc(GetProcessHeap(), 0, bytes);
  if (!list || !InitializeProcThreadAttributeList(list, 4, 0, &bytes)) {error = GetLastError(); goto end;}
  initialized = TRUE;
  SECURITY_CAPABILITIES capabilities; ZeroMemory(&capabilities, sizeof(capabilities));
  /* CreateProcess reads public Windows registry configuration even for a private
   * executable. Without registryRead the native call fails with ACCESS_DENIED.
   * This SID grants only registry keys whose ACL already names that capability;
   * it neither restores ALL APPLICATION PACKAGES nor grants network/file access. */
  typedef BOOL (WINAPI *derive_capability)(LPCWSTR, PSID **, DWORD *, PSID **, DWORD *);
  derive_capability derive = (derive_capability)(void *)GetProcAddress(GetModuleHandleW(L"kernelbase.dll"), "DeriveCapabilitySidsFromName");
  stage = L"launch.registry-capability";
  if (!derive || !derive(L"registryRead", &groups, &group_count, &capability_sids, &capability_count) || capability_count != 1) {
    error = GetLastError(); if (!error) error = ERROR_NOT_SUPPORTED; goto end;
  }
  registry_read.Sid = capability_sids[0]; registry_read.Attributes = SE_GROUP_ENABLED;
  capabilities.AppContainerSid = app;
  capabilities.Capabilities = &registry_read; capabilities.CapabilityCount = 1;
  DWORD lpac = 1; /* PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT: exclude ambient ALL APPLICATION PACKAGES grants. */
  if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities, sizeof(capabilities), NULL, NULL) ||
      !UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, &lpac, sizeof(lpac), NULL, NULL) ||
      !UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, streams, sizeof(streams), NULL, NULL) ||
      !UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job), NULL, NULL)) {error = GetLastError(); goto end;}
  STARTUPINFOEXW startup; ZeroMemory(&startup, sizeof(startup));
  startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = list;
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  /* A hidden console and registryRead permit native toolchain descendants. */
  startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.StartupInfo.lpDesktop = desktop_name;
  startup.StartupInfo.hStdInput = streams[0]; startup.StartupInfo.hStdOutput = streams[1]; startup.StartupInfo.hStdError = streams[2];
  line = command_line(count - 4, args + 4);
  if (!line) {error = ERROR_NOT_ENOUGH_MEMORY; goto end;}
  /* Kernel applies the lowbox, handle allowlist and non-breakaway job atomically.
   * Suspension also lets us reject a missing lowbox before its first instruction. */
  stage = L"launch.process";
  SECURITY_ATTRIBUTES child_security = {sizeof(child_security), object_security, FALSE};
  if (!CreateProcessW(args[4], line, &child_security, &child_security, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED |
      CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT | (null_broker ? DEBUG_PROCESS : 0), NULL, args[3], &startup.StartupInfo, &child)) {error = GetLastError(); goto end;}
  HANDLE child_token = NULL; DWORD is_container = 0, returned = 0;
  stage = L"launch.token";
  if (!OpenProcessToken(child.hProcess, TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, &child_token)) {error = GetLastError(); goto end;}
  BOOL checked = GetTokenInformation(child_token, TokenIsAppContainer, &is_container, sizeof(is_container), &returned);
  /* A pipe with a host-only default DACL cannot be reopened by its own
   * restricted token. Set only this suspended job token's default, so new
   * private IPC admits its package;
   * no ambient application-package or host object grant is restored. */
  PACL default_acl = NULL; BOOL present = FALSE, defaulted = FALSE;
  if (checked && is_container) {
    stage = L"launch.token.default-dacl";
    checked = GetSecurityDescriptorDacl(object_security, &present, &default_acl, &defaulted);
    if (checked && present && default_acl) {
      TOKEN_DEFAULT_DACL defaults = {default_acl};
      checked = SetTokenInformation(child_token, TokenDefaultDacl, &defaults, sizeof(defaults));
    } else {checked = FALSE; SetLastError(ERROR_INVALID_ACL);}
  }
  DWORD token_error = checked ? 0 : GetLastError();
  CloseHandle(child_token);
  if (!checked) {error = token_error; goto end;}
  if (!is_container) {stage = L"launch.token.not-appcontainer"; error = ERROR_ACCESS_DENIED; goto end;}
  if (ResumeThread(child.hThread) == (DWORD)-1) {error = GetLastError(); goto end;}
  if (null_broker) {
    stage = L"launch.null-broker";
    broker_started = TRUE;
    error = protected_null_run(job, &child, app, registry_read.Sid, FALSE, &exit_code);
    goto end;
  }
  if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0 || !GetExitCodeProcess(child.hProcess, &exit_code)) {error = GetLastError(); goto end;}
end:
  if (null_broker && child.hProcess && !broker_started) {
    DWORD drained = protected_null_run(job, &child, app, registry_read.Sid, TRUE, &exit_code);
    if (!error) error = drained;
  }
  /* A successful root exit must not leave detached descendants holding the view. */
  if (job) {
    TerminateJobObject(job, 125);
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
    for (int i = 0; i < 1000; i++) {
      if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL)) {error = GetLastError(); break;}
      if (!accounting.ActiveProcesses) break;
      if (i == 999) error = ERROR_TIMEOUT;
      Sleep(10);
    }
  }
  if (child.hThread) CloseHandle(child.hThread);
  if (child.hProcess) CloseHandle(child.hProcess);
  if (list) {if (initialized) DeleteProcThreadAttributeList(list); HeapFree(GetProcessHeap(), 0, list);}
  for (int i = 0; i < 3; i++) if (streams[i]) CloseHandle(streams[i]);
  if (job) CloseHandle(job);
  if (station) SetProcessWindowStation(original_station);
  if (desktop) CloseDesktop(desktop);
  if (station) CloseWindowStation(station);
  if (object_security) LocalFree(object_security);
  for (DWORD i = 0; i < group_count; i++) LocalFree(groups[i]);
  if (groups) LocalFree(groups);
  for (DWORD i = 0; i < capability_count; i++) LocalFree(capability_sids[i]);
  if (capability_sids) LocalFree(capability_sids);
  if (app) FreeSid(app);
  if (line) free(line);
  if (!error && exit_code) fwprintf(stderr, L"execution.windows.child: exit status %lu\n", exit_code);
  return error ? failure(stage, error) : (int)exit_code;
}

static int probe(const wchar_t *path) {
  HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
  if (file != INVALID_HANDLE_VALUE) {CloseHandle(file); return failure(L"probe.ambient-grant", ERROR_ACCESS_DENIED);}
  if (GetLastError() != ERROR_ACCESS_DENIED) return failure(L"probe.ambient-path", GetLastError());
  /* Native child runtimes open NUL even for piped stdio (ignored stdin).
   * Some Server kernels omit LPAC access on this existing system device. No
   * job-local ACL/token default can grant access to an existing host device;
   * the caller may repeat this same probe with the bounded native Null broker.
   * It must actually pass before the selected launch mode can be admitted. */
  file = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
    NULL, OPEN_EXISTING, 0, NULL);
  if (file == INVALID_HANDLE_VALUE) return failure(L"probe.null-device", GetLastError());
  CloseHandle(file);
  fputws(VERSION, stdout); return 0;
}

/* Read-only diagnostic for the platform prerequisite, never edits its ACL. */
static int diagnose_null(void) {
  HANDLE file = CreateFileW(L"NUL", READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
  if (file == INVALID_HANDLE_VALUE) return failure(L"null-device.open-security", GetLastError());
  PSECURITY_DESCRIPTOR descriptor = NULL; LPWSTR text = NULL;
  DWORD error = GetSecurityInfo(file, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, NULL, NULL, &descriptor);
  if (!error && !ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, SDDL_REVISION_1,
      DACL_SECURITY_INFORMATION, &text, NULL)) error = GetLastError();
  if (!error) fwprintf(stdout, L"NUL DACL: %ls\n", text);
  if (text) LocalFree(text);
  if (descriptor) LocalFree(descriptor);
  CloseHandle(file);
  return error ? failure(L"null-device.security", error) : 0;
}

int main(void) {
  int count = 0; wchar_t **args = CommandLineToArgvW(GetCommandLineW(), &count);
  int result = 125;
  if (count == 2 && !wcscmp(args[1], L"--version")) {fputws(VERSION, stdout); result = 0;}
  else if (count == 2 && !wcscmp(args[1], L"--diagnose-null")) result = diagnose_null();
  else if (count == 3 && !wcscmp(args[1], L"--probe")) result = probe(args[2]);
  else if (count > 1 && !wcscmp(args[1], L"setup")) result = setup(count, args);
  else if (count > 1 && !wcscmp(args[1], L"run")) result = launch(count, args, FALSE);
  else if (count > 1 && !wcscmp(args[1], L"run-null-broker")) result = launch(count, args, TRUE);
  else result = failure(L"arguments", ERROR_INVALID_PARAMETER);
  if (args) LocalFree(args);
  return result;
}
