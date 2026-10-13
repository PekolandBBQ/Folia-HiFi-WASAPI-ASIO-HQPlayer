; packaging/exclusive/private-development-installer.nsi — private, current-user development distribution.
Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
Name "Folia HiFi Private Development r4"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\FoliaHiFiPrivateDevelopment-20261006"
RequestExecutionLevel user
SetCompressor lzma
SetCompressorDictSize 32
SetOverwrite on
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "0.7.12.4"
VIAddVersionKey /LANG=1033 "ProductName" "Folia HiFi Private Development"
VIAddVersionKey /LANG=1033 "ProductVersion" "0.7.12-private.r4"
VIAddVersionKey /LANG=1033 "FileVersion" "0.7.12.4"
VIAddVersionKey /LANG=1033 "FileDescription" "Private development installer; Windows execution not validated"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Folia contributors; see bundled licenses"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TEXT "This private development build has not been validated by Windows execution. Close Folia before installing. Your existing private profile is preserved. Native audio and HQPlayer components can be installed in Settings. Spotify setup downloads the personal SDK through the normal app flow."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchFolia
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!define MUI_FINISHPAGE_RUN_TEXT "Launch Folia HiFi Private Development"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function LaunchFolia
    Exec '"$INSTDIR\electron\electron.exe" "$INSTDIR\app"'
FunctionEnd

Function .onInit
    ${IfNot} ${RunningX64}
        MessageBox MB_OK|MB_ICONSTOP "This private build requires 64-bit Windows."
        Abort
    ${EndIf}
FunctionEnd

Section "Install"
    SetShellVarContext current
    ; Only replace the two application directories. Never touch AppData or kill processes.
    ClearErrors
    IfFileExists "$INSTDIR\app\*.*" 0 app_removed
    RMDir /r "$INSTDIR\app"
    IfErrors install_locked
    app_removed:
    IfFileExists "$INSTDIR\electron\*.*" 0 electron_removed
    RMDir /r "$INSTDIR\electron"
    IfErrors install_locked
    electron_removed:
    SetOutPath "$INSTDIR"
    !include "${PAYLOAD_INCLUDE}"
    CreateDirectory "$SMPROGRAMS\Folia HiFi Private Development 20261006"
    CreateShortCut "$SMPROGRAMS\Folia HiFi Private Development 20261006\Folia.lnk" "$INSTDIR\electron\electron.exe" '"$INSTDIR\app"'
    CreateShortCut "$SMPROGRAMS\Folia HiFi Private Development 20261006\Open diagnostic folder.lnk" "$WINDIR\explorer.exe" '"$APPDATA\Folia HiFi Private Development 20261006\diagnostics"'
    WriteUninstaller "$INSTDIR\Uninstall.exe"
    CreateShortCut "$SMPROGRAMS\Folia HiFi Private Development 20261006\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoliaHiFiPrivateDevelopment20261006" "DisplayName" "Folia HiFi Private Development"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoliaHiFiPrivateDevelopment20261006" "DisplayVersion" "0.7.12-private.r4"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoliaHiFiPrivateDevelopment20261006" "UninstallString" '"$INSTDIR\Uninstall.exe"'
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoliaHiFiPrivateDevelopment20261006" "InstallLocation" "$INSTDIR"
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoliaHiFiPrivateDevelopment20261006" "NoModify" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoliaHiFiPrivateDevelopment20261006" "NoRepair" 1
    Goto install_done
    install_locked:
    MessageBox MB_OK|MB_ICONSTOP "Close Folia and retry. The application files could not be replaced. Your profile was preserved."
    Abort
    install_done:
SectionEnd

Section "Uninstall"
    SetShellVarContext current
    RMDir /r "$INSTDIR\app"
    RMDir /r "$INSTDIR\electron"
    Delete "$INSTDIR\Uninstall.exe"
    RMDir "$INSTDIR"
    Delete "$SMPROGRAMS\Folia HiFi Private Development 20261006\Folia.lnk"
    Delete "$SMPROGRAMS\Folia HiFi Private Development 20261006\Open diagnostic folder.lnk"
    Delete "$SMPROGRAMS\Folia HiFi Private Development 20261006\Uninstall.lnk"
    RMDir "$SMPROGRAMS\Folia HiFi Private Development 20261006"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoliaHiFiPrivateDevelopment20261006"
SectionEnd
