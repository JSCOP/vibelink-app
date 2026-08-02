param(
  [ValidateSet('menu', 'help', 'build', 'release-build', 'dev-run', 'dev-status', 'release-run', 'installer-dev', 'installer-release', 'installer-ci', 'dev-release', 'installers', 'open-installers', 'version-preview', 'version-bump')]
  [string]$Action = 'menu',
  [string]$Version = '',
  [string]$ConfigOverlay = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$DevConfig = Join-Path $RepoRoot 'src-tauri\tauri.dev.conf.json'
$ReleaseExe = Join-Path $RepoRoot 'src-tauri\target\release\app.exe'
$StopLegacyDevLocks = Join-Path $RepoRoot 'scripts\stop-legacy-dev-locks.ps1'
$StageSidecars = Join-Path $RepoRoot 'scripts\stage-sidecars.ps1'
$PackageJson = Join-Path $RepoRoot 'package.json'
$CargoToml = Join-Path $RepoRoot 'src-tauri\Cargo.toml'
$CargoLock = Join-Path $RepoRoot 'src-tauri\Cargo.lock'
$TauriConfig = Join-Path $RepoRoot 'src-tauri\tauri.conf.json'
$VerifyEmbeddedAssets = Join-Path $RepoRoot 'scripts\verify-embedded-assets.mjs'
$DevVitePort = 1420
$DevVitePortEnd = 1439
$ProdWebViewCdpPort = 9333
$DevWebViewCdpPort = 19333
$DevWebViewCdpPortEnd = 19363
$DevBrowserProfilePort = 19400
$DevBrowserProfilePortEnd = 19655
$ProdRemotePort = 42811
$DevRemotePort = 42812
$DebugAppExe = Join-Path $RepoRoot 'src-tauri\target\debug\app.exe'
$GeneratedDevConfig = Join-Path $RepoRoot 'src-tauri\target\vibelink-dev-runtime.conf.json'

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

function Assert-LocalTauriCli {
  $tauriCommand = Join-Path $RepoRoot 'node_modules\.bin\tauri.cmd'
  if (Test-Path -LiteralPath $tauriCommand -PathType Leaf) { return }

  Assert-Tool 'pnpm'
  Write-Host 'Local Tauri CLI is missing; installing node dependencies with pnpm.' -ForegroundColor Yellow
  Push-Location -LiteralPath $RepoRoot
  try {
    & pnpm install --frozen-lockfile
    $exitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 0 }
    if ($exitCode -ne 0) {
      Write-Host 'Frozen-lockfile install failed; retrying with a lockfile update.' -ForegroundColor Yellow
      & pnpm install
      $exitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 0 }
    }
  } finally {
    Pop-Location
  }

  if ($exitCode -ne 0) {
    throw "pnpm install failed with exit code $exitCode. Run it manually from $RepoRoot, then retry."
  }
  if (-not (Test-Path -LiteralPath $tauriCommand -PathType Leaf)) {
    throw "pnpm install completed but $tauriCommand is still missing. Check that @tauri-apps/cli is in devDependencies."
  }
  Write-Host 'Node dependencies installed.' -ForegroundColor Green
}

function Assert-ReleaseLicenseApiUrl {
  if ([string]::IsNullOrWhiteSpace($env:VIBELINK_LICENSE_API_URL)) {
    $env:VIBELINK_LICENSE_API_URL = 'https://vibelink.moobang.net'
    Write-Host 'VIBELINK_LICENSE_API_URL was not set; defaulting to https://vibelink.moobang.net.' -ForegroundColor DarkGray
  }
  try {
    $uri = [System.Uri]$env:VIBELINK_LICENSE_API_URL
  } catch {
    throw 'VIBELINK_LICENSE_API_URL must be a valid absolute HTTPS origin.'
  }
  if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'https' -or -not [string]::IsNullOrEmpty($uri.UserInfo) -or $uri.AbsolutePath -ne '/' -or -not [string]::IsNullOrEmpty($uri.Query) -or -not [string]::IsNullOrEmpty($uri.Fragment)) {
    throw 'VIBELINK_LICENSE_API_URL must be an HTTPS origin without credentials, path, query, or fragment.'
  }
  if ($uri.AbsoluteUri -ne 'https://vibelink.moobang.net/') {
    throw 'VIBELINK_LICENSE_API_URL must be exactly https://vibelink.moobang.net for release builds.'
  }
}

