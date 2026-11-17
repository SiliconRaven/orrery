!macro StopInstalledHub
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ClearErrors
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --orrery-quit-for-update' $0
    ${If} ${Errors}
    ${OrIf} $0 != 0
      MessageBox MB_ICONSTOP|MB_OK "Orrery Beta could not stop its background Hub. Close the Hub from Orrery and retry. No other Node process was stopped." /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  !insertmacro StopInstalledHub
!macroend

!macro customUnInstall
  !insertmacro StopInstalledHub
!macroend
