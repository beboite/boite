; Installer hooks for Boite on Windows, named by `bundle.windows.nsis.installerHooks`.
;
; The core outlives the shell: it keeps running after the window closes, and
; the generated installer only closes the shell (`CheckIfAppIsRunning` matches
; boite-shell.exe by name). A reinstall or an uninstall over a running core
; cannot write or delete boite-core.exe ("Error opening file for writing"), so
; these hooks obtain idle admission before installation. Explicit uninstall
; still stops the core of this install, with stop-core.ps1.
;
; Tauri's installer.nsi includes this file near its top, before it defines
; BUNDLEID, MAINBINARYNAME and PRODUCTNAME. Nothing outside the macros below
; may read those: `!if` at file level would compare the literal text
; "${BUNDLEID}". A macro body is read where it is inserted, inside a section,
; after the template defined them.

; Read here, where it names this file's directory: inside the macro it would
; name the generated installer's.
!define BOITE_HOOKS_DIR "${__FILEDIR__}"

; The directory the data directories live under. A test build of these hooks
; points it at a scratch directory.
!ifndef BOITE_DATA_ROOT
  !define BOITE_DATA_ROOT "$LOCALAPPDATA"
!endif

!macro BOITE_STOP_CORE IDLE_ONLY
  !ifndef BUNDLEID
    !error "hooks.nsh: BUNDLEID is not defined where BOITE_STOP_CORE is inserted"
  !endif
  ; The data directory this install's core writes core.json in: the name
  ; `Channel::data_dir_name` gives in src/channel.rs.
  !if "${BUNDLEID}" == "com.boite.two.dev"
    !define /redef BOITE_DATA_NAME "boite2-dev"
  !else
    !define /redef BOITE_DATA_NAME "boite2"
  !endif
  !echo "Boite hooks: ${BUNDLEID} stops the core of ${BOITE_DATA_ROOT}\${BOITE_DATA_NAME}"

  ; The window first. A running shell restarts a core it lost within seconds,
  ; from the executable this installer is about to replace, and the check the
  ; template runs after this hook waits on an OK/Cancel box before it ends the
  ; shell. This is that same check, run earlier: the same question before
  ; anything is stopped, and the template's then finds nothing left to close.
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  Push $0
  Push $1
  InitPluginsDir
  File "/oname=$PLUGINSDIR\boite-stop-core.ps1" "${BOITE_HOOKS_DIR}\stop-core.ps1"
  ; The paths reach the script through the environment, so no path can break
  ; its command line.
  System::Call 'Kernel32::SetEnvironmentVariable(t "BOITE_STOP_EXE", t "$INSTDIR\boite-core.exe") i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "BOITE_STOP_DIR", t "${BOITE_DATA_ROOT}\${BOITE_DATA_NAME}") i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "BOITE_STOP_IDLE", t "${IDLE_ONLY}") i'
  ; nsExec runs it without a window.
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\boite-stop-core.ps1"'
  Pop $0
  !if "${IDLE_ONLY}" == "1"
    StrCmp $0 "0" boite_core_admitted
      DetailPrint "Boite is still working or cannot confirm an idle core. Finish its work or stop it explicitly, then retry."
      Pop $1
      Pop $0
      SetErrorLevel 2
      Abort
    boite_core_admitted:
  !endif
  ; Whatever still holds the file (a core that would not stop, a scanner):
  ; move it aside, which Windows allows for a running executable, so the new
  ; one can be written, and delete the old one at the next restart.
  ClearErrors
  IfFileExists "$INSTDIR\boite-core.exe" 0 boite_core_free
    FileOpen $1 "$INSTDIR\boite-core.exe" a
    IfErrors 0 boite_core_writable
      !if "${IDLE_ONLY}" == "1"
        DetailPrint "boite-core.exe is still in use. Nothing was replaced; retry once the core has exited."
        Pop $1
        Pop $0
        SetErrorLevel 2
        Abort
      !endif
      Delete "$INSTDIR\boite-core.exe.old"
      Rename "$INSTDIR\boite-core.exe" "$INSTDIR\boite-core.exe.old"
      Delete /REBOOTOK "$INSTDIR\boite-core.exe.old"
      Goto boite_core_free
    boite_core_writable:
    FileClose $1
  boite_core_free:
  ClearErrors
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro BOITE_STOP_CORE 1
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro BOITE_STOP_CORE 0
!macroend
