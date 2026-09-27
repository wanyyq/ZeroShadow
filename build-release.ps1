# ============================================================================
#  build-release.ps1 - ZeroShadow multi-platform release builder
#
#  WHY THIS EXISTS
#    Auto-building.bat used to build a single node18-win-x64 binary and GitHub
#    Actions would have needed its own copy of the same steps. Two copies of a
#    build pipeline always drift. This script is the single source of truth:
#    Auto-building.bat is now a thin wrapper around it, and the CI workflow
#    calls it directly on both Windows and Linux runners.
#
#  WHAT IT DOES
#    1. installs server + web dependencies (pnpm, lockfile-pinned when asked)
#    2. builds the frontend            -> web/dist
#    3. bundles the ESM backend to CJS -> server/dist/server-bundle.cjs
#       (pkg cannot consume ESM, hence the esbuild step)
#    4. runs pkg once per requested platform, staging each result into
#       build/<platform>/
#    5. calls package-release.ps1 per platform, which stages LICENSE /
#       README.md / docs, purges regenerable secrets, runs the secret gate and
#       writes ZeroShadow-<version>-<platform>.zip
#
#  USAGE
#    # every supported platform
#    pwsh -NoProfile -File build-release.ps1
#
#    # only what a given machine can realistically cross-build
#    pwsh -NoProfile -File build-release.ps1 -Targets windows-x64,windows-arm64
#    pwsh -NoProfile -File build-release.ps1 -Targets linux-x64,linux-arm64
#
#    # CI: dependencies already installed from the lockfile
#    pwsh -NoProfile -File build-release.ps1 -FrozenLockfile -SkipInstall
#
#    # build + stage only, no archives
#    pwsh -NoProfile -File build-release.ps1 -NoZip
#
#  TARGETS
#    windows-x64    node18-win-x64            ZeroShadow.exe
#    windows-arm64  node18-win-arm64          ZeroShadow.exe
#    linux-x64      node18-linux-x64          ZeroShadow
#    linux-arm64    node18-linux-arm64        ZeroShadow
#    linux-armv7    node18-linuxstatic-armv7  ZeroShadow
#
#    windows-x32 is NOT buildable: pkg-fetch publishes no win-x86 runtime for any
#    Node version. Passing it reports the reason and exits 1 - see the target
#    table comment below for the full evidence.
#
#  EXIT CODES
#    0  every requested platform built and packaged
#    1  fatal error (missing tool, failed frontend build, ...)
#    2  at least one platform failed (others may have succeeded)
#
#  NOTE: messages are intentionally ASCII-only. Windows PowerShell 5.1 decodes
#        .ps1 files using the ANSI code page unless they carry a UTF-8 BOM, and
#        a BOM is awkward in a file that also runs on Linux, so keep this file
#        plain ASCII and it behaves identically everywhere.
# ============================================================================
[CmdletBinding()]
param(
  [string]$Root = "",
  # Platform labels to build. Empty => every supported target.
  [string[]]$Targets = @(),
  # Pass --frozen-lockfile to pnpm install (CI should always do this).
  [switch]$FrozenLockfile,
  [switch]$SkipInstall,
  [switch]$SkipFrontend,
  [switch]$SkipBundle,
  # Build and stage, but do not create archives.
  [switch]$NoZip
)

# Native tools write to stderr freely; let explicit exit-code checks drive
# control flow instead of turning every stderr line into a terminating error.
$ErrorActionPreference = "Continue"

if (-not $Root) {
  $scriptPath = $MyInvocation.MyCommand.Path
  $Root = if ($scriptPath) { Split-Path -Parent $scriptPath } else { (Get-Location).Path }
}
$Root = (Resolve-Path $Root).Path

function Write-Step { param([string]$Message) Write-Host ""; Write-Host "[STEP] $Message" -ForegroundColor Cyan }
function Write-Ok { param([string]$Message) Write-Host "[OK]   $Message" -ForegroundColor Green }
function Write-Warn2 { param([string]$Message) Write-Host "[WARN] $Message" -ForegroundColor Yellow }
function Write-Err { param([string]$Message) Write-Host "[ERROR] $Message" -ForegroundColor Red }

