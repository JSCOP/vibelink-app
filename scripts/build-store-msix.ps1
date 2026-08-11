param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$IdentityName,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Publisher,

  [ValidateNotNullOrEmpty()]
  [string]$PublisherDisplayName = '무방',

  [string]$Version = '',
  [string]$OutputPath = '',
  [switch]$SkipBuild,
  [switch]$TrustCertificate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$TauriConfig = Join-Path $RepoRoot 'src-tauri\tauri.conf.json'
$ManifestTemplate = Join-Path $RepoRoot 'src-tauri\AppxManifest.xml.template'
$ReleaseRoot = Join-Path $RepoRoot 'src-tauri\target\release'
$ReleaseExe = Join-Path $ReleaseRoot 'app.exe'
$IconRoot = Join-Path $RepoRoot 'src-tauri\icons'
$StoreRoot = Join-Path $RepoRoot 'src-tauri\target\store'
$StageRoot = Join-Path $StoreRoot 'package'
$CertificatePath = Join-Path $StoreRoot 'VibeLink-store-test.cer'
$LeafCertificatePath = Join-Path $StoreRoot 'VibeLink-store-test-leaf.cer'

function Invoke-Checked([string]$File, [string[]]$Arguments) {
  Write-Host "> $File $($Arguments -join ' ')" -ForegroundColor DarkGray
  & $File @Arguments
  $exitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 0 }
  if ($exitCode -ne 0) {
    throw "Command failed with exit code $exitCode`: $File $($Arguments -join ' ')"
  }
}

function Find-WindowsSdkTool([string]$Name) {
  $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $tool = Get-ChildItem -LiteralPath $sdkRoot -Filter $Name -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } |
    Sort-Object { [version]$_.Directory.Parent.Name } |
    Select-Object -Last 1
  if (-not $tool) { throw "$Name was not found under $sdkRoot." }
  $tool.FullName
}

function ConvertTo-XmlText([string]$Value) {
  [System.Security.SecurityElement]::Escape($Value)
}

function Get-PackageVersion {
  $configured = if ([string]::IsNullOrWhiteSpace($Version)) {
    [string]((Get-Content -LiteralPath $TauriConfig -Raw -Encoding UTF8 | ConvertFrom-Json).version)
  } else {
    $Version.Trim()
  }
  if ($configured -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
    throw "Store version must be simple semver x.y.z: $configured"
  }
  $parts = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
  $storeMajor = $parts[0] + 1
  if (@($storeMajor, $parts[1], $parts[2]) | Where-Object { $_ -gt 65535 }) {
    throw "Store version components must be <= 65535 after mapping product major + 1: $configured"
  }
  "$storeMajor.$($parts[1]).$($parts[2]).0"
}

if ($IdentityName -notmatch '^[A-Za-z0-9.-]{3,50}$') {
  throw 'IdentityName must be 3-50 characters using letters, digits, periods, or hyphens.'
}
if ($Publisher -notmatch '^CN=') {
  throw 'Publisher must be the exact Partner Center identity subject and start with CN=.'
}
if ([string]::IsNullOrWhiteSpace($env:VIBELINK_API_URL)) {
  throw 'VIBELINK_API_URL is required. Set it to https://vibelink.moobang.net for Store release builds.'
}
if ($TrustCertificate) {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'TrustCertificate requires an elevated PowerShell session because executable MSIX test packages use LocalMachine certificate stores.'
  }
}

$packageVersion = Get-PackageVersion
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $OutputPath = Join-Path $StoreRoot "VibeLink_$($packageVersion)_x64.msix"
} else {
  $OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
}

$makeAppx = Find-WindowsSdkTool 'makeappx.exe'
$signTool = Find-WindowsSdkTool 'signtool.exe'

if (-not $SkipBuild) {
  Set-Location -LiteralPath $RepoRoot
  Invoke-Checked 'pnpm' @('exec', 'tauri', 'build', '--no-bundle')
}
if (-not (Test-Path -LiteralPath $ReleaseExe -PathType Leaf)) {
  throw "Release executable is missing: $ReleaseExe"
}

if (Test-Path -LiteralPath $StageRoot) {
  Remove-Item -LiteralPath $StageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $StageRoot 'Assets') -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
Copy-Item -LiteralPath $ReleaseExe -Destination (Join-Path $StageRoot 'app.exe')
foreach ($asset in @('StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png')) {
  $source = Join-Path $IconRoot $asset
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Store asset is missing: $source" }
  Copy-Item -LiteralPath $source -Destination (Join-Path $StageRoot "Assets\$asset")
}

$manifest = Get-Content -LiteralPath $ManifestTemplate -Raw -Encoding UTF8
$manifest = $manifest.Replace('{{IDENTITY_NAME}}', (ConvertTo-XmlText $IdentityName))
$manifest = $manifest.Replace('{{PUBLISHER}}', (ConvertTo-XmlText $Publisher))
$manifest = $manifest.Replace('{{PUBLISHER_DISPLAY_NAME}}', (ConvertTo-XmlText $PublisherDisplayName))
$manifest = $manifest.Replace('{{VERSION}}', $packageVersion)
[System.IO.File]::WriteAllText((Join-Path $StageRoot 'AppxManifest.xml'), $manifest, (New-Object System.Text.UTF8Encoding($false)))

