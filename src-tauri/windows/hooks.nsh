; Hooks for the NSIS installer, wired through bundle.windows.nsis.installerHooks
; in tauri.conf.json. Tauri inserts NSIS_HOOK_PREINSTALL at the top of its
; Install section and NSIS_HOOK_POSTINSTALL at the bottom of it.
;
; 1.4.0 renamed the product from "Boite" to "Boite Legacy". Tauri's installer
; keys the uninstall entry, the install directory and the shortcuts on the
; product name, and the updater runs it with /UPDATE, a mode that never
; uninstalls what it finds and creates no shortcuts. Left alone, an update from
; a 1.x "Boite" would land beside it in a directory of its own, with no
; shortcut, while the old shortcut kept launching the old build, which would
; then install this one again on every start.
;
; So the pre-install hook removes the 1.x install the way the reinstall page
; would have (its own uninstaller, passive, app data kept), and the post-install
; hook creates the shortcuts the update skipped. Only a "Boite" whose
; DisplayVersion starts with "1." is touched: the next Boite ships under that
; name again with its own major, and it is not this installer's to remove.

Var LegacyBoiteFound
Var LegacyBoiteHadDesktop

!define LEGACY_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Boite"
; What the 1.x installer wrote its install directory under (manufacturer, then
; product name).
!define LEGACY_MANUPRODUCTKEY "Software\boite\Boite"

!macro NSIS_HOOK_PREINSTALL
  StrCpy $LegacyBoiteFound 0
  StrCpy $LegacyBoiteHadDesktop 0

  ReadRegStr $R8 SHCTX "${LEGACY_UNINSTKEY}" "UninstallString"
  ReadRegStr $R9 SHCTX "${LEGACY_UNINSTKEY}" "DisplayVersion"
  StrCpy $R7 $R9 2
  ${If} $R8 != ""
  ${AndIf} $R7 == "1."
    DetailPrint "Removing Boite $R9, which this build replaces"

    ; The directory the old uninstaller runs in: what its installer saved, or
    ; the uninstaller's own parent when that key is gone. UninstallString is
    ; quoted, so the quotes go before the path is split.
    ReadRegStr $R6 SHCTX "${LEGACY_MANUPRODUCTKEY}" ""
    ${If} $R6 == ""
      StrCpy $R5 $R8 1
      ${If} $R5 == '"'
        StrCpy $R6 $R8 -1 1
      ${Else}
        StrCpy $R6 $R8
      ${EndIf}
      ${GetParent} $R6 $R6
    ${EndIf}

    ${If} ${FileExists} "$DESKTOP\Boite.lnk"
      StrCpy $LegacyBoiteHadDesktop 1
    ${EndIf}

    ; /P: nothing asks. No /UPDATE: the shortcuts and the uninstall entry go.
    ; The confirm page, and with it the "delete app data" box, is skipped in
    ; passive mode, so the data directory stays for the app to move on first
    ; start. _?= runs the uninstaller in place, which is what makes ExecWait
    ; wait for it, and also what keeps it from deleting itself.
    ClearErrors
    ExecWait '$R8 /P _?=$R6' $0
    ${If} ${Errors}
    ${OrIf} $0 <> 0
      DetailPrint "The Boite $R9 uninstaller did not finish (exit $0); its entry may remain"
    ${EndIf}
    Delete "$R6\uninstall.exe"
    RMDir "$R6"

    StrCpy $LegacyBoiteFound 1
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; An update creates no shortcuts, since it expects the ones it has. This
  ; build is the first one under its name, and the ones the 1.x install had
  ; went with it above.
  ${If} $LegacyBoiteFound = 1
  ${AndIf} $UpdateMode = 1
    DetailPrint "Creating the shortcuts the renamed product did not have yet"
    StrCpy $UpdateMode 0
    Call CreateOrUpdateStartMenuShortcut
    ${If} $LegacyBoiteHadDesktop = 1
      Call CreateOrUpdateDesktopShortcut
    ${EndIf}
    StrCpy $UpdateMode 1
  ${EndIf}
!macroend
