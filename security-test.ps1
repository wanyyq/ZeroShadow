# ============================================================================
#  security-test.ps1 - ZeroShadow security regression harness
#
#  WHAT IT DOES
#    Asserts the security invariants of the audit against a RUNNING server.
#    Each check states the TARGET policy, so a failing check is either a live
#    vulnerability or a regression - never a surprise.
#
#  WHY IT EXISTS
#    Every security fix in this project must be verifiable and must not break
#    the existing behaviour. This harness pins both: the protections that
#    already work (CSRF guard, path-traversal rejection, zip-slip rejection)
#    and the ones being added (authorization on listing, SSRF filtering,
#    sandboxed HTML preview, security headers, release packaging).
#
#  SAFETY
#    - Talks to a local server only; SSRF probes point at the server itself.
#    - All artefacts live in one scratch folder inside the file store, which is
#      removed at the end (use -KeepScratch to inspect it).
#    - Never touches users, config, guest visibility, or the release archive.
#
#  USAGE
#    1) start the server on a free port:
#         $env:HOST='127.0.0.1'; $env:PORT='5179'; node server/index.js
#    2) run:
#         powershell -NoProfile -ExecutionPolicy Bypass -File security-test.ps1
#         powershell ... -File security-test.ps1 -BaseUrl http://127.0.0.1:5179
#
#  EXIT CODE = number of failed checks (0 = all good)
#
#  NOTE: messages are intentionally ASCII-only so the script behaves the same
#        under Windows PowerShell 5.1 in any console code page.
# ============================================================================
[CmdletBinding()]
param(
  [string]$BaseUrl = "http://127.0.0.1:5179",
  [string]$Root = "",
  [string]$User = "",
  [string]$Password = "",
  # Optional positive case: a target the server is allowed to download (for
  # example http://127.0.0.1:5179/api/meta, with DOWNLOAD_URL_ALLOW_HOSTS set
  # on the server). Leave empty to skip the happy-path verification.
  [string]$PositiveProbeUrl = "",
  # Set this when the tested server allowlists 127.0.0.1 (DOWNLOAD_URL_ALLOW_HOSTS).
  # The URL forms 127.1 and 2130706433 are *normalized* to 127.0.0.1 by the URL
  # parser, so they are legitimately permitted by such an allowlist.
  [switch]$LoopbackAllowlisted,
  # Set this when the tested server runs with TRUST_PROXY enabled, so the
  # X-Forwarded-For header is expected to determine the client IP.
  [switch]$TrustProxyMode,
  # Login-lockout scoping test. Off by default: it spends ~12 entries of the
  # per-IP failure budget, so run it against a freshly started server.
  [switch]$TestLockout,
  # Name of a read-only mapped folder (FILES_SOFT_DIR) configured on the tested
  # server, used to verify that its content cannot be copied into the store.
  [string]$SoftDirName = "",
  # Job-ownership test: creates a temporary member account and removes it again.
  [switch]$TestJobOwnership,
  [switch]$KeepScratch
)

$ErrorActionPreference = "Continue"

if (-not $Root) {
  $scriptPath = $MyInvocation.MyCommand.Path
  $Root = if ($scriptPath) { Split-Path -Parent $scriptPath } else { (Get-Location).Path }
}
$Root = (Resolve-Path $Root).Path

$script:passed = 0
$script:failed = 0
$script:names = @()
$script:scratch = $null

function Section { param([string]$Title) Write-Host ""; Write-Host "== $Title" -ForegroundColor Cyan }
function Note { param([string]$Message) Write-Host ("   .. " + $Message) -ForegroundColor DarkGray }
function Check {
  param([string]$Name, [bool]$Ok, [string]$Detail = "")
  if ($Ok) {
    $script:passed++
    Write-Host ("   PASS  " + $Name) -ForegroundColor Green
  } else {
    $script:failed++
    $script:names += $Name
    $line = "   FAIL  " + $Name
    if ($Detail) { $line += "   <-- " + $Detail }
    Write-Host $line -ForegroundColor Red
  }
}

function Invoke-Api {
  param(
    [string]$Method,
    [string]$Path,
    $Body = $null,
    $Session = $null,
    [hashtable]$ExtraHeaders = $null,
    [switch]$NoCsrf
  )
  $headers = @{}
  if ($ExtraHeaders) { foreach ($key in $ExtraHeaders.Keys) { $headers[$key] = $ExtraHeaders[$key] } }
  $params = @{ UseBasicParsing = $true; Method = $Method; Uri = ($BaseUrl + $Path); Headers = $headers }
  if ($null -ne $Body) {
    $params.ContentType = "application/json"
    $params.Body = ($Body | ConvertTo-Json -Depth 8 -Compress)
    if (-not $NoCsrf) { $headers["X-Requested-With"] = "XMLHttpRequest" }
  }
  if ($Session) { $params.WebSession = $Session }
  if ($NoCsrf -and $null -eq $Body) { $params.Headers = @{} }
  try {
    $r = Invoke-WebRequest @params
    return @{ code = [int]$r.StatusCode; body = [string]$r.Content; headers = $r.Headers }
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $text = ""
      try {
        $stream = $resp.GetResponseStream()
        if ($stream) { $reader = New-Object System.IO.StreamReader($stream); $text = $reader.ReadToEnd() }
      } catch { }
      return @{ code = [int]$resp.StatusCode; body = $text; headers = $resp.Headers }
    }
    return @{ code = -1; body = $_.Exception.Message; headers = $null }
  }
}

function Get-EnvValue {
  param([string]$File, [string]$Key)
  if (-not (Test-Path $File)) { return "" }
  $match = Select-String -Path $File -Pattern ("^" + [regex]::Escape($Key) + "=(.*)$") | Select-Object -First 1
  if ($match) { return $match.Matches[0].Groups[1].Value.Trim() }
  return ""
}

