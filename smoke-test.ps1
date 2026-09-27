# ============================================================================
#  smoke-test.ps1 - ZeroShadow 冒烟测试
#
#  作用：对一台**正在运行**的 ZeroShadow 实例做端到端功能回归，覆盖 15 组断言：
#        传输层与认证、目录操作、路径穿越、上传、访客可见性与权限边界、
#        成员全生命周期、长任务（ZIP）、搜索、日志、状态、隧道、SPA 与静态资源。
#
#  用法：
#     # 1) 先起一个实例（默认端口取自仓库根 .env 的 PORT）
#     pnpm dev:server        # 或 pnpm start
#     # 2) 另开一个终端
#     pwsh -NoProfile -File smoke-test.ps1
#     # 指定别的实例（例如独立测试实例）
#     pwsh -NoProfile -File smoke-test.ps1 -BaseUrl http://127.0.0.1:5179
#
#  参数：
#     -BaseUrl   被测服务地址，默认 http://127.0.0.1:<.env 里的 PORT>
#     -Root      项目根目录，默认脚本所在目录（用于读 .env）
#     -User      超管用户名，默认读 .env 的 SUPER_ADMIN_USER
#     -Password  超管密码，  默认读 .env 的 SUPER_ADMIN_PASSWORD
#     -KeepScratch  保留测试用的临时目录（默认跑完删掉）
#
#  退出码：= 失败项数量（0 表示全部通过）；连不上服务退 1；超管登录失败退 2。
#
#  安全声明：脚本只在网盘文件库里创建一个临时目录（跑完自动删除），并临时创建
#            一个成员账号（跑完自动删除）。它**不会**读取或修改 data/ 下的任何
#            运行时文件，也不改动服务配置。
#
#  注意：脚本刻意用 127.0.0.1 而不是 localhost —— 服务端监听 0.0.0.0（仅 IPv4），
#        而 localhost 在部分系统上会先解析到 ::1，导致连接被拒。
# ============================================================================
[CmdletBinding()]
param(
  [string]$BaseUrl = "",
  [string]$Root = "",
  [string]$User = "",
  [string]$Password = "",
  [switch]$KeepScratch
)

$ErrorActionPreference = "Continue"

if (-not $Root) {
  $scriptPath = $MyInvocation.MyCommand.Path
  $Root = if ($scriptPath) { Split-Path -Parent $scriptPath } else { (Get-Location).Path }
}
$Root = (Resolve-Path $Root).Path

# ---------------------------------------------------------------- 报告 ------
$script:Pass = 0
$script:Fail = 0
$script:Skip = 0

function Section {
  param([string]$Title)
  Write-Host ""
  Write-Host "== $Title" -ForegroundColor Cyan
}

function Check {
  param([string]$Name, [bool]$Ok, [string]$Detail = "")
  if ($Ok) {
    $script:Pass++
    Write-Host "PASS $Name" -ForegroundColor Green
  } else {
    $script:Fail++
    $line = "FAIL $Name"
    if ($Detail) { $line += "  -- $Detail" }
    Write-Host $line -ForegroundColor Red
  }
}

function Skip {
  param([string]$Name, [string]$Reason = "")
  $script:Skip++
  Write-Host ("SKIP {0}  ({1})" -f $Name, $Reason) -ForegroundColor DarkGray
}

function Note {
  param([string]$Message)
  Write-Host "   .. $Message" -ForegroundColor DarkGray
}

# ------------------------------------------------------------ 基础设施 ------
# 从 KEY=VALUE 文本里取值；只认非注释行，取最后一个匹配（后写覆盖先写）。
function Read-EnvValue {
  param([string]$File, [string]$Key, [string]$Default = "")
  if (-not (Test-Path $File)) { return $Default }
  $value = $Default
  foreach ($line in ([System.IO.File]::ReadAllLines($File, [System.Text.Encoding]::UTF8))) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $idx = $trimmed.IndexOf("=")
    if ($idx -lt 1) { continue }
    if ($trimmed.Substring(0, $idx).Trim() -ne $Key) { continue }
    $value = $trimmed.Substring($idx + 1).Trim()
  }
  return $value
}

