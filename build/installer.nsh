; Custom NSIS hooks for electron-builder (per-user install).

; On a real uninstall (not an in-place update) remove the per-user browser native-messaging registry keys. The shared
; ~/.zdm folders (extension copy, connector manifests) are deliberately left alone: the regular and the
; Legacy build share them, and deleting them broke the other build's browser connection.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.zelvior.zdm.host"
    DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.zelvior.zdm.host"
    DeleteRegKey HKCU "Software\Mozilla\NativeMessagingHosts\com.zelvior.zdm.host"
  ${endIf}
!macroend

; The app hides to the system tray when its window is closed, so the installer's polite close request never ends the
; process and setup stops with "cannot be closed. Please close it manually". End the running app (and its helper
; processes) up front. Downloads resume afterwards: progress is checkpointed every two seconds.
!macro zdmStopApp
  nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 1500
!macroend
!macro customInit
  !insertmacro zdmStopApp
!macroend
!macro customUnInit
  !insertmacro zdmStopApp
!macroend
!macro customCheckAppRunning
  !insertmacro zdmStopApp
!macroend

; Hide the "<product> <version>" branding text at the bottom of the installer and uninstaller windows.
!macro customHeader
  BrandingText " "
!macroend
