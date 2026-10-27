#ifndef BOITE_PROTECTED_NULL_H
#define BOITE_PROTECTED_NULL_H
#include <windows.h>
DWORD protected_null_run(HANDLE job, PROCESS_INFORMATION *root, PSID package, PSID registry, BOOL terminating, DWORD *exit_code);
#endif
