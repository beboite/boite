; Installer hooks for Boite on Windows, named by `bundle.windows.nsis.installerHooks`.
;
; The core outlives the shell: it keeps running after the window closes, and
; the generated installer only closes the shell. A reinstall or an uninstall
; over a running core cannot write or delete boite-core.exe ("Error opening
; file for writing"), so these hooks obtain idle admission before installation,
; or carry the user's accepted Kill prompt to the resident core. Explicit
; uninstall also stops the core of this install, with stop-core.ps1.
;
; The shell is closed here too, by the full path of its executable
; (stop-shell.ps1), in place of the template's `CheckIfAppIsRunning`, which
; matches a file name across the whole session: Boite and Boite Dev install
; side by side, and one installer must never close the other's window.
; BOITE_HOOKS_CLOSE_SHELL tells the template (installer.nsi) to skip its own
; check. The previous install's registered MainBinaryName counts as this
; install's shell: Boite Dev ran boite-shell.exe before boite-dev-shell.exe.
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

; installer.nsi runs CheckIfAppIsRunning only without this.
!define BOITE_HOOKS_CLOSE_SHELL

; Runs stop-shell.ps1 with ACTION (find or stop) and pops its exit code in $0.
!macro BOITE_SHELL_SCRIPT ACTION
  System::Call 'Kernel32::SetEnvironmentVariable(t "BOITE_SHELL_ACTION", t "${ACTION}") i'
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\boite-stop-shell.ps1"'
  Pop $0
!macroend

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

  Push $0
  Push $1
  Push $2
  StrCpy $2 "0"

  InitPluginsDir
  File "/oname=$PLUGINSDIR\boite-stop-shell.ps1" "${BOITE_HOOKS_DIR}\stop-shell.ps1"
  File "/oname=$PLUGINSDIR\boite-stop-core.ps1" "${BOITE_HOOKS_DIR}\stop-core.ps1"

  ; The window first. A running shell restarts a core it lost within seconds,
  ; from the executable this installer is about to replace. Only a shell
  ; running from this install's directory, under this build's name or the one
  ; the previous install registered (the template deletes that file later).
  ReadRegStr $1 SHCTX "${UNINSTKEY}" "MainBinaryName"
  System::Call 'Kernel32::SetEnvironmentVariable(t "BOITE_SHELL_DIR", t "$INSTDIR") i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "BOITE_SHELL_NAMES", t "${MAINBINARYNAME}.exe|$1") i'
  ; Silent and passive runs end it unasked, as the template's check does.
  IfSilent boite_shell_stop
  StrCmp $PassiveMode "1" boite_shell_stop
  !insertmacro BOITE_SHELL_SCRIPT find
  StrCmp $0 "0" 0 boite_shell_closed
  nsis_tauri_utils::StrReplace "$(appRunningOkKill)" "{{product_name}}" "${PRODUCTNAME}"
  Pop $1
  MessageBox MB_OKCANCEL $1 IDOK boite_shell_accepted
    nsis_tauri_utils::StrReplace "$(appRunning)" "{{product_name}}" "${PRODUCTNAME}"
    Pop $1
    DetailPrint $1
    Pop $2
    Pop $1
    Pop $0
    Abort
  boite_shell_accepted:
  ; Only the interactive Kill prompt grants an explicit stop, including the
  ; resident core. Silent and passive updates continue to require idle admission.
  StrCpy $2 "1"
  boite_shell_stop:
  !insertmacro BOITE_SHELL_SCRIPT stop
  StrCmp $0 "0" boite_shell_closed
    nsis_tauri_utils::StrReplace "$(failedToKillApp)" "{{product_name}}" "${PRODUCTNAME}"
    Pop $1
    DetailPrint $1
    Pop $2
    Pop $1
    Pop $0
    SetErrorLevel 2
    Abort
  boite_shell_closed:

  ; The paths reach the scripts through the environment, so no path can break
  ; their command line.
  System::Call 'Kernel32::SetEnvironmentVariable(t "BOITE_STOP_EXE", t "$INSTDIR\boite-core.exe") i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "BOITE_STOP_DIR", t "${BOITE_DATA_ROOT}\${BOITE_DATA_NAME}") i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "BOITE_STOP_IDLE", t "${IDLE_ONLY}") i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "BOITE_STOP_EXPLICIT", t "$2") i'
  ; nsExec runs it without a window.
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\boite-stop-core.ps1"'
  Pop $0
  !if "${IDLE_ONLY}" == "1"
    StrCmp $0 "0" boite_core_admitted
      DetailPrint "Boite is still working or cannot confirm an idle core. Finish its work or stop it explicitly, then retry."
      Pop $2
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
        Pop $2
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
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro BOITE_STOP_CORE 1
!macroend

; A login entry the shell registered (src/platform/login.rs) under the
; previous install's binary name, which the template has just deleted, follows
; it to this build's name. $OldMainBinaryName is the template's: it reads the
; previous install's name before it records this build's.
!macro NSIS_HOOK_POSTINSTALL
  ${If} $OldMainBinaryName != ""
  ${AndIf} $OldMainBinaryName != "${MAINBINARYNAME}.exe"
    Push $0
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
    ${If} $0 == "$\"$INSTDIR\$OldMainBinaryName$\" --autostart"
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --autostart"
    ${EndIf}
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro BOITE_STOP_CORE 0
!macroend
