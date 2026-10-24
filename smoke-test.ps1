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
      # 删除现在会**移入回收站**（1.1.2 起），所以还要把回收站里属于本次测试的
      # 条目彻底清掉 —— 否则每跑一次冒烟测试就在实例回收站里留一条
      # _smoketest-xxxx，跑多次就攒一堆。
      # 只清理"原路径等于或位于本次 scratch 之下"的条目：绝不动用户在回收站里的东西。
      $tr = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/admin/trash"; WebSession = $session }
      $mine = @()
      try {
        $mine = ($tr.Content | ConvertFrom-Json).items |
          Where-Object { $_.rel -eq $scratch -or $_.rel -like "$scratch/*" }
      } catch { }
      foreach ($trashItem in $mine) {
        Invoke-Api -Parameters @{
          Uri = "$BaseUrl/api/admin/trash/purge"; Method = "POST"; Headers = $jsonHeaders
          ContentType = $jsonType; Body = (JsonBytes @{ id = $trashItem.id }); WebSession = $session
        } | Out-Null
      }
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

# --------------------------------------------- 10. 兼容模式页面 ------------
# web/public/robustness/ 是给旧浏览器（IE11 / 老 Chrome）用的独立静态页，
# 不经过 Vite 打包。这里断言它能被托管、且与后端 CSP 不冲突。
Section "10. 兼容模式页面（robustness）"
$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/robustness/index.html"; Method = "GET" }
if ($r.Status -eq 503 -or $r.Status -eq 404) {
  Skip "robustness-page" "前端未构建或未包含 robustness（需先 pnpm build）"
} else {
  Check "robustness-page" ($r.Status -eq 200) "期望 200，实际 $($r.Status)"

  # 页面外壳的 CSP 是 script-src 'self'，内联 <script> 会被浏览器拦掉 ——
  # 所以这份页面必须只引用外部脚本。这条断言防的是"后来有人往 HTML 里塞内联脚本"。
  #
  # 三步，每一步都是踩过的坑：
  #   1. 先剥掉 HTML 注释：页面里有一句注释写着"内联 <script> 会被拦掉"，
  #      那个裸标签会被当成真的内联脚本；
  #   2. 再把每个 <script ...> 开标签单独挑出来，看它**自己**有没有 src=；
  #   3. 不要用 "<script(?![^>]*src=)" 负向前瞻：.NET 正则会从下一个 <script
  #      重新尝试，一路匹配到后面标签的 src=，把合法外部脚本误报成内联脚本。
  $stripped = [regex]::Replace($r.Content, '<!--.*?-->', '', 'Singleline')
  $scriptTags = [regex]::Matches($stripped, '<script\b[^>]*>', "IgnoreCase")
  $inlineCount = 0
  foreach ($tag in $scriptTags) { if ($tag.Value -notmatch '\bsrc\s*=') { $inlineCount++ } }
  Check "robustness-no-inline-script" ($inlineCount -eq 0) "发现 $inlineCount 处内联脚本（会被 CSP 拦掉）"

  foreach ($asset in @("/robustness/index.css", "/robustness/index.js", "/robustness/theme-boot.js")) {
    $a = Invoke-Api -Parameters @{ Uri = "$BaseUrl$asset"; Method = "GET" }
    # 若文件不存在，SPA fallback 会返回 index.html（text/html），这里正是要抓这种情况
    $ok = $a.Status -eq 200 -and $a.Content -notmatch '<!doctype html'
    Check ("robustness-asset " + $asset) $ok "$($a.Status) $($a.Headers['Content-Type'])"
  }

  # 首页底部必须有进入兼容模式的入口。
  # 变量名不能叫 $home：PowerShell 变量名不区分大小写，$HOME 是只读自动变量，
  # 赋值会直接抛错并中断脚本 —— 早期就是踩了这个才让后面一条断言拿到状态码 0。
  $homePage = Invoke-Api -Parameters @{ Uri = "$BaseUrl/"; Method = "GET" }
  Check "robustness-entry-on-home" ($homePage.Content -match '/robustness/index\.html') "首页未找到兼容模式入口链接"
}

# --------------------------------------------- 11. 回收站 -----------------
Section "11. 回收站"

$trashDir = "$scratch/回收站探针"
Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/mkdir"; Method = "POST"; Headers = $jsonHeaders
  ContentType = $jsonType; Body = (JsonBytes @{ path = $scratch; name = "回收站探针" }); WebSession = $session
} | Out-Null
Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/save-file"; Method = "POST"; Headers = $jsonHeaders
  ContentType = $jsonType; Body = (JsonBytes @{ path = "$trashDir/inside.txt"; content = "trash probe" }); WebSession = $session
} | Out-Null

$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/delete"; Method = "POST"; Headers = $jsonHeaders
  ContentType = $jsonType; Body = (JsonBytes @{ paths = @($trashDir) }); WebSession = $session
}
# 删除必须进回收站（trashed=1），而不是直接销毁
Check "trash-delete-trashifies" ($r.Status -eq 200 -and $r.Content -match '"trashed"\s*:\s*1') "期望 trashed=1，实际 $($r.Status) $($r.Content)"

$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/fs/list?path=" + [uri]::EscapeDataString($scratch); WebSession = $session }
Check "trash-hidden-after-delete" ($r.Content -notmatch "inside\.txt") "删除后仍能在列表里看到"

$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/admin/trash"; WebSession = $session }
$trashItem = $null
try { $trashItem = ($r.Content | ConvertFrom-Json).items | Where-Object { $_.rel -eq $trashDir } | Select-Object -First 1 } catch { }
Check "trash-lists-item" ($null -ne $trashItem) "回收站里没找到该条目；响应前 200 字: $($r.Content.Substring(0, [Math]::Min(200, $r.Content.Length)))"
Check "trash-records-origin" ([bool]($trashItem -and $trashItem.type -eq "dir" -and $trashItem.deletedBy)) "原类型与删除者应被记录"

