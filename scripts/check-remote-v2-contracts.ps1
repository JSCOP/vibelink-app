$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$appRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $appRoot
$generatorPath = Join-Path $PSScriptRoot 'generate-remote-v2-contracts.ps1'
$canonicalPath = Join-Path $appRoot 'contracts\remote-v2.json'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false, $true)

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)

  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Test-BytesEqual {
  param(
    [Parameter(Mandatory = $true)][byte[]]$Left,
    [Parameter(Mandatory = $true)][byte[]]$Right
  )

  if ($Left.Length -ne $Right.Length) {
    return $false
  }
  for ($index = 0; $index -lt $Left.Length; $index++) {
    if ($Left[$index] -ne $Right[$index]) {
      return $false
    }
  }
  return $true
}

function Get-StrictUtf8Text {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][byte[]]$Bytes
  )

  if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) {
    throw "$Path must be UTF-8 without BOM."
  }
  try {
    return $utf8NoBom.GetString($Bytes)
  } catch {
    throw "$Path is not valid UTF-8: $($_.Exception.Message)"
  }
}

function Assert-ByteCopy {
  param(
    [Parameter(Mandatory = $true)][byte[]]$Expected,
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Missing ${Label}: $Path"
  }
  $actual = [System.IO.File]::ReadAllBytes($Path)
  if (-not (Test-BytesEqual $Expected $actual)) {
    throw "$Label differs byte-for-byte: $Path"
  }
}

if (-not (Test-Path -LiteralPath $generatorPath -PathType Leaf)) {
  throw "Missing Remote-v2 generator: $generatorPath"
}

# The generator owns the complete expected byte set. -Check performs no writes and
# catches stale DTOs even when someone leaves the JSON/hash files untouched.
& $generatorPath -Check

if (-not (Test-Path -LiteralPath $canonicalPath -PathType Leaf)) {
  throw "Missing canonical Remote-v2 contract: $canonicalPath"
}
$canonicalBytes = [System.IO.File]::ReadAllBytes($canonicalPath)
$canonicalText = Get-StrictUtf8Text $canonicalPath $canonicalBytes
try {
  $contract = $canonicalText | ConvertFrom-Json
} catch {
  throw "Canonical Remote-v2 contract is invalid JSON: $($_.Exception.Message)"
}
$canonicalHash = Get-Sha256Hex $canonicalBytes

$contractPaths = @(
  $canonicalPath,
  (Join-Path $workspaceRoot 'vibelink-mobile\contracts\remote-v2.json'),
  (Join-Path $workspaceRoot 'vibelink-web\contracts\remote-v2.json')
)
foreach ($contractPath in $contractPaths) {
  Assert-ByteCopy $canonicalBytes $contractPath 'Remote-v2 contract copy'
  $hashPath = [System.IO.Path]::ChangeExtension($contractPath, 'sha256')
  if (-not (Test-Path -LiteralPath $hashPath -PathType Leaf)) {
    throw "Missing declared Remote-v2 hash: $hashPath"
  }
  $hashBytes = [System.IO.File]::ReadAllBytes($hashPath)
  $declaredText = (Get-StrictUtf8Text $hashPath $hashBytes).Trim()
  $parts = @($declaredText -split '\s+')
  if ($parts.Count -ne 2 -or $parts[1] -ne 'remote-v2.json') {
    throw "Invalid declared Remote-v2 hash format: $hashPath"
  }
  if ($parts[0].ToLowerInvariant() -ne $canonicalHash) {
    throw "Declared Remote-v2 hash mismatch: $hashPath expected $canonicalHash, found $($parts[0])"
  }
}

$desktopRustPath = Join-Path $appRoot 'src-tauri\src\remote\v2\generated.rs'
$mobileRustPath = Join-Path $workspaceRoot 'vibelink-mobile\crates\remote-core\src\generated_v2.rs'
Assert-ByteCopy ([System.IO.File]::ReadAllBytes($desktopRustPath)) $mobileRustPath 'Generated Rust DTO mirror'

$generatedPaths = @(
  $desktopRustPath,
  $mobileRustPath,
  (Join-Path $workspaceRoot 'vibelink-mobile\packages\remote-contracts\src\generated-v2.ts')
)
$methodNames = @()
foreach ($domainProperty in @($contract.methods.PSObject.Properties)) {
  foreach ($methodProperty in @($domainProperty.Value.PSObject.Properties)) {
    $methodNames += "$($domainProperty.Name).$($methodProperty.Name)"
  }
}
$eventNames = @($contract.events.PSObject.Properties | ForEach-Object Name)
foreach ($generatedPath in $generatedPaths) {
  if (-not (Test-Path -LiteralPath $generatedPath -PathType Leaf)) {
    throw "Missing generated Remote-v2 DTO: $generatedPath"
  }
  $generatedBytes = [System.IO.File]::ReadAllBytes($generatedPath)
  $generatedText = Get-StrictUtf8Text $generatedPath $generatedBytes
  foreach ($methodName in $methodNames) {
    if (-not $generatedText.Contains($methodName)) {
      throw "Generated method registry is missing '$methodName': $generatedPath"
    }
  }
  foreach ($eventName in $eventNames) {
    if (-not $generatedText.Contains($eventName)) {
      throw "Generated event registry is missing '$eventName': $generatedPath"
    }
  }
}

$fixturePath = Join-Path $appRoot 'contracts\remote-v2-fixture.json'
if (Test-Path -LiteralPath $fixturePath -PathType Leaf) {
  $fixtureBytes = [System.IO.File]::ReadAllBytes($fixturePath)
  [void](Get-StrictUtf8Text $fixturePath $fixtureBytes)
  Assert-ByteCopy $fixtureBytes (Join-Path $workspaceRoot 'vibelink-mobile\contracts\remote-v2-fixture.json') 'Remote-v2 fixture mirror'
  Assert-ByteCopy $fixtureBytes (Join-Path $workspaceRoot 'vibelink-web\contracts\remote-v2-fixture.json') 'Remote-v2 fixture mirror'
}

Write-Host "Remote-v2 contract parity OK: $canonicalHash"
Write-Host 'Regenerate with:'
Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File vibelink-app\scripts\generate-remote-v2-contracts.ps1'
Write-Host 'Check with:'
Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File vibelink-app\scripts\check-remote-v2-contracts.ps1'
