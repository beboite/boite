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

; .onInstFailed below is read here, at file level.
!include LogicLib.nsh

; Runs stop-shell.ps1 with ACTION (find or stop) and pops its exit code in $0.
!macro BOITE_SHELL_SCRIPT ACTION
  System::Call 'Kernel32::SetEnvironmentVariable(t "BOITE_SHELL_ACTION", t "${ACTION}") i'
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\boite-stop-shell.ps1"'
  Pop $0
!macroend

; Sets OUT to 1 when FILE is absent or opens for writing, which Windows
; refuses while a process runs from it, else to 0.
!macro BOITE_FILE_FREE FILE OUT
  StrCpy ${OUT} 1
  ${If} ${FileExists} "${FILE}"
    ClearErrors
    FileOpen $R7 "${FILE}" a
    ${If} ${Errors}
      StrCpy ${OUT} 0
    ${Else}
      FileClose $R7
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend

; Sets $R9 to 1 when nothing of this install runs: no core holds the lock of
; DATA (a core removes it when it exits; one that crashed leaves it, and the
; scripts check), and neither the core nor the shell executable is in use.
; $1 holds the shell name the previous install registered, or "".
!macro BOITE_NOTHING_RUNS DATA
  StrCpy $R9 0
  ${IfNot} ${FileExists} "${DATA}\core.lock"
    !insertmacro BOITE_FILE_FREE "$INSTDIR\boite-core.exe" $R8
    ${If} $R8 == 1
      !insertmacro BOITE_FILE_FREE "$INSTDIR\${MAINBINARYNAME}.exe" $R8
    ${EndIf}
    ${If} $R8 == 1
    ${AndIf} $1 != ""
      !insertmacro BOITE_FILE_FREE "$INSTDIR\$1" $R8
    ${EndIf}
    StrCpy $R9 $R8
  ${EndIf}
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
  ReadRegStr $1 SHCTX "${UNINSTKEY}" "MainBinaryName"

  ; Nothing of this install runs, as after an in-app update stopped its core:
  ; the two PowerShell scripts below are skipped. Each took about a second on
  ; Windows 11 with nothing to stop (`Measure-Command { powershell -NoProfile
  ; -File stop-core.ps1 }`, 2026-10-23), most of an update's installation. That update's
  ; shell exits just after starting this installer, so a silent or passive
  ; run gives it 3 seconds to let go of its executable.
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  StrCpy $R6 0
  ${Do}
    !insertmacro BOITE_NOTHING_RUNS "${BOITE_DATA_ROOT}\${BOITE_DATA_NAME}"
    ${If} $R9 == 1
    ${OrIf} $R6 >= 30
      ${ExitDo}
    ${EndIf}
    ; A core holds the lock: no wait helps, the scripts decide.
    ${If} ${FileExists} "${BOITE_DATA_ROOT}\${BOITE_DATA_NAME}\core.lock"
      ${ExitDo}
    ${EndIf}
    ${IfNot} ${Silent}
    ${AndIf} $PassiveMode != 1
      ${ExitDo}
    ${EndIf}
    Sleep 100
    IntOp $R6 $R6 + 1
  ${Loop}
  StrCpy $0 $R9
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  ; Still through the last check below: something may take the file meanwhile.
  StrCmp $0 "1" boite_core_check

  InitPluginsDir
  File "/oname=$PLUGINSDIR\boite-stop-shell.ps1" "${BOITE_HOOKS_DIR}\stop-shell.ps1"
  File "/oname=$PLUGINSDIR\boite-stop-core.ps1" "${BOITE_HOOKS_DIR}\stop-core.ps1"

  ; The window first. A running shell restarts a core it lost within seconds,
  ; from the executable this installer is about to replace. Only a shell
  ; running from this install's directory, under this build's name or the one
  ; the previous install registered (the template deletes that file later).
  System::Call 'Kernel32::SetEnvironmentVariable(t "BOITE_SHELL_DIR", t "$INSTDIR") i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "BOITE_SHELL_NAMES", t "${MAINBINARYNAME}.exe|$1") i'
  ; Silent and passive runs end it unasked, as the template's check does.
  IfSilent boite_shell_stop
  StrCmp $PassiveMode "1" boite_shell_stop
  !insertmacro BOITE_SHELL_SCRIPT find
  ; Only a confirmed "none running" (1) skips the question. A failed check (2)
  ; or a script that did not start ("error") asks, then goes through the stop.
  StrCmp $0 "1" boite_shell_closed
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
  boite_core_check:
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
  ; An agent's `boite` command (boite.exe) that outlived its core holds that
  ; file the same way: it moves aside too, whatever the admission.
  ClearErrors
  IfFileExists "$INSTDIR\boite.exe" 0 boite_cli_free
    FileOpen $1 "$INSTDIR\boite.exe" a
    IfErrors 0 boite_cli_writable
      Delete "$INSTDIR\boite.exe.old"
      Rename "$INSTDIR\boite.exe" "$INSTDIR\boite.exe.old"
      Delete /REBOOTOK "$INSTDIR\boite.exe.old"
      Goto boite_cli_free
    boite_cli_writable:
    FileClose $1
  boite_cli_free:
  ClearErrors
  Pop $2
  Pop $1
  Pop $0