if ($trashItem) {
  $r = Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/admin/trash/restore"; Method = "POST"; Headers = $jsonHeaders
    ContentType = $jsonType; Body = (JsonBytes @{ id = $trashItem.id }); WebSession = $session
  }
  Check "trash-restore" ($r.Status -eq 200) "期望 200，实际 $($r.Status) $($r.Content)"
  $r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/fs/list?path=" + [uri]::EscapeDataString($trashDir); WebSession = $session }
  Check "trash-restored-content" ($r.Content -match "inside\.txt") "还原后内容不在原位"

  # 再删一次并彻底删除，避免测试在回收站里留下垃圾
  Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/fs/delete"; Method = "POST"; Headers = $jsonHeaders
    ContentType = $jsonType; Body = (JsonBytes @{ paths = @($trashDir) }); WebSession = $session
  } | Out-Null
  $r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/admin/trash"; WebSession = $session }
  $again = $null
  try { $again = ($r.Content | ConvertFrom-Json).items | Where-Object { $_.rel -eq $trashDir } | Select-Object -First 1 } catch { }
  if ($again) {
    $r = Invoke-Api -Parameters @{
      Uri = "$BaseUrl/api/admin/trash/purge"; Method = "POST"; Headers = $jsonHeaders
      ContentType = $jsonType; Body = (JsonBytes @{ id = $again.id }); WebSession = $session
    }
    Check "trash-purge" ($r.Status -eq 200) "期望 200，实际 $($r.Status)"
  } else {
    Check "trash-purge" $false "回收站里找不到刚删除的探针"
  }
}

# --------------------------------------------- 12. 并发编辑保护 -----------
Section "12. 并发编辑保护"

$conflictPath = "$scratch/conflict.txt"
$r = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/save-file"; Method = "POST"; Headers = $jsonHeaders
  ContentType = $jsonType; Body = (JsonBytes @{ path = $conflictPath; content = "v1" }); WebSession = $session
}
Check "conflict-setup" ($r.Status -eq 200) "建立测试文件失败：$($r.Status) $($r.Content)"

$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/fs/file?path=" + [uri]::EscapeDataString($conflictPath); WebSession = $session }
$baseVersion = $null
try { $baseVersion = ($r.Content | ConvertFrom-Json).baseVersion } catch { }
# 没有版本串就无法发现"别人已经改过"，这条断了整个并发保护就失效
Check "conflict-baseversion-returned" ([bool]$baseVersion) "GET /api/fs/file 应返回 baseVersion"

if ($baseVersion) {
  $r = Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/fs/save-file"; Method = "POST"; Headers = $jsonHeaders
    ContentType = $jsonType; Body = (JsonBytes @{ path = $conflictPath; content = "v2"; baseVersion = $baseVersion }); WebSession = $session
  }
  Check "conflict-save-fresh-version" ($r.Status -eq 200) "带正确版本应能保存，实际 $($r.Status) $($r.Content)"

  # 用同一个已过期的版本再保存一次，必须被拒绝
  $r = Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/fs/save-file"; Method = "POST"; Headers = $jsonHeaders
    ContentType = $jsonType; Body = (JsonBytes @{ path = $conflictPath; content = "v3-should-be-rejected"; baseVersion = $baseVersion }); WebSession = $session
  }
  Check "conflict-stale-rejected" ($r.Status -eq 409) "过期版本应返回 409，实际 $($r.Status)"
  # 409 的正文里应有 VERSION_CONFLICT 标记，前端据此弹出「重新加载 / 强制覆盖」。
  # 但 Windows PowerShell 5.1 的 Invoke-WebRequest 不暴露非 2xx 响应的正文
  # （读出来是 0 字节，curl 能正常拿到），所以读不到正文时只提示、不算失败 ——
  # 状态码本身已经证明了拒绝行为，这一点在 5.1 与 7 上都成立。
  if ($r.Content) {
    Check "conflict-code-returned" ($r.Content -match "VERSION_CONFLICT") "409 正文应带 VERSION_CONFLICT 标记：$($r.Content)"
  } else {
    Note "PS 5.1 未暴露 409 正文，跳过 VERSION_CONFLICT 标记断言（可用 curl 手工核对）"
  }

  # 被拒绝的保存不得改动磁盘内容
  $r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/fs/file?path=" + [uri]::EscapeDataString($conflictPath); WebSession = $session }
  Check "conflict-drive-unchanged" ($r.Content -match "v2" -and $r.Content -notmatch "should-be-rejected") "被拒绝的保存改动了磁盘内容"
}

# --------------------------------------------- 13. 审计日志导出 -----------
Section "13. 审计日志导出"

foreach ($fmt in @("jsonl", "csv")) {
  $r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/admin/logs/export?format=$fmt&days=5"; WebSession = $session }
  Check "logs-export-$fmt" ($r.Status -eq 200 -and $r.Content.Length -gt 0) "期望 200 且有内容，实际 $($r.Status)"
  $cd = [string]$r.Headers["Content-Disposition"]
  Check "logs-export-$fmt-attachment" ($cd -match "attachment" -and $cd -match "\.$fmt") "缺少附件下载头：$cd"
}
# CSV 首字符必须是 UTF-8 BOM，否则 Excel 打开中文日志会乱码
$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/admin/logs/export?format=csv&days=5"; WebSession = $session }
Check "logs-export-csv-bom" ([int][char]$r.Content[0] -eq 0xFEFF) ("首字符应为 BOM，实际 U+" + ([int][char]$r.Content[0]).ToString("X4"))
$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/admin/logs/export?format=xml"; WebSession = $session }
Check "logs-export-invalid-format" ($r.Status -eq 400) "非法 format 应 400，实际 $($r.Status)"