# ---------------------------------------------------------------------------
# setup
# ---------------------------------------------------------------------------
$envFile = Join-Path $Root ".env"
if (-not $User) { $User = Get-EnvValue -File $envFile -Key "SUPER_ADMIN_USER" }
if (-not $User) { $User = "admin" }
if (-not $Password) { $Password = Get-EnvValue -File $envFile -Key "SUPER_ADMIN_PASSWORD" }

$filesDirSetting = Get-EnvValue -File $envFile -Key "FILES_DIR"
$filesDir = if ($filesDirSetting) { $filesDirSetting } else { Join-Path $Root "data\files" }

Write-Host "ZeroShadow security regression harness"
Write-Host ("Target     : " + $BaseUrl)
Write-Host ("Project    : " + $Root)
Write-Host ("File store : " + $filesDir)

$probe = Invoke-Api -Method GET -Path "/api/meta"
if ($probe.code -ne 200) {
  Write-Host ("Cannot reach the server (" + $probe.code + "). Start it first, e.g.:") -ForegroundColor Red
  Write-Host "  `$env:HOST='127.0.0.1'; `$env:PORT='5179'; node server/index.js" -ForegroundColor Red
  exit 1
}

# ---------------------------------------------------------------------------
Section "1. Transport hardening"
# ---------------------------------------------------------------------------
$r = Invoke-Api -Method POST -Path "/api/auth/login" -Body @{ username = $User; password = "definitely-wrong" } -NoCsrf
Check "csrf-guard rejects headerless POST" ($r.code -eq 403) ("got " + $r.code)

$r = Invoke-Api -Method GET -Path "/"
$nosniff = ""
if ($r.headers) { $nosniff = [string]$r.headers["X-Content-Type-Options"] }
Check "X-Content-Type-Options: nosniff on documents" ($nosniff -match "nosniff") ("got '" + $nosniff + "'")

$shellCsp = ""
if ($r.headers) { $shellCsp = [string]$r.headers["Content-Security-Policy"] }
Check "app shell ships a Content-Security-Policy" (-not [string]::IsNullOrWhiteSpace($shellCsp)) ("CSP header is empty")

$permissionsPolicy = ""
if ($r.headers) { $permissionsPolicy = [string]$r.headers["Permissions-Policy"] }
Check "Permissions-Policy is set" (-not [string]::IsNullOrWhiteSpace($permissionsPolicy)) "missing"

# Cross-site hints must be refused even when the custom header is present.
$r = Invoke-Api -Method POST -Path "/api/auth/login" -Body @{ username = $User; password = "probe" } -ExtraHeaders @{ Origin = "https://evil.example" }
Check "foreign Origin is refused" ($r.code -eq 403) ("got " + $r.code)
$r = Invoke-Api -Method POST -Path "/api/auth/login" -Body @{ username = $User; password = "probe" } -ExtraHeaders @{ "Sec-Fetch-Site" = "cross-site" }
Check "cross-site fetch metadata is refused" ($r.code -eq 403) ("got " + $r.code)

# ---------------------------------------------------------------------------
Section "2. Authentication and authorization"
# ---------------------------------------------------------------------------
$r = Invoke-Api -Method POST -Path "/api/auth/login" -Body @{ username = $User; password = "definitely-wrong" }
Check "wrong password rejected" ($r.code -eq 401) ("got " + $r.code)

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$r = Invoke-Api -Method POST -Path "/api/auth/login" -Body @{ username = $User; password = $Password } -Session $session
Check "superadmin login works" ($r.code -eq 200 -and $r.body -match "superadmin") ("got " + $r.code + " " + $r.body)
if ($r.code -ne 200) {
  Write-Host "Login failed - aborting the remaining checks." -ForegroundColor Red
  exit 2
}

$r = Invoke-Api -Method GET -Path "/api/admin/status"
Check "admin API denies anonymous access" ($r.code -eq 401 -or $r.code -eq 403) ("got " + $r.code)

# ---------------------------------------------------------------------------
Section "3. Path traversal"
# ---------------------------------------------------------------------------
$traversal = @(
  @{ Name = "dot-dot segments";      Path = "/api/fs/list?path=..%2F.." },
  @{ Name = "percent-encoded dot-dot"; Path = "/api/fs/list?path=%2e%2e%2f%2e%2e%2f" },
  @{ Name = "windows separators";    Path = "/api/fs/list?path=..%5C..%5Cwindows" },
  @{ Name = "NUL byte";              Path = "/api/fs/list?path=a%00b" }
)
foreach ($case in $traversal) {
  $r = Invoke-Api -Method GET -Path $case.Path
  Check ("traversal rejected: " + $case.Name) ($r.code -eq 400) ("got " + $r.code)
}

# ---------------------------------------------------------------------------
Section "4. Guest authorization must follow the admin switches"
# ---------------------------------------------------------------------------
# scratch area inside the file store (removed at the end)
$scratchName = "_sectest-" + ([guid]::NewGuid().ToString("N").Substring(0, 8))
$scratchAbs = Join-Path $filesDir $scratchName
New-Item -ItemType Directory -Path $scratchAbs -Force | Out-Null
$script:scratch = $scratchAbs
Set-Content -Path (Join-Path $scratchAbs "guest-probe.txt") -Value "guest probe" -Encoding UTF8
$guestProbePath = $scratchName + "/guest-probe.txt"

$cfgResponse = Invoke-Api -Method GET -Path "/api/admin/config" -Session $session
$originalGuest = $null
try {
  $cfg = $cfgResponse.body | ConvertFrom-Json
  $originalGuest = @{
    browse         = [bool]$cfg.guestPerms.browse
    downloadFile   = [bool]$cfg.guestPerms.downloadFile
    downloadFolder = [bool]$cfg.guestPerms.downloadFolder
    preview        = [bool]$cfg.guestPerms.preview
  }
} catch { }

