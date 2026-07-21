[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$SourcePath,
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\VibeLink CLI'),
  [ValidateSet('dev', 'prod')]
  [string]$Flavor = 'prod',
  [switch]$NoPathUpdate,
  [switch]$SkipSmoke,
  [switch]$Uninstall,
  [switch]$PassThru
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-NormalizedPathEntry([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) { return $null }
  return [System.IO.Path]::GetFullPath($PathValue.Trim().TrimEnd('\', '/')).TrimEnd('\')
}

function Get-UserPathEntries {
  $raw = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
  return @($raw.Split(';', [System.StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Set-UserPathEntries([string[]]$Entries) {
  $deduplicated = New-Object System.Collections.Generic.List[string]
  $seen = New-Object System.Collections.Generic.HashSet[string]([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $Entries) {
    $normalized = Get-NormalizedPathEntry $entry
    if ($normalized -and $seen.Add($normalized)) { $deduplicated.Add($entry.Trim().TrimEnd('\')) }
  }
  [Environment]::SetEnvironmentVariable('Path', ($deduplicated -join ';'), 'User')
}

function Publish-EnvironmentChange {
  if (-not ('VibeLink.CliInstaller.NativeMethods' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace VibeLink.CliInstaller {
  public static class NativeMethods {
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
  }
}
'@
  }
  $result = [UIntPtr]::Zero
  [void][VibeLink.CliInstaller.NativeMethods]::SendMessageTimeout(
    [IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$result
  )
}

function Resolve-CliSource([string]$ExplicitPath) {
  if ($ExplicitPath) {
    $resolved = [System.IO.Path]::GetFullPath($ExplicitPath)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "CLI source does not exist: $resolved" }
    return $resolved
  }
  $repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
  $candidates = @(
    (Join-Path $repoRoot 'src-tauri\target\release\vibelink.exe'),
    (Join-Path $repoRoot 'src-tauri\target\debug\vibelink.exe')
  )
  $staged = Get-ChildItem -LiteralPath (Join-Path $repoRoot 'src-tauri\binaries') -Filter 'vibelink-*.exe' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -ExpandProperty FullName
  $candidates += @($staged)
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return [System.IO.Path]::GetFullPath($candidate)
    }
  }
  throw 'Could not find vibelink.exe. Build it with `cargo build --release --bin vibelink` or pass -SourcePath.'
}

$installRoot = Get-NormalizedPathEntry $InstallDirectory
if (-not $installRoot) { throw 'InstallDirectory must not be empty.' }
$destination = Join-Path $installRoot 'vibelink.exe'

if ($Uninstall) {
  if ($PSCmdlet.ShouldProcess($destination, 'Uninstall VibeLink CLI')) {
    if (Test-Path -LiteralPath $destination -PathType Leaf) { Remove-Item -LiteralPath $destination -Force }
    if (-not $NoPathUpdate) {
      $remaining = @(Get-UserPathEntries | Where-Object { (Get-NormalizedPathEntry $_) -ne $installRoot })
      Set-UserPathEntries $remaining
      Publish-EnvironmentChange
    }
    if ((Test-Path -LiteralPath $installRoot -PathType Container) -and -not (Get-ChildItem -LiteralPath $installRoot -Force | Select-Object -First 1)) {
      Remove-Item -LiteralPath $installRoot -Force
    }
  }
  $result = [pscustomobject]@{ action = 'uninstall'; path = $destination; flavor = $Flavor; pathUpdated = -not $NoPathUpdate }
  if ($PassThru) { return $result }
  Write-Host "VibeLink CLI removed: $destination"
  return
}

$source = Resolve-CliSource $SourcePath
if ($PSCmdlet.ShouldProcess($destination, "Install VibeLink CLI from $source")) {
  New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
  $stagedPath = Join-Path $installRoot (".vibelink.{0}.tmp" -f [Guid]::NewGuid().ToString('N'))
  try {
    Copy-Item -LiteralPath $source -Destination $stagedPath -Force
    Move-Item -LiteralPath $stagedPath -Destination $destination -Force
  } finally {
    if (Test-Path -LiteralPath $stagedPath) { Remove-Item -LiteralPath $stagedPath -Force }
  }

  if (-not $NoPathUpdate) {
    $entries = @(Get-UserPathEntries)
    if (-not ($entries | Where-Object { (Get-NormalizedPathEntry $_) -eq $installRoot })) {
      $entries += $installRoot
      Set-UserPathEntries $entries
      Publish-EnvironmentChange
    }
  }

  if (-not $SkipSmoke) {
    $output = & $destination status --json --flavor $Flavor --request-timeout-seconds 1 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -notin @(0, 3)) {
      throw "Installed CLI smoke failed with exit code $exitCode`: $($output -join [Environment]::NewLine)"
    }
    $jsonLine = @($output | Where-Object { $_ -is [string] -and $_.TrimStart().StartsWith('{') } | Select-Object -First 1)
    if (-not $jsonLine) { throw 'Installed CLI smoke did not return its JSON envelope.' }
    $envelope = $jsonLine | ConvertFrom-Json
    if ($envelope.version -ne 1 -or $null -eq $envelope.ok) { throw 'Installed CLI smoke returned an invalid envelope.' }
  }
}

$result = [pscustomobject]@{
  action = 'install'
  source = $source
  path = $destination
  flavor = $Flavor
  pathUpdated = -not $NoPathUpdate
}
if ($PassThru) { return $result }
Write-Host "VibeLink CLI installed: $destination"
if (-not $NoPathUpdate) { Write-Host 'User PATH updated. Open a new terminal before running vibelink.' }