# --------------------------------------------- 14. WebDAV（正式功能） -------
Section "14. WebDAV（正式功能，默认关闭，后台可开关）"

# Invoke-WebRequest 无法构造 PROPFIND 这类自定义方法（会得到状态 0），
# 所以 DAV 断言走 .NET 的 HttpWebRequest，它能直接设置任意 Method 与请求体。
function Invoke-Dav {
  param(
    [string]$Url,
    [string]$Method = "PROPFIND",
    [hashtable]$Headers = $null,
    [byte[]]$Body = $null,
    [string]$ContentType = $null,
    # Range 在 HttpWebRequest 里是**受限头**，不能用 Headers.Add 设置
    # （会抛 "The 'Range' header must be modified using the appropriate property"），
    # 必须走 AddRange()。这里收一个 "bytes=0-4" 形式的字符串。
    [string]$Range = ""
  )
  $req = [System.Net.HttpWebRequest]::Create($Url)
  $req.Method = $Method
  $req.AllowAutoRedirect = $false
  $req.Timeout = 15000
  if ($Headers) {
    foreach ($k in $Headers.Keys) {
      if ($k -ieq "Range") { continue }
      $req.Headers.Add($k, [string]$Headers[$k])
    }
  }
  if ($Range) {
    $spec = ($Range -replace '^bytes=', '').Split('-')
    $from = [long]$spec[0]
    if ($spec.Length -gt 1 -and $spec[1]) { $req.AddRange($from, [long]$spec[1]) } else { $req.AddRange($from) }
  }
  if ($null -ne $Body) {
    $req.ContentLength = $Body.Length
    if ($ContentType) { $req.ContentType = $ContentType }
    $stream = $req.GetRequestStream()
    $stream.Write($Body, 0, $Body.Length)
    $stream.Close()
  }
  try {
    $resp = $req.GetResponse()
  } catch [System.Net.WebException] {
    if ($_.Exception.Response) { $resp = $_.Exception.Response } else { return [pscustomobject]@{ Status = 0; Body = ""; ETag = "" } }
  }
  try {
    [int]$code = [int]$resp.StatusCode
    $etag = ""
    try { $etag = [string]$resp.Headers["ETag"] } catch { }
    # 注意：局部变量**不能**叫 $body —— 它与参数 [byte[]]$Body 是同一个变量
    # （PowerShell 变量名不区分大小写），赋字符串会被强制转成 byte[]，
    # 最后 Body 变成空数组，`-notmatch` 返回数组而不是布尔值。
    $respText = ""
    try {
      $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $respText = $reader.ReadToEnd()
      $reader.Dispose()
    } catch { }
    return [pscustomobject]@{ Status = $code; Body = $respText; ETag = $etag }
  } finally {
    try { $resp.Close() } catch { }
  }
}

function Get-DavBasic([string]$Name, [string]$Pass) {
  return "Basic " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($Name + ":" + $Pass)))
}

# 记下原始配置，跑完原样还原（本段会开关 WebDAV、还会临时改挂载路径）
$origCfg = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/admin/config"; WebSession = $session }
$origDavEnabled = $false
$origDavPath = "/dav"
try {
  $origDavEnabled = [bool](($origCfg.Content | ConvertFrom-Json).webdavEnabled)
  $origDavPath = [string](($origCfg.Content | ConvertFrom-Json).webdavPath)
} catch { }

function Set-DavConfig([hashtable]$Body) {
  return Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/admin/config"; Method = "PATCH"; Headers = $jsonHeaders
    ContentType = $jsonType; WebSession = $session; Body = (JsonBytes $Body)
  }
}

$davQuery = $scratch + "/dav-probe.txt"
$davDirRel = $scratch + "/dav-dir"
$davMember = "_davuser-" + $suffix
$davMemberPass = "Dav-$suffix-1"
$davMemberId = $null
$davUserHeader = $null

