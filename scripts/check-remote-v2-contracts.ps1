$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $appRoot
$contracts = @(
  Join-Path $workspaceRoot 'vibelink-app\contracts\remote-v2.json'
  Join-Path $workspaceRoot 'vibelink-mobile\contracts\remote-v2.json'
  Join-Path $workspaceRoot 'vibelink-web\contracts\remote-v2.json'
)

$hashes = foreach ($contract in $contracts) {
  if (-not (Test-Path -LiteralPath $contract -PathType Leaf)) {
    throw "Missing remote-v2 contract: $contract"
  }

  $stream = [System.IO.File]::OpenRead($contract)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $hash = ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }

  $declaredPath = [System.IO.Path]::ChangeExtension($contract, 'sha256')
  if (-not (Test-Path -LiteralPath $declaredPath -PathType Leaf)) {
    throw "Missing declared remote-v2 hash: $declaredPath"
  }
  $declared = ((Get-Content -LiteralPath $declaredPath -Raw).Trim().ToLowerInvariant() -split '\s+')[0]
  if ($declared -ne $hash) {
    throw "Declared remote-v2 hash mismatch: $declaredPath expected $hash, found $declared"
  }

  [pscustomobject]@{ Path = $contract; Hash = $hash }
}

$distinct = @($hashes.Hash | Sort-Object -Unique)
if ($distinct.Count -ne 1) {
  $hashes | Format-Table -AutoSize | Out-String | Write-Host
  throw 'Remote-v2 contracts do not match across desktop, mobile, and relay repositories.'
}

$hashes | Format-Table -AutoSize
Write-Host "remote-v2 contract parity OK: $($distinct[0])"
