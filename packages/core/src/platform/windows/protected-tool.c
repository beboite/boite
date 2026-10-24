/* Trusted launcher. No command interpreter, elevation, global ACL or firewall changes.
 * Build: Windows SDK clang, or x86_64-w64-mingw32-gcc, with userenv/advapi32/shell32.
 * Only this process owns the non-inherited private job handle. */
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

#define VERSION L"boite-windows-protected 1"
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

static int launch(int count, wchar_t **args) {
  if (count < 5) return failure(L"launch.arguments", ERROR_INVALID_PARAMETER);
  PSID app = NULL; HANDLE job = NULL, streams[3] = {NULL, NULL, NULL};
  LPPROC_THREAD_ATTRIBUTE_LIST list = NULL; PROCESS_INFORMATION child; ZeroMemory(&child, sizeof(child));
  DWORD error = 0, exit_code = 125; wchar_t *line = NULL;
  HRESULT hr = DeriveAppContainerSidFromAppContainerName(args[2], &app);
  if (FAILED(hr)) return failure(L"profile.derive", (DWORD)hr);
  job = CreateJobObjectW(NULL, NULL);
  if (!job) {error = GetLastError(); goto end;}
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits; ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  JOBOBJECT_BASIC_UI_RESTRICTIONS ui = {0xff};
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
      !SetInformationJobObject(job, JobObjectBasicUIRestrictions, &ui, sizeof(ui))) {error = GetLastError(); goto end;}
  DWORD ids[3] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
  for (int i = 0; i < 3; i++) {
    HANDLE original = GetStdHandle(ids[i]);
    if (!original || original == INVALID_HANDLE_VALUE || !DuplicateHandle(GetCurrentProcess(), original,
        GetCurrentProcess(), &streams[i], 0, TRUE, DUPLICATE_SAME_ACCESS)) {error = GetLastError(); goto end;}
  }
  SIZE_T bytes = 0;
  InitializeProcThreadAttributeList(NULL, 4, 0, &bytes);
  list = HeapAlloc(GetProcessHeap(), 0, bytes);
  if (!list || !InitializeProcThreadAttributeList(list, 4, 0, &bytes)) {error = GetLastError(); goto end;}
  SECURITY_CAPABILITIES capabilities; ZeroMemory(&capabilities, sizeof(capabilities));
  capabilities.AppContainerSid = app; /* No network, shared-file or other capability SIDs. */
  DWORD lpac = 1; /* PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT: exclude ambient ALL APPLICATION PACKAGES grants. */
  if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities, sizeof(capabilities), NULL, NULL) ||
      !UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, &lpac, sizeof(lpac), NULL, NULL) ||
      !UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, streams, sizeof(streams), NULL, NULL) ||
      !UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job), NULL, NULL)) {error = GetLastError(); goto end;}
  STARTUPINFOEXW startup; ZeroMemory(&startup, sizeof(startup));
  startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = list;
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.StartupInfo.hStdInput = streams[0]; startup.StartupInfo.hStdOutput = streams[1]; startup.StartupInfo.hStdError = streams[2];
  line = command_line(count - 4, args + 4);
  if (!line) {error = ERROR_NOT_ENOUGH_MEMORY; goto end;}
  /* Kernel applies the lowbox, handle allowlist and non-breakaway job atomically.
   * Suspension also lets us reject a missing lowbox before its first instruction. */
  if (!CreateProcessW(args[4], line, NULL, NULL, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED |
      CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, NULL, args[3], &startup.StartupInfo, &child)) {error = GetLastError(); goto end;}
  HANDLE child_token = NULL; DWORD is_container = 0, returned = 0;
  if (!OpenProcessToken(child.hProcess, TOKEN_QUERY, &child_token)) {error = GetLastError(); goto end;}
  BOOL checked = GetTokenInformation(child_token, TokenIsAppContainer, &is_container, sizeof(is_container), &returned);
  CloseHandle(child_token);
  if (!checked || !is_container) {error = ERROR_ACCESS_DENIED; goto end;}
  if (ResumeThread(child.hThread) == (DWORD)-1) {error = GetLastError(); goto end;}
  if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0 || !GetExitCodeProcess(child.hProcess, &exit_code)) {error = GetLastError(); goto end;}
end:
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
  if (list) {DeleteProcThreadAttributeList(list); HeapFree(GetProcessHeap(), 0, list);}
  for (int i = 0; i < 3; i++) if (streams[i]) CloseHandle(streams[i]);
  if (job) CloseHandle(job);
  if (app) FreeSid(app);
  if (line) free(line);
  return error ? failure(L"launch", error) : (int)exit_code;
}

int main(void) {
  int count = 0; wchar_t **args = CommandLineToArgvW(GetCommandLineW(), &count);
  int result = 125;
  if (count == 2 && !wcscmp(args[1], L"--version")) {fputws(VERSION, stdout); result = 0;}
  else if (count > 1 && !wcscmp(args[1], L"setup")) result = setup(count, args);
  else if (count > 1 && !wcscmp(args[1], L"run")) result = launch(count, args);
  else result = failure(L"arguments", ERROR_INVALID_PARAMETER);
  if (args) LocalFree(args);
  return result;
}
