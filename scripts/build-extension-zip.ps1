[CmdletBinding()]
param(
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# The Chrome Web Store rejects a re-upload that does not raise manifest version,
# so the file name carries the manifest's own version instead of a literal.
$source = Join-Path $PSScriptRoot '..\src-tauri\resources\browser-extension'
$source = [System.IO.Path]::GetFullPath($source)
$manifestPath = Join-Path $source 'manifest.json'
$version = (Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json).version
if ([string]::IsNullOrWhiteSpace($version)) { throw "manifest.json has no version: $manifestPath" }

if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $PSScriptRoot '..\src-tauri\target\chrome-web-store'
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

# README.md is deliberately excluded: it documents the off-store developer-mode
# path and only widens the review surface.
$files = @(
  'manifest.json',
  'service-worker.js',
  'bridge-port.json',
  'icons/icon-32.png',
  'icons/icon-128.png'
)
foreach ($relativePath in $files) {
  $path = Join-Path $source $relativePath
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Missing extension file: $path"
  }
}

$zip = Join-Path $OutputDirectory "vibelink-browser-control-$version.zip"
$timestamp = [System.DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [System.TimeSpan]::Zero)
Add-Type -AssemblyName System.IO.Compression

$zipStream = [System.IO.File]::Open(
  $zip,
  [System.IO.FileMode]::Create,
  [System.IO.FileAccess]::ReadWrite,
  [System.IO.FileShare]::None
)
try {
  $archive = [System.IO.Compression.ZipArchive]::new(
    $zipStream,
    [System.IO.Compression.ZipArchiveMode]::Create,
    $false
  )
  try {
    foreach ($relativePath in $files) {
      $entry = $archive.CreateEntry(
        $relativePath,
        [System.IO.Compression.CompressionLevel]::Optimal
      )
      $entry.LastWriteTime = $timestamp

      $sourceStream = [System.IO.File]::OpenRead((Join-Path $source $relativePath))
      try {
        $entryStream = $entry.Open()
        try {
          $sourceStream.CopyTo($entryStream)
        } finally {
          $entryStream.Dispose()
        }
      } finally {
        $sourceStream.Dispose()
      }
    }
  } finally {
    $archive.Dispose()
  }
} finally {
  $zipStream.Dispose()
}

Write-Output $zip
