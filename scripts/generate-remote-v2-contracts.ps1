[CmdletBinding()]
param(
  [Alias('CheckOnly')]
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$appRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $appRoot
$canonicalPath = Join-Path $appRoot 'contracts\remote-v2.json'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false, $true)

function Get-RequiredProperty {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Context
  )

  if ($null -eq $Value) {
    throw "$Context is null."
  }
  $property = $Value.PSObject.Properties[$Name]
  if ($null -eq $property) {
    throw "$Context is missing required property '$Name'."
  }
  return $property.Value
}

function Get-OptionalProperty {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][string]$Name
  )

  if ($null -eq $Value) {
    return $null
  }
  $property = $Value.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }
  return $property.Value
}

function Assert-Object {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][string]$Context
  )

  if ($null -eq $Value -or $Value -is [string] -or $Value -is [System.Collections.IEnumerable]) {
    throw "$Context must be a JSON object."
  }
  if (@($Value.PSObject.Properties).Count -eq 0) {
    throw "$Context must not be empty."
  }
}

function Assert-Identifier {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Context
  )

  if ($Name -notmatch '^[A-Za-z][A-Za-z0-9]*$') {
    throw "$Context '$Name' is not a supported generated identifier."
  }
}

function Get-ReferenceName {
  param(
    [Parameter(Mandatory = $true)]$Schema,
    [Parameter(Mandatory = $true)][string]$Context
  )

  $reference = Get-RequiredProperty $Schema '$ref' $Context
  if ($reference -isnot [string] -or $reference -notmatch '^#/types/([A-Za-z][A-Za-z0-9]*)$') {
    throw "$Context must be a local type reference in the form '#/types/TypeName'."
  }
  return $Matches[1]
}

function Assert-Schema {
  param(
    [Parameter(Mandatory = $true)]$Schema,
    [Parameter(Mandatory = $true)][string]$Context,
    [Parameter(Mandatory = $true)][System.Collections.Generic.HashSet[string]]$TypeNames,
    [switch]$TopLevel
  )

  if ($null -eq $Schema -or $Schema -is [string] -or $Schema -is [System.Collections.IEnumerable]) {
    throw "$Context must be a JSON schema object."
  }

  if ($null -ne $Schema.PSObject.Properties['$ref']) {
    $referenceName = Get-ReferenceName $Schema $Context
    if (-not $TypeNames.Contains($referenceName)) {
      throw "$Context references missing type '$referenceName'."
    }
    return
  }

  $schemaType = Get-RequiredProperty $Schema 'type' $Context
  if ($schemaType -isnot [string]) {
    throw "$Context.type must be a string."
  }

  switch ($schemaType) {
    'object' {
      $additionalProperties = Get-RequiredProperty $Schema 'additionalProperties' $Context
      if ($additionalProperties -eq $true) {
        if ($null -ne (Get-OptionalProperty $Schema 'properties') -or $null -ne (Get-OptionalProperty $Schema 'required')) {
          throw "$Context open object must not declare properties or required fields."
        }
        return
      }
      if ($additionalProperties -ne $false) {
        if (-not $TopLevel) {
          throw "$Context map schemas must be named top-level types."
        }
        if ($null -ne (Get-OptionalProperty $Schema 'properties') -or $null -ne (Get-OptionalProperty $Schema 'required')) {
          throw "$Context map must not declare properties or required fields."
        }
        Assert-Schema $additionalProperties "$Context.additionalProperties" $TypeNames
        return
      }

      $properties = Get-RequiredProperty $Schema 'properties' $Context
      if ($null -eq $properties -or $properties -is [string] -or $properties -is [System.Collections.IEnumerable]) {
        throw "$Context.properties must be a JSON object."
      }
      $required = @(Get-RequiredProperty $Schema 'required' $Context)
      $propertyNames = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
      foreach ($property in @($properties.PSObject.Properties)) {
        if (-not $propertyNames.Add($property.Name)) {
          throw "$Context contains duplicate property '$($property.Name)'."
        }
        if ($property.Name -notmatch '^[a-z][A-Za-z0-9]*$') {
          throw "$Context property '$($property.Name)' must use canonical camelCase."
        }
        Assert-Schema $property.Value "$Context.properties.$($property.Name)" $TypeNames
      }

      $requiredNames = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
      foreach ($requiredName in $required) {
        if ($requiredName -isnot [string] -or -not $propertyNames.Contains($requiredName)) {
          throw "$Context.required contains unknown property '$requiredName'."
        }
        if (-not $requiredNames.Add($requiredName)) {
          throw "$Context.required contains duplicate property '$requiredName'."
        }
      }
    }
    'array' {
      $items = Get-RequiredProperty $Schema 'items' $Context
      Assert-Schema $items "$Context.items" $TypeNames
    }
    'string' {
      $values = Get-OptionalProperty $Schema 'enum'
      if ($null -ne $values) {
        if (-not $TopLevel) {
          throw "$Context uses an inline enum; literal enums must be named top-level types."
        }
        $enumValues = @($values)
        if ($enumValues.Count -eq 0) {
          throw "$Context.enum must not be empty."
        }
        $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
        foreach ($enumValue in $enumValues) {
          if ($enumValue -isnot [string] -or [string]::IsNullOrWhiteSpace($enumValue)) {
            throw "$Context.enum values must be non-empty strings."
          }
          if (-not $seen.Add($enumValue)) {
            throw "$Context.enum contains duplicate value '$enumValue'."
          }
        }
      }
    }
    'integer' {
      $format = Get-OptionalProperty $Schema 'format'
      if ($null -ne $format -and $format -notin @('uint16', 'uint32', 'uint64', 'int32', 'int64')) {
        throw "$Context.format '$format' is not supported for integer generation."
      }
      $minimum = Get-OptionalProperty $Schema 'minimum'
      if ($null -ne $minimum -and $minimum -isnot [ValueType]) {
        throw "$Context.minimum must be numeric."
      }
      if ($null -ne $minimum -and $format -in @('uint16', 'uint32', 'uint64') -and [decimal]$minimum -lt 0) {
        throw "$Context.minimum cannot be negative for unsigned integer format '$format'."
      }
    }
    'number' { }
    'boolean' { }
    default {
      throw "$Context.type '$schemaType' is not supported by the Remote-v2 generator."
    }
  }
}