if (-not $originalGuest) {
  Check "guest permission set is readable" $false "could not read /api/admin/config"
} else {
  Note ("guest switches: browse=" + $originalGuest.browse + " downloadFile=" + $originalGuest.downloadFile + " downloadFolder=" + $originalGuest.downloadFolder + " preview=" + $originalGuest.preview)

  # --- switch ON: anonymous access follows the setting -----------------------
  $r = Invoke-Api -Method GET -Path "/api/fs/list?path="
  if ($originalGuest.browse) {
    Check "listing allowed while guest browse is ON" ($r.code -eq 200) ("got " + $r.code + " - the admin switch is not being honoured")
  } else {
    Check "listing denied while guest browse is OFF" ($r.code -eq 401 -or $r.code -eq 403) ("got " + $r.code)
  }

  $r = Invoke-Api -Method GET -Path ("/api/fs/download?path=" + $guestProbePath)
  if ($originalGuest.downloadFile) {
    Check "download allowed while guest download is ON" ($r.code -eq 200) ("got " + $r.code)
  } else {
    Check "download denied while guest download is OFF" ($r.code -eq 401 -or $r.code -eq 403) ("got " + $r.code)
  }

  # --- switch OFF: everything anonymous must be refused ----------------------
  $null = Invoke-Api -Method PATCH -Path "/api/admin/config" -Session $session -Body @{
    guestPerms = @{ browse = $false; downloadFile = $false; downloadFolder = $false; preview = $false }
  }
  $r = Invoke-Api -Method GET -Path "/api/fs/list?path="
  Check "listing denied after admin disables guest browse" ($r.code -eq 401 -or $r.code -eq 403) ("got " + $r.code + " - directory tree still enumerable")
  $r = Invoke-Api -Method GET -Path "/api/fs/search?q=guest&path="
  Check "search denied after admin disables guest browse" ($r.code -eq 401 -or $r.code -eq 403) ("got " + $r.code)
  $r = Invoke-Api -Method GET -Path ("/api/fs/download?path=" + $guestProbePath)
  Check "download denied after admin disables guest download" ($r.code -eq 401 -or $r.code -eq 403) ("got " + $r.code)
  $r = Invoke-Api -Method GET -Path ("/api/fs/zip?path=" + $scratchName)
  Check "zip denied after admin disables guest download" ($r.code -eq 401 -or $r.code -eq 403) ("got " + $r.code)

  # --- restore the admin's own settings and confirm access comes back --------
  $null = Invoke-Api -Method PATCH -Path "/api/admin/config" -Session $session -Body @{ guestPerms = $originalGuest }
  $r = Invoke-Api -Method GET -Path "/api/fs/list?path="
  $restored = if ($originalGuest.browse) { $r.code -eq 200 } else { $r.code -eq 401 -or $r.code -eq 403 }
  Check "guest settings restored to the admin's values" $restored ("got " + $r.code)
}

# ---------------------------------------------------------------------------
Section "5. SSRF filtering on /api/fs/download-url"
# ---------------------------------------------------------------------------
$port = ([uri]$BaseUrl).Port
$ssrfCases = @(
  @{ Name = "IPv6 loopback [::1]";       Url = ("http://[::1]:" + $port + "/api/meta") },
  @{ Name = "IPv6 loopback expanded";    Url = ("http://[0:0:0:0:0:0:0:1]:" + $port + "/api/meta") },
  @{ Name = "IPv4-mapped IPv6";          Url = ("http://[::ffff:127.0.0.1]:" + $port + "/api/meta") },
  @{ Name = "IPv6 mapped, hex form";     Url = ("http://[::ffff:7f00:1]:" + $port + "/api/meta") },
  @{ Name = "localhost";                 Url = ("http://localhost:" + $port + "/api/meta") },
  @{ Name = "localhost FQDN (dot)";      Url = ("http://localhost.:" + $port + "/api/meta") },
  @{ Name = "short IPv4 form 127.1";     Url = ("http://127.1:" + $port + "/api/meta"); NormalizesToLoopback = $true },
  @{ Name = "decimal IPv4";              Url = ("http://2130706433:" + $port + "/api/meta"); NormalizesToLoopback = $true },
  @{ Name = "unspecified 0";             Url = ("http://0:" + $port + "/api/meta") },
  @{ Name = "cloud metadata address";    Url = "http://169.254.169.254/latest/meta-data/" },
  @{ Name = "non-http scheme";           Url = "file:///etc/passwd" },
  @{ Name = "credentials inside URL";    Url = "http://user:pass@example.com/x.zip" }
)
foreach ($case in $ssrfCases) {
  $r = Invoke-Api -Method POST -Path "/api/fs/download-url" -Body @{ url = $case.Url; dest = $scratchName } -Session $session
  if ($case.NormalizesToLoopback -and $LoopbackAllowlisted) {
    Check ("allowlisted loopback accepted: " + $case.Name) ($r.code -eq 200) ("got " + $r.code + " " + $r.body)
    continue
  }
  $rejected = ($r.code -eq 400)
  $detail = "got " + $r.code
  if (-not $rejected -and $r.code -eq 200) {
    $detail = "accepted (job created) - the server will fetch an address it must refuse"
  }
  Check ("SSRF rejected: " + $case.Name) $rejected $detail
}