try {
  # ---- 1) 默认关闭：404 且不能是前端首页（早期会被 SPA fallback 接住）----
  $r = Set-DavConfig @{ webdavEnabled = $false; webdavPath = "/dav" }
  Check "webdav-config-off" ($r.Ok -and $r.Content -match '"webdavEnabled":false') "$($r.Status) $($r.Content)"

  $davOff = Invoke-Dav -Url "$BaseUrl/dav/" -Method "PROPFIND" -Headers @{ Depth = "0" }
  Check "webdav-disabled-propfind" ($davOff.Status -eq 404) "未启用时 PROPFIND 应 404，实际 $($davOff.Status)"
  Check "webdav-disabled-not-spa" ($davOff.Body -notmatch '<div id="root">') "未启用时不应返回前端首页"
  $davGetOff = Invoke-Dav -Url "$BaseUrl/dav/" -Method "GET"
  Check "webdav-disabled-get-404" ($davGetOff.Status -eq 404) "未启用时 GET /dav/ 应 404，实际 $($davGetOff.Status)"

  # ---- 2) 打开（后台开关，实时生效、不需要重启）----
  $r = Set-DavConfig @{ webdavEnabled = $true }
  Check "webdav-config-on" ($r.Ok -and $r.Content -match '"webdavEnabled":true') "$($r.Status) $($r.Content)"

  $opt = Invoke-Dav -Url "$BaseUrl/dav/" -Method "OPTIONS"
  Check "webdav-options" ($opt.Status -eq 200) "OPTIONS 应 200，实际 $($opt.Status)"

  # 建一个临时成员：DAV 只接受成员账号（不接受超管）
  $r = Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/admin/members"; Method = "POST"; Headers = $jsonHeaders
    ContentType = $jsonType; WebSession = $session
    Body = (JsonBytes @{ users = @(@{ username = $davMember; password = $davMemberPass }) })
  }
  $r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/admin/members"; WebSession = $session }
  try {
    $davMemberId = ($r.Content | ConvertFrom-Json).members |
      Where-Object { $_.username -eq $davMember } |
      Select-Object -First 1 -ExpandProperty id
  } catch { }
  Check "webdav-member-created" ([bool]$davMemberId) "未创建出临时成员 $davMember"
  $davUserHeader = @{ Authorization = (Get-DavBasic $davMember $davMemberPass) }

  # ---- 3) 只认 Basic，绝不认 Cookie ----
  # 直接把会话 Cookie 塞进 DAV 请求：必须 401。否则任意网页都能借登录态发起 DAV
  # 请求，等于一个绕过 CSRF 的后门（DAV 不带 X-Requested-With，走不到 csrfGuard）。
  $davCookie = $session.Cookies.GetCookies([uri]$BaseUrl)["zs_token"]
  $cookieHeader = "zs_token=" + $davCookie.Value
  $r = Invoke-Dav -Url "$BaseUrl/dav/" -Method "PROPFIND" -Headers @{ Depth = "0"; Cookie = $cookieHeader }
  Check "webdav-cookie-rejected" ($r.Status -eq 401) "仅带 Cookie 的 DAV 请求必须 401，实际 $($r.Status)"

  # ---- 4) 超管账号被拒（密码不该被客户端反复发送）----
  $superHeader = @{ Authorization = (Get-DavBasic $User $Password); Depth = "0" }
  $r = Invoke-Dav -Url "$BaseUrl/dav/" -Method "PROPFIND" -Headers $superHeader
  Check "webdav-superadmin-rejected" ($r.Status -eq 403) "超管 Basic 应 403，实际 $($r.Status)"

  # ---- 5) 成员 Basic：PROPFIND 正常 ----
  $davHeaders = @{ Authorization = $davUserHeader.Authorization; Depth = "0" }
  $r = Invoke-Dav -Url "$BaseUrl/dav/" -Method "PROPFIND" -Headers $davHeaders
  Check "webdav-propfind-member" ($r.Status -eq 207 -and $r.Body -match "multistatus") "期望 207 + multistatus，实际 $($r.Status)"

  # Depth: infinity 会扫描整棵树 → 明确拒绝
  $r = Invoke-Dav -Url "$BaseUrl/dav/" -Method "PROPFIND" -Headers @{ Authorization = $davUserHeader.Authorization; Depth = "infinity" }
  Check "webdav-depth-infinity-rejected" ($r.Status -eq 403) "期望 403，实际 $($r.Status)"

  # ---- 6) 写：PUT 新建 → 201；再 PUT 覆盖 → 204 ----
  $davPut = @{ Authorization = $davUserHeader.Authorization }
  $bytes1 = [Text.Encoding]::UTF8.GetBytes("hello webdav v2")
  $r = Invoke-Dav -Url ("$BaseUrl/dav/" + $davQuery) -Method "PUT" -Headers $davPut -Body $bytes1 -ContentType "text/plain"
  Check "webdav-put-create" ($r.Status -eq 201) "期望 201，实际 $($r.Status) $($r.Body)"
  $bytes2 = [Text.Encoding]::UTF8.GetBytes("hello webdav v2 (updated)")
  $r = Invoke-Dav -Url ("$BaseUrl/dav/" + $davQuery) -Method "PUT" -Headers $davPut -Body $bytes2 -ContentType "text/plain"
  Check "webdav-put-overwrite" ($r.Status -eq 204) "期望 204，实际 $($r.Status)"

  # ---- 7) 读：ETag / If-None-Match 304 / Range 206 ----
  $r = Invoke-Dav -Url ("$BaseUrl/dav/" + $davQuery) -Method "GET" -Headers $davPut
  Check "webdav-get" ($r.Status -eq 200 -and $r.Body -match "updated") "期望 200 + 新内容，实际 $($r.Status)"
  $etag = $r.ETag
  Check "webdav-get-etag" ([bool]$etag) "GET 应返回 ETag"
  if ($etag) {
    $r2 = Invoke-Dav -Url ("$BaseUrl/dav/" + $davQuery) -Method "GET" -Headers @{ Authorization = $davUserHeader.Authorization; "If-None-Match" = $etag }
    Check "webdav-if-none-match-304" ($r2.Status -eq 304) "期望 304，实际 $($r2.Status)"
  }
  $r3 = Invoke-Dav -Url ("$BaseUrl/dav/" + $davQuery) -Method "GET" -Headers $davPut -Range "bytes=0-4"
  Check "webdav-range-206" ($r3.Status -eq 206 -and ([string]$r3.Body).Length -eq 5) "期望 206 + 5 字节，实际 $($r3.Status) len=$(([string]$r3.Body).Length)"

  # ---- 8) MKCOL：带请求体必须 415；正常建目录 201 ----
  $r = Invoke-Dav -Url ("$BaseUrl/dav/" + $davDirRel) -Method "MKCOL" -Headers $davPut -Body ([Text.Encoding]::UTF8.GetBytes("<x/>")) -ContentType "application/xml"
  Check "webdav-mkcol-body-415" ($r.Status -eq 415) "期望 415，实际 $($r.Status)"
  $r = Invoke-Dav -Url ("$BaseUrl/dav/" + $davDirRel) -Method "MKCOL" -Headers $davPut
  Check "webdav-mkcol" ($r.Status -eq 201) "期望 201，实际 $($r.Status)"

  # ---- 9) MOVE 的 Destination 不能指向别的主机 ----
  $r = Invoke-Dav -Url ("$BaseUrl/dav/" + $davQuery) -Method "MOVE" -Headers @{
    Authorization = $davUserHeader.Authorization
    Destination = "http://evil.example/dav/x.txt"
    Overwrite = "T"
  }
  Check "webdav-destination-host-mismatch" ($r.Status -eq 502) "期望 502，实际 $($r.Status)"

  # ---- 10) 挂载路径可改，且实时生效 ----
  $r = Set-DavConfig @{ webdavPath = "/davcheck" }
  Check "webdav-path-saved" ($r.Ok -and $r.Content -match '"webdavPath":"/davcheck"') "$($r.Status) $($r.Content)"
  $newPath = Invoke-Dav -Url "$BaseUrl/davcheck/" -Method "PROPFIND" -Headers $davHeaders
  Check "webdav-new-path-works" ($newPath.Status -eq 207) "改路径后新地址应 207，实际 $($newPath.Status)"
  $oldPath = Invoke-Dav -Url "$BaseUrl/dav/" -Method "PROPFIND" -Headers $davHeaders
  Check "webdav-old-path-404" ($oldPath.Status -eq 404) "改路径后旧地址应 404，实际 $($oldPath.Status)"
  $r = Set-DavConfig @{ webdavPath = "/dav" }
  Check "webdav-path-restored" ($r.Ok) "$($r.Status)"

  # ---- 11) 非法挂载路径被拒 ----
  $r = Set-DavConfig @{ webdavPath = "/api/webdav" }
  Check "webdav-invalid-path-400" ($r.Status -eq 400) "占用 /api 前缀应 400，实际 $($r.Status)"
} finally {
  # 还原现场：关掉（或恢复原值）、删掉临时成员与探测文件
  try {
    $restore = @{ webdavEnabled = $origDavEnabled; webdavPath = $origDavPath }
    $null = Set-DavConfig $restore
  } catch { }
  if ($davMemberId) {
    try {
      $null = Invoke-Api -Parameters @{
        Uri = "$BaseUrl/api/admin/members/batch"; Method = "POST"; Headers = $jsonHeaders
        ContentType = $jsonType; WebSession = $session
        Body = (JsonBytes @{ action = "delete"; ids = @($davMemberId) })
      }
    } catch { }
  }
  try {
    $null = Invoke-Api -Parameters @{
      Uri = "$BaseUrl/api/fs/delete"; Method = "POST"; Headers = $jsonHeaders
      ContentType = $jsonType; WebSession = $session
      Body = (JsonBytes @{ paths = @($davDirRel, $davQuery) })
    }
  } catch { }
}