if (Test-Path -LiteralPath $OutputPath) { Remove-Item -LiteralPath $OutputPath -Force }
Invoke-Checked $makeAppx @('pack', '/d', $StageRoot, '/p', $OutputPath, '/o')

$pfxPath = Join-Path $StoreRoot 'VibeLink-store-test.pfx'
$pfxPassword = [guid]::NewGuid().ToString('N')
$certificateNotBefore = (Get-Date).AddMinutes(-5)
$rootCertificateNotAfter = (Get-Date).AddDays(7)
$leafCertificateNotAfter = $rootCertificateNotAfter.AddSeconds(-1)
$rootRsa = [System.Security.Cryptography.RSA]::Create(2048)
$rootSubject = "CN=VibeLink Store Package Test Root $([guid]::NewGuid().ToString('N'))"
$rootRequest = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest(
  $rootSubject,
  $rootRsa,
  [System.Security.Cryptography.HashAlgorithmName]::SHA256,
  [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$rootRequest.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension($true, $false, 0, $true)))
$rootRequest.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509KeyUsageExtension(
  ([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign),
  $true
)))
$rootCertificate = $rootRequest.CreateSelfSigned($certificateNotBefore, $rootCertificateNotAfter)

$leafRsa = [System.Security.Cryptography.RSA]::Create(2048)
$leafRequest = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest(
  $Publisher,
  $leafRsa,
  [System.Security.Cryptography.HashAlgorithmName]::SHA256,
  [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$leafRequest.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension($false, $false, 0, $true)))
$leafRequest.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509KeyUsageExtension(
  [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,
  $true
)))
$codeSigningOids = New-Object System.Security.Cryptography.OidCollection
[void]$codeSigningOids.Add((New-Object System.Security.Cryptography.Oid('1.3.6.1.5.5.7.3.3')))
$leafRequest.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension(
  $codeSigningOids,
  $true
)))
$serial = New-Object byte[] 16
$serialRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $serialRng.GetBytes($serial) } finally { $serialRng.Dispose() }
$serial[0] = $serial[0] -band 0x7f
$leafPublic = $leafRequest.Create($rootCertificate, $certificateNotBefore, $leafCertificateNotAfter, $serial)
$leafCertificate = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($leafPublic, $leafRsa)
try {
  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
  [void]$chain.Add($leafCertificate)
  [void]$chain.Add($rootCertificate)
  [System.IO.File]::WriteAllBytes(
    $pfxPath,
    $chain.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $pfxPassword)
  )
  [System.IO.File]::WriteAllBytes(
    $CertificatePath,
    $rootCertificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
  )
  [System.IO.File]::WriteAllBytes(
    $LeafCertificatePath,
    $leafCertificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
  )
  Write-Host "> $signTool sign /fd SHA256 /f $pfxPath /p ******** /sha1 $($leafCertificate.Thumbprint) $OutputPath" -ForegroundColor DarkGray
  & $signTool sign /fd SHA256 /f $pfxPath /p $pfxPassword /sha1 $leafCertificate.Thumbprint $OutputPath
  if ($LASTEXITCODE -ne 0) { throw "SignTool failed with exit code $LASTEXITCODE." }
  if ($TrustCertificate) {
    Invoke-Checked 'certutil.exe' @('-addstore', 'Root', $CertificatePath)
    Invoke-Checked 'certutil.exe' @('-addstore', 'TrustedPeople', $LeafCertificatePath)
  }
} finally {
  $leafCertificate.Dispose()
  $leafPublic.Dispose()
  $rootCertificate.Dispose()
  $leafRsa.Dispose()
  $rootRsa.Dispose()
  Remove-Item -LiteralPath $pfxPath -Force -ErrorAction SilentlyContinue
}

$verifyRoot = Join-Path $StoreRoot 'verification'
if (Test-Path -LiteralPath $verifyRoot) { Remove-Item -LiteralPath $verifyRoot -Recurse -Force }
try {
  Invoke-Checked $makeAppx @('unpack', '/p', $OutputPath, '/d', $verifyRoot, '/o')
  if (-not (Test-Path -LiteralPath (Join-Path $verifyRoot 'AppxSignature.p7x') -PathType Leaf)) {
    throw 'MSIX signature payload is missing.'
  }
  [xml]$verifiedManifest = Get-Content -LiteralPath (Join-Path $verifyRoot 'AppxManifest.xml') -Raw -Encoding UTF8
  $verifiedIdentity = $verifiedManifest.Package.Identity
  if ($verifiedIdentity.Name -ne $IdentityName -or $verifiedIdentity.Publisher -ne $Publisher -or $verifiedIdentity.Version -ne $packageVersion) {
    throw 'Packed MSIX identity does not match the requested Store identity.'
  }
} finally {
  Remove-Item -LiteralPath $verifyRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Store package: $OutputPath" -ForegroundColor Green
Write-Host "Test certificate: $CertificatePath" -ForegroundColor Green
Write-Host "Package identity: $IdentityName" -ForegroundColor Green
Write-Host "Publisher: $Publisher" -ForegroundColor Green
Write-Host "Version: $packageVersion" -ForegroundColor Green