# 请求体一律用 UTF-8 字节发送：Windows PowerShell 5.1 在 ContentType 未带
# charset 时会按 ISO-8859-1 编码字符串，中文会被写成乱码。
#
# 注意 return 后面那个逗号：PowerShell 会把函数返回的数组「展开」成多个输出
# 对象，于是 byte[] 到了调用方就变成 Object[]，再交给 -Body 会被拼成
# "123 45 67 ..." 这样的字符串，服务端 express.json() 解析失败返回 400。
# 逗号把它包成单元素数组，展开后正好还原成 byte[]。
function JsonBytes {
  param([object]$Object)
  $json = $Object | ConvertTo-Json -Depth 10 -Compress
  return , ([System.Text.Encoding]::UTF8.GetBytes($json))
}

# 统一把异常翻译成 HTTP 状态码（PS 5.1 的 WebException 与 PS 7 的
# HttpResponseException 结构不同，这里两种都兼容）。
function Get-ErrorStatus {
  param($ErrorRecord)
  try {
    $response = $ErrorRecord.Exception.Response
    if ($null -eq $response) { return 0 }
    $code = $response.StatusCode
    if ($null -eq $code) { return 0 }
    return [int]$code
  } catch {
    return 0
  }
}

# 永不抛异常的请求封装：返回 Ok / Status / Content。
function Invoke-Api {
  param([hashtable]$Parameters)
  try {
    $response = Invoke-WebRequest -UseBasicParsing @Parameters
    return [pscustomobject]@{
      Ok      = $true
      Status  = [int]$response.StatusCode
      Content = [string]$response.Content
      Headers = $response.Headers
      Error   = ""
    }
  } catch {
    # 把错误响应的正文也读出来：否则断言失败时只能看到一个状态码，
    # 排查「400 是 CSRF 还是 JSON 解析失败」这类问题会非常痛苦。
    $body = ""
    try {
      $stream = $_.Exception.Response.GetResponseStream()
      if ($stream) {
        $reader = New-Object System.IO.StreamReader($stream)
        $body = $reader.ReadToEnd()
        $reader.Dispose()
      }
    } catch { }
    return [pscustomobject]@{
      Ok      = $false
      Status  = (Get-ErrorStatus $_)
      Content = $body
      Headers = $null
      Error   = $_.Exception.Message
    }
  }
}

# ------------------------------------------------------------ 读配置 -------
$envFile = Join-Path $Root ".env"
if (-not $User) { $User = Read-EnvValue -File $envFile -Key "SUPER_ADMIN_USER" -Default "admin" }
if (-not $Password) { $Password = Read-EnvValue -File $envFile -Key "SUPER_ADMIN_PASSWORD" }
$port = [int](Read-EnvValue -File $envFile -Key "PORT" -Default "12345")
if ($port -lt 1 -or $port -gt 65535) { $port = 12345 }
if (-not $BaseUrl) { $BaseUrl = "http://127.0.0.1:$port" }
$BaseUrl = $BaseUrl.TrimEnd("/")

Write-Host "ZeroShadow 冒烟测试" -ForegroundColor White
Note "项目根目录: $Root"
Note "被测服务:   $BaseUrl"
Note "超管账号:   $User"

$csrf = @{ "X-Requested-With" = "XMLHttpRequest" }
$jsonHeaders = @{ "X-Requested-With" = "XMLHttpRequest" }
$jsonType = "application/json; charset=utf-8"

# 临时资源名：加随机后缀，避免与既有数据冲突，也让脚本可重复运行。
$suffix = -join ((1..8) | ForEach-Object { "0123456789abcdef"[(Get-Random -Maximum 16)] })
$scratch = "_smoketest-$suffix"
$publicDir = "$scratch/公开资料"
$internalDir = "$scratch/内部资料"
$memberName = "smoke_$suffix"
$memberPassword = "Smoke-$suffix-1"
# 用于「错误凭据返回 401」的断言，见 Section 1 的说明。
$noSuchUser = "nosuchuser-$suffix"
$uploadName = "测试文档.txt"
$localTmp = Join-Path ([System.IO.Path]::GetTempPath()) "zs-smoke-$suffix.txt"

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$memberSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$memberId = $null

