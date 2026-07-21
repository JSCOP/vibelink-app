param(
  [ValidateSet('debug', 'release')]
  [string]$Profile = 'release'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$TauriRoot = Join-Path $RepoRoot 'src-tauri'
$CargoArgs = @('build', '--manifest-path', (Join-Path $TauriRoot 'Cargo.toml'), '--bin', 'vibelink', '--bin', 'vibelink-computer-host')
if ($Profile -eq 'release') { $CargoArgs += '--release' }

& cargo @CargoArgs
if ($LASTEXITCODE -ne 0) { throw "Sidecar cargo build failed with exit code $LASTEXITCODE." }

foreach ($Name in @('vibelink', 'vibelink-computer-host')) {
  $Output = Join-Path $TauriRoot "target\$Profile\$Name.exe"
  if (-not (Test-Path -LiteralPath $Output -PathType Leaf)) { throw "Sidecar output is missing: $Output" }
  Write-Host "Prepared sidecar: $Output"
}