function Test-Command {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# Run a native command and return its exit code, echoing the command first so
# CI logs show exactly what ran.
function Invoke-Native {
  param([string]$File, [string[]]$Arguments, [string]$WorkDir = "")
  $display = "$File " + ($Arguments -join " ")
  Write-Host "  > $display" -ForegroundColor DarkGray
  $saved = Get-Location
  try {
    if ($WorkDir) { Set-Location -LiteralPath $WorkDir }
    # Out-Host is essential, not cosmetic: without it the child process's stdout
    # becomes part of THIS function's output, so `$code = Invoke-Native ...`
    # would receive an array of the command's output lines plus the exit code.
    # `$code -ne 0` on an array filters it and yields a non-empty result, which
    # is always truthy - every command that printed anything would look like a
    # failure. Sending stdout straight to the host keeps the return value a
    # single integer. stderr already goes to the error stream, not the output
    # stream, so it needs no special handling.
    & $File @Arguments | Out-Host
    $exitCode = $LASTEXITCODE
    return [int]$exitCode
  } finally {
    Set-Location -LiteralPath $saved
  }
}

# ---------------------------------------------------------------------------
#  target table
#
#  NOTE ON linuxstatic-armv7
#    pkg-fetch publishes no plain "linux-armv7" runtime for node18 (nor for any
#    other Node version) - only "linuxstatic-armv7". A statically linked build
#    is in fact the better distribution choice here: the binary does not depend
#    on the target machine's glibc version.
# ---------------------------------------------------------------------------
$TARGET_MAP = [ordered]@{
  "windows-x64"   = @{ pkg = "node18-win-x64";             binary = "ZeroShadow.exe" }
  "windows-arm64" = @{ pkg = "node18-win-arm64";           binary = "ZeroShadow.exe" }
  "linux-x64"     = @{ pkg = "node18-linux-x64";           binary = "ZeroShadow" }
  "linux-arm64"   = @{ pkg = "node18-linux-arm64";         binary = "ZeroShadow" }
  "linux-armv7"   = @{ pkg = "node18-linuxstatic-armv7";   binary = "ZeroShadow" }
}

# Targets that look reasonable but CANNOT be built. Kept here so a maintainer
# gets a real explanation instead of a cryptic "404 Not Found" from pkg.
#
#   windows-x32 (32-bit Windows)
#     pkg-fetch has NEVER published a win-x86 base runtime - not for node18, not
#     for any Node version. Verified three ways:
#       1. pkg-fetch 3.4.2's own lib-es5/expected.js (EXPECTED_HASHES) contains
#          no "*-win-x86" key at all;
#       2. the pkg-fetch v3.4 GitHub release has 178 assets, none of them win-x86;
#       3. @yao-pkg/pkg-fetch v3.5 has 997 assets, still none of them win-x86.
#     Asking pkg for it fails with:
#       "Error! 404: Not Found / Not found in remote cache:
#        {"tag":"v3.4","name":"node-v18.5.0-win-x86"}"
#     Delivering 32-bit Windows would require a different packager entirely
#     (e.g. nexe), which produces a different binary layout and would need its
#     own packaging path - not a drop-in extra --target.
$UNSUPPORTED_TARGETS = @{
  "windows-x32" = "pkg-fetch has no win-x86 runtime for any Node version (verified against pkg-fetch 3.4.2 and @yao-pkg/pkg-fetch 3.5 asset lists). Use a different packager if 32-bit Windows is truly required."
}

if (-not $Targets -or $Targets.Count -eq 0) { $Targets = @($TARGET_MAP.Keys) }

$unsupported = @($Targets | Where-Object { $UNSUPPORTED_TARGETS.Contains($_) })
if ($unsupported.Count -gt 0) {
  foreach ($name in $unsupported) {
    Write-Err "cannot build '$name': $($UNSUPPORTED_TARGETS[$name])"
  }
  exit 1
}

$unknown = @($Targets | Where-Object { -not $TARGET_MAP.Contains($_) })
if ($unknown.Count -gt 0) {
  Write-Err "unknown target(s): $($unknown -join ', ')"
  Write-Err "valid targets: $($TARGET_MAP.Keys -join ', ')"
  exit 1
}

Write-Host "ZeroShadow release build" -ForegroundColor White
Write-Host "  project root: $Root"
Write-Host "  platform(s):  $($Targets -join ', ')"

# ---------------------------------------------------------------------------
#  toolchain
# ---------------------------------------------------------------------------
Write-Step "Checking toolchain"

if (-not (Test-Command "node")) {
  Write-Err "Node.js not found. Install Node.js 18 or newer."
  exit 1
}
$nodeVersion = (& node -v).TrimStart("v")
$nodeMajor = [int]($nodeVersion -split "\.")[0]
Write-Ok "node $nodeVersion"

# pkg builds for the node18 runtime regardless of the host node version, so a
# newer local node is fine - only very old toolchains are a real problem.
if ($nodeMajor -lt 18) {
  Write-Warn2 "host node is $nodeMajor (<18); the build may fail"
}

# Prefer pnpm, fall back to npm with the matching sub-command spelling.
$packageManager = if (Test-Command "pnpm") { "pnpm" } else { "npm" }
Write-Ok "package manager: $packageManager"

$pkgCommand = $null
if (Test-Command "pkg") {
  $pkgCommand = "pkg"
} else {
  # A locally installed pkg (server devDependency or a repo-local install)
  # wins over touching the global prefix.
  $localPkg = Join-Path $Root "server/node_modules/.bin/pkg"
  if (Test-Path $localPkg) {
    $pkgCommand = $localPkg
  }
}
if (-not $pkgCommand) {
  Write-Warn2 "pkg not found; installing it globally with npm"
  $code = Invoke-Native -File "npm" -Arguments @("install", "-g", "pkg")
  if ($code -ne 0) {
    Write-Err "failed to install pkg"
    exit 1
  }
  $pkgCommand = "pkg"
}
Write-Ok "pkg: $pkgCommand"

# ---------------------------------------------------------------------------
#  dependencies + build steps
# ---------------------------------------------------------------------------
if (-not $SkipInstall) {
  Write-Step "Installing dependencies"
  # Both invocations intentionally run with CWD = $Root: server/src/env.js
  # resolves .env and data/ from the process working directory, so every script
  # here must agree on the project root. See the developer guide under docs/.
  $installArgs = if ($FrozenLockfile) { @("install", "--frozen-lockfile") } else { @("install") }
  $code = Invoke-Native -File $packageManager -Arguments (@("-C", "server") + $installArgs) -WorkDir $Root
  if ($code -ne 0) { Write-Err "server dependency install failed"; exit 1 }
  $code = Invoke-Native -File $packageManager -Arguments (@("-C", "web") + $installArgs) -WorkDir $Root
  if ($code -ne 0) { Write-Err "web dependency install failed"; exit 1 }
}

if (-not $SkipFrontend) {
  Write-Step "Building frontend"
  $code = Invoke-Native -File $packageManager -Arguments @("-C", "web", "build") -WorkDir $Root
  if ($code -ne 0) { Write-Err "frontend build failed"; exit 1 }
  $distIndex = Join-Path $Root "web/dist/index.html"
  if (-not (Test-Path $distIndex)) {
    Write-Err "frontend build produced no web/dist/index.html"
    exit 1
  }
  Write-Ok "web/dist ready"
}

if (-not $SkipBundle) {
  Write-Step "Bundling backend (esbuild: ESM -> CJS)"
  # pkg has poor ESM support, so the server is bundled to a single CJS file
  # first. --external keeps web/dist and data/ as runtime paths instead of
  # inlining them into the bundle.
  $code = Invoke-Native -File $packageManager -Arguments @("-C", "server", "bundle") -WorkDir $Root
  if ($code -ne 0) { Write-Err "backend bundle failed"; exit 1 }
  if (-not (Test-Path (Join-Path $Root "server/dist/server-bundle.cjs"))) {
    Write-Err "esbuild produced no server/dist/server-bundle.cjs"
    exit 1
  }
  Write-Ok "server/dist/server-bundle.cjs ready"
}

# ---------------------------------------------------------------------------
#  per-platform pkg + packaging
# ---------------------------------------------------------------------------
$bundle = Join-Path $Root "server/dist/server-bundle.cjs"
$buildDir = Join-Path $Root "build"
$succeeded = @()
$failed = @()

foreach ($platform in $Targets) {
  $spec = $TARGET_MAP[$platform]
  Write-Step "Platform $platform  (pkg target $($spec.pkg))"

  $stageDir = Join-Path $buildDir $platform
  if (Test-Path $stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force }
  New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

  # pkg fetches a prebuilt runtime for the requested target, which is why
  # cross-building (e.g. linux binaries on a Windows host) works at all. It
  # needs network access the first time per target.
  $binaryPath = Join-Path $stageDir $spec.binary
  $code = Invoke-Native -File $pkgCommand -Arguments @(
    $bundle, "--target", $spec.pkg, "--output", $binaryPath
  ) -WorkDir $Root

  if ($code -ne 0 -or -not (Test-Path $binaryPath)) {
    Write-Err "pkg failed for $platform (exit $code)"
    $failed += $platform
    continue
  }
  $sizeMb = [math]::Round((Get-Item $binaryPath).Length / 1MB, 1)
  Write-Ok "built $($spec.binary) ($sizeMb MB)"

  # Assemble the release layout: binary + frontend + config template + data/.
  $webDist = Join-Path $Root "web/dist"
  $stageWeb = Join-Path $stageDir "web"
  New-Item -ItemType Directory -Path $stageWeb -Force | Out-Null
  Copy-Item -LiteralPath $webDist -Destination (Join-Path $stageWeb "dist") -Recurse -Force

  $envExample = Join-Path $Root ".env.example"
  if (Test-Path $envExample) {
    Copy-Item -LiteralPath $envExample -Destination (Join-Path $stageDir ".env.example") -Force
  } else {
    Write-Warn2 ".env.example is missing; the archive will have no config template"
  }

  # A placeholder keeps data/ present after unzip: the archive writer only
  # stores files, and the app would otherwise create the folder on first run
  # anyway.
  $stageData = Join-Path $stageDir "data"
  New-Item -ItemType Directory -Path $stageData -Force | Out-Null
  New-Item -ItemType File -Path (Join-Path $stageData ".gitkeep") -Force | Out-Null

  # package-release.ps1 stages LICENSE / README.md / docs itself, purges
  # regenerable credentials and enforces the secret gate.
  $packArgs = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $Root "package-release.ps1"),
    "-Root", $Root,
    "-ReleaseDir", $stageDir,
    "-Platform", $platform
  )
  if ($NoZip) { $packArgs += "-NoZip" }

  $psExe = if (Test-Command "pwsh") { "pwsh" } else { "powershell" }
  $code = Invoke-Native -File $psExe -Arguments $packArgs -WorkDir $Root
  if ($code -ne 0) {
    Write-Err "packaging failed for $platform (exit $code)"
    $failed += $platform
    continue
  }

  $succeeded += $platform
}

# ---------------------------------------------------------------------------
#  summary
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "===== build summary =====" -ForegroundColor White
foreach ($platform in $Targets) {
  if ($succeeded -contains $platform) {
    Write-Host ("  OK    {0}" -f $platform) -ForegroundColor Green
  } else {
    Write-Host ("  FAIL  {0}" -f $platform) -ForegroundColor Red
  }
}

if (-not $NoZip -and $succeeded.Count -gt 0) {
  Write-Host ""
  Write-Host "archives in $Root :"
  Get-ChildItem -Path (Join-Path $Root "ZeroShadow-*.zip") -ErrorAction SilentlyContinue |
    Sort-Object Name |
    ForEach-Object { Write-Host ("  {0}  ({1} MB)" -f $_.Name, [math]::Round($_.Length / 1MB, 1)) }
}

Write-Host ""
if ($failed.Count -gt 0) {
  Write-Err "$($failed.Count) platform(s) failed: $($failed -join ', ')"
  exit 2
}
Write-Ok "all requested platforms built successfully"
exit 0