function ConvertTo-PascalCase {
  param([Parameter(Mandatory = $true)][string]$Value)

  $expanded = [System.Text.RegularExpressions.Regex]::Replace($Value, '([a-z0-9])([A-Z])', '$1 $2')
  $expanded = [System.Text.RegularExpressions.Regex]::Replace($expanded, '[^A-Za-z0-9]+', ' ')
  $parts = @($expanded.Split(@(' '), [System.StringSplitOptions]::RemoveEmptyEntries))
  if ($parts.Count -eq 0) {
    throw "Cannot generate an identifier from '$Value'."
  }
  return (($parts | ForEach-Object {
    if ($_.Length -eq 1) { $_.ToUpperInvariant() }
    else { $_.Substring(0, 1).ToUpperInvariant() + $_.Substring(1) }
  }) -join '')
}

function ConvertTo-SnakeCase {
  param([Parameter(Mandatory = $true)][string]$Value)

  $expanded = [System.Text.RegularExpressions.Regex]::Replace($Value, '([a-z0-9])([A-Z])', '$1_$2')
  $expanded = [System.Text.RegularExpressions.Regex]::Replace($expanded, '[^A-Za-z0-9]+', '_')
  return $expanded.Trim('_').ToLowerInvariant()
}

function ConvertTo-UpperSnakeCase {
  param([Parameter(Mandatory = $true)][string]$Value)
  return (ConvertTo-SnakeCase $Value).ToUpperInvariant()
}

function Get-RustFieldName {
  param([Parameter(Mandatory = $true)][string]$Value)

  $name = ConvertTo-SnakeCase $Value
  $reserved = @(
    'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum',
    'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod',
    'move', 'mut', 'pub', 'ref', 'return', 'self', 'static', 'struct', 'super', 'trait',
    'true', 'type', 'unsafe', 'use', 'where', 'while'
  )
  if ($reserved -contains $name) {
    return "r#$name"
  }
  return $name
}