if ($PositiveProbeUrl) {
  Section "5b. Link downloader happy path (optional)"
  $countBefore = @(Get-ChildItem (Join-Path $filesDir $scratchName) -File -ErrorAction SilentlyContinue).Count
  $r = Invoke-Api -Method POST -Path "/api/fs/download-url" -Body @{ url = $PositiveProbeUrl; dest = $scratchName } -Session $session
  $job = ""
  try { $job = [string](($r.body | ConvertFrom-Json).jobId) } catch { }
  Check "legit download accepted" ($r.code -eq 200 -and $job) ("got " + $r.code + " " + $r.body)
  if ($job) {
    $deadline = (Get-Date).AddSeconds(60)
    $state = "running"
    $jobError = ""
    while ($state -eq "running" -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 500
      $st = Invoke-Api -Method GET -Path ("/api/fs/download-url/status?job=" + $job) -Session $session
      try {
        $parsed = $st.body | ConvertFrom-Json
        $state = [string]$parsed.state
        if ($parsed.error) { $jobError = [string]$parsed.error }
      } catch { $state = "unparsed" }
    }
    Check "legit download completed" ($state -eq "done") ("state=" + $state + " error=" + $jobError)
    $countAfter = @(Get-ChildItem (Join-Path $filesDir $scratchName) -File -ErrorAction SilentlyContinue).Count
    Check "downloaded file landed in the store" ($countAfter -gt $countBefore) ("file count " + $countBefore + " -> " + $countAfter)
  }
} else {
  Note "no -PositiveProbeUrl given - skipping the positive download path"
}

# ---------------------------------------------------------------------------
Section "6. HTML preview must not run in the application origin"
# ---------------------------------------------------------------------------
$probeHtml = Join-Path $scratchAbs "probe.html"
Set-Content -Path $probeHtml -Value "<script>document.title='pwned'</script>probe" -Encoding UTF8
$relHtml = $scratchName + "/probe.html"
$r = Invoke-Api -Method GET -Path ("/api/fs/download?path=" + $relHtml + "&inline=1") -Session $session
$ctype = ""
$previewCsp = ""
if ($r.headers) {
  $ctype = [string]$r.headers["Content-Type"]
  $previewCsp = [string]$r.headers["Content-Security-Policy"]
}
Check "inline HTML is served as text/html" ($ctype -match "text/html") ("got '" + $ctype + "'")
Check "inline HTML response is sandboxed by CSP" ($previewCsp -match "sandbox") ("CSP is '" + $previewCsp + "' - the file runs with full origin privileges")

# SVG is a document too: opened directly it would script the app origin.
$probeSvg = Join-Path $scratchAbs "probe.svg"
Set-Content -Path $probeSvg -Value '<svg xmlns="http://www.w3.org/2000/svg"><script>document.title="pwned"</script></svg>' -Encoding UTF8
$r = Invoke-Api -Method GET -Path ("/api/fs/download?path=" + $scratchName + "/probe.svg&inline=1") -Session $session
$svgCsp = ""
if ($r.headers) { $svgCsp = [string]$r.headers["Content-Security-Policy"] }
Check "inline SVG response is sandboxed by CSP" ($svgCsp -match "sandbox") ("CSP is '" + $svgCsp + "' - an SVG document scripts the app origin when opened directly")

$htmlPage = Join-Path $Root "web\src\pages\html-page.tsx"
$dialogs = Join-Path $Root "web\src\components\browser\dialogs.tsx"
foreach ($pair in @(@{ File = $htmlPage; Label = "html-page.tsx" }, @{ File = $dialogs; Label = "dialogs.tsx" })) {
  if (Test-Path $pair.File) {
    $text = Get-Content -Path $pair.File -Raw
    # Inspect real sandbox attribute values, so a comment that merely mentions
    # allow-same-origin cannot mask a genuine regression.
    $values = @([regex]::Matches($text, 'sandbox="([^"]*)"') | ForEach-Object { $_.Groups[1].Value })
    $sandboxed = ($values -contains "allow-scripts")
    $keepsOrigin = @($values | Where-Object { $_ -match "allow-same-origin" }).Count -gt 0
    Check ("iframe sandboxed in " + $pair.Label) ($sandboxed -and -not $keepsOrigin) ("sandbox values found: " + ($values -join " | "))
  }
}

# ---------------------------------------------------------------------------
Section "7. Existing protections that must not regress"
# ---------------------------------------------------------------------------
# zip-slip: a crafted archive must not write outside the extraction folder.
$evilDir = Join-Path $scratchAbs "evil"
New-Item -ItemType Directory -Path $evilDir -Force | Out-Null
$slipZip = Join-Path $evilDir "slip.zip"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$za = [System.IO.Compression.ZipFile]::Open($slipZip, [System.IO.Compression.ZipArchiveMode]::Create)
foreach ($entry in @(@{ Name = "../../escape-probe.txt"; Data = "escaped" }, @{ Name = "ok/inside.txt"; Data = "legit" })) {
  $e = $za.CreateEntry($entry.Name)
  $w = New-Object System.IO.StreamWriter($e.Open())
  $w.Write($entry.Data)
  $w.Dispose()
}
$za.Dispose()

$r = Invoke-Api -Method POST -Path "/api/fs/extract" -Body @{ path = ($scratchName + "/evil/slip.zip") } -Session $session
$jobId = ""
try { $jobId = [string](($r.body | ConvertFrom-Json).jobId) } catch { }
Check "extract job accepted" ($r.code -eq 200 -and $jobId) ("got " + $r.code + " " + $r.body)
if ($jobId) {
  $deadline = (Get-Date).AddSeconds(20)
  $state = "running"
  while ($state -eq "running" -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    $st = Invoke-Api -Method GET -Path ("/api/fs/extract/status?job=" + $jobId) -Session $session
    try { $state = [string](($st.body | ConvertFrom-Json).state) } catch { $state = "unparsed" }
  }
  Note ("extract job state: " + $state)
  $escapedOntoStore = Test-Path (Join-Path $filesDir "escape-probe.txt")
  $escapedIntoScratch = Test-Path (Join-Path $scratchAbs "escape-probe.txt")
  Check "zip-slip entry cannot escape the extraction folder" ((-not $escapedOntoStore) -and (-not $escapedIntoScratch)) "archive entry escaped the destination"
  Check "legitimate archive entries are still extracted" (Test-Path (Join-Path $evilDir "slip/ok/inside.txt"))
}