function Reset-ReleaseBuildArtifacts {
  Assert-Tool 'cargo'
  Write-Host 'Clearing app release artifacts so Tauri embeds the current frontend assets.' -ForegroundColor DarkGray
  Invoke-Checked 'cargo' @('clean', '--release', '--package', 'app', '--manifest-path', $CargoToml)
}

function Enter-RepoRoot {
  Set-Location -LiteralPath $RepoRoot
}

function Get-PortOwners([int]$Port) {
  $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  if ($connections.Count -eq 0) { return }

  foreach ($connection in $connections) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
    [pscustomobject]@{
      Port = $Port
      Address = $connection.LocalAddress
      Name = $process.Name
      ProcessId = $connection.OwningProcess
      ParentProcessId = $process.ParentProcessId
      ExecutablePath = $process.ExecutablePath
      CommandLine = $process.CommandLine
    }
  }
}

function Show-PortOwner([int]$Port, [string]$Label) {
  $owners = @(Get-PortOwners $Port)
  Write-Host "$Label`: $Port" -ForegroundColor Cyan
  if ($owners.Count -eq 0) {
    Write-Host '  free' -ForegroundColor DarkGray
    return
  }
  $owners | Format-List
}

function Test-ProjectDevPortOwner([object]$Owner, [string]$Kind) {
  if ($Kind -eq 'Vite') {
    $commandLine = [string]$Owner.CommandLine
    return $commandLine -like "*$RepoRoot*" -and $commandLine -match '(?i)[\\/]vite(\.js)?([\s\"'']|$)'
  }

  if ($Kind -eq 'WebView2Cdp') {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($Owner.ParentProcessId)" -ErrorAction SilentlyContinue
    return $null -ne $parent -and $parent.ExecutablePath -eq $DebugAppExe
  }

  return $false
}

function Select-DevPort([int]$Start, [int]$End, [string]$Label, [string]$OwnerKind) {
  for ($port = $Start; $port -le $End; $port++) {
    $owners = @(Get-PortOwners $port)
    if ($owners.Count -eq 0) {
      if ($port -ne $Start) {
        Write-Host "$Label preferred port $Start is occupied by another program; using fallback $port." -ForegroundColor Yellow
      }
      return $port
    }

    $existingDevOwners = @($owners | Where-Object { Test-ProjectDevPortOwner $_ $OwnerKind })
    if ($existingDevOwners.Count -gt 0) {
      Write-Host "An existing VibeLink development runtime owns $Label port $port`:" -ForegroundColor Yellow
      $existingDevOwners | Format-List | Out-Host
      throw "VibeLink development is already running on $Label port $port. Refusing to start a second dev runtime."
    }

    if ($port -eq $Start) {
      Write-Host "$Label preferred port $Start is occupied by another program:" -ForegroundColor Yellow
      $owners | Format-List | Out-Host
    }
  }

  throw "No free $Label port remains in the development fallback range $Start-$End. No process was stopped."
}

function Show-DevPortRange([int]$Start, [int]$End, [string]$Label, [string]$OwnerKind) {
  Write-Host "$Label`: $Start-$End (preferred $Start)" -ForegroundColor Cyan
  $occupied = @()
  for ($port = $Start; $port -le $End; $port++) {
    foreach ($owner in @(Get-PortOwners $port)) {
      $occupied += [pscustomobject]@{
        Port = $port
        Scope = if (Test-ProjectDevPortOwner $owner $OwnerKind) { 'VibeLink dev' } else { 'other process' }
        Name = $owner.Name
        ProcessId = $owner.ProcessId
        ParentProcessId = $owner.ParentProcessId
        ExecutablePath = $owner.ExecutablePath
        CommandLine = $owner.CommandLine
      }
    }
  }
  if ($occupied.Count -eq 0) {
    Write-Host '  all free' -ForegroundColor DarkGray
  } else {
    $occupied | Format-List
  }
}