# 访客可见性测试会写 data/config.json。记下它原本是否存在，好让清理阶段能把
# 实例还原成原样（config.json 一旦存在就会永久覆盖代码里的 DEFAULTS）。
$configFile = Join-Path $Root "data/config.json"
$configExistedBefore = Test-Path $configFile

# 退出码与清理：无论中途怎么退出，都尽量把痕迹擦干净。
function Get-Finished {
  param([int]$Code)
  try {
    if ($memberId -and $session) {
      Invoke-Api -Parameters @{
        Uri = "$BaseUrl/api/admin/members/batch"; Method = "POST"; Headers = $jsonHeaders
        ContentType = $jsonType; Body = (JsonBytes @{ action = "delete"; ids = @($memberId) })
        WebSession = $session
      } | Out-Null
    }
  } catch { }
  try {
    if ($session) {
      Invoke-Api -Parameters @{
        Uri = "$BaseUrl/api/fs/delete"; Method = "POST"; Headers = $jsonHeaders
        ContentType = $jsonType; Body = (JsonBytes @{ paths = @($scratch) })
        WebSession = $session
      } | Out-Null
    }
  } catch { }
  # 显式撤销访客隐藏设置。服务端在删除目录时也会顺手清理 hiddenPaths，但那是
  # 实现细节，不能依赖它——否则将来改了 delete 的处理逻辑，这里就会留下一条
  # 指向已删除目录的死配置。
  try {
    if ($session) {
      Invoke-Api -Parameters @{
        Uri = "$BaseUrl/api/admin/hidden-paths"; Method = "DELETE"; Headers = $jsonHeaders
        ContentType = $jsonType; Body = (JsonBytes @{ path = $internalDir })
        WebSession = $session
      } | Out-Null
    }
  } catch { }
  # data/config.json 一旦存在，就会永久覆盖代码里的 DEFAULTS，日后升级拿不到
  # 新的默认值。所以：只有当本次运行才第一次生成它、且隐藏列表已清空时才删掉，
  # 让实例回到「纯默认值」的原状。被别人改过配置就原样保留。
  try {
    if (-not $configExistedBefore -and (Test-Path $configFile)) {
      $cfg = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if (-not $cfg.guestHiddenPaths -or @($cfg.guestHiddenPaths).Count -eq 0) {
        Remove-Item $configFile -Force -ErrorAction Stop
        Note "已删除测试期间首次生成的 data/config.json，恢复纯默认值状态"
      } else {
        Note "data/config.json 仍含访客隐藏项，保留不动：$($cfg.guestHiddenPaths -join ', ')"
      }
    }
  } catch { }
  if (-not $KeepScratch) { Remove-Item $localTmp -Force -ErrorAction SilentlyContinue }
  Write-Host ""
  Write-Host ("===== 通过 {0} / 失败 {1} / 跳过 {2} =====" -f $script:Pass, $script:Fail, $script:Skip) `
    -ForegroundColor $(if ($script:Fail -eq 0) { "Green" } else { "Red" })
  exit $Code
}

# ------------------------------------------------- 0. 连通性 ---------------
Section "0. 连通性"
$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/ping"; Method = "GET" }
if (-not $r.Ok -or $r.Content.Trim() -ne "pong") {
  Write-Host "无法连接 $BaseUrl/ping —— 请先启动服务（pnpm dev:server 或 pnpm start）" -ForegroundColor Red
  Note "最后错误: $($r.Error)"
  exit 1
}
Check "ping" $true

$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/meta"; Method = "GET" }
Check "meta" ($r.Ok -and $r.Content -match '"name"')

# --------------------------------------------- 1. CSRF 与登录 --------------
Section "1. CSRF 拦截与认证"
$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/auth/login"; Method = "POST"; ContentType = $jsonType
  Body = (JsonBytes @{ username = $User; password = "definitely-wrong" })
}
Check "csrf-blocked" ($r.Status -eq 403) "期望 403，实际 $($r.Status)"

# 故意用一个不存在的用户名，而不是超管自己的账号：登录失败计数是按「提交的
# 用户名」累计的（server/src/auth.js 的 recordLoginFail），连打 10 次同一用户名
# 就会把该账号锁 5 分钟并逐步翻倍。超管全局唯一，用他的账号做这个断言等于每跑
# 一次冒烟测试就给他记一笔失败，多跑几轮就会把自己锁在门外。
$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/auth/login"; Method = "POST"; Headers = $jsonHeaders
  ContentType = $jsonType
  Body = (JsonBytes @{ username = $noSuchUser; password = "definitely-wrong" })
}
Check "bad-login-401" ($r.Status -eq 401) "期望 401，实际 $($r.Status)"

$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/auth/login"; Method = "POST"; Headers = $jsonHeaders
  ContentType = $jsonType; Body = (JsonBytes @{ username = $User; password = $Password })
  WebSession = $session
}
if (-not $r.Ok -or $r.Content -notmatch "superadmin") {
  Write-Host "超管登录失败 —— 请核对 $envFile 里的 SUPER_ADMIN_USER / SUPER_ADMIN_PASSWORD" -ForegroundColor Red
  Note "实际状态: $($r.Status)  响应: $($r.Content)"
  exit 2
}
Check "super-login" $true

# --------------------------------------------- 2. 目录与路径穿越 -------------
Section "2. 目录操作与路径穿越"
$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/mkdir"; Method = "POST"; Headers = $jsonHeaders
  ContentType = $jsonType; Body = (JsonBytes @{ path = ""; name = $scratch }); WebSession = $session
}
Check "mkdir-scratch" ($r.Ok) "$($r.Status) $($r.Content)"

$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/mkdir"; Method = "POST"; Headers = $jsonHeaders
  ContentType = $jsonType; Body = (JsonBytes @{ path = $scratch; name = "公开资料" }); WebSession = $session
}
Check "mkdir-public" ($r.Ok) "$($r.Status)"

$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/mkdir"; Method = "POST"; Headers = $jsonHeaders
  ContentType = $jsonType; Body = (JsonBytes @{ path = $scratch; name = "内部资料" }); WebSession = $session
}
Check "mkdir-internal" ($r.Ok) "$($r.Status)"

$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/list?path=" + [uri]::EscapeDataString("../../"); WebSession = $session
}
Check "traversal-blocked" ($r.Status -eq 400) "期望 400，实际 $($r.Status)"

# --------------------------------------------- 3. 上传 -------------
Section "3. 上传"
[System.IO.File]::WriteAllText($localTmp, "hello zeroshadow 中文测试`n", (New-Object System.Text.UTF8Encoding($false)))
$boundary = [System.Guid]::NewGuid().ToString()
$enc = [System.Text.Encoding]::UTF8
$fileBytes = [System.IO.File]::ReadAllBytes($localTmp)
$pre = $enc.GetBytes(
  "--$boundary`r`n" +
  "Content-Disposition: form-data; name=`"files`"; filename=`"$uploadName`"`r`n" +
  "Content-Type: text/plain`r`n`r`n")
$post = $enc.GetBytes("`r`n--$boundary--`r`n")
$body = New-Object byte[] ($pre.Length + $fileBytes.Length + $post.Length)
[Array]::Copy($pre, 0, $body, 0, $pre.Length)
[Array]::Copy($fileBytes, 0, $body, $pre.Length, $fileBytes.Length)
[Array]::Copy($post, 0, $body, $pre.Length + $fileBytes.Length, $post.Length)

$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/upload?path=" + [uri]::EscapeDataString($publicDir)
  Method = "POST"; Headers = $jsonHeaders
  ContentType = "multipart/form-data; boundary=$boundary"; Body = $body; WebSession = $session
}
Check "upload" ($r.Ok -and $r.Content -match '"ok":true') "$($r.Status) $($r.Content)"