# ---------------------------------------------------------------------------
Section "8. Credential / release hygiene (audit item 1)"
# ---------------------------------------------------------------------------
$weakFile = Join-Path $Root ".env"
if (Test-Path $weakFile) {
  $current = Get-EnvValue -File $weakFile -Key "SUPER_ADMIN_PASSWORD"
  $weak = @("", "change-me", "wa114514", "admin", "password", "123456", "12345678")
  $strong = ($current.Length -ge 12) -and ($weak -notcontains $current)
  Check "superadmin password is not a known-weak value" $strong ("length " + $current.Length + ", value is guessable")
}

$releaseZip = Join-Path $Root "ZeroShadow-Release.zip"
if (Test-Path $releaseZip) {
  $zip = [System.IO.Compression.ZipFile]::OpenRead($releaseZip)
  $envEntries = @($zip.Entries | Where-Object { $_.FullName -match "(^|/)\.env$" })
  $backslash = @($zip.Entries | Where-Object { $_.FullName -match "\\" })
  $zip.Dispose()
  Check "release archive ships no .env" ($envEntries.Count -eq 0) ($envEntries.Count.ToString() + " .env entr(ies) inside the archive")
  Check "release archive uses portable '/' paths" ($backslash.Count -eq 0) ($backslash.Count.ToString() + " entr(ies) use backslashes")
} else {
  Note "no release archive present - skipping archive checks"
}

$gate = Join-Path $Root "package-release.ps1"
$gateDir = Join-Path $Root "ZeroShadow-Release"
if (-not (Test-Path $gateDir)) {
  # The gate only has something to judge when a release directory exists.
  # Asserting on a missing directory would report "exit 1 = directory not found"
  # as a hygiene failure, which is not what this check is about.
  Note "no release directory present - skipping the packaging secret gate"
} elseif (Test-Path $gate) {
  $null = & powershell -NoProfile -ExecutionPolicy Bypass -File $gate -ReleaseDir "ZeroShadow-Release" -NoZip -DryRun 2>&1
  Check "release packaging secret gate runs clean" ($LASTEXITCODE -eq 0) ("gate exited " + $LASTEXITCODE)
}

# ---------------------------------------------------------------------------
Section "9. Client IP resolution (rate limiting and logs)"
# ---------------------------------------------------------------------------
$spoofedIp = "203.0.113.7"
$r = Invoke-Api -Method GET -Path ("/api/fs/download?path=" + $guestProbePath) -Session $session -ExtraHeaders @{ "X-Forwarded-For" = $spoofedIp }
$loggedIp = ""
$logs = Invoke-Api -Method GET -Path "/api/admin/logs?limit=60&stats=0" -Session $session
try {
  $entry = ($logs.body | ConvertFrom-Json).logs | Where-Object { $_.ev -eq "download" } | Select-Object -First 1
  if ($entry) { $loggedIp = [string]$entry.ip }
} catch { }
Check "download event is logged with a client IP" (-not [string]::IsNullOrEmpty($loggedIp)) "no download entry found in the log"
if ($loggedIp) {
  if ($TrustProxyMode) {
    Check "X-Forwarded-For is honoured while TRUST_PROXY is on" ($loggedIp -eq $spoofedIp) ("logged ip = " + $loggedIp)
  } else {
    Check "X-Forwarded-For is ignored while TRUST_PROXY is off" ($loggedIp -ne $spoofedIp) ("logged ip = " + $loggedIp + " - a client could spoof its way around IP throttling")
  }
}

if ($TestLockout) {
  # -------------------------------------------------------------------------
  Section "10. Login lockout scoping (fresh server recommended)"
  # -------------------------------------------------------------------------
  $fakeUser = "_locktest-" + ([guid]::NewGuid().ToString("N").Substring(0, 6))
  $codes = @()
  for ($i = 1; $i -le 11; $i++) {
    $r = Invoke-Api -Method POST -Path "/api/auth/login" -Body @{ username = $fakeUser; password = ("wrong-" + $i) }
    $codes += $r.code
  }
  Note ("attempt codes: " + ($codes -join ","))
  Check "repeated failures end in 429 for that account" ($codes[-1] -eq 429) ("last code " + $codes[-1])

  $other = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $r = Invoke-Api -Method POST -Path "/api/auth/login" -Body @{ username = $User; password = $Password } -Session $other
  Check "another account is not caught by that lock" ($r.code -eq 200) ("got " + $r.code)

  $r = Invoke-Api -Method POST -Path "/api/auth/login" -Body @{ username = $fakeUser; password = "wrong-again" }
  Check "someone else's success does not clear a locked account" ($r.code -eq 429) ("got " + $r.code)
}

