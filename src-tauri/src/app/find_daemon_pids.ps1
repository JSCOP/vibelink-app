$ErrorActionPreference = 'Stop'
$exe = [System.IO.Path]::GetFullPath($env:AWT_DAEMON_EXE)
$daemonDir = $null
if ($env:AWT_DAEMON_DIR) {
  $daemonDir = [System.IO.Path]::GetFullPath($env:AWT_DAEMON_DIR).TrimEnd('\') + '\'
}
$copyPrefix = "app-daemon-$($env:AWT_APP_FLAVOR)-"

Get-CimInstance Win32_Process |
  Where-Object {
    if (-not $_.ExecutablePath -or -not ($_.CommandLine -like '*--daemon*')) {
      return $false
    }

    $processExe = [System.IO.Path]::GetFullPath($_.ExecutablePath)
    if ([System.String]::Equals($processExe, $exe, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }

    if ($daemonDir -and $processExe.StartsWith($daemonDir, [System.StringComparison]::OrdinalIgnoreCase)) {
      $fileName = [System.IO.Path]::GetFileName($processExe)
      return $fileName.StartsWith($copyPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        $fileName.EndsWith('.exe', [System.StringComparison]::OrdinalIgnoreCase)
    }

    return $false
  } |
  ForEach-Object { $_.ProcessId }
