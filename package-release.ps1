# ============================================================================
#  package-release.ps1 - ZeroShadow release packaging with a secret gate
#
#  WHY THIS EXISTS
#    A release archive must NEVER contain runtime secrets. `.env` holds the
#    superadmin password, `data\.jwt-secret` signs every session token and
#    `data\users.json` holds member password hashes. If any of them ship inside
#    an archive, every user of that archive shares one password / one signing
#    key - and the publisher's own credentials leak to the public.
#
#    Zipping the project root is therefore always wrong. This script only ever
#    packages the contents of the release directory: it removes regenerable
#    credentials, then refuses to build the archive if anything secret or any
#    user data is still present.
#
#  USAGE
#    powershell -NoProfile -ExecutionPolicy Bypass -File package-release.ps1
#    powershell ... -File package-release.ps1 -ReleaseDir ZeroShadow-Release `
#                                               -ZipPath ZeroShadow-Release.zip
#    powershell ... -File package-release.ps1 -NoZip    # purge + scan only
#    powershell ... -File package-release.ps1 -DryRun   # report only, no changes
#
#  EXIT CODES
#    0  success
#    1  unexpected failure (missing release dir, write error, ...)
#    2  secret gate tripped - nothing was packaged
#
#  NOTE: messages are intentionally ASCII-only so the script behaves the same
#        under Windows PowerShell 5.1 in any console code page.
# ============================================================================
[CmdletBinding()]
param(
  # Project root - defaults to the folder containing this script.
  # NOTE: left empty on purpose. $PSScriptRoot is NOT reliably populated while
  #       parameter defaults are evaluated, so it is resolved below instead.
  [string]$Root = "",
  # Release directory to package (relative to -Root unless absolute).
  [string]$ReleaseDir = "ZeroShadow-Release",
  # Output archive path (relative to -Root unless absolute).
  [string]$ZipPath = "ZeroShadow-Release.zip",
  # Skip archive creation and only purge/verify the release directory.
  [switch]$NoZip,
  # Do not delete anything - only report what would be removed.
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if (-not $Root) {
  $scriptPath = $MyInvocation.MyCommand.Path
  $Root = if ($scriptPath) { Split-Path -Parent $scriptPath } else { (Get-Location).Path }
}

# ZipArchiveMode lives in System.IO.Compression (FileSystem only re-exports
# ZipFile), so both assemblies must be loaded explicitly.
Add-Type -AssemblyName System.IO.Compression -ErrorAction Stop
Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop

function Resolve-UnderRoot {
  param([string]$Base, [string]$Path)
  if ([System.IO.Path]::IsPathRooted($Path)) { return [System.IO.Path]::GetFullPath($Path) }
  return [System.IO.Path]::GetFullPath((Join-Path $Base $Path))
}

function Write-Step { param([string]$Message) Write-Host "[STEP] $Message" }
function Write-Ok { param([string]$Message) Write-Host "[OK]   $Message" -ForegroundColor Green }
function Write-Warn2 { param([string]$Message) Write-Host "[WARN] $Message" -ForegroundColor Yellow }
function Write-Err { param([string]$Message) Write-Host "[ERROR] $Message" -ForegroundColor Red }

# --- Optional, regenerable credential material: removed before packaging ----
# Everything here is recreated by the app on first run, so deleting it from a
# build output is lossless. `.env.example` is deliberately NOT matched.
$PURGE_PATTERNS = @(
  @{ Name = "superadmin password (.env)"; Glob = ".env" },
  @{ Name = "JWT signing secret";         Glob = "data/.jwt-secret" },
  @{ Name = "member password hashes";     Glob = "data/users.json" },
  @{ Name = "server config";              Glob = "data/config.json" },
  @{ Name = "server logs";                Glob = "data/logs/*.log" }
)

# --- Never deleted, always blocking: user data and stray archives ----------
# The gate refuses to package while these are present, so a careless build
# cannot publish somebody's files. Clean them out manually.
$BLOCK_PATTERNS = @(
  @{ Name = "uploaded user files"; Glob = "data/files/*" },
  @{ Name = "temp upload state";   Glob = "data/tmp/*" },
  @{ Name = "nested archive";      Glob = "*.zip"; Recursive = $true }
)

function Get-ReleasePath {
  param([string]$ReleaseRoot, [string]$Relative)
  return (Join-Path $ReleaseRoot ($Relative -replace '/', [System.IO.Path]::DirectorySeparatorChar))
}

function Get-PatternHits {
  param([string]$ReleaseRoot, [hashtable]$Pattern)
  $target = Get-ReleasePath -ReleaseRoot $ReleaseRoot -Relative $Pattern.Glob
  $items = @(Get-ChildItem -Path $target -Force -Recurse:([bool]$Pattern.Recursive) -ErrorAction SilentlyContinue)
  foreach ($item in $items) {
    $rel = $item.FullName.Substring($ReleaseRoot.Length).TrimStart('\', '/')
    [pscustomobject]@{
      Name     = $Pattern.Name
      Relative = ($rel -replace '\\', '/')
      IsDir    = [bool]$item.PSIsContainer
    }
  }
}

function Get-SecretFindings {
  param([string]$ReleaseRoot)
  $found = @()
  foreach ($pattern in $BLOCK_PATTERNS) { $found += @(Get-PatternHits -ReleaseRoot $ReleaseRoot -Pattern $pattern) }
  return $found
}

function Remove-SecretState {
  param([string]$ReleaseRoot)
  foreach ($pattern in $PURGE_PATTERNS) {
    foreach ($item in @(Get-PatternHits -ReleaseRoot $ReleaseRoot -Pattern $pattern)) {
      if ($DryRun) {
        Write-Warn2 "would remove: $($item.Relative)  ($($pattern.Name))"
        continue
      }
      try {
        Remove-Item -LiteralPath (Join-Path $ReleaseRoot $item.Relative) -Recurse -Force -ErrorAction Stop
        Write-Host "        removed: $($item.Relative)  ($($pattern.Name))"
      } catch {
        Write-Err "cannot remove $($item.Relative): $($_.Exception.Message)"
        throw
      }
    }
  }
}

function New-ReleaseArchive {
  param([string]$ReleaseRoot, [string]$Destination)
  $parent = Split-Path -Parent $Destination
  if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  if (Test-Path $Destination) { Remove-Item -LiteralPath $Destination -Force }

  # Entries are written by hand on purpose. [ZipFile]::CreateFromDirectory
  # emits "\" separators when running on Windows, and the ZIP spec (plus every
  # unzip tool on macOS/Linux) requires "/" - a backslash-separated archive
  # extracts as one oddly named file instead of a directory tree.
  $rootFull = (Resolve-Path $ReleaseRoot).Path.TrimEnd('\', '/')
  $zip = [System.IO.Compression.ZipFile]::Open($Destination, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in @(Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force)) {
      $relative = ($file.FullName.Substring($rootFull.Length).TrimStart('\', '/')) -replace '\\', '/'
      $entry = $zip.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal)
      # ZIP timestamps cannot represent anything before 1980.
      if ($file.LastWriteTime.Year -ge 1980) { $entry.LastWriteTime = $file.LastWriteTime }
      $input = [System.IO.File]::OpenRead($file.FullName)
      try {
        $output = $entry.Open()
        try { $input.CopyTo($output) } finally { $output.Dispose() }
      } finally { $input.Dispose() }
    }
  } finally {
    $zip.Dispose()
  }
}

function Test-ArchiveSafety {
  param([string]$Archive)
  $zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    $entries = @($zip.Entries)
    $names = @($entries | ForEach-Object { $_.FullName -replace '\\', '/' })
    $bad = @($entries | Where-Object {
      $n = ($_.FullName -replace '\\', '/')
      ($n -match '(^|/)\.env$') -or
      ($n -match 'jwt-secret') -or
      ($n -match '(^|/)users\.json$') -or
      ($n -match '(^|/)config\.json$') -or
      ($n -match '\.log$') -or
      ($_.FullName -match '\\')      # backslash entry name: not portable
    })
    return [pscustomobject]@{
      Count      = $entries.Count
      HasExe     = [bool](@($names | Where-Object { $_ -match '(^|/)ZeroShadow\.exe$' }).Count)
      HasWebDist = [bool](@($names | Where-Object { $_ -match '^web/dist/' }).Count)
      Violations = @($bad | ForEach-Object { $_.FullName })
    }
  } finally {
    $zip.Dispose()
  }
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
$staging = $null
try {
  $releaseRoot = Resolve-UnderRoot -Base $Root -Path $ReleaseDir
  $zipFull = Resolve-UnderRoot -Base $Root -Path $ZipPath

  Write-Step "Release directory: $releaseRoot"
  if (-not (Test-Path $releaseRoot)) {
    Write-Err "release directory not found: $releaseRoot"
    Write-Err "run the build first (frontend build + pkg), then package."
    exit 1
  }

  # Packaging the project root would sweep in .env and data\.
  if ((Resolve-Path $releaseRoot).Path -eq (Resolve-Path $Root).Path) {
    Write-Err "refusing to package the project root - use the release directory."
    exit 2
  }

  Write-Step "Purging regenerable credentials from the release directory..."
  Remove-SecretState -ReleaseRoot $releaseRoot

  Write-Step "Secret gate: scanning release directory..."
  $findings = @(Get-SecretFindings -ReleaseRoot $releaseRoot)
  if ($findings.Count -gt 0) {
    Write-Err "the following must not ship - remove them manually and rebuild:"
    foreach ($finding in $findings) {
      $kind = if ($finding.IsDir) { "directory" } else { "file" }
      Write-Err "  $($finding.Relative)  [${kind}: $($finding.Name)]"
    }
    Write-Err "packaging aborted; no archive was written."
    exit 2
  }
  Write-Ok "release directory is clean"

  if ($NoZip) {
    Write-Ok "folder mode (-NoZip): archive creation skipped"
    exit 0
  }

  # Build beside the target and only publish it once verification passed, so a
  # failed run never leaves the previous archive deleted or half written.
  $staging = "$zipFull.building"
  Write-Step "Creating archive: $zipFull"
  New-ReleaseArchive -ReleaseRoot $releaseRoot -Destination $staging

  Write-Step "Verifying archive contents..."
  $report = Test-ArchiveSafety -Archive $staging
  if ($report.Violations.Count -gt 0) {
    Write-Err "archive contains forbidden entries:"
    foreach ($violation in $report.Violations) { Write-Err "  $violation" }
    Write-Err "unsafe archive discarded; existing release archive left untouched."
    exit 2
  }
  if (-not $report.HasExe) { Write-Warn2 "ZeroShadow.exe not found in archive" }
  if (-not $report.HasWebDist) { Write-Warn2 "web/dist not found in archive - the UI will not be served" }

  Move-Item -LiteralPath $staging -Destination $zipFull -Force
  $staging = $null
  $size = [math]::Round((Get-Item $zipFull).Length / 1MB, 2)
  Write-Ok "archive verified: $($report.Count) entries, $size MB, no secrets"
  exit 0
} catch {
  Write-Err $_.Exception.Message
  exit 1
} finally {
  if ($staging -and (Test-Path $staging)) { Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue }
}
