; SPDX-License-Identifier: MIT
; Copyright (c) 2026 NEURAFLOK contributors
!macro grantSandboxReadAccess
  ClearErrors
  ExecWait '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)" /Q' $0
  ${If} ${Errors}
    StrCpy $0 2
  ${EndIf}
  ${If} $0 != 0
    SetErrorLevel 2
    Abort "Windows could not set the folder access needed to start NEURAFLOK safely."
  ${EndIf}
!macroend

!macro customInit
  # Repair an existing install before an update removes its runnable version.
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    !insertmacro grantSandboxReadAccess
  ${EndIf}
!macroend

!macro customInstall
  # Grant Chromium's sandbox inherited read and execute access without resetting other ACLs.
  !insertmacro grantSandboxReadAccess
!macroend