function Escape-RustString {
  param([Parameter(Mandatory = $true)][string]$Value)
  return $Value.Replace('\', '\\').Replace('"', '\"').Replace("`r", '\r').Replace("`n", '\n')
}

function Escape-TypeScriptString {
  param([Parameter(Mandatory = $true)][string]$Value)
  return $Value.Replace('\', '\\').Replace("'", "\'").Replace("`r", '\r').Replace("`n", '\n')
}

function Get-RustType {
  param(
    [Parameter(Mandatory = $true)]$Schema,
    [Parameter(Mandatory = $true)][string]$Context
  )

  if ($null -ne $Schema.PSObject.Properties['$ref']) {
    return Get-ReferenceName $Schema $Context
  }

  $schemaType = Get-RequiredProperty $Schema 'type' $Context
  switch ($schemaType) {
    'string' { return 'String' }
    'boolean' { return 'bool' }
    'number' { return 'f64' }
    'integer' {
      $format = Get-OptionalProperty $Schema 'format'
      switch ($format) {
        'uint16' { return 'u16' }
        'uint32' { return 'u32' }
        'uint64' { return 'u64' }
        'int32' { return 'i32' }
        'int64' { return 'i64' }
        default { return 'i64' }
      }
    }
    'array' {
      $items = Get-RequiredProperty $Schema 'items' $Context
      return "Vec<$(Get-RustType $items "$Context.items")>"
    }
    default { throw "$Context cannot be emitted as a Rust field type." }
  }
}

function Get-TypeScriptType {
  param(
    [Parameter(Mandatory = $true)]$Schema,
    [Parameter(Mandatory = $true)][string]$Context
  )

  if ($null -ne $Schema.PSObject.Properties['$ref']) {
    return Get-ReferenceName $Schema $Context
  }

  $schemaType = Get-RequiredProperty $Schema 'type' $Context
  switch ($schemaType) {
    'string' { return 'string' }
    'boolean' { return 'boolean' }
    'number' { return 'number' }
    'integer' { return 'number' }
    'array' {
      $items = Get-RequiredProperty $Schema 'items' $Context
      return "ReadonlyArray<$(Get-TypeScriptType $items "$Context.items")>"
    }
    default { throw "$Context cannot be emitted as a TypeScript property type." }
  }
}

function Add-Line {
  param(
    [Parameter(Mandatory = $true)][System.Text.StringBuilder]$Builder,
    [string]$Line = ''
  )
  [void]$Builder.Append($Line).Append("`n")
}

function New-RustOutput {
  param(
    [Parameter(Mandatory = $true)]$Contract,
    [Parameter(Mandatory = $true)][string]$Hash,
    [Parameter(Mandatory = $true)][object[]]$MethodRecords,
    [Parameter(Mandatory = $true)][object[]]$EventRecords
  )

  $builder = New-Object System.Text.StringBuilder
  Add-Line $builder '// @generated by scripts/generate-remote-v2-contracts.ps1; DO NOT EDIT.'
  Add-Line $builder 'use serde::{Deserialize, Serialize};'
  Add-Line $builder 'use std::collections::BTreeMap;'
  Add-Line $builder "pub const GENERATED_CONTRACT_VERSION: u32 = $($Contract.contractVersion);"
  Add-Line $builder "pub const GENERATED_PROTOCOL_VERSION: u16 = $($Contract.protocolVersion);"
  Add-Line $builder "pub const GENERATED_SUBPROTOCOL: &str = `"$(Escape-RustString ([string]$Contract.subprotocol))`";"
  Add-Line $builder "pub const GENERATED_CONTRACT_SHA256: &str = `"$Hash`";"
  Add-Line $builder

  Add-Line $builder 'pub const REMOTE_V2_METHODS: &[(&str, &[&str])] = &['
  foreach ($domainProperty in @($Contract.methods.PSObject.Properties) | Sort-Object Name) {
    $methodNames = @($domainProperty.Value.PSObject.Properties | ForEach-Object Name | Sort-Object)
    $quotedMethods = ($methodNames | ForEach-Object { "`"$(Escape-RustString $_)`"" }) -join ', '
    Add-Line $builder "    (`"$(Escape-RustString $domainProperty.Name)`", &[$quotedMethods]),"
  }
  Add-Line $builder '];'
  Add-Line $builder
  Add-Line $builder 'pub const REMOTE_V2_METHOD_NAMES: &[&str] = &['
  foreach ($record in $MethodRecords) {
    Add-Line $builder "    `"$(Escape-RustString $record.FullName)`","
  }
  Add-Line $builder '];'
  Add-Line $builder
  Add-Line $builder 'pub const REMOTE_V2_EVENTS: &[&str] = &['
  foreach ($record in $EventRecords) {
    Add-Line $builder "    `"$(Escape-RustString $record.Name)`","
  }
  Add-Line $builder '];'
  Add-Line $builder

  foreach ($typeProperty in @($Contract.types.PSObject.Properties) | Sort-Object Name) {
    $typeName = $typeProperty.Name
    $schema = $typeProperty.Value
    $schemaType = [string](Get-RequiredProperty $schema 'type' "types.$typeName")
    if ($schemaType -eq 'string' -and $null -ne (Get-OptionalProperty $schema 'enum')) {
      Add-Line $builder '#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]'
      Add-Line $builder "pub enum $typeName {"
      $variantNames = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
      foreach ($enumValue in @(Get-OptionalProperty $schema 'enum')) {
        $variant = ConvertTo-PascalCase ([string]$enumValue)
        if (-not $variantNames.Add($variant)) {
          throw "types.$typeName generates duplicate Rust enum variant '$variant'."
        }
        Add-Line $builder "    #[serde(rename = `"$(Escape-RustString ([string]$enumValue))`")]"
        Add-Line $builder "    $variant,"
      }
      Add-Line $builder '}'
      Add-Line $builder
      continue
    }

    if ($schemaType -ne 'object') {
      throw "Top-level type '$typeName' must be an object or string enum."
    }
    $additionalProperties = Get-RequiredProperty $schema 'additionalProperties' "types.$typeName"
    if ($additionalProperties -eq $true) {
      Add-Line $builder "pub type $typeName = BTreeMap<String, serde_json::Value>;"
      Add-Line $builder
      continue
    }
    if ($additionalProperties -ne $false) {
      $mapValueType = Get-RustType $additionalProperties "types.$typeName.additionalProperties"
      Add-Line $builder "pub type $typeName = BTreeMap<String, $mapValueType>;"
      Add-Line $builder
      continue
    }
    Add-Line $builder '#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]'
    Add-Line $builder '#[serde(rename_all = "camelCase", deny_unknown_fields)]'
    Add-Line $builder "pub struct $typeName {"
    $required = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    foreach ($requiredName in @(Get-RequiredProperty $schema 'required' "types.$typeName")) {
      [void]$required.Add([string]$requiredName)
    }
    $properties = Get-RequiredProperty $schema 'properties' "types.$typeName"
    foreach ($property in @($properties.PSObject.Properties) | Sort-Object Name) {
      $rustName = Get-RustFieldName $property.Name
      $rustType = Get-RustType $property.Value "types.$typeName.properties.$($property.Name)"
      if ($required.Contains($property.Name)) {
        Add-Line $builder "    pub ${rustName}: $rustType,"
      } else {
        Add-Line $builder '    #[serde(skip_serializing_if = "Option::is_none")]'
        Add-Line $builder "    pub ${rustName}: Option<$rustType>,"
      }
    }
    Add-Line $builder '}'
    Add-Line $builder
  }

  foreach ($record in $MethodRecords) {
    if ($record.ParamsAlias -ne $record.ParamsType) {
      Add-Line $builder "pub type $($record.ParamsAlias) = $($record.ParamsType);"
    }
    if ($record.ResultAlias -ne $record.ResultType) {
      Add-Line $builder "pub type $($record.ResultAlias) = $($record.ResultType);"
    }
  }
  foreach ($record in $EventRecords) {
    if ($record.Alias -ne $record.PayloadType) {
      Add-Line $builder "pub type $($record.Alias) = $($record.PayloadType);"
    }
  }

  return $builder.ToString()
}

function New-TypeScriptOutput {
  param(
    [Parameter(Mandatory = $true)]$Contract,
    [Parameter(Mandatory = $true)][string]$Hash,
    [Parameter(Mandatory = $true)][object[]]$MethodRecords,
    [Parameter(Mandatory = $true)][object[]]$EventRecords
  )

  $builder = New-Object System.Text.StringBuilder
  Add-Line $builder '// @generated by scripts/generate-remote-v2-contracts.ps1; DO NOT EDIT.'
  Add-Line $builder "export const GENERATED_REMOTE_V2_CONTRACT_VERSION = $($Contract.contractVersion) as const"
  Add-Line $builder "export const GENERATED_REMOTE_V2_PROTOCOL_VERSION = $($Contract.protocolVersion) as const"
  Add-Line $builder "export const GENERATED_REMOTE_V2_SUBPROTOCOL = '$(Escape-TypeScriptString ([string]$Contract.subprotocol))' as const"
  Add-Line $builder "export const GENERATED_REMOTE_V2_CONTRACT_SHA256 = '$Hash' as const"
  Add-Line $builder
  Add-Line $builder 'export const GENERATED_REMOTE_V2_METHODS = {'
  foreach ($domainProperty in @($Contract.methods.PSObject.Properties) | Sort-Object Name) {
    $methodNames = @($domainProperty.Value.PSObject.Properties | ForEach-Object Name | Sort-Object)
    $quotedMethods = ($methodNames | ForEach-Object { "'$(Escape-TypeScriptString $_)'" }) -join ', '
    Add-Line $builder "  '$(Escape-TypeScriptString $domainProperty.Name)': [$quotedMethods],"
  }
  Add-Line $builder '} as const'
  Add-Line $builder
  Add-Line $builder 'export const GENERATED_REMOTE_V2_METHOD_NAMES = ['
  foreach ($record in $MethodRecords) {
    Add-Line $builder "  '$(Escape-TypeScriptString $record.FullName)',"
  }
  Add-Line $builder '] as const'
  Add-Line $builder
  Add-Line $builder 'export const GENERATED_REMOTE_V2_EVENTS = ['
  foreach ($record in $EventRecords) {
    Add-Line $builder "  '$(Escape-TypeScriptString $record.Name)',"
  }
  Add-Line $builder '] as const'
  Add-Line $builder

  foreach ($typeProperty in @($Contract.types.PSObject.Properties) | Sort-Object Name) {
    $typeName = $typeProperty.Name
    $schema = $typeProperty.Value
    $schemaType = [string](Get-RequiredProperty $schema 'type' "types.$typeName")
    if ($schemaType -eq 'string' -and $null -ne (Get-OptionalProperty $schema 'enum')) {
      $constantName = "$(ConvertTo-UpperSnakeCase $typeName)_VALUES"
      Add-Line $builder "export const $constantName = ["
      foreach ($enumValue in @(Get-OptionalProperty $schema 'enum')) {
        Add-Line $builder "  '$(Escape-TypeScriptString ([string]$enumValue))',"
      }
      Add-Line $builder '] as const'
      Add-Line $builder "export type $typeName = (typeof $constantName)[number]"
      Add-Line $builder
      continue
    }

    if ($schemaType -ne 'object') {
      throw "Top-level type '$typeName' must be an object or string enum."
    }
    $additionalProperties = Get-RequiredProperty $schema 'additionalProperties' "types.$typeName"
    if ($additionalProperties -eq $true) {
      Add-Line $builder "export type $typeName = Readonly<Record<string, unknown>>"
      Add-Line $builder
      continue
    }
    if ($additionalProperties -ne $false) {
      $mapValueType = Get-TypeScriptType $additionalProperties "types.$typeName.additionalProperties"
      Add-Line $builder "export type $typeName = Readonly<Record<string, $mapValueType>>"
      Add-Line $builder
      continue
    }
    $required = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    foreach ($requiredName in @(Get-RequiredProperty $schema 'required' "types.$typeName")) {
      [void]$required.Add([string]$requiredName)
    }
    $properties = Get-RequiredProperty $schema 'properties' "types.$typeName"
    if (@($properties.PSObject.Properties).Count -eq 0) {
      Add-Line $builder "export type $typeName = Readonly<Record<string, never>>"
      Add-Line $builder
      continue
    }
    Add-Line $builder "export type $typeName = {"
    foreach ($property in @($properties.PSObject.Properties) | Sort-Object Name) {
      $optional = if ($required.Contains($property.Name)) { '' } else { '?' }
      $typescriptType = Get-TypeScriptType $property.Value "types.$typeName.properties.$($property.Name)"
      Add-Line $builder "  readonly $($property.Name)${optional}: $typescriptType"
    }
    Add-Line $builder '}'
    Add-Line $builder
  }

  foreach ($record in $MethodRecords) {
    if ($record.ParamsAlias -ne $record.ParamsType) {
      Add-Line $builder "export type $($record.ParamsAlias) = $($record.ParamsType)"
    }
    if ($record.ResultAlias -ne $record.ResultType) {
      Add-Line $builder "export type $($record.ResultAlias) = $($record.ResultType)"
    }
  }
  foreach ($record in $EventRecords) {
    if ($record.Alias -ne $record.PayloadType) {
      Add-Line $builder "export type $($record.Alias) = $($record.PayloadType)"
    }
  }

  return $builder.ToString()
}

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

function Get-RelativePath {
  param([Parameter(Mandatory = $true)][string]$Path)

  $fullRoot = [System.IO.Path]::GetFullPath($workspaceRoot).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  if ($fullPath.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $fullPath.Substring($fullRoot.Length)
  }
  return $fullPath
}

if (-not (Test-Path -LiteralPath $canonicalPath -PathType Leaf)) {
  throw "Missing canonical Remote-v2 contract: $canonicalPath"
}
$canonicalBytes = [System.IO.File]::ReadAllBytes($canonicalPath)
if ($canonicalBytes.Length -eq 0) {
  throw "Canonical Remote-v2 contract is empty: $canonicalPath"
}
if ($canonicalBytes.Length -ge 3 -and $canonicalBytes[0] -eq 0xEF -and $canonicalBytes[1] -eq 0xBB -and $canonicalBytes[2] -eq 0xBF) {
  throw 'Canonical Remote-v2 contract must be UTF-8 without BOM.'
}
try {
  $canonicalText = $utf8NoBom.GetString($canonicalBytes)
} catch {
  throw "Canonical Remote-v2 contract is not valid UTF-8: $($_.Exception.Message)"
}
if ($canonicalText.Contains("`r")) {
  throw 'Canonical Remote-v2 contract must use LF line endings.'
}
if (-not $canonicalText.EndsWith("`n", [System.StringComparison]::Ordinal) -or $canonicalText.EndsWith("`n`n", [System.StringComparison]::Ordinal)) {
  throw 'Canonical Remote-v2 contract must end with exactly one LF newline.'
}
try {
  $contract = $canonicalText | ConvertFrom-Json
} catch {
  throw "Canonical Remote-v2 contract is not valid JSON: $($_.Exception.Message)"
}

$contractVersion = Get-RequiredProperty $contract 'contractVersion' 'contract'
$protocolVersion = Get-RequiredProperty $contract 'protocolVersion' 'contract'
$subprotocol = Get-RequiredProperty $contract 'subprotocol' 'contract'
if ($contractVersion -isnot [ValueType] -or [int64]$contractVersion -le 0) {
  throw 'contract.contractVersion must be a positive integer.'
}
if ([int64]$protocolVersion -ne 2) {
  throw 'contract.protocolVersion must remain 2.'
}
if ($subprotocol -ne 'vibelink-remote-v2') {
  throw "contract.subprotocol must remain 'vibelink-remote-v2'."
}

$types = Get-RequiredProperty $contract 'types' 'contract'
$methods = Get-RequiredProperty $contract 'methods' 'contract'
$events = Get-RequiredProperty $contract 'events' 'contract'
Assert-Object $types 'contract.types'
Assert-Object $methods 'contract.methods'
Assert-Object $events 'contract.events'

$typeNames = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
foreach ($typeProperty in @($types.PSObject.Properties)) {
  Assert-Identifier $typeProperty.Name 'Type name'
  if (-not $typeNames.Add($typeProperty.Name)) {
    throw "Duplicate type '$($typeProperty.Name)'."
  }
}
foreach ($typeProperty in @($types.PSObject.Properties)) {
  Assert-Schema $typeProperty.Value "types.$($typeProperty.Name)" $typeNames -TopLevel
}

$methodRecords = @()
foreach ($domainProperty in @($methods.PSObject.Properties) | Sort-Object Name) {
  if ($domainProperty.Name -notmatch '^[a-z][a-z0-9]*$') {
    throw "Method domain '$($domainProperty.Name)' is invalid."
  }
  Assert-Object $domainProperty.Value "methods.$($domainProperty.Name)"
  foreach ($methodProperty in @($domainProperty.Value.PSObject.Properties) | Sort-Object Name) {
    if ($methodProperty.Name -notmatch '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$') {
      throw "Method name '$($domainProperty.Name).$($methodProperty.Name)' is invalid."
    }
    $paramsSchema = Get-RequiredProperty $methodProperty.Value 'params' "methods.$($domainProperty.Name).$($methodProperty.Name)"
    $resultSchema = Get-RequiredProperty $methodProperty.Value 'result' "methods.$($domainProperty.Name).$($methodProperty.Name)"
    $paramsType = Get-ReferenceName $paramsSchema "methods.$($domainProperty.Name).$($methodProperty.Name).params"
    $resultType = Get-ReferenceName $resultSchema "methods.$($domainProperty.Name).$($methodProperty.Name).result"
    if (-not $typeNames.Contains($paramsType) -or -not $typeNames.Contains($resultType)) {
      throw "Method '$($domainProperty.Name).$($methodProperty.Name)' references a missing params or result type."
    }
    $aliasBase = "$(ConvertTo-PascalCase $domainProperty.Name)$(ConvertTo-PascalCase $methodProperty.Name)"
    $methodRecords += [pscustomobject]@{
      Domain = $domainProperty.Name
      Method = $methodProperty.Name
      FullName = "$($domainProperty.Name).$($methodProperty.Name)"
      ParamsType = $paramsType
      ResultType = $resultType
      ParamsAlias = "${aliasBase}Params"
      ResultAlias = "${aliasBase}Result"
    }
  }
}
if ($methodRecords.Count -eq 0) {
  throw 'contract.methods must declare at least one method.'
}

$eventRecords = @()
foreach ($eventProperty in @($events.PSObject.Properties) | Sort-Object Name) {
  if ($eventProperty.Name -notmatch '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$') {
    throw "Event name '$($eventProperty.Name)' is invalid."
  }
  $payloadType = Get-ReferenceName $eventProperty.Value "events.$($eventProperty.Name)"
  if (-not $typeNames.Contains($payloadType)) {
    throw "Event '$($eventProperty.Name)' references missing payload type '$payloadType'."
  }
  $eventRecords += [pscustomobject]@{
    Name = $eventProperty.Name
    PayloadType = $payloadType
    Alias = "$(ConvertTo-PascalCase $eventProperty.Name)Event"
  }
}
if ($eventRecords.Count -eq 0) {
  throw 'contract.events must declare at least one push event.'
}

$hash = Get-Sha256Hex $canonicalBytes
$hashText = "$hash  remote-v2.json`n"
$rustText = New-RustOutput $contract $hash $methodRecords $eventRecords
$typescriptText = New-TypeScriptOutput $contract $hash $methodRecords $eventRecords

$expected = [ordered]@{}
$expected[(Join-Path $appRoot 'contracts\remote-v2.json')] = $canonicalBytes
$expected[(Join-Path $workspaceRoot 'vibelink-mobile\contracts\remote-v2.json')] = $canonicalBytes
$expected[(Join-Path $workspaceRoot 'vibelink-web\contracts\remote-v2.json')] = $canonicalBytes
$expected[(Join-Path $appRoot 'contracts\remote-v2.sha256')] = [byte[]]$utf8NoBom.GetBytes($hashText)
$expected[(Join-Path $workspaceRoot 'vibelink-mobile\contracts\remote-v2.sha256')] = [byte[]]$utf8NoBom.GetBytes($hashText)
$expected[(Join-Path $workspaceRoot 'vibelink-web\contracts\remote-v2.sha256')] = [byte[]]$utf8NoBom.GetBytes($hashText)
$expected[(Join-Path $appRoot 'src-tauri\src\remote\v2\generated.rs')] = [byte[]]$utf8NoBom.GetBytes($rustText)
$expected[(Join-Path $workspaceRoot 'vibelink-mobile\crates\remote-core\src\generated_v2.rs')] = [byte[]]$utf8NoBom.GetBytes($rustText)
$expected[(Join-Path $workspaceRoot 'vibelink-mobile\packages\remote-contracts\src\generated-v2.ts')] = [byte[]]$utf8NoBom.GetBytes($typescriptText)
$canonicalFixturePath = Join-Path $appRoot 'contracts\remote-v2-fixture.json'
if (Test-Path -LiteralPath $canonicalFixturePath -PathType Leaf) {
  $fixtureBytes = [System.IO.File]::ReadAllBytes($canonicalFixturePath)
  if ($fixtureBytes.Length -eq 0) {
    throw "Canonical Remote-v2 fixture is empty: $canonicalFixturePath"
  }
  if ($fixtureBytes.Length -ge 3 -and $fixtureBytes[0] -eq 0xEF -and $fixtureBytes[1] -eq 0xBB -and $fixtureBytes[2] -eq 0xBF) {
    throw 'Canonical Remote-v2 fixture must be UTF-8 without BOM.'
  }
  try {
    $fixtureText = $utf8NoBom.GetString($fixtureBytes)
  } catch {
    throw "Canonical Remote-v2 fixture is not valid UTF-8: $($_.Exception.Message)"
  }
  $fixtureText = $fixtureText.Replace("`r`n", "`n").Replace("`r", "`n")
  $fixtureBytes = [byte[]]$utf8NoBom.GetBytes($fixtureText)
  try {
    [void]($fixtureText | ConvertFrom-Json)
  } catch {
    throw "Canonical Remote-v2 fixture is not valid JSON: $($_.Exception.Message)"
  }
  $expected[$canonicalFixturePath] = $fixtureBytes
  $expected[(Join-Path $workspaceRoot 'vibelink-mobile\contracts\remote-v2-fixture.json')] = $fixtureBytes
  $expected[(Join-Path $workspaceRoot 'vibelink-web\contracts\remote-v2-fixture.json')] = $fixtureBytes
}

$changedPaths = @()
foreach ($path in $expected.Keys) {
  $different = $true
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    $actualBytes = [System.IO.File]::ReadAllBytes($path)
    $different = -not (Test-BytesEqual $actualBytes ([byte[]]$expected[$path]))
  }
  if ($different) {
    $changedPaths += Get-RelativePath $path
    if (-not $Check) {
      $directory = Split-Path -Parent $path
      if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        [void][System.IO.Directory]::CreateDirectory($directory)
      }
      [System.IO.File]::WriteAllBytes($path, [byte[]]$expected[$path])
    }
  }
}

if ($Check -and $changedPaths.Count -gt 0) {
  Write-Host 'Remote-v2 generated contract drift:'
  foreach ($path in $changedPaths) {
    Write-Host "  $path"
  }
  Write-Host 'Regenerate with:'
  Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File vibelink-app\scripts\generate-remote-v2-contracts.ps1'
  throw 'Remote-v2 generated files are stale.'
}

if ($changedPaths.Count -gt 0) {
  Write-Host 'Remote-v2 generated paths:'
  foreach ($path in $changedPaths) {
    Write-Host "  $path"
  }
} else {
  Write-Host 'Remote-v2 generated files are up to date.'
}
Write-Host "Remote-v2 contract SHA-256: $hash"
Write-Host 'Check with:'
Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File vibelink-app\scripts\check-remote-v2-contracts.ps1'