function New-DevRuntimeConfig([int]$VitePort) {
  $config = Get-Content -LiteralPath $DevConfig -Raw | ConvertFrom-Json
  $build = [pscustomobject]@{}
  $build | Add-Member -NotePropertyName 'devUrl' -NotePropertyValue "http://localhost:$VitePort"
  $build | Add-Member -NotePropertyName 'beforeDevCommand' -NotePropertyValue "pnpm exec vite --port $VitePort --strictPort"
  $config | Add-Member -NotePropertyName 'build' -NotePropertyValue $build -Force
  $directory = Split-Path -Parent $GeneratedDevConfig
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $json = $config | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($GeneratedDevConfig, $json, [System.Text.UTF8Encoding]::new($false))
  return $GeneratedDevConfig
}

function Invoke-DevStatus {
  Write-Section 'Runtime isolation status'
  Write-Host 'Development endpoints' -ForegroundColor Green
  Show-DevPortRange $DevVitePort $DevVitePortEnd '  Vite' 'Vite'
  Show-DevPortRange $DevWebViewCdpPort $DevWebViewCdpPortEnd '  WebView2 CDP' 'WebView2Cdp'
  Write-Host "  Browser profiles: $DevBrowserProfilePort-$DevBrowserProfilePortEnd (allocated automatically)" -ForegroundColor Cyan
  Show-PortOwner $DevRemotePort '  Remote default (user-configurable)'
  Write-Host 'Protected release endpoints (observe only; never clean up during development)' -ForegroundColor Yellow
  Show-PortOwner $ProdWebViewCdpPort '  WebView2 CDP'
  Show-PortOwner $ProdRemotePort '  Remote'
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

function Open-InstallerOutputs {
  $installerDirectories = @(
    @(
      (Join-Path $RepoRoot 'src-tauri\target\debug\bundle\nsis'),
      (Join-Path $RepoRoot 'src-tauri\target\release\bundle\nsis')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Container }
  )

  if ($installerDirectories.Count -eq 0) {
    Write-Host 'No NSIS installer output directories found. Build an installer first.' -ForegroundColor Yellow
    return
  }

  foreach ($installerDirectory in $installerDirectories) {
    Invoke-Item -LiteralPath $installerDirectory
    Write-Host "Opened installer output: $installerDirectory" -ForegroundColor Green
  }
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
  Assert-LocalTauriCli
  $env:VITE_VIBELINK_APP_FLAVOR = 'dev'
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
  Assert-LocalTauriCli
  $env:VITE_VIBELINK_APP_FLAVOR = 'prod'
  Assert-ReleaseLicenseApiUrl
  Reset-ReleaseBuildArtifacts
  Invoke-Checked 'pnpm' @('exec', 'tauri', 'build', '--no-bundle')
  Write-Host 'Release build complete: src-tauri\target\release\app.exe' -ForegroundColor Green
}

function Invoke-DevRun {
  Write-Section 'Run: dev flavor with Vite hot reload'
  Enter-RepoRoot
  Assert-Tool 'pnpm'
  Assert-LocalTauriCli
  $env:VITE_VIBELINK_APP_FLAVOR = 'dev'
  $vitePort = Select-DevPort $DevVitePort $DevVitePortEnd 'Vite' 'Vite'
  if (Test-Path -LiteralPath $StopLegacyDevLocks) {
    & $StopLegacyDevLocks
  }
  $webViewCdpPort = Select-DevPort $DevWebViewCdpPort $DevWebViewCdpPortEnd 'WebView2 CDP' 'WebView2Cdp'
  $env:VIBELINK_DEV_VITE_PORT = $vitePort.ToString()
  $env:VIBELINK_BROWSER_CDP_PORT = $webViewCdpPort.ToString()
  $runtimeConfig = New-DevRuntimeConfig $vitePort
  Write-Host "Development only: Vite=$vitePort, WebView2 CDP=$webViewCdpPort, browser profiles=$DevBrowserProfilePort-$DevBrowserProfilePortEnd, Remote default=$DevRemotePort." -ForegroundColor Green
  Write-Host "Release remains protected: WebView2 CDP=$ProdWebViewCdpPort, Remote=$ProdRemotePort." -ForegroundColor Yellow
  & $StageSidecars -Profile debug
  if ($LASTEXITCODE -ne 0) { throw "Sidecar staging failed with exit code $LASTEXITCODE" }
  try {
    Invoke-Checked 'pnpm' @('exec', 'tauri', 'dev', '--config', $runtimeConfig)
  } finally {
    Remove-Item -LiteralPath $runtimeConfig -Force -ErrorAction SilentlyContinue
  }
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

function Invoke-DevInstaller([switch]$SkipVersionBump) {
  Write-Section 'Installer: dev flavor, debug build, side-by-side data'
  Enter-RepoRoot
  Assert-Tool 'pnpm'
  Assert-LocalTauriCli
  $env:VITE_VIBELINK_APP_FLAVOR = 'dev'
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
  Assert-LocalTauriCli
  $env:VITE_VIBELINK_APP_FLAVOR = 'prod'
  Assert-ReleaseLicenseApiUrl
  if (-not $SkipVersionBump) { Invoke-InstallerVersionBump }
  Reset-ReleaseBuildArtifacts
  Invoke-Checked 'pnpm' @('exec', 'tauri', 'build', '--bundles', 'msi', 'nsis')
  Show-Bundles 'release'
}

function Invoke-CiInstaller([switch]$IncrementalLocal) {
  Write-Section $(if ($IncrementalLocal) { 'Installer: incremental local release flavor' } else { 'Installer: CI release flavor without version mutation' })
  Enter-RepoRoot
  Assert-Tool 'pnpm'
  Assert-LocalTauriCli
  $env:VITE_VIBELINK_APP_FLAVOR = 'prod'
  Assert-ReleaseLicenseApiUrl
  $packageVersion = Get-JsonVersion $PackageJson
  $cargoVersion = Get-CargoPackageVersion $CargoToml
  $tauriVersion = Get-JsonVersion $TauriConfig
  if ($packageVersion -ne $cargoVersion -or $packageVersion -ne $tauriVersion) {
    throw "Version mismatch: package.json=$packageVersion, Cargo.toml=$cargoVersion, tauri.conf.json=$tauriVersion"
  }
  if (-not $IncrementalLocal) { Reset-ReleaseBuildArtifacts }
  # Pass the flag explicitly: some runners export CI=1, which Tauri's boolean
  # environment parser rejects even though the CLI flag itself is valid.
  $arguments = @('exec', 'tauri', 'build', '--ci', '--bundles', 'msi', 'nsis')
  if ($ConfigOverlay.Trim().Length -gt 0) {
    $overlay = [System.IO.Path]::GetFullPath($ConfigOverlay)
    if (-not (Test-Path -LiteralPath $overlay -PathType Leaf)) { throw "Config overlay not found: $overlay" }
    $arguments += @('--config', $overlay)
  }

  $previousCargoIncremental = [Environment]::GetEnvironmentVariable('CARGO_INCREMENTAL', 'Process')
  try {
    if ($IncrementalLocal) {
      Assert-Tool 'node'
      if (-not (Test-Path -LiteralPath $VerifyEmbeddedAssets -PathType Leaf)) { throw "Embedded asset verifier not found: $VerifyEmbeddedAssets" }
      $env:CARGO_INCREMENTAL = '1'
    }
    Invoke-Checked 'pnpm' $arguments
    if ($IncrementalLocal) {
      try {
        Invoke-Checked 'node' @($VerifyEmbeddedAssets)
      } catch {
        Write-Host "Incremental asset verification failed; retrying once from a clean app package. $($_.Exception.Message)" -ForegroundColor Yellow
        Reset-ReleaseBuildArtifacts
        Invoke-Checked 'pnpm' $arguments
        Invoke-Checked 'node' @($VerifyEmbeddedAssets)
      }
    }
  } finally {
    if ($IncrementalLocal) {
      if ($null -eq $previousCargoIncremental) {
        Remove-Item Env:CARGO_INCREMENTAL -ErrorAction SilentlyContinue
      } else {
        $env:CARGO_INCREMENTAL = $previousCargoIncremental
      }
    }
  }
  Show-Bundles 'release'
}

function Invoke-AllInstallers {
  Enter-RepoRoot
  Assert-Tool 'pnpm'
  Assert-LocalTauriCli
  Assert-ReleaseLicenseApiUrl
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
  dev-status         Shows dev endpoints and protected release endpoints without stopping anything.
  release-run        Starts src-tauri\target\release\app.exe; builds first if missing.
  installer-dev      Dev-flavor installer; auto-bumps patch version first.
  installer-release  Production installer; auto-bumps patch version first.
  installers         Builds both installers after one shared patch bump.
  dev-release       Cached local release installers; verifies every embedded frontend asset.
  open-installers    Open existing dev and release NSIS installer output folders.
  version-preview    Shows the next installer version without changing files.
  version-bump       Promotes package.json/Cargo.toml/Cargo.lock/tauri.conf.json (patch bump, or -Version x.y.z) without building.

Debug vs release:
  Debug/dev prefers Vite 1420 and WebView2 CDP 19333. If another program
  occupies either port, the launcher chooses the first free port in the bounded
  dev-only ranges 1420-1439 and 19333-19363. Browser profiles use 19400-19655;
  Remote defaults to user-configurable 42812. The Dev data root and debug
  executable path remain separate. Release stays fixed on WebView2 CDP 9333
  (profiles 9334-9589), Remote 42811, the production data root, and the
  installed/release executable path. Release is a protected user runtime during
  development; never attach a dev smoke to its ports or stop it to make a
  development command succeed.

Versioning:
  Installer actions update package.json, src-tauri/Cargo.toml,
  src-tauri/Cargo.lock, and src-tauri/tauri.conf.json from x.y.z to x.y.(z+1).
  Pass -Version x.y.z with installer actions to force a specific newer version.

Release licensing:
  Release actions default VIBELINK_LICENSE_API_URL to
  https://vibelink.moobang.net when it is not already set.
  Any explicitly supplied value must still be exactly that HTTPS origin.

Embedded frontend assets:
  Public/CI production builds clean the app package first. Local dev-release
  reuses Cargo's release cache, verifies every current asset in app.exe, and
  automatically retries once with the clean path if verification fails.

Safety:
  Development preflight automatically bypasses unrelated listeners only inside
  the bounded dev ranges. It fails closed if an existing VibeLink dev runtime
  owns any candidate, if every candidate is occupied, or if strict binding later
  loses a race. This script never stops another program or a release process.
  Dev run/build cleanup is limited to exact src-tauri\target\debug\app.exe PIDs.
'@ -ForegroundColor Gray
}

function Invoke-Action([string]$Name) {
  switch ($Name) {
    'help' { Show-HelpText }
    'build' { Invoke-DevBuild }
    'release-build' { Invoke-ReleaseBuild }
    'dev-run' { Invoke-DevRun }
    'dev-status' { Invoke-DevStatus }
    'release-run' { Invoke-ReleaseRun }
    'installer-dev' { Invoke-DevInstaller }
    'installer-release' { Invoke-ReleaseInstaller }
    'installer-ci' { Invoke-CiInstaller }
    'dev-release' { Invoke-CiInstaller -IncrementalLocal }
    'installers' { Invoke-AllInstallers }
    'open-installers' { Open-InstallerOutputs }
    'version-preview' { Invoke-InstallerVersionBump -DryRun }
    'version-bump' { Invoke-InstallerVersionBump }
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
    Write-Host '8. Open installer output folders'
    Write-Host '9. Create current-version dev release installers (no bump/publish)'
    Write-Host 'v. Preview next installer version without changing files'
    Write-Host 'b. Promote version now (patch bump; pass -Version x.y.z to override)'
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
        '8' { Open-InstallerOutputs }
        '9' { Invoke-CiInstaller }
        'v' { Invoke-InstallerVersionBump -DryRun }
        'version' { Invoke-InstallerVersionBump -DryRun }
        'b' { Invoke-InstallerVersionBump }
        'bump' { Invoke-InstallerVersionBump }
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