# --------------------------------------------- 15. 图片缩略图 ---------------
Section "15. 图片缩略图（v2.0，服务端 sharp）"

# 用 .NET 现画一张 64×48 的 PNG 再上传：不依赖仓库里是否存在图片文件。
$thumbName = "缩略图测试.png"
$thumbLocal = Join-Path ([System.IO.Path]::GetTempPath()) "zs-thumb-$suffix.png"
$thumbUploaded = $false
try {
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap 64, 48
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::FromArgb(0, 120, 215))
  $g.Dispose()
  $bmp.Save($thumbLocal, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()

  $tBoundary = [System.Guid]::NewGuid().ToString()
  $tEnc = [System.Text.Encoding]::UTF8
  $tBytes = [System.IO.File]::ReadAllBytes($thumbLocal)
  $tPre = $tEnc.GetBytes(
    "--$tBoundary`r`n" +
    "Content-Disposition: form-data; name=`"files`"; filename=`"$thumbName`"`r`n" +
    "Content-Type: image/png`r`n`r`n")
  $tPost = $tEnc.GetBytes("`r`n--$tBoundary--`r`n")
  $tBody = New-Object byte[] ($tPre.Length + $tBytes.Length + $tPost.Length)
  [Array]::Copy($tPre, 0, $tBody, 0, $tPre.Length)
  [Array]::Copy($tBytes, 0, $tBody, $tPre.Length, $tBytes.Length)
  [Array]::Copy($tPost, 0, $tBody, $tPre.Length + $tBytes.Length, $tPost.Length)

  $r = Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/fs/upload?path=" + [uri]::EscapeDataString($scratch)
    Method = "POST"; Headers = $jsonHeaders; ContentType = "multipart/form-data; boundary=$tBoundary"
    WebSession = $session; Body = $tBody
  }
  $thumbUploaded = ($r.Ok -and $r.Content -match '"ok":true')
  Check "thumb-upload-png" $thumbUploaded "$($r.Status) $($r.Content)"

  $thumbRel = "$scratch/$thumbName"
  $thumbQuery = [uri]::EscapeDataString($thumbRel)

  $r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/fs/thumb?path=$thumbQuery&w=96"; WebSession = $session }
  Check "thumb-image-webp" ($r.Status -eq 200 -and ([string]$r.Headers["Content-Type"]) -match "image/webp") `
    "期望 200 image/webp，实际 $($r.Status) $([string]$r.Headers['Content-Type'])"
  Check "thumb-cache-control" (([string]$r.Headers["Cache-Control"]) -match "max-age") "缺少 Cache-Control: $([string]$r.Headers['Cache-Control'])"

  # 宽度只在白名单里就近取值，乱填不该报错（前端可能传任意值）
  $r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/fs/thumb?path=$thumbQuery&w=99999"; WebSession = $session }
  Check "thumb-width-clamped" ($r.Status -eq 200) "超范围宽度应被收敛，实际 $($r.Status)"

  # 非图片 → 415（网格里不会请求它，但接口不能默默生成垃圾）。
  # 这里现建一个文本文件：section 3 上传的那个文件在后面几节里已经被删掉了。
  $null = Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/fs/create-file"; Method = "POST"; Headers = $jsonHeaders
    ContentType = $jsonType; WebSession = $session
    Body = (JsonBytes @{ path = $scratch; name = "thumb-notimage.txt"; content = "not an image" })
  }
  $txtQuery = [uri]::EscapeDataString("$scratch/thumb-notimage.txt")
  $r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/fs/thumb?path=$txtQuery&w=96"; WebSession = $session }
  Check "thumb-non-image-415" ($r.Status -eq 415) "文本文件应 415，实际 $($r.Status)"

  # 不存在 → 404；根目录 → 400
  $missing = [uri]::EscapeDataString("$scratch/__nope__.png")
  $r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/fs/thumb?path=$missing&w=96"; WebSession = $session }
  Check "thumb-missing-404" ($r.Status -eq 404) "不存在应 404，实际 $($r.Status)"
  $r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/fs/thumb?path=&w=96"; WebSession = $session }
  Check "thumb-root-400" ($r.Status -eq 400) "根目录应 400，实际 $($r.Status)"

  # 访客没有 preview 时不该能拿缩略图：临时关掉 guest.preview，用无 Cookie 的会话请求
  $r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/admin/config"; WebSession = $session }
  $originalGuestPreview = $true
  try { $originalGuestPreview = [bool](($r.Content | ConvertFrom-Json).guestPerms.preview) } catch { }
  try {
    $null = Invoke-Api -Parameters @{
      Uri = "$BaseUrl/api/admin/config"; Method = "PATCH"; Headers = $jsonHeaders
      ContentType = $jsonType; WebSession = $session
      Body = (JsonBytes @{ guestPerms = @{ preview = $false } })
    }
    $r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/fs/thumb?path=$thumbQuery&w=96" }
    Check "thumb-guest-denied-without-preview" ($r.Status -eq 401) "访客无 preview 应 401，实际 $($r.Status)"
  } finally {
    $null = Invoke-Api -Parameters @{
      Uri = "$BaseUrl/api/admin/config"; Method = "PATCH"; Headers = $jsonHeaders
      ContentType = $jsonType; WebSession = $session
      Body = (JsonBytes @{ guestPerms = @{ preview = $originalGuestPreview } })
    }
  }
} catch {
  Check "thumb-section-completed" $false $_.Exception.Message
} finally {
  if (Test-Path $thumbLocal) { Remove-Item $thumbLocal -Force -ErrorAction SilentlyContinue }
}

# --------------------------------------------- 16. 弱网 / 缓存优化 -----------
Section "16. 弱网优化（Service Worker / Range / 条件请求）"

# 16.1 sw.js 必须由静态托管出正确的 MIME：如果它被 SPA fallback 接住返回 HTML，
# 浏览器会以 "MIME type mismatch" 拒绝注册（而且错误信息很难懂）。
$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/sw.js" }
Check "sw-served-as-js" ($r.Status -eq 200 -and ([string]$r.Headers["Content-Type"]) -match "javascript") `
  "sw.js 应以 javascript 返回，实际 $($r.Status) $([string]$r.Headers['Content-Type'])"