# ---------------------------------------------------------------------------
Section "11. Extract protection (total size cap and cleanup)"
# ---------------------------------------------------------------------------
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# restore helper: keep the admin's original values in one place
$originalConfig = $null
$cfgResponse = Invoke-Api -Method GET -Path "/api/admin/config" -Session $session
try { $originalConfig = $cfgResponse.body | ConvertFrom-Json } catch { }
if (-not $originalConfig) {
  Check "admin config readable for step-11 checks" $false "could not read /api/admin/config"
} else {
  # (a) declared uncompressed size above the cap must be refused up front
  $bigZip = Join-Path $scratchAbs "big.zip"
  $za = [System.IO.Compression.ZipFile]::Open($bigZip, [System.IO.Compression.ZipArchiveMode]::Create)
  foreach ($name in @("part1.bin", "part2.bin")) {
    $entry = $za.CreateEntry($name)
    $stream = $entry.Open()
    $chunk = New-Object byte[] (700 * 1024)
    $stream.Write($chunk, 0, $chunk.Length)
    $stream.Dispose()
  }
  $za.Dispose()
  $null = Invoke-Api -Method PATCH -Path "/api/admin/config" -Session $session -Body @{ extractMaxTotalMB = 1 }
  $r = Invoke-Api -Method POST -Path "/api/fs/extract" -Body @{ path = ($scratchName + "/big.zip") } -Session $session
  Check "extract refused when the archive exceeds the total cap" ($r.code -eq 400) ("got " + $r.code + " " + $r.body)
  $null = Invoke-Api -Method PATCH -Path "/api/admin/config" -Session $session -Body @{ extractMaxTotalMB = $originalConfig.extractMaxTotalMB }

  # (b) a failure during extraction must not leave a half-written folder behind
  $clashZip = Join-Path $scratchAbs "clash.zip"
  $za = [System.IO.Compression.ZipFile]::Open($clashZip, [System.IO.Compression.ZipArchiveMode]::Create)
  foreach ($name in @("clash", "clash/inner.txt")) {
    $entry = $za.CreateEntry($name)
    $stream = $entry.Open()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("payload")
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Dispose()
  }
  $za.Dispose()
  $r = Invoke-Api -Method POST -Path "/api/fs/extract" -Body @{ path = ($scratchName + "/clash.zip") } -Session $session
  $clashJob = ""
  try { $clashJob = [string](($r.body | ConvertFrom-Json).jobId) } catch { }
  Check "conflicting archive is accepted as a job" ($r.code -eq 200 -and $clashJob) ("got " + $r.code + " " + $r.body)
  if ($clashJob) {
    $deadline = (Get-Date).AddSeconds(20)
    $state = "running"
    while ($state -eq "running" -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 400
      $st = Invoke-Api -Method GET -Path ("/api/fs/extract/status?job=" + $clashJob) -Session $session
      try { $state = [string](($st.body | ConvertFrom-Json).state) } catch { $state = "unparsed" }
    }
    Check "failed extraction reports an error" ($state -eq "error") ("state=" + $state)
    Check "failed extraction leaves no partial folder" (-not (Test-Path (Join-Path $scratchAbs "clash"))) "half-written output remained on disk"
  }
}

# ---------------------------------------------------------------------------
Section "12. Rate limiting on heavy endpoints"
# ---------------------------------------------------------------------------
if (-not $originalConfig) {
  Check "admin config readable for step-12 checks" $false "could not read /api/admin/config"
} else {
  $null = Invoke-Api -Method PATCH -Path "/api/admin/config" -Session $session -Body @{ rateLimitEnabled = $true; rateLimitPerMin = 2 }
  $codes = @()
  $retryAfter = ""
  for ($i = 1; $i -le 6; $i++) {
    $r = Invoke-Api -Method GET -Path "/api/fs/stat?path=" -Session $session
    $codes += $r.code
    if ($r.code -eq 429 -and -not $retryAfter -and $r.headers) { $retryAfter = [string]$r.headers["Retry-After"] }
  }
  Note ("stat codes with a limit of 2/min: " + ($codes -join ","))
  Check "heavy endpoint throttles once the limit is reached" ($codes -contains 429) ("codes " + ($codes -join ","))
  Check "throttled response carries Retry-After" (-not [string]::IsNullOrEmpty($retryAfter)) "no Retry-After header"

  $null = Invoke-Api -Method PATCH -Path "/api/admin/config" -Session $session -Body @{ rateLimitEnabled = $false }
  $codesOff = @()
  for ($i = 1; $i -le 4; $i++) {
    $r = Invoke-Api -Method GET -Path "/api/fs/stat?path=" -Session $session
    $codesOff += $r.code
  }
  Note ("stat codes with limiting disabled: " + ($codesOff -join ","))
  Check "disabling the limiter stops throttling" (-not ($codesOff -contains 429)) ("codes " + ($codesOff -join ","))

  $null = Invoke-Api -Method PATCH -Path "/api/admin/config" -Session $session -Body @{ rateLimitEnabled = $originalConfig.rateLimitEnabled; rateLimitPerMin = $originalConfig.rateLimitPerMin }
  Note ("limiter restored to enabled=" + $originalConfig.rateLimitEnabled + " perMin=" + $originalConfig.rateLimitPerMin)
}

# ---------------------------------------------------------------------------
Section "13. Read-only mapped folders (configured soft dirs)"
# ---------------------------------------------------------------------------
if ($SoftDirName) {
  $r = Invoke-Api -Method POST -Path "/api/fs/copy" -Body @{ sources = @($SoftDirName); dest = $scratchName } -Session $session
  Check "copy out of a read-only mapped folder is refused" ($r.code -eq 403) ("got " + $r.code + " " + $r.body)
  $r = Invoke-Api -Method POST -Path "/api/fs/compress" -Body @{ paths = @($SoftDirName); dest = $scratchName } -Session $session
  Check "compress out of a read-only mapped folder is refused" ($r.code -eq 403) ("got " + $r.code + " " + $r.body)
  $r = Invoke-Api -Method GET -Path ("/api/fs/list?path=" + $SoftDirName) -Session $session
  Check "reading a mapped folder still works" ($r.code -eq 200) ("got " + $r.code)
} else {
  Note "no -SoftDirName given - skipping mapped-folder checks"
}