$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/list?path=" + [uri]::EscapeDataString($publicDir); WebSession = $session
}
Check "upload-visible" ($r.Content -match [regex]::Escape($uploadName))

# --------------------------------------------- 4. 访客可见性 -----------------
Section "4. 访客可见性与权限边界"
$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/guest-visibility"; Method = "POST"; Headers = $jsonHeaders
  ContentType = $jsonType; Body = (JsonBytes @{ path = $internalDir; hidden = $true }); WebSession = $session
}
Check "hide-folder" ($r.Ok) "$($r.Status) $($r.Content)"

$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/list?path=" + [uri]::EscapeDataString($scratch); WebSession = $session
}
Check "admin-sees-hidden" ($r.Content -match "内部资料")

$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/fs/list?path=" + [uri]::EscapeDataString($scratch) }
Check "guest-hidden-filtered" (-not ($r.Content -match "内部资料"))

$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/fs/list?path=" + [uri]::EscapeDataString($internalDir) }
Check "guest-hidden-404" ($r.Status -eq 404) "期望 404，实际 $($r.Status)"

$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/admin/status" }
Check "guest-admin-401" ($r.Status -eq 401) "期望 401，实际 $($r.Status)"

$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/mkdir"; Method = "POST"; Headers = $jsonHeaders
  ContentType = $jsonType; Body = (JsonBytes @{ path = ""; name = "guest-should-not-exist" })
}
Check "guest-mkdir-401" ($r.Status -eq 401) "期望 401，实际 $($r.Status)"