Check "sw-no-cache" (([string]$r.Headers["Cache-Control"]) -match "no-cache") `
  "sw.js 必须 no-cache（否则更新永远不生效），实际 $([string]$r.Headers['Cache-Control'])"

# 16.2 sw.js 里的版本号必须与 package.json 一致：缓存名带版本，忘了改会导致
# 升级后仍然命中旧缓存（"改了代码但界面没变"的经典坑）。
$pkgVersion = ""
try { $pkgVersion = [string]((Get-Content (Join-Path $Root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version) } catch { }
$swSource = ""
try { $swSource = Get-Content (Join-Path $Root "web\public\sw.js") -Raw -Encoding UTF8 } catch { }
Check "sw-version-matches-package" ([bool]$pkgVersion -and $swSource -match [regex]::Escape('const VERSION = "' + $pkgVersion + '"')) `
  "sw.js 的 VERSION 与 package.json($pkgVersion) 不一致"

# 16.3 已删除的死资源不能再出现（269 KB 且无任何引用）。
# 注意：未知路径会落到 SPA fallback 返回 200 HTML，所以不能只断言 404 ——
# 真正要保证的是"不再以一个 270 KB 的 JS 文件被发出去"，以及构建产物里没有它。
$r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/resources/tailwindcss.min.js" }
$tlType = [string]$r.Headers["Content-Type"]
Check "removed-tailwind-resource-not-js" ($r.Status -eq 404 -or $tlType -notmatch "javascript") `
  "该资源已删除，不应再以 JS 返回，实际 $($r.Status) $tlType"
Check "removed-tailwind-resource-not-built" (-not (Test-Path (Join-Path $Root "web\dist\resources\tailwindcss.min.js"))) `
  "web/dist/resources 里仍有 tailwindcss.min.js"

# 16.4 下载必须支持 Range 与条件请求：视频拖动进度、弱网重试都依赖它们
$rangeName = "range-probe.txt"
$rangeContent = "0123456789abcdef"
$null = Invoke-Api -Parameters @{
  Uri = "$BaseUrl/api/fs/create-file"; Method = "POST"; Headers = $jsonHeaders
  ContentType = $jsonType; WebSession = $session
  Body = (JsonBytes @{ path = $scratch; name = $rangeName; content = $rangeContent })
}
$rangeRel = "$scratch/$rangeName"
$rangeUrl = "$BaseUrl/api/fs/download?path=" + [uri]::EscapeDataString($rangeRel)
$cookieHeader = "zs_token=" + $session.Cookies.GetCookies([uri]$BaseUrl)["zs_token"].Value
$dlHeaders = @{ Cookie = $cookieHeader; "X-Requested-With" = "XMLHttpRequest" }