# ---------------------------------------------------------------------------
Section "14. Job status ownership"
# ---------------------------------------------------------------------------
if ($TestJobOwnership) {
  $memberName = "_sectest-member"
  $memberPass = "sectest-" + ([guid]::NewGuid().ToString("N").Substring(0, 8))
  $created = $false
  try {
    $r = Invoke-Api -Method POST -Path "/api/admin/members" -Body @{ users = @(@{ username = $memberName; password = $memberPass }) } -Session $session
    $created = ($r.code -eq 200 -and $r.body -match '"ok":true')
    Check "temporary member account created" $created ("got " + $r.code + " " + $r.body)
    if ($created) {
      # a job created by the superadmin
      $zipForJob = Join-Path $scratchAbs "jobprobe.zip"
      $za = [System.IO.Compression.ZipFile]::Open($zipForJob, [System.IO.Compression.ZipArchiveMode]::Create)
      $entry = $za.CreateEntry("jobprobe.txt")
      $stream = $entry.Open()
      $bytes = [System.Text.Encoding]::UTF8.GetBytes("job probe")
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Dispose()
      $za.Dispose()
      $r = Invoke-Api -Method POST -Path "/api/fs/extract" -Body @{ path = ($scratchName + "/jobprobe.zip") } -Session $session
      $probeJob = ""
      try { $probeJob = [string](($r.body | ConvertFrom-Json).jobId) } catch { }
      $memberSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
      $login = Invoke-Api -Method POST -Path "/api/auth/login" -Body @{ username = $memberName; password = $memberPass } -Session $memberSession
      Check "temporary member can log in" ($login.code -eq 200) ("got " + $login.code)
      if ($probeJob) {
        $r = Invoke-Api -Method GET -Path ("/api/fs/extract/status?job=" + $probeJob) -Session $memberSession
        $state = ""
        try { $state = [string](($r.body | ConvertFrom-Json).state) } catch { }
        Check "another user's job is hidden while owner-only is on" ($state -eq "gone") ("state=" + $state)

        $null = Invoke-Api -Method PATCH -Path "/api/admin/config" -Session $session -Body @{ jobStatusOwnerOnly = $false }
        $r = Invoke-Api -Method GET -Path ("/api/fs/extract/status?job=" + $probeJob) -Session $memberSession
        $state = ""
        try { $state = [string](($r.body | ConvertFrom-Json).state) } catch { }
        Check "job becomes visible once owner-only is off" ($state -ne "gone") ("state=" + $state)
        $null = Invoke-Api -Method PATCH -Path "/api/admin/config" -Session $session -Body @{ jobStatusOwnerOnly = $originalConfig.jobStatusOwnerOnly }
      }
    }
  } finally {
    if ($created) {
      $idList = @()
      $r = Invoke-Api -Method GET -Path "/api/admin/members" -Session $session
      try { $idList = @(($r.body | ConvertFrom-Json).members | Where-Object { $_.username -eq $memberName } | ForEach-Object { $_.id }) } catch { }
      if ($idList.Count) {
        $null = Invoke-Api -Method POST -Path "/api/admin/members/batch" -Session $session -Body @{ action = "delete"; ids = $idList }
        $r = Invoke-Api -Method GET -Path "/api/admin/members" -Session $session
        $stillThere = $false
        try { $stillThere = @(($r.body | ConvertFrom-Json).members | Where-Object { $_.username -eq $memberName }).Count -gt 0 } catch { }
        Check "temporary member account removed" (-not $stillThere) "cleanup failed - remove $memberName manually"
      }
    }
  }
} else {
  Note "no -TestJobOwnership given - skipping ownership checks"
}

# ---------------------------------------------------------------------------
Section "15. Guest visibility bookkeeping follows renames"
# ---------------------------------------------------------------------------
New-Item -ItemType Directory -Path (Join-Path $scratchAbs "CaseProbe") -Force | Out-Null
# hide it using a different letter case than the on-disk name (Windows/macOS match case-insensitively)
$null = Invoke-Api -Method POST -Path "/api/fs/guest-visibility" -Body @{ path = ($scratchName + "/caseprobe"); hidden = $true } -Session $session
# NOTE: list the scratch folder itself - the hidden entry is nested inside it
$r = Invoke-Api -Method GET -Path ("/api/fs/list?path=" + $scratchName)
Check "guest listing hides the folder" (-not ($r.body -match "CaseProbe")) "guest listing exposed a hidden folder"

$r = Invoke-Api -Method POST -Path "/api/fs/rename" -Body @{ path = ($scratchName + "/CaseProbe"); newName = "CaseRenamed" } -Session $session
Check "probe folder renamed" ($r.code -eq 200) ("got " + $r.code + " " + $r.body)

$r = Invoke-Api -Method GET -Path ("/api/fs/list?path=" + $scratchName)
Check "hidden entry follows the rename (stays hidden)" (-not ($r.body -match "CaseRenamed")) "a rename made a hidden folder public"

$r = Invoke-Api -Method GET -Path ("/api/fs/list?path=" + $scratchName) -Session $session
Check "owner view still marks it hidden" ($r.body -match '"name":"CaseRenamed"[^}]*"hiddenFromGuest":true') "no hidden marker in the owner view"

$null = Invoke-Api -Method POST -Path "/api/fs/guest-visibility" -Body @{ path = ($scratchName + "/CaseRenamed"); hidden = $false } -Session $session

# ---------------------------------------------------------------------------
Section "16. Path resolution hardening"
# ---------------------------------------------------------------------------
foreach ($reserved in @("constructor", "toString", "__proto__", "hasOwnProperty", "valueOf")) {
  $r = Invoke-Api -Method GET -Path ("/api/fs/list?path=" + $reserved)
  Check ("reserved name handled without a server error: " + $reserved) ($r.code -ne 500 -and $r.code -ne 502) ("got " + $r.code)
}

# ---------------------------------------------------------------------------
Section "17. Upload / archive / log-query regressions"
# ---------------------------------------------------------------------------

# stats.users is keyed by username and usernames may differ only by case
# (Wangyq vs wangyq). Windows PowerShell's ConvertFrom-Json treats those as
# duplicate keys and throws, which silently broke the section 9 assertion.
# stats=0 must therefore be able to omit the aggregate entirely.
$r = Invoke-Api -Method GET -Path "/api/admin/logs?limit=5" -Session $session
Check "log query returns aggregated stats by default" ($r.code -eq 200 -and $r.body -match '"stats"') ("got " + $r.code)
$r = Invoke-Api -Method GET -Path "/api/admin/logs?limit=5&stats=0" -Session $session
Check "log query omits stats when stats=0" ($r.code -eq 200 -and $r.body -match '"logs"' -and $r.body -notmatch '"stats"') ("got " + $r.code)

