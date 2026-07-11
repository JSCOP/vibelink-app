param(
  [ValidateSet('menu', 'help', 'build', 'release-build', 'dev-run', 'release-run', 'installer-dev', 'installer-release', 'installers', 'version-preview')]
  [string]$Action = 'menu',
  [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$DevConfig = Join-Path $RepoRoot 'src-tauri\tauri.dev.conf.json'
$ReleaseExe = Join-Path $RepoRoot 'src-tauri\target\release\app.exe'
$StopLegacyDevLocks = Join-Path $RepoRoot 'scripts\stop-legacy-dev-locks.ps1'
$PackageJson = Join-Path $RepoRoot 'package.json'
$CargoToml = Join-Path $RepoRoot 'src-tauri\Cargo.toml'
$CargoLock = Join-Path $RepoRoot 'src-tauri\Cargo.lock'
$TauriConfig = Join-Path $RepoRoot 'src-tauri\tauri.conf.json'
$BuildVoiceSidecar = Join-Path $RepoRoot 'scripts\build-voice-sidecar.ps1'
$VoiceSidecarDistExe = Join-Path $RepoRoot 'voice-sidecar\dist\vibelink-voice-sidecar.exe'


function Write-Section([string]$Title) {
  Write-Host ''
  Write-Host ('─' * 72) -ForegroundColor DarkGray
  Write-Host $Title -ForegroundColor Cyan
  Write-Host ('─' * 72) -ForegroundColor DarkGray
}

function Invoke-Checked([string]$File, [string[]]$Arguments) {
  Write-Host "> $File $($Arguments -join ' ')" -ForegroundColor DarkGray
  & $File @Arguments
  $exitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 0 }
  if ($exitCode -ne 0) {
    throw "Command failed with exit code $exitCode`: $File $($Arguments -join ' ')"
  }
}

function Assert-Tool([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required tool not found on PATH: $Name"
  }
}

function Enter-RepoRoot {
  Set-Location -LiteralPath $RepoRoot
}

function Show-PortOwner([int]$Port) {
  $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $connections) { return }

  Write-Host "Port $Port is already listening:" -ForegroundColor Yellow
  Get-CimInstance Win32_Process |
    Where-Object { $connections.OwningProcess -contains $_.ProcessId } |
    Select-Object Name, ProcessId, ParentProcessId, ExecutablePath, CommandLine |
    Format-List
  Write-Host 'Not stopping anything automatically. Close the shown owner if it is not this dev run.' -ForegroundColor Yellow
}