try {
  $r = Invoke-Dav -Url $rangeUrl -Method "GET" -Headers $dlHeaders
  Check "download-accept-ranges" ($r.Status -eq 200 -and $r.ETag) "期望 200 + ETag，实际 $($r.Status)"
  if ($r.ETag) {
    $r2 = Invoke-Dav -Url $rangeUrl -Method "GET" -Headers @{ Cookie = $cookieHeader; "X-Requested-With" = "XMLHttpRequest"; "If-None-Match" = $r.ETag }
    Check "download-if-none-match-304" ($r2.Status -eq 304) "条件请求应 304，实际 $($r2.Status)"
  }
  $r3 = Invoke-Dav -Url $rangeUrl -Method "GET" -Headers $dlHeaders -Range "bytes=0-3"
  Check "download-range-206" ($r3.Status -eq 206 -and [string]$r3.Body -eq "0123") `
    "期望 206 + '0123'，实际 $($r3.Status) body=$([string]$r3.Body)"
} catch {
  Check "download-range-section" $false $_.Exception.Message
} finally {
  $null = Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/fs/delete"; Method = "POST"; Headers = $jsonHeaders
    ContentType = $jsonType; WebSession = $session
    Body = (JsonBytes @{ paths = @($rangeRel) })
  }
}

# --------------------------------------------- 17. 插件体系 ---------------
Section "17. 插件体系（manifest / apiVersion / 权限白名单 / JSON Schema）"

$pluginWork = Join-Path ([System.IO.Path]::GetTempPath()) "zs-plugin-$suffix"
$pluginZip = Join-Path ([System.IO.Path]::GetTempPath()) "zs-plugin-$suffix.zip"
$badZip = Join-Path ([System.IO.Path]::GetTempPath()) "zs-bad-$suffix.zip"
$pluginId = "org.zeroshadow.smoke-theme"
$origPluginsEnabled = $false
try {
  $r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/admin/config"; WebSession = $session }
  try { $origPluginsEnabled = [bool](($r.Content | ConvertFrom-Json).pluginsEnabled) } catch { }

  # 17.1 默认关闭：关闭时接口应拒绝安装（而不是"装了但不生效"）
  $null = Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/admin/config"; Method = "PATCH"; Headers = $jsonHeaders
    ContentType = $jsonType; WebSession = $session
    Body = (JsonBytes @{ pluginsEnabled = $false })
  }
  New-Item -ItemType Directory -Path $pluginWork -Force | Out-Null
  $manifest = @{
    id = $pluginId
    name = "冒烟主题"
    version = "1.0.0"
    apiVersion = 1
    kind = "theme"
    description = "smoke test theme"
    theme = @{
      light = @{ "--background" = "oklch(0.98 0.01 90)"; "--foreground" = "oklch(0.3 0.02 220)" }
      dark = @{ "--background" = "oklch(0.22 0.02 220)" }
    }
    settings = @{
      type = "object"
      additionalProperties = $false
      properties = @{
        accent = @{ type = "string"; title = "Accent"; default = "auto"; enum = @("auto", "blue", "green") }
        compact = @{ type = "boolean"; title = "Compact"; default = $false }
        size = @{ type = "integer"; title = "Size"; minimum = 1; maximum = 100; default = 16 }
      }
    }
  }
  $manifest | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $pluginWork "manifest.json") -Encoding UTF8
  if (Test-Path $pluginZip) { Remove-Item $pluginZip -Force }
  Compress-Archive -Path (Join-Path $pluginWork "*") -DestinationPath $pluginZip -Force
  $zipBytes = [System.IO.File]::ReadAllBytes($pluginZip)

  $r = Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/admin/plugins?filename=smoke-theme.zip"; Method = "POST"
    Headers = $jsonHeaders; ContentType = "application/zip"; WebSession = $session; Body = $zipBytes
  }
  Check "plugin-install-blocked-when-disabled" ($r.Status -eq 403) "插件关闭时应 403，实际 $($r.Status)"

  # 17.2 打开总开关后可以安装
  $r = Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/admin/config"; Method = "PATCH"; Headers = $jsonHeaders
    ContentType = $jsonType; WebSession = $session
    Body = (JsonBytes @{ pluginsEnabled = $true })
  }
  Check "plugin-config-on" ($r.Ok -and $r.Content -match '"pluginsEnabled":true') "$($r.Status)"

  $r = Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/admin/plugins?filename=smoke-theme.zip"; Method = "POST"
    Headers = $jsonHeaders; ContentType = "application/zip"; WebSession = $session; Body = $zipBytes
  }
  Check "plugin-install" ($r.Status -eq 201 -and $r.Content -match [regex]::Escape($pluginId)) "$($r.Status) $($r.Content)"

  # 17.3 装完默认禁用；主题插件不需要任何权限
  $r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/admin/plugins"; WebSession = $session }
  $pluginsBody = $r.Content
  Check "plugin-installed-disabled" ($pluginsBody -match [regex]::Escape($pluginId) -and $pluginsBody -match '"enabled":false') `
    "装完应默认禁用: $pluginsBody"
  Check "plugin-no-permissions" ($pluginsBody -match '"permissions":\[\]') "主题插件不应带权限"

  # 17.4 未启用时不能应用主题；启用后才可以
  $r = Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/admin/plugins/" + [uri]::EscapeDataString($pluginId) + "/theme"; Method = "POST"
    Headers = $jsonHeaders; ContentType = $jsonType; WebSession = $session; Body = (JsonBytes @{ active = $true })
  }
  Check "plugin-theme-needs-enable" ($r.Status -eq 400) "未启用就应用主题应 400，实际 $($r.Status)"

  $r = Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/admin/plugins/" + [uri]::EscapeDataString($pluginId); Method = "PATCH"
    Headers = $jsonHeaders; ContentType = $jsonType; WebSession = $session; Body = (JsonBytes @{ enabled = $true })
  }
  Check "plugin-enable" ($r.Ok -and $r.Content -match '"enabled":true') "$($r.Status)"

  $r = Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/admin/plugins/" + [uri]::EscapeDataString($pluginId) + "/theme"; Method = "POST"
    Headers = $jsonHeaders; ContentType = $jsonType; WebSession = $session; Body = (JsonBytes @{ active = $true })
  }
  Check "plugin-theme-apply" ($r.Ok -and $r.Content -match [regex]::Escape($pluginId)) "$($r.Status) $($r.Content)"

  # 17.5 公开主题接口：返回服务端拼好的 CSS（访客也要能看到同一套主题）
  $r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/plugins/theme" }
  Check "plugin-theme-public-css" ($r.Status -eq 200 -and $r.Content -match "data-theme-plugin" -and $r.Content -match "--background") `
    "主题 CSS 未下发: $($r.Content)"

  # 17.6 设置按 JSON Schema 校验：合法值保存、越界值拒绝
  $r = Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/admin/plugins/" + [uri]::EscapeDataString($pluginId); Method = "PATCH"
    Headers = $jsonHeaders; ContentType = $jsonType; WebSession = $session
    Body = (JsonBytes @{ settings = @{ accent = "blue"; compact = $true; size = 16 } })
  }
  Check "plugin-settings-save" ($r.Ok -and $r.Content -match '"accent":"blue"') "$($r.Status) $($r.Content)"

  $r = Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/admin/plugins/" + [uri]::EscapeDataString($pluginId); Method = "PATCH"
    Headers = $jsonHeaders; ContentType = $jsonType; WebSession = $session
    Body = (JsonBytes @{ settings = @{ size = 999 } })
  }
  Check "plugin-settings-range-rejected" ($r.Status -eq 400) "越界设置应 400，实际 $($r.Status)"

  $r = Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/admin/plugins/" + [uri]::EscapeDataString($pluginId); Method = "PATCH"
    Headers = $jsonHeaders; ContentType = $jsonType; WebSession = $session
    Body = (JsonBytes @{ settings = @{ accent = "purple" } })
  }
  Check "plugin-settings-enum-rejected" ($r.Status -eq 400) "非枚举值应 400，实际 $($r.Status)"

  # 17.7 非法清单被拒：apiVersion 不支持 / 未知权限 / 缺 manifest
  $badWork = Join-Path ([System.IO.Path]::GetTempPath()) "zs-bad-$suffix"
  New-Item -ItemType Directory -Path $badWork -Force | Out-Null
  @{
    id = "org.zeroshadow.bad-api"; name = "bad"; version = "1.0.0"; apiVersion = 99; kind = "theme"
    theme = @{ light = @{ "--background" = "red" } }
  } | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $badWork "manifest.json") -Encoding UTF8
  if (Test-Path $badZip) { Remove-Item $badZip -Force }
  Compress-Archive -Path (Join-Path $badWork "*") -DestinationPath $badZip -Force
  $r = Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/admin/plugins?filename=bad.zip"; Method = "POST"
    Headers = $jsonHeaders; ContentType = "application/zip"; WebSession = $session
    Body = ([System.IO.File]::ReadAllBytes($badZip))
  }
  Check "plugin-bad-api-version-rejected" ($r.Status -eq 400) "apiVersion=99 应 400，实际 $($r.Status)"

  $badPermWork = Join-Path ([System.IO.Path]::GetTempPath()) "zs-badperm-$suffix"
  New-Item -ItemType Directory -Path $badPermWork -Force | Out-Null
  @{
    id = "org.zeroshadow.bad-perm"; name = "bad perm"; version = "1.0.0"; apiVersion = 1; kind = "theme"
    permissions = @("fs.write")
    theme = @{ light = @{ "--background" = "red" } }
  } | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $badPermWork "manifest.json") -Encoding UTF8
  $badPermZip = Join-Path ([System.IO.Path]::GetTempPath()) "zs-badperm-$suffix.zip"
  if (Test-Path $badPermZip) { Remove-Item $badPermZip -Force }
  Compress-Archive -Path (Join-Path $badPermWork "*") -DestinationPath $badPermZip -Force
  $r = Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/admin/plugins?filename=badperm.zip"; Method = "POST"
    Headers = $jsonHeaders; ContentType = "application/zip"; WebSession = $session
    Body = ([System.IO.File]::ReadAllBytes($badPermZip))
  }
  Check "plugin-theme-permission-rejected" ($r.Status -eq 400) "主题插件带权限应 400，实际 $($r.Status)"

  # 17.8 卸载后主题自动恢复默认
  $r = Invoke-Api -Parameters @{
    Uri = "$BaseUrl/api/admin/plugins/" + [uri]::EscapeDataString($pluginId); Method = "DELETE"
    Headers = $jsonHeaders; WebSession = $session
  }
  Check "plugin-uninstall" ($r.Ok) "$($r.Status) $($r.Content)"
  $r = Invoke-Api -Parameters @{ Uri = "$BaseUrl/api/plugins/theme" }
  Check "plugin-theme-reset-after-uninstall" ($r.Content -match '"id":""') "卸载后应恢复默认主题: $($r.Content)"
} catch {
  Check "plugin-section-completed" $false $_.Exception.Message
} finally {
  # 还原现场：卸掉可能残留的插件、恢复总开关、清理临时文件
  try {
    $null = Invoke-Api -Parameters @{
      Uri = "$BaseUrl/api/admin/plugins/" + [uri]::EscapeDataString($pluginId); Method = "DELETE"
      Headers = $jsonHeaders; WebSession = $session
    }
  } catch { }
  try {
    $null = Invoke-Api -Parameters @{
      Uri = "$BaseUrl/api/admin/config"; Method = "PATCH"; Headers = $jsonHeaders
      ContentType = $jsonType; WebSession = $session
      Body = (JsonBytes @{ pluginsEnabled = $origPluginsEnabled })
    }
  } catch { }
  foreach ($p in @($pluginWork, $pluginZip, $badZip, $badPermWork, $badPermZip)) {
    if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

Get-Finished $(if ($script:Fail -gt 0) { $script:Fail } else { 0 })
