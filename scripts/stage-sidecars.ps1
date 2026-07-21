param(
  [ValidateSet('debug', 'release')]
  [string]$Profile = 'release'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$TauriRoot = Join-Path $RepoRoot 'src-tauri'
$BinariesRoot = Join-Path $TauriRoot 'binaries'
$HostLine = (& rustc -vV | Where-Object { $_ -like 'host:*' } | Select-Object -First 1)
if (-not $HostLine) { throw 'Could not determine the Rust host target.' }
$TargetTriple = ($HostLine -split ':', 2)[1].Trim()
$CargoArgs = @('build', '--manifest-path', (Join-Path $TauriRoot 'Cargo.toml'), '--bin', 'vibelink', '--bin', 'vibelink-computer-host')
if ($Profile -eq 'release') { $CargoArgs += '--release' }

$PreviousTauriConfig = $env:TAURI_CONFIG
$env:TAURI_CONFIG = '{"bundle":{"externalBin":[]}}'
& cargo @CargoArgs
if ($null -eq $PreviousTauriConfig) { Remove-Item Env:TAURI_CONFIG -ErrorAction SilentlyContinue } else { $env:TAURI_CONFIG = $PreviousTauriConfig }
if ($LASTEXITCODE -ne 0) { throw "Sidecar cargo build failed with exit code $LASTEXITCODE." }

New-Item -ItemType Directory -Force -Path $BinariesRoot | Out-Null
foreach ($Name in @('vibelink', 'vibelink-computer-host')) {
  $Source = Join-Path $TauriRoot "target\$Profile\$Name.exe"
  $Destination = Join-Path $BinariesRoot "$Name-$TargetTriple.exe"
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "Sidecar output is missing: $Source" }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
  Write-Host "Staged sidecar: $Destination"
}