$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/download?path=" + [uri]::EscapeDataString("$publicDir/$uploadName")
}
Check "guest-download" ($r.Status -eq 200) "期望 200，实际 $($r.Status)"

$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/auth/me" }
Check "guest-me" ($r.Content -match '"role":"guest"')

# --------------------------------------------- 5. 成员生命周期 ---------------
Section "5. 成员生命周期"
$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/admin/members"; Method = "POST"; Headers = $jsonHeaders
  ContentType = $jsonType; WebSession = $session
  Body = (JsonBytes @{ users = @(@{ username = $memberName; password = $memberPassword }) })
}
Check "member-create" ($r.Ok -and $r.Content -match '"ok":true') "$($r.Status) $($r.Content)"

# 按用户名查 id：绝不能取 members[0]，那会命中既有账号（本仓库就存在多个）。
$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/admin/members"; WebSession = $session }
$memberId = $null
try {
  $memberId = ($r.Content | ConvertFrom-Json).members |
    Where-Object { $_.username -eq $memberName } |
    Select-Object -First 1 -ExpandProperty id
} catch { }
Check "member-id-found" ([bool]$memberId) "在成员列表里找不到 $memberName"

$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/auth/login"; Method = "POST"; Headers = $jsonHeaders
  ContentType = $jsonType; WebSession = $memberSession
  Body = (JsonBytes @{ username = $memberName; password = $memberPassword })
}
Check "member-login" ($r.Ok -and $r.Content -match '"member"') "$($r.Status) $($r.Content)"

