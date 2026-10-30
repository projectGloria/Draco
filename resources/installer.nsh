; Custom steps electron-builder splices into the NSIS installer/uninstaller.
;
; Setup puts the `draco` command on the user's PATH; uninstall takes it off.
; Neither touches PATH from NSIS itself: NSIS strings have a fixed size, and a
; long PATH read into one comes back truncated. Draco.exe runs as plain Node
; instead (ELECTRON_RUN_AS_NODE) and executes out/main/path-setup.js, which
; uses the same code as the Options toggle.
;
; It also owns draco.cfg, the CLI's config in the install root. That folder is
; deleted wholesale on every update (the old uninstaller runs first), so the
; user's copy is parked in %APPDATA%\Draco on the way out and put back on the
; way in.

!define DRACO_CFG_BACKUP "$APPDATA\Draco\draco.cfg.bak"

!macro dracoPathSetup ACTION
  ; Child processes inherit the installer's environment, so set the flag only
  ; around this one call. Leaving it set would make the "Run Draco" checkbox at
  ; the end launch Draco.exe as headless Node instead of the app.
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
  nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\app.asar\out\main\path-setup.js" ${ACTION} "$INSTDIR\resources\bin"'
  Pop $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", p 0)'
  ${If} $0 != 0
    ; Not fatal: the app re-syncs PATH on every start.
    DetailPrint "draco PATH ${ACTION} did not complete (exit $0)"
  ${EndIf}
!macroend

!macro customInstall
  !insertmacro dracoPathSetup add

  ; The user's own config wins over the sample: restore the copy the previous
  ; version's uninstaller parked, and write the commented sample only when
  ; there is nothing of theirs to keep.
  ${IfNot} ${FileExists} "$INSTDIR\draco.cfg"
    ${If} ${FileExists} "${DRACO_CFG_BACKUP}"
      CopyFiles /SILENT "${DRACO_CFG_BACKUP}" "$INSTDIR\draco.cfg"
      Delete "${DRACO_CFG_BACKUP}"
      DetailPrint "Restored your draco.cfg"
    ${Else}
      File "/oname=$INSTDIR\draco.cfg" "${BUILD_RESOURCES_DIR}\draco.cfg"
    ${EndIf}
  ${EndIf}
!macroend

; Runs before the files are deleted, so Draco.exe, the script and draco.cfg
; still exist. Also runs when an update replaces this version; the new
; install's customInstall re-adds PATH and restores draco.cfg right after.
!macro customUnInstall
  !insertmacro dracoPathSetup remove

  ${If} ${FileExists} "$INSTDIR\draco.cfg"
    CreateDirectory "$APPDATA\Draco"
    CopyFiles /SILENT "$INSTDIR\draco.cfg" "${DRACO_CFG_BACKUP}"
  ${EndIf}
!macroend
