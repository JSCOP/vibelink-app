$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$debugExe = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'src-tauri\target\debug\app.exe'))

if (-not (Test-Path -LiteralPath $debugExe)) {
  exit 0
}

$candidates = Get-CimInstance Win32_Process |
  Where-Object {
    if (-not $_.ExecutablePath) {
      return $false
    }
    $processExe = [System.IO.Path]::GetFullPath($_.ExecutablePath)
    [System.String]::Equals($processExe, $debugExe, [System.StringComparison]::OrdinalIgnoreCase)
  } |
  Select-Object Name, ProcessId, ParentProcessId, ExecutablePath, CommandLine

foreach ($process in $candidates) {
  Write-Host "Stopping legacy dev app lock:"
  Write-Host "  Name=$($process.Name)"
  Write-Host "  PID=$($process.ProcessId)"
  Write-Host "  ParentPID=$($process.ParentProcessId)"
  Write-Host "  ExecutablePath=$($process.ExecutablePath)"
  Write-Host "  CommandLine=$($process.CommandLine)"
  Stop-Process -Id $process.ProcessId -ErrorAction Stop
}

foreach ($process in $candidates) {
  try {
    Wait-Process -Id $process.ProcessId -Timeout 3 -ErrorAction Stop
  } catch {
    $stillRunning = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ProcessId)" -ErrorAction SilentlyContinue
    if ($stillRunning) {
      throw "Legacy dev app lock PID $($process.ProcessId) did not exit"
    }
  }
}
