Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
Name "Draco CLI"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Draco CLI"
InstallDirRegKey HKCU "Software\DracoCLI" "InstallDir"
RequestExecutionLevel user
; Solid LZMA: ffmpeg + ffprobe + node.exe are ~420 MB raw. zlib ships them at
; ~210 MB, LZMA at well under half that; only `npm run dist` pays the extra time.
SetCompressor /SOLID lzma
!define MUI_ICON "${RESOURCES}\icon.ico"
!define MUI_UNICON "${RESOURCES}\icon.ico"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Draco CLI"
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*"
  SetOutPath "$INSTDIR"
  IfFileExists "$INSTDIR\draco.cfg" config_done
    File /oname=draco.cfg "${RESOURCES}\draco.cfg"
  config_done:
  nsExec::ExecToLog '"$INSTDIR\node.exe" "$INSTDIR\out\main\path-setup.js" add "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK "Draco CLI was installed, but PATH could not be updated. Run draco.cmd from $INSTDIR."
  ${EndIf}
  CreateDirectory "$SMPROGRAMS\Draco CLI"
  SetOutPath "$PROFILE\Downloads"
  CreateShortcut "$SMPROGRAMS\Draco CLI\Draco CLI.lnk" "$INSTDIR\draco.cmd" "" "$INSTDIR\resources\icon.ico"
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\DracoCLI" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DracoCLI" "DisplayName" "Draco CLI"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DracoCLI" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DracoCLI" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DracoCLI" "InstallLocation" "$INSTDIR"
SectionEnd

Section "Uninstall"
  nsExec::ExecToLog '"$INSTDIR\node.exe" "$INSTDIR\out\main\path-setup.js" remove "$INSTDIR"'
  Pop $0
  ; Keep the user's config and downloads; only remove files owned by this installer.
  RMDir /r "$INSTDIR\out"
  RMDir /r "$INSTDIR\node_modules"
  RMDir /r "$INSTDIR\resources"
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\NODE-LICENSE.txt"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\package-lock.json"
  Delete "$INSTDIR\draco.cmd"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\Draco CLI\Draco CLI.lnk"
  RMDir "$SMPROGRAMS\Draco CLI"
  DeleteRegKey HKCU "Software\DracoCLI"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DracoCLI"
SectionEnd