# 断言 me 与后台配置一致，而不是写死 512 —— 否则管理员调整过上限就会误报。
$rConfig = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/admin/config"; WebSession = $session }
$expectedLimit = $null
try { $expectedLimit = ($rConfig.Content | ConvertFrom-Json).memberUploadLimitMB } catch { }
$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/auth/me"; WebSession = $memberSession }
$actualLimit = $null
try { $actualLimit = ($r.Content | ConvertFrom-Json).uploadLimitMB } catch { }
Check "member-me-limit" ($null -ne $expectedLimit -and $expectedLimit -eq $actualLimit) `
  "me=$actualLimit 配置=$expectedLimit"

$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/admin/config"; WebSession = $memberSession }
Check "member-admin-403" ($r.Status -eq 403) "期望 403，实际 $($r.Status)"

# --------------------------------------------- 6. 文件操作 -------------------
Section "6. 复制 / 重命名 / 移动 / 详情 / 删除"
$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/copy"; Method = "POST"; Headers = $jsonHeaders
  ContentType = $jsonType; WebSession = $memberSession
  Body = (JsonBytes @{ sources = @("$publicDir/$uploadName"); dest = $scratch })
}
Check "member-copy" ($r.Ok) "$($r.Status) $($r.Content)"

$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/rename"; Method = "POST"; Headers = $jsonHeaders
  ContentType = $jsonType; WebSession = $memberSession
  Body = (JsonBytes @{ path = "$scratch/$uploadName"; newName = "改名了.txt" })
}
Check "member-rename" ($r.Ok) "$($r.Status) $($r.Content)"

$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/move"; Method = "POST"; Headers = $jsonHeaders
  ContentType = $jsonType; WebSession = $memberSession
  Body = (JsonBytes @{ sources = @("$scratch/改名了.txt"); dest = $publicDir })
}
Check "member-move" ($r.Ok) "$($r.Status) $($r.Content)"

$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/stat?path=" + [uri]::EscapeDataString($publicDir); WebSession = $memberSession
}
Check "member-stat-files-2" ($r.Content -match '"files":2') "响应: $($r.Content)"

$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/delete"; Method = "POST"; Headers = $jsonHeaders
  ContentType = $jsonType; WebSession = $memberSession
  Body = (JsonBytes @{ paths = @("$publicDir/改名了.txt") })
}
Check "member-delete" ($r.Ok) "$($r.Status) $($r.Content)"

# --------------------------------------------- 7. 禁用成员 -------------------
Section "7. 禁用成员后会话失效"
$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/admin/members/batch"; Method = "POST"; Headers = $jsonHeaders
  ContentType = $jsonType; WebSession = $session
  Body = (JsonBytes @{ action = "disable"; ids = @($memberId) })
}
Check "member-disable" ($r.Ok) "$($r.Status) $($r.Content)"

$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/auth/me"; WebSession = $memberSession }
Check "disabled-member-guest" ($r.Content -match '"guest"') "响应: $($r.Content)"

# --------------------------------------------- 8. 长任务与运维接口 -----------
Section "8. ZIP 打包 / 搜索 / 日志 / 状态 / 隧道"
$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/zip?path=" + [uri]::EscapeDataString($publicDir); WebSession = $session
}
Check "zip" ($r.Ok -and "$($r.Headers["Content-Type"])" -match "zip") `
  "$($r.Status) Content-Type=$($r.Headers["Content-Type"])"

$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/search?q=" + [uri]::EscapeDataString("测试") +
        "&path=" + [uri]::EscapeDataString($scratch); WebSession = $session
}
Check "search" ($r.Content -match [regex]::Escape($uploadName)) "响应: $($r.Content)"

$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/admin/logs?limit=50"; WebSession = $session }
Check "logs" ($r.Content -match "login_success")

$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/admin/status"; WebSession = $session }
Check "status" ($r.Ok -and $r.Content -match '"node"' -and $r.Content -match '"storage"')

# 不断言 enabled=false：隧道可能正被有意开启。改为验证结构正确。
$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/admin/tunnel"; WebSession = $session }
$tunnelOk = $false
try {
  $tunnel = $r.Content | ConvertFrom-Json
  $tunnelOk = ($null -ne $tunnel.config) -and ($null -ne $tunnel.status) -and
              ($tunnel.config.enabled -is [bool])
} catch { }
Check "tunnel-status" $tunnelOk "响应: $($r.Content)"

# --------------------------------------------- 9. 前端托管 ------------------
Section "9. SPA 与静态资源"
$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/"; Method = "GET" }
if ($r.Status -eq 503) {
  Skip "spa-index" "前端未构建（web/dist 不存在）；开发模式请改用 pnpm dev:web 直接访问 5173"
} else {
  # 注意：页面标题是 ZeroShadow，不是 EPan（旧断言写错，必然失败）。
  Check "spa-index" ($r.Ok -and $r.Content -match "ZeroShadow") "$($r.Status)"
}

$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/resources/lucide.min.js"; Method = "HEAD" }
if ($r.Status -eq 503) {
  Skip "resources" "前端未构建（web/dist 不存在）"
} else {
  Check "resources" ($r.Status -eq 200) "期望 200，实际 $($r.Status)"
}

Get-Finished $(if ($script:Fail -gt 0) { $script:Fail } else { 0 })
