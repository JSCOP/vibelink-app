$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$SidecarDir = Join-Path $RepoRoot 'voice-sidecar'
$DistDir = Join-Path $SidecarDir 'dist'
$ResourceDir = Join-Path $RepoRoot 'src-tauri\resources\voice'

function Resolve-CudaPath {
  $candidates = [System.Collections.Generic.List[string]]::new()
  foreach ($value in @(
    $env:CUDA_PATH,
    [Environment]::GetEnvironmentVariable('CUDA_PATH', 'Machine'),
    [Environment]::GetEnvironmentVariable('CUDA_PATH', 'User')
  )) {
    if ($value -and (Test-Path -LiteralPath $value)) { $candidates.Add($value) | Out-Null }
  }

  $defaultRoot = 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA'
  if (Test-Path -LiteralPath $defaultRoot) {
    foreach ($dir in (Get-ChildItem -LiteralPath $defaultRoot -Directory | Sort-Object Name -Descending)) {
      $candidates.Add($dir.FullName) | Out-Null
    }
  }

  foreach ($candidate in $candidates) {
    if ((Test-Path (Join-Path $candidate 'bin\nvcc.exe')) -and
        ((Test-Path (Join-Path $candidate 'bin\x64\cublas64_13.dll')) -or
         (Test-Path (Join-Path $candidate 'bin\cublas64_13.dll')))) {
      return $candidate
    }
  }
  throw 'CUDA Toolkit 13.x was not found. Install it or set CUDA_PATH.'
}

function Resolve-CudaDll([string]$CudaPath, [string]$Name) {
  foreach ($candidate in @(
    (Join-Path $CudaPath "bin\x64\$Name"),
    (Join-Path $CudaPath "bin\$Name")
  )) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  throw "Required CUDA runtime DLL not found: $Name"
}

$cudaPath = Resolve-CudaPath
$cudaBin = Join-Path $cudaPath 'bin'
$cudaBinX64 = Join-Path $cudaBin 'x64'
$env:CUDA_PATH = $cudaPath
$env:CUDA_PATH_V13_3 = $cudaPath
$env:CudaToolkitDir = "$cudaPath\"
$env:Path = "$cudaBinX64;$cudaBin;$env:Path"

& cargo build --manifest-path (Join-Path $SidecarDir 'Cargo.toml') --bin vibelink-voice-sidecar --release --features cuda
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
New-Item -ItemType Directory -Force -Path $ResourceDir | Out-Null
Get-ChildItem -LiteralPath $DistDir -File -ErrorAction SilentlyContinue | Remove-Item -Force
Get-ChildItem -LiteralPath $ResourceDir -File -ErrorAction SilentlyContinue | Remove-Item -Force

$binary = Join-Path $SidecarDir 'target\release\vibelink-voice-sidecar.exe'
Copy-Item -LiteralPath $binary -Destination (Join-Path $DistDir 'vibelink-voice-sidecar.exe') -Force
foreach ($dll in @('cublas64_13.dll', 'cublasLt64_13.dll', 'cudart64_13.dll')) {
  Copy-Item -LiteralPath (Resolve-CudaDll $cudaPath $dll) -Destination (Join-Path $DistDir $dll) -Force
}
Copy-Item -Path (Join-Path $DistDir '*') -Destination $ResourceDir -Force
Write-Host "VibeLink voice sidecar staged in $DistDir and $ResourceDir" -ForegroundColor Green
