$ErrorActionPreference = "Continue"
$base = "http://localhost:5170"
$pass = (Get-Content .env | Where-Object { $_ -match "^SUPER_ADMIN_PASSWORD=" }) -replace "^SUPER_ADMIN_PASSWORD=", ""
$results = @()
function Check($name, $cond) { $script:results += "{0} {1}" -f ($(if ($cond) {"PASS"} else {"FAIL"}), $name) }

# 1. CSRF: POST without X-Requested-With -> 403
try { Invoke-WebRequest -UseBasicParsing -Method POST "$base/api/auth/login" -ContentType "application/json" -Body '{"username":"admin","password":"x"}' | Out-Null; Check "csrf-blocked" $false }
catch { Check "csrf-blocked" ($_.Exception.Response.StatusCode.value__ -eq 403) }

$h = @{ "X-Requested-With" = "XMLHttpRequest" }

# 2. wrong password -> 401
try { Invoke-WebRequest -UseBasicParsing -Method POST "$base/api/auth/login" -Headers $h -ContentType "application/json" -Body '{"username":"admin","password":"wrong"}' | Out-Null; Check "bad-login-401" $false }
catch { Check "bad-login-401" ($_.Exception.Response.StatusCode.value__ -eq 401) }

# 3. superadmin login
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$r = Invoke-WebRequest -UseBasicParsing -Method POST "$base/api/auth/login" -Headers $h -ContentType "application/json" -Body (@{username="admin";password=$pass} | ConvertTo-Json) -WebSession $s
Check "super-login" ($r.StatusCode -eq 200 -and $r.Content -match "superadmin")

# 4. mkdir
$r = Invoke-WebRequest -UseBasicParsing -Method POST "$base/api/fs/mkdir" -Headers $h -ContentType "application/json" -Body '{"path":"","name":"公开资料"}' -WebSession $s
Check "mkdir" ($r.StatusCode -eq 200)
Invoke-WebRequest -UseBasicParsing -Method POST "$base/api/fs/mkdir" -Headers $h -ContentType "application/json" -Body '{"path":"","name":"内部资料"}' -WebSession $s | Out-Null

# 5. path traversal blocked
try { Invoke-WebRequest -UseBasicParsing "$base/api/fs/list?path=..%2F.." -WebSession $s | Out-Null; Check "traversal-blocked" $false }
catch { Check "traversal-blocked" ($_.Exception.Response.StatusCode.value__ -eq 400) }

