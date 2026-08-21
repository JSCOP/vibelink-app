; VibeLink NSIS installer hooks.
;
; Updating over a running install used to abort with
;   Error opening file for writing: ...\VibeLink\vibelink.exe
; because `vibelink.exe mcp serve` is a long-lived stdio server that whichever agent CLI started it
; keeps alive for the whole session. Those processes are children of the agent, not of VibeLink, so
; the installer has no standing to close them, and a mapped PE image cannot be overwritten.
;
; Windows does allow such a file to be RENAMED. Moving it aside lets the running process keep the
; image it already mapped while the new build lands at the real path for the next launch, so the
; update completes without asking anyone to quit their agent. The stale copies are deleted by the
; next install and by the app at startup.

!macro VibeLinkMoveAside FILE
  ; Clear the previous generation first; by now nothing is still running from it.
  Delete "$INSTDIR\${FILE}.old"
  ClearErrors
  ; Rename rather than Delete: Delete fails on a mapped image, Rename does not.
  Rename "$INSTDIR\${FILE}" "$INSTDIR\${FILE}.old"
  ; A fresh install has nothing to move, and a failed rename must not abort the installer -
  ; the file copy that follows reports the real problem if there still is one.
  ClearErrors
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro VibeLinkMoveAside "vibelink.exe"
  !insertmacro VibeLinkMoveAside "vibelink-computer-host.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\vibelink.exe.old"
  Delete "$INSTDIR\vibelink-computer-host.exe.old"
  ClearErrors
!macroend
