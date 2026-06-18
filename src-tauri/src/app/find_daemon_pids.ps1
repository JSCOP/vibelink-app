$ErrorActionPreference = 'Stop'
$exe = [System.IO.Path]::GetFullPath($env:AWT_DAEMON_EXE)
Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -eq $exe -and $_.CommandLine -like '*--daemon*' } |
  ForEach-Object { $_.ProcessId }