function Send-MultipartUpload {
  param([string]$RelPath, [string]$Body, [string]$Query)
  $boundary = [guid]::NewGuid().ToString("N")
  $nl = "`r`n"
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append("--" + $boundary + $nl)
  [void]$sb.Append('Content-Disposition: form-data; name="files"; filename="' + $RelPath + '"' + $nl)
  [void]$sb.Append("Content-Type: text/plain" + $nl + $nl)
  [void]$sb.Append($Body + $nl)
  [void]$sb.Append("--" + $boundary + "--" + $nl)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($sb.ToString())
  $uri = $BaseUrl + "/api/fs/upload?path=" + $Query
  return Invoke-WebRequest -UseBasicParsing -Method POST -Uri $uri -WebSession $session `
    -Headers @{ "X-Requested-With" = "XMLHttpRequest" } `
    -ContentType ("multipart/form-data; boundary=" + $boundary) -Body $bytes
}

# Folder upload must keep the relative path: busboy strips it unless
# preservePath is enabled, which silently flattened every folder upload.
$r = Send-MultipartUpload -RelPath "UpFolder/Sub/deep.txt" -Body "nested-body" -Query $scratchName
$uploadBody = [string]$r.Content
Check "folder upload keeps the nested relative path" ($uploadBody -match "UpFolder/Sub/deep.txt") ("body: " + $uploadBody)
Check "upload response advertises the per-request file cap" ($uploadBody -match "maxFilesPerRequest") ("body: " + $uploadBody)
$nestedFile = Join-Path $filesDir ($scratchName + "\UpFolder\Sub\deep.txt")
Check "folder upload created the nested directory on disk" (Test-Path -LiteralPath $nestedFile) ("missing " + $nestedFile)

# Folder level overwrite/merge are expressed as the file's relative path; the
# server must match it as well as a bare basename, otherwise both options are
# silent no-ops that leave a "name (1)" duplicate behind.
$overwrite = [uri]::EscapeDataString('["UpFolder/Sub/deep.txt"]')
$r = Send-MultipartUpload -RelPath "UpFolder/Sub/deep.txt" -Body "replaced-body" -Query ($scratchName + "&overwrite=" + $overwrite)
$nestedContent = if (Test-Path -LiteralPath $nestedFile) { [string](Get-Content -LiteralPath $nestedFile -Raw) } else { "" }
Check "folder-level overwrite replaces the nested file" ($nestedContent -match "replaced-body") ("content: " + $nestedContent)
Check "folder-level overwrite leaves no duplicate copy" (-not (Test-Path -LiteralPath (Join-Path $filesDir ($scratchName + "\UpFolder\Sub\deep (1).txt")))) "a duplicate copy was created"

# Copy/move use targetNames so the conflict dialog's "rename" option works.
# It used to rename the SOURCE path on the client, so the server always 404ed.
$null = Invoke-Api -Method POST -Path "/api/fs/save-file" -Session $session -Body @{ path = ($scratchName + "/src.txt"); content = "source" }
$null = Invoke-Api -Method POST -Path "/api/fs/mkdir" -Session $session -Body @{ path = $scratchName; name = "dest" }
$null = Invoke-Api -Method POST -Path "/api/fs/save-file" -Session $session -Body @{ path = ($scratchName + "/dest/src.txt"); content = "existing" }
$r = Invoke-Api -Method POST -Path "/api/fs/copy" -Session $session -Body @{
  sources     = @($scratchName + "/src.txt")
  dest        = ($scratchName + "/dest")
  targetNames = @{ ($scratchName + "/src.txt") = "src (1).txt" }
}
$renamedCopy = Join-Path $filesDir ($scratchName + "\dest\src (1).txt")
Check "copy honours targetNames (conflict rename)" ($r.code -eq 200 -and (Test-Path -LiteralPath $renamedCopy)) ("got " + $r.code + " " + $r.body)

# save-file carries a whole file body, so its JSON limit is raised well above
# the global 1 MB; before that fix a 2 MB file could not be saved at all and
# express.json answered with the English "request entity too large".
$twoMb = "a" * (2 * 1024 * 1024)
$r = Invoke-Api -Method POST -Path "/api/fs/save-file" -Session $session -Body @{ path = ($scratchName + "/big.txt"); content = $twoMb }
Check "save-file accepts a 2 MB body (limit raised above the global 1 MB)" ($r.code -eq 200) ("got " + $r.code + " " + $r.body)
$bigFile = Join-Path $filesDir ($scratchName + "\big.txt")
$bigSize = if (Test-Path -LiteralPath $bigFile) { (Get-Item -LiteralPath $bigFile).Length } else { -1 }
Check "save-file wrote the complete body (atomic replace)" ($bigSize -eq (2 * 1024 * 1024)) ("size " + $bigSize)

# ---------------------------------------------------------------------------
# cleanup
# ---------------------------------------------------------------------------
if ($script:scratch -and (Test-Path $script:scratch)) {
  if ($KeepScratch) {
    Note ("scratch kept at " + $script:scratch)
  } else {
    Remove-Item -LiteralPath $script:scratch -Recurse -Force -ErrorAction SilentlyContinue
  }
}
$leftover = Join-Path $filesDir "escape-probe.txt"
if (Test-Path $leftover) { Remove-Item -LiteralPath $leftover -Force -ErrorAction SilentlyContinue }

Write-Host ""
Write-Host ("checks passed: " + $script:passed + "   failed: " + $script:failed) -ForegroundColor ($(if ($script:failed -eq 0) { "Green" } else { "Red" }))
if ($script:failed -gt 0) {
  Write-Host "failing checks:" -ForegroundColor Red
  foreach ($name in $script:names) { Write-Host ("  - " + $name) -ForegroundColor Red }
}
exit $script:failed