function Show-Bundles([string]$Profile) {
  $bundleRoot = Join-Path $RepoRoot "src-tauri\target\$Profile\bundle"
  if (-not (Test-Path -LiteralPath $bundleRoot)) {
    Write-Host "No bundle directory found: $bundleRoot" -ForegroundColor Yellow
    return
  }

  Write-Host "Bundle output:" -ForegroundColor Green
  Get-ChildItem -LiteralPath $bundleRoot -Recurse -File |
    Where-Object { $_.Extension -in '.msi', '.exe' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object FullName, Length, LastWriteTime |
    Format-Table -AutoSize
}

function Read-Text([string]$Path) {
  Get-Content -LiteralPath $Path -Raw -Encoding UTF8
}

function Write-Text([string]$Path, [string]$Content, [switch]$DryRun) {
  if ($DryRun) { return }
  [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-JsonVersion([string]$Path) {
  $json = Read-Text $Path | ConvertFrom-Json
  if (-not $json.version) { throw "Missing version field: $Path" }
  [string]$json.version
}

function Get-CargoPackageVersion([string]$Path) {
  $text = Read-Text $Path
  $packageMatch = [regex]::Match($text, '(?ms)^\[package\]\s*(.*?)(?=^\[|\z)')
  if (-not $packageMatch.Success) { throw "Missing [package] block: $Path" }
  $versionMatch = [regex]::Match($packageMatch.Groups[1].Value, '(?m)^version\s*=\s*"([^"]+)"')
  if (-not $versionMatch.Success) { throw "Missing package version: $Path" }
  $versionMatch.Groups[1].Value
}

function Get-NextPatchVersion([string]$Current) {
  $match = [regex]::Match($Current, '^(\d+)\.(\d+)\.(\d+)$')
  if (-not $match.Success) {
    throw "Cannot auto-bump non-simple semver '$Current'. Pass -Version x.y.z explicitly."
  }
  $major = [int]$match.Groups[1].Value
  $minor = [int]$match.Groups[2].Value
  $patch = [int]$match.Groups[3].Value + 1
  "$major.$minor.$patch"
}

function Assert-SimpleSemver([string]$Value) {
  if (-not [regex]::IsMatch($Value, '^\d+\.\d+\.\d+$')) {
    throw "Version must be simple semver x.y.z: $Value"
  }
}

function Set-JsonVersion([string]$Path, [string]$Old, [string]$New, [switch]$DryRun) {
  $text = Read-Text $Path
  $pattern = '("version"\s*:\s*)"' + [regex]::Escape($Old) + '"'
  $regex = [regex]::new($pattern)
  $updated = $regex.Replace($text, { param($m) $m.Groups[1].Value + '"' + $New + '"' }, 1)
  if ($updated -eq $text) { throw "Could not update version in $Path" }
  Write-Text $Path $updated -DryRun:$DryRun
}

function Set-CargoPackageVersion([string]$Path, [string]$Old, [string]$New, [switch]$DryRun) {
  $text = Read-Text $Path
  $pattern = '(?ms)(^\[package\]\s*.*?^version\s*=\s*")' + [regex]::Escape($Old) + '(")'
  $regex = [regex]::new($pattern)
  $updated = $regex.Replace($text, { param($m) $m.Groups[1].Value + $New + $m.Groups[2].Value }, 1)
  if ($updated -eq $text) { throw "Could not update package version in $Path" }
  Write-Text $Path $updated -DryRun:$DryRun
}

function Set-CargoLockPackageVersion([string]$Path, [string]$Old, [string]$New, [switch]$DryRun) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $text = Read-Text $Path
  $pattern = '(?ms)(^\[\[package\]\]\s*name\s*=\s*"app"\s*version\s*=\s*")' + [regex]::Escape($Old) + '(")'
  $regex = [regex]::new($pattern)
  $updated = $regex.Replace($text, { param($m) $m.Groups[1].Value + $New + $m.Groups[2].Value }, 1)
  if ($updated -eq $text) { throw "Could not update app package version in $Path" }
  Write-Text $Path $updated -DryRun:$DryRun
}

function Invoke-InstallerVersionBump([switch]$DryRun) {
  $versions = [ordered]@{
    'package.json' = Get-JsonVersion $PackageJson
    'src-tauri/Cargo.toml' = Get-CargoPackageVersion $CargoToml
    'src-tauri/tauri.conf.json' = Get-JsonVersion $TauriConfig
  }

  $current = $versions['package.json']
  foreach ($entry in $versions.GetEnumerator()) {
    if ($entry.Value -ne $current) {
      throw "Version mismatch: package.json=$current, $($entry.Key)=$($entry.Value). Fix versions before building installers."
    }
  }

  $next = if ($Version.Trim().Length -gt 0) { $Version.Trim() } else { Get-NextPatchVersion $current }
  Assert-SimpleSemver $next
  if ($next -eq $current) { throw "Installer version is already $current; choose a newer version." }

  Set-JsonVersion $PackageJson $current $next -DryRun:$DryRun
  Set-CargoPackageVersion $CargoToml $current $next -DryRun:$DryRun
  Set-JsonVersion $TauriConfig $current $next -DryRun:$DryRun
  Set-CargoLockPackageVersion $CargoLock $current $next -DryRun:$DryRun

  $mode = if ($DryRun) { 'Would bump' } else { 'Bumped' }
  Write-Host "$mode installer version: $current -> $next" -ForegroundColor Green
}

function Invoke-DevBuild {
  Write-Section 'Build: debug/dev flavor executable, no installer'
  Enter-RepoRoot
  Assert-Tool 'pnpm'
  if (Test-Path -LiteralPath $StopLegacyDevLocks) {
    & $StopLegacyDevLocks
  }
  Invoke-Checked 'pnpm' @('exec', 'tauri', 'build', '--debug', '--no-bundle', '--config', $DevConfig)
  Write-Host 'Debug/dev build complete: src-tauri\target\debug\app.exe' -ForegroundColor Green
}

function Invoke-ReleaseBuild {
  Write-Section 'Build: release executable, no installer'
  Enter-RepoRoot
  Assert-Tool 'pnpm'
  Invoke-Checked 'pnpm' @('exec', 'tauri', 'build', '--no-bundle')
  Write-Host 'Release build complete: src-tauri\target\release\app.exe' -ForegroundColor Green
}

function Invoke-DevRun {
  Write-Section 'Run: dev flavor with Vite hot reload'
  Enter-RepoRoot
  Assert-Tool 'pnpm'
  Show-PortOwner 1420
  if (Test-Path -LiteralPath $StopLegacyDevLocks) {
    & $StopLegacyDevLocks
  }
  Invoke-Checked 'pnpm' @('exec', 'tauri', 'dev', '--config', $DevConfig)
}

function Invoke-ReleaseRun {
  Write-Section 'Run: built release executable'
  Enter-RepoRoot
  if (-not (Test-Path -LiteralPath $ReleaseExe)) {
    Write-Host 'Release executable is missing; building it first.' -ForegroundColor Yellow
    Invoke-ReleaseBuild
  }
  $process = Start-Process -FilePath $ReleaseExe -WorkingDirectory (Split-Path -Parent $ReleaseExe) -PassThru
  Write-Host "Started release app PID $($process.Id): $ReleaseExe" -ForegroundColor Green
}

function Ensure-VoiceSidecar {
  if (-not (Test-Path -LiteralPath $BuildVoiceSidecar)) {
    throw "Voice sidecar build script is missing: $BuildVoiceSidecar"
  }

  $sourceFiles = @(
    Get-ChildItem -LiteralPath (Join-Path $RepoRoot 'voice-sidecar\src') -File
    Get-Item -LiteralPath (Join-Path $RepoRoot 'voice-sidecar\Cargo.toml')
    Get-Item -LiteralPath $BuildVoiceSidecar
  )
  $distItem = Get-Item -LiteralPath $VoiceSidecarDistExe -ErrorAction SilentlyContinue
  $isStale = -not $distItem -or ($sourceFiles | Where-Object { $_.LastWriteTimeUtc -gt $distItem.LastWriteTimeUtc })
  if ($isStale) {
    Write-Section 'Build: CUDA voice sidecar'
    & $BuildVoiceSidecar
    if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) {
      throw "Voice sidecar build failed with exit code $LASTEXITCODE"
    }
  }
}

function Invoke-DevInstaller([switch]$SkipVersionBump) {
  Write-Section 'Installer: dev flavor, debug build, side-by-side data'
  Enter-RepoRoot
  Assert-Tool 'pnpm'
  Ensure-VoiceSidecar
  if (-not $SkipVersionBump) { Invoke-InstallerVersionBump }
  if (Test-Path -LiteralPath $StopLegacyDevLocks) {
    & $StopLegacyDevLocks
  }
  Invoke-Checked 'pnpm' @('exec', 'tauri', 'build', '--debug', '--config', $DevConfig, '--bundles', 'msi', 'nsis')
  Show-Bundles 'debug'
}

function Invoke-ReleaseInstaller([switch]$SkipVersionBump) {
  Write-Section 'Installer: release flavor'
  Enter-RepoRoot
  Assert-Tool 'pnpm'
  Ensure-VoiceSidecar
  if (-not $SkipVersionBump) { Invoke-InstallerVersionBump }
  Invoke-Checked 'pnpm' @('exec', 'tauri', 'build', '--bundles', 'msi', 'nsis')
  Show-Bundles 'release'
}

function Invoke-AllInstallers {
  Enter-RepoRoot
  Invoke-InstallerVersionBump
  Invoke-DevInstaller -SkipVersionBump
  Invoke-ReleaseInstaller -SkipVersionBump
}

function Show-HelpText {
  Write-Host @'
VibeLink interactive build/run helper

Usage:
  powershell -ExecutionPolicy Bypass -File scripts\vibelink.ps1
  powershell -ExecutionPolicy Bypass -File scripts\vibelink.ps1 -Action dev-run

Actions:
  build              Debug/dev flavor executable only. Fast local compile; no installer.
  release-build      Optimized production executable only; no installer.
  dev-run            Tauri dev mode using tauri.dev.conf.json and Vite hot reload.
  release-run        Starts src-tauri\target\release\app.exe; builds first if missing.
  installer-dev      Dev-flavor installer; auto-bumps patch version first.
  installer-release  Production installer; auto-bumps patch version first.
  installers         Builds both installers after one shared patch bump.
  version-preview    Shows the next installer version without changing files.

Debug vs release:
  Debug/dev is for fast iteration and uses the Dev flavor/data directory.
  Release is optimized and is what users should install/run.
  You do not need both every time; keep debug for development, release for distribution.

Versioning:
  Installer actions update package.json, src-tauri/Cargo.toml,
  src-tauri/Cargo.lock, and src-tauri/tauri.conf.json from x.y.z to x.y.(z+1).
  Pass -Version x.y.z with installer actions to force a specific newer version.

Safety:
  This script does not broad-kill processes. Dev run/build only delegates to
  scripts\stop-legacy-dev-locks.ps1, which stops exact src-tauri\target\debug\app.exe PIDs.
'@ -ForegroundColor Gray
}

function Invoke-Action([string]$Name) {
  switch ($Name) {
    'help' { Show-HelpText }
    'build' { Invoke-DevBuild }
    'release-build' { Invoke-ReleaseBuild }
    'dev-run' { Invoke-DevRun }
    'release-run' { Invoke-ReleaseRun }
    'installer-dev' { Invoke-DevInstaller }
    'installer-release' { Invoke-ReleaseInstaller }
    'installers' { Invoke-AllInstallers }
    'version-preview' { Invoke-InstallerVersionBump -DryRun }
    default { throw "Unknown action: $Name" }
  }
}

function Show-Menu {
  while ($true) {
    Write-Section 'VibeLink build menu'
    Write-Host '1. Build debug/dev executable (no installer)'
    Write-Host '2. Build release executable (no installer)'
    Write-Host '3. Run dev app (hot reload)'
    Write-Host '4. Run release app'
    Write-Host '5. Create dev-flavor installer'
    Write-Host '6. Create release installer'
    Write-Host '7. Create both installers'
    Write-Host 'v. Preview next installer version'
    Write-Host 'h. Help / debug vs release explanation'
    Write-Host 'q. Quit'
    $choice = Read-Host 'Select'

    try {
      switch ($choice.Trim().ToLowerInvariant()) {
        '1' { Invoke-DevBuild }
        '2' { Invoke-ReleaseBuild }
        '3' { Invoke-DevRun }
        '4' { Invoke-ReleaseRun }
        '5' { Invoke-DevInstaller }
        '6' { Invoke-ReleaseInstaller }
        '7' { Invoke-AllInstallers }
        'v' { Invoke-InstallerVersionBump -DryRun }
        'version' { Invoke-InstallerVersionBump -DryRun }
        'h' { Show-HelpText }
        'help' { Show-HelpText }
        'q' { return }
        'quit' { return }
        default { Write-Host 'Unknown selection.' -ForegroundColor Yellow }
      }
    } catch {
      Write-Host $_.Exception.Message -ForegroundColor Red
    }
  }
}

if ($Action -eq 'menu') {
  Show-Menu
} else {
  Invoke-Action $Action
}