# 6. upload via multipart
$tmp = "test-upload.txt"
"hello epan 中文测试" | Out-File $tmp -Encoding utf8
$boundary = [System.Guid]::NewGuid().ToString()
$fileBytes = [System.IO.File]::ReadAllBytes((Resolve-Path $tmp))
$enc = [System.Text.Encoding]::UTF8
$pre = $enc.GetBytes("--$boundary`r`nContent-Disposition: form-data; name=`"files`"; filename=`"测试文档.txt`"`r`nContent-Type: text/plain`r`n`r`n")
$post = $enc.GetBytes("`r`n--$boundary--`r`n")
$body = New-Object byte[] ($pre.Length + $fileBytes.Length + $post.Length)
[Array]::Copy($pre, 0, $body, 0, $pre.Length)
[Array]::Copy($fileBytes, 0, $body, $pre.Length, $fileBytes.Length)
[Array]::Copy($post, 0, $body, $pre.Length + $fileBytes.Length, $post.Length)
$r = Invoke-WebRequest -UseBasicParsing -Method POST "$base/api/fs/upload?path=%E5%85%AC%E5%BC%80%E8%B5%84%E6%96%99" -Headers $h -ContentType "multipart/form-data; boundary=$boundary" -Body $body -WebSession $s
Check "upload" ($r.Content -match '"ok":true')
Remove-Item $tmp

# 7. hide folder from guests
$r = Invoke-WebRequest -UseBasicParsing -Method POST "$base/api/fs/guest-visibility" -Headers $h -ContentType "application/json" -Body '{"path":"内部资料","hidden":true}' -WebSession $s
Check "hide-folder" ($r.StatusCode -eq 200)

# 8. admin sees hidden, guest does not
$r = Invoke-WebRequest -UseBasicParsing "$base/api/fs/list?path=" -WebSession $s
Check "admin-sees-hidden" ($r.Content -match "内部资料")
$r2 = Invoke-WebRequest -UseBasicParsing "$base/api/fs/list?path="
Check "guest-hidden-filtered" (-not ($r2.Content -match "内部资料"))

# 9. guest cannot access hidden dir or admin APIs
try { Invoke-WebRequest -UseBasicParsing "$base/api/fs/list?path=%E5%86%85%E9%83%A8%E8%B5%84%E6%96%99" | Out-Null; Check "guest-hidden-404" $false }
catch { Check "guest-hidden-404" ($_.Exception.Response.StatusCode.value__ -eq 404) }
try { Invoke-WebRequest -UseBasicParsing "$base/api/admin/status" | Out-Null; Check "guest-admin-401" $false }
catch { Check "guest-admin-401" ($_.Exception.Response.StatusCode.value__ -eq 401) }
try { Invoke-WebRequest -UseBasicParsing -Method POST "$base/api/fs/mkdir" -Headers $h -ContentType "application/json" -Body '{"path":"","name":"x"}' | Out-Null; Check "guest-mkdir-401" $false }
catch { Check "guest-mkdir-401" ($_.Exception.Response.StatusCode.value__ -eq 401) }

# 10. guest download works
$r = Invoke-WebRequest -UseBasicParsing "$base/api/fs/download?path=%E5%85%AC%E5%BC%80%E8%B5%84%E6%96%99%2F%E6%B5%8B%E8%AF%95%E6%96%87%E6%A1%A3.txt"
Check "guest-download" ($r.StatusCode -eq 200)

# 11. create member, login as member, disabled member check
$r = Invoke-WebRequest -UseBasicParsing -Method POST "$base/api/admin/members" -Headers $h -ContentType "application/json" -Body '{"users":[{"username":"alice","password":"test123456"}]}' -WebSession $s
Check "member-create" ($r.Content -match '"ok":true')
$s2 = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$r = Invoke-WebRequest -UseBasicParsing -Method POST "$base/api/auth/login" -Headers $h -ContentType "application/json" -Body '{"username":"alice","password":"test123456"}' -WebSession $s2
Check "member-login" ($r.Content -match '"member"')
$r = Invoke-WebRequest -UseBasicParsing "$base/api/auth/me" -WebSession $s2
Check "member-me" ($r.Content -match '"uploadLimitMB":512')
try { Invoke-WebRequest -UseBasicParsing "$base/api/admin/config" -WebSession $s2 | Out-Null; Check "member-admin-403" $false }
catch { Check "member-admin-403" ($_.Exception.Response.StatusCode.value__ -eq 403) }

# 12. member rename + copy + move + delete + details
$r = Invoke-WebRequest -UseBasicParsing -Method POST "$base/api/fs/copy" -Headers $h -ContentType "application/json" -Body '{"sources":["公开资料/测试文档.txt"],"dest":""}' -WebSession $s2
Check "member-copy" ($r.StatusCode -eq 200)
$r = Invoke-WebRequest -UseBasicParsing -Method POST "$base/api/fs/rename" -Headers $h -ContentType "application/json" -Body '{"path":"测试文档.txt","newName":"改名了.txt"}' -WebSession $s2
Check "member-rename" ($r.StatusCode -eq 200)
$r = Invoke-WebRequest -UseBasicParsing -Method POST "$base/api/fs/move" -Headers $h -ContentType "application/json" -Body '{"sources":["改名了.txt"],"dest":"公开资料"}' -WebSession $s2
Check "member-move" ($r.StatusCode -eq 200)
$r = Invoke-WebRequest -UseBasicParsing "$base/api/fs/stat?path=%E5%85%AC%E5%BC%80%E8%B5%84%E6%96%99" -WebSession $s2
Check "member-stat" ($r.Content -match '"files":2')
$r = Invoke-WebRequest -UseBasicParsing -Method POST "$base/api/fs/delete" -Headers $h -ContentType "application/json" -Body '{"paths":["公开资料/改名了.txt"]}' -WebSession $s2
Check "member-delete" ($r.StatusCode -eq 200)

# 13. disable member -> access revoked
$id = ((Invoke-WebRequest -UseBasicParsing "$base/api/admin/members" -WebSession $s).Content | ConvertFrom-Json).members[0].id
Invoke-WebRequest -UseBasicParsing -Method POST "$base/api/admin/members/batch" -Headers $h -ContentType "application/json" -Body (@{action="disable";ids=@($id)} | ConvertTo-Json) -WebSession $s | Out-Null
$r = Invoke-WebRequest -UseBasicParsing "$base/api/auth/me" -WebSession $s2
Check "disabled-member-guest" ($r.Content -match '"guest"')

# 14. zip download + search + logs + status + tunnel status
$r = Invoke-WebRequest -UseBasicParsing "$base/api/fs/zip?path=%E5%85%AC%E5%BC%80%E8%B5%84%E6%96%99" -WebSession $s
Check "zip" ($r.StatusCode -eq 200 -and $r.Headers["Content-Type"] -eq "application/zip")
$r = Invoke-WebRequest -UseBasicParsing "$base/api/fs/search?q=%E6%B5%8B%E8%AF%95&path=" -WebSession $s
Check "search" ($r.Content -match "测试文档")
$r = Invoke-WebRequest -UseBasicParsing "$base/api/admin/logs?limit=50" -WebSession $s
Check "logs" ($r.Content -match "login_success")
$r = Invoke-WebRequest -UseBasicParsing "$base/api/admin/status" -WebSession $s
Check "status" ($r.Content -match '"node"')
$r = Invoke-WebRequest -UseBasicParsing "$base/api/admin/tunnel" -WebSession $s
Check "tunnel-status" ($r.Content -match '"enabled":false')

# 15. SPA served
$r = Invoke-WebRequest -UseBasicParsing "$base/"
Check "spa-index" ($r.Content -match "EPan")
$r = Invoke-WebRequest -UseBasicParsing "$base/resources/lucide.min.js" -Method Head
Check "resources" ($r.StatusCode -eq 200)

$results | ForEach-Object { Write-Output $_ }
