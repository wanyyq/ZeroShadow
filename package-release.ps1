# ============================================================================
#  package-release.ps1 - ZeroShadow release packaging with a secret gate
#
#  WHY THIS EXISTS
#    A release archive must NEVER contain runtime secrets. `.env` holds the
#    superadmin password, `data/.jwt-secret` signs every session token and
#    `data/users.json` holds member password hashes. If any of them ship inside
#    an archive, every user of that archive shares one password / one signing
#    key - and the publisher's own credentials leak to the public.
#
#    Zipping the project root is therefore always wrong. This script only ever
#    packages the contents of the release directory: it removes regenerable
#    credentials, stages the legal/user documentation, then refuses to build the
#    archive if anything secret or any user data is still present.
#
#  WHAT LANDS IN THE ARCHIVE
#    <binary>            ZeroShadow.exe (Windows) or ZeroShadow (Linux)
#    web/dist/           built frontend, served by the backend
#    .env.example        config template (copied to .env by the operator)
#    data/               empty runtime folder
#    LICENSE             Apache 2.0
#    README.md           project overview
#    docs/               all user manuals (+ docs/img screenshots)
#
#    LICENSE / README.md / docs are staged automatically by this script (see
#    -IncludeDocs), so the local build and CI cannot drift apart.
#
#  USAGE
#    powershell -NoProfile -ExecutionPolicy Bypass -File package-release.ps1
#    powershell ... -File package-release.ps1 -Platform windows-x64
#    powershell ... -File package-release.ps1 -ReleaseDir ZeroShadow-Release `
#                                               -ZipPath ZeroShadow-1.1.0-linux-x64.zip
#    powershell ... -File package-release.ps1 -NoZip    # purge + scan + stage only
#    powershell ... -File package-release.ps1 -DryRun   # report only, no changes
#
#    When -ZipPath is omitted the archive is named
#      ZeroShadow-<version>-<platform>.zip   (platform from -Platform)
#      ZeroShadow-<version>.zip              (no platform given)
#
#  EXIT CODES
#    0  success
#    1  unexpected failure (missing release dir, write error, ...)
#    2  secret gate tripped - nothing was packaged
#
#  NOTE: messages are intentionally ASCII-only so the script behaves the same
#        under Windows PowerShell 5.1 in any console code page. Do not add
#        non-ASCII characters here unless you also add a UTF-8 BOM.
# ============================================================================
[CmdletBinding()]
param(
  # Project root - defaults to the folder containing this script.
  # NOTE: left empty on purpose. $PSScriptRoot is NOT reliably populated while
  #       parameter defaults are evaluated, so it is resolved below instead.
  [string]$Root = "",
  # Release directory to package (relative to -Root unless absolute).
  [string]$ReleaseDir = "ZeroShadow-Release",
  # Output archive path. Empty => ZeroShadow-<version>[-<platform>].zip
  [string]$ZipPath = "",
  # Target platform label used in the default archive name, e.g. windows-x64.
  [string]$Platform = "",
  # Override the version (empty => read "version" from the root package.json).
  [string]$Version = "",
  # Stage LICENSE / README.md / docs into the release directory before packing.
  [switch]$IncludeDocs,
  # Skip archive creation and only purge/verify/stage the release directory.
  [switch]$NoZip,
  # Do not delete or copy anything - only report what would happen.
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# $PSBoundParameters does not survive into functions, so remember the switch
# here; documentation staging is on by default.
$StageDocs = -not $PSBoundParameters.ContainsKey("IncludeDocs") -or [bool]$IncludeDocs

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

# --- Documentation staged into every release -------------------------------
# Paths are relative to the project root; directories are copied recursively.
$DOC_SOURCES = @("LICENSE", "README.md", "docs")

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

function Add-ReleaseDocs {
  param([string]$ProjectRoot, [string]$ReleaseRoot)
  foreach ($source in $DOC_SOURCES) {
    $from = Join-Path $ProjectRoot $source
    if (-not (Test-Path $from)) {
      Write-Warn2 "documentation missing from the project: $source (skipped)"
      continue
    }
    $to = Join-Path $ReleaseRoot $source
    if ($DryRun) {
      Write-Warn2 "would stage: $source"
      continue
    }
    Copy-Item -LiteralPath $from -Destination $to -Recurse -Force
    Write-Host "        staged: $source"
  }
}

function Get-ProjectVersion {
  param([string]$ProjectRoot)
  try {
    $manifest = Join-Path $ProjectRoot "package.json"
    if (Test-Path $manifest) {
      $parsed = [System.IO.File]::ReadAllText($manifest, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
      if ($parsed.version) { return [string]$parsed.version }
    }
  } catch {
    Write-Warn2 "cannot read version from package.json: $($_.Exception.Message)"
  }
  return "0.0.0"
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

      # Carry a Unix mode in the high 16 bits of the external attributes. Without
      # this a Linux/macOS unzip yields a 0644 binary and the operator has to
      # `chmod +x` it by hand. 0100755 = regular file + rwxr-xr-x (0x81ED),
      # 0100644 = regular file + rw-r--r-- (0x81A4). The extension-less
      # "ZeroShadow" entry is the Linux/macOS build, so it gets the exec bit.
      $unixMode = if ($relative -eq "ZeroShadow") { 0x81ED } else { 0x81A4 }
      $attributes = [int64]$unixMode -shl 16
      if ($attributes -gt [int]::MaxValue) { $attributes -= 4294967296 }   # fold into signed Int32
      $entry.ExternalAttributes = [int]$attributes
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
    # Platform-agnostic: pkg emits ZeroShadow.exe on Windows and ZeroShadow on
    # Linux/macOS, so do not hard-code the Windows name here.
    $binary = @($names | Where-Object { $_ -match '^ZeroShadow(\.exe)?$' })
    return [pscustomobject]@{
      Count      = $entries.Count
      BinaryName = if ($binary.Count) { $binary[0] } else { $null }
      HasWebDist = [bool](@($names | Where-Object { $_ -match '^web/dist/' }).Count)
      HasLicense = [bool](@($names | Where-Object { $_ -match '^LICENSE$' }).Count)
      HasReadme  = [bool](@($names | Where-Object { $_ -match '^README\.md$' }).Count)
      DocCount   = @($names | Where-Object { $_ -match '^docs/.+\.md$' }).Count
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

  # Resolve the archive name before anything else so -DryRun can report it.
  $version = if ($Version) { $Version } else { Get-ProjectVersion -ProjectRoot $Root }
  if (-not $ZipPath) {
    $ZipPath = if ($Platform) { "ZeroShadow-$version-$Platform.zip" } else { "ZeroShadow-$version.zip" }
  }
  $zipFull = Resolve-UnderRoot -Base $Root -Path $ZipPath

  Write-Step "Release directory: $releaseRoot"
  Write-Step "Target archive:    $zipFull"
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

  # Never let the archive land inside the directory it packages, otherwise the
  # *.zip gate would flag the output as a nested archive.
  $releaseFull = (Resolve-Path $releaseRoot).Path.TrimEnd('\', '/')
  if ($zipFull.StartsWith($releaseFull + [System.IO.Path]::DirectorySeparatorChar)) {
    Write-Err "output archive must not be written inside the release directory."
    exit 1
  }

  if ($StageDocs) {
    Write-Step "Staging documentation (LICENSE / README.md / docs)..."
    Add-ReleaseDocs -ProjectRoot $Root -ReleaseRoot $releaseRoot
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
  Write-Step "Creating archive..."
  New-ReleaseArchive -ReleaseRoot $releaseRoot -Destination $staging

  Write-Step "Verifying archive contents..."
  $report = Test-ArchiveSafety -Archive $staging
  if ($report.Violations.Count -gt 0) {
    Write-Err "archive contains forbidden entries:"
    foreach ($violation in $report.Violations) { Write-Err "  $violation" }
    Write-Err "unsafe archive discarded; existing release archive left untouched."
    exit 2
  }
  if ($report.BinaryName) {
    Write-Ok "backend binary: $($report.BinaryName)"
  } else {
    Write-Warn2 "no ZeroShadow binary found in archive - did pkg run?"
  }
  if (-not $report.HasWebDist) { Write-Warn2 "web/dist not found in archive - the UI will not be served" }
  if (-not $report.HasLicense) { Write-Warn2 "LICENSE not found in archive" }
  if (-not $report.HasReadme) { Write-Warn2 "README.md not found in archive" }
  if ($report.DocCount -eq 0) {
    Write-Warn2 "no docs/*.md found in archive - user manuals are missing"
  } else {
    Write-Ok "user manuals included: $($report.DocCount) markdown files"
  }

  Move-Item -LiteralPath $staging -Destination $zipFull -Force
  $staging = $null
  $size = [math]::Round((Get-Item $zipFull).Length / 1MB, 2)
  Write-Ok "archive verified: $($report.Count) entries, $size MB, no secrets"
  Write-Ok "output: $zipFull"
  exit 0
} catch {
  Write-Err $_.Exception.Message
  exit 1
} finally {
  if ($staging -and (Test-Path $staging)) { Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue }
}