!macroend

; The core bundle and the UI carry a hash in every file name, and the template
; only copies files and deletes the ones this build lists: each update used to
; leave the previous build's chunks beside the new ones, and an uninstall left
; them all. Only these two directories are emptied, and only once the core of
; this install has stopped, since it loads chunks from `core` lazily. An empty
; $INSTDIR would turn the paths into the root of the current drive.
!macro BOITE_CLEAR_BUNDLES
  StrCmp $INSTDIR "" +3
    RMDir /r "$INSTDIR\core"
    RMDir /r "$INSTDIR\ui"
!macroend

; Set when this run moved that directory aside, and only then: what an
; interrupted run left behind is never taken for the current build.
Var BoiteCoreAside
Var BoiteUiAside

; An install moves the two directories aside rather than deleting them: a copy
; that fails halfway (a full disk) puts them back in .onInstFailed, so the
; previous core still finds its chunks; a completed install deletes them. A
; directory that cannot be moved (a file held open, or a leftover from an
; interrupted run that cannot be deleted) stays, and the new build is copied
; into it as before this hook. Only these directories: the template still
; overwrites boite-core.exe, the Workers and the shell in place.
!macro BOITE_SET_ASIDE NAME FLAG
  StrCpy ${FLAG} ""
  RMDir /r "$INSTDIR\${NAME}.previous"
  ${IfNot} ${FileExists} "$INSTDIR\${NAME}.previous\*.*"
  ${AndIf} ${FileExists} "$INSTDIR\${NAME}\*.*"
    ClearErrors
    Rename "$INSTDIR\${NAME}" "$INSTDIR\${NAME}.previous"
    ${IfNot} ${Errors}
      StrCpy ${FLAG} "1"
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend

!macro BOITE_RESTORE_ASIDE NAME FLAG
  ${If} ${FLAG} == "1"
    RMDir /r "$INSTDIR\${NAME}"
    Rename "$INSTDIR\${NAME}.previous" "$INSTDIR\${NAME}"
  ${EndIf}
!macroend

!macro BOITE_SET_BUNDLES_ASIDE
  ${If} $INSTDIR != ""
    !insertmacro BOITE_SET_ASIDE core $BoiteCoreAside
    !insertmacro BOITE_SET_ASIDE ui $BoiteUiAside
  ${EndIf}
!macroend

!macro BOITE_DROP_BUNDLES_ASIDE
  StrCmp $INSTDIR "" +3
    RMDir /r /REBOOTOK "$INSTDIR\core.previous"
    RMDir /r /REBOOTOK "$INSTDIR\ui.previous"
!macroend

; NSIS calls it when the install aborts or a file cannot be written. A refused
; install (a busy core) aborts before anything was moved aside.
Function .onInstFailed
  ${If} $INSTDIR != ""
    !insertmacro BOITE_RESTORE_ASIDE core $BoiteCoreAside
    !insertmacro BOITE_RESTORE_ASIDE ui $BoiteUiAside
  ${EndIf}
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  !insertmacro BOITE_STOP_CORE 1
  !insertmacro BOITE_SET_BUNDLES_ASIDE
!macroend

; A login entry the shell registered (src/platform/login.rs) under the
; previous install's binary name, which the template has just deleted, follows
; it to this build's name. $OldMainBinaryName is the template's: it reads the
; previous install's name before it records this build's.
!macro NSIS_HOOK_POSTINSTALL
  !insertmacro BOITE_DROP_BUNDLES_ASIDE
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

; Before the template's deletions, so its final `RMDir "$INSTDIR"`, which only
; removes an empty directory, finds the two directories gone. A core that would
; not stop was moved aside above and goes with its install.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro BOITE_STOP_CORE 0
  !insertmacro BOITE_CLEAR_BUNDLES
!macroend

; And again after them: `RMDir /r` skips a file someone still holds open (a
; scanner, an editor) without failing the uninstall, and that file kept `core`
; or `ui`, and so the install directory, alive. What is still held now goes at
; the next restart where Windows allows it; the directory goes once empty.
!macro NSIS_HOOK_POSTUNINSTALL
  StrCmp $INSTDIR "" +6
    RMDir /r /REBOOTOK "$INSTDIR\core"
    RMDir /r /REBOOTOK "$INSTDIR\ui"
    RMDir /r /REBOOTOK "$INSTDIR\core.previous"
    RMDir /r /REBOOTOK "$INSTDIR\ui.previous"
    RMDir "$INSTDIR"
!macroend
