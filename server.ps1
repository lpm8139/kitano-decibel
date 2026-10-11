# server.ps1 — ロケット かんせいしつ の保存サーバー（PowerShell 版）
#
# Python が入っていない Windows PC 用の予備サーバー。Windows 標準の PowerShell 5.1 だけで動く。
# server.py と同じ API・同じ保存形式（どちらで起動しても同じ data/ フォルダを使える）。
#
#   GET  /api/health / GET・POST /api/records/<YYYY-MM-DD> / GET・POST /api/settings / GET /api/sounds
#   GET・POST /api/lobby（スマホ受付）
#
# スマホ受付: http://+:<port>/ で待ち受けられたときだけ LAN に公開する（Windows では管理者権限か URL 予約が必要。
# だめなら localhost だけで動き、スマホ受付は使えない）。PC 以外からは /phone.html と合言葉付きの /api/lobby だけ許可。
#
# 保存の仕組み（server.py と同じ）
#   data/<日付>.json              … その日の全記録（tmp に書いてから置き換え＝途中で落ちても壊れない）
#   data/history/<日付>_<時刻>.json … 上書き前の世代コピー（直近20件）
#   data/<日付>.log.jsonl         … 初めて届いた記録を1行ずつ追記するだけのログ
#
# 起動: start.bat から自動で呼ばれる（直接なら powershell -ExecutionPolicy Bypass -File server.ps1）
# テスト用: -Port 8123 -DataDir <path> -NoBrowser

param(
  [int]$Port = 0,
  [string]$DataDir = '',
  [switch]$NoBrowser,
  [switch]$LocalOnly
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$HistoryKeep = 20
$MaxBody = 20MB
$DateRe = '^\d{4}-\d{2}-\d{2}$'
$script:LoggedIds = @{}

# ---------------------------------------------------------------------------
# JSON（Windows PowerShell 5.1 は JavaScriptSerializer、PowerShell 7 は ConvertFrom-Json -AsHashtable）
# ConvertTo-Json(5.1) は入れ子の配列（記録の時系列）を壊すことがあるため使わない。
# ---------------------------------------------------------------------------

$script:Ser = $null
try {
  Add-Type -AssemblyName System.Web.Extensions
  $script:Ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
  $script:Ser.MaxJsonLength = [int]::MaxValue
  $script:Ser.RecursionLimit = 1000
} catch {
  $script:Ser = $null
}

function ConvertFrom-JsonText([string]$text) {
  if ($script:Ser) { return , $script:Ser.DeserializeObject($text) }
  return , (ConvertFrom-Json -InputObject $text -AsHashtable -Depth 100 -NoEnumerate)
}

function ConvertTo-JsonText($obj) {
  if ($script:Ser) { return $script:Ser.Serialize($obj) }
  return (ConvertTo-Json -InputObject $obj -Depth 100 -Compress)
}

function Test-Dict($x) { return ($x -is [System.Collections.IDictionary]) }
function Test-List($x) { return ($null -ne $x) -and ($x -is [System.Collections.IList]) -and -not (Test-Dict $x) }

function Get-Field($r, [string]$k) {
  if ((Test-Dict $r) -and (@($r.Keys) -contains $k)) { return , $r[$k] }
  return $null
}

function Test-Number($v) {
  return ($v -is [int]) -or ($v -is [long]) -or ($v -is [double]) -or ($v -is [decimal]) -or ($v -is [single])
}

function Get-Stamp($r) {
  foreach ($k in @('updatedAt', 'ts')) {
    $v = Get-Field $r $k
    if (Test-Number $v) { return [double]$v }
  }
  return [double]0
}

function Test-Deleted($r) { return ((Get-Field $r 'deleted') -eq $true) }

function Test-Record($r) { return (Test-Dict $r) -and ((Get-Field $r 'id') -is [string]) }

# ID ごとに新しい方（updatedAt が大きい方）を残す。同時刻なら破棄済みを優先。ts 昇順。（js/sync.js・server.py と同じ規則）
function Merge-Records($a, $b) {
  $byId = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  $all = New-Object System.Collections.ArrayList
  if (Test-List $a) { foreach ($x in $a) { [void]$all.Add($x) } }
  if (Test-List $b) { foreach ($x in $b) { [void]$all.Add($x) } }
  foreach ($r in $all) {
    if (-not (Test-Record $r)) { continue }
    $id = [string](Get-Field $r 'id')
    if (-not $byId.ContainsKey($id)) { $byId[$id] = $r; continue }
    $cur = $byId[$id]
    $sr = Get-Stamp $r
    $sc = Get-Stamp $cur
    if (($sr -gt $sc) -or (($sr -eq $sc) -and (Test-Deleted $r) -and -not (Test-Deleted $cur))) { $byId[$id] = $r }
  }
  # 並べ替えは .NET の List.Sort で行う。Sort-Object（パイプライン）を通すと要素が PSObject で包まれ、
  # Windows PowerShell 5.1 の JavaScriptSerializer が循環参照エラーで保存できなくなるため（Windows 実機で確認）。
  $list = New-Object 'System.Collections.Generic.List[object]'
  foreach ($v in $byId.Values) { $list.Add($v.PSObject.BaseObject) }
  $cmp = [System.Comparison[object]] {
    param($x, $y)
    $tx = Get-Stamp-Ts $x
    $ty = Get-Stamp-Ts $y
    if ($tx -lt $ty) { return -1 }
    if ($tx -gt $ty) { return 1 }
    return [string]::CompareOrdinal([string](Get-Field $x 'id'), [string](Get-Field $y 'id'))
  }
  $list.Sort($cmp)
  return , $list.ToArray()
}

function Get-Stamp-Ts($r) {
  $t = Get-Field $r 'ts'
  if (Test-Number $t) { return [double]$t }
  return [double]0
}

# ---------------------------------------------------------------------------
# ファイル
# ---------------------------------------------------------------------------

function Write-Atomic([string]$path, [string]$text) {
  $tmp = "$path.tmp"
  $bytes = $Utf8.GetBytes($text)
  $fs = [System.IO.File]::Open($tmp, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try {
    $fs.Write($bytes, 0, $bytes.Length)
    $fs.Flush($true)
  } finally {
    $fs.Dispose()
  }
  if ([System.IO.File]::Exists($path)) {
    [System.IO.File]::Replace($tmp, $path, [NullString]::Value)
  } else {
    [System.IO.File]::Move($tmp, $path)
  }
}

function Read-JsonFile([string]$path, $default) {
  if (-not [System.IO.File]::Exists($path)) { return , $default }
  try {
    return , (ConvertFrom-JsonText ([System.IO.File]::ReadAllText($path, $Utf8)))
  } catch {
    try { Copy-Item -LiteralPath $path -Destination ($path + '.broken-' + (Get-Date -Format 'yyyyMMddHHmmss')) } catch { }
    return , $default
  }
}

function Backup-History([string]$date, [string]$path) {
  if (-not [System.IO.File]::Exists($path)) { return }
  $hist = Join-Path $script:DataDirFull 'history'
  [void][System.IO.Directory]::CreateDirectory($hist)
  $stamp = (Get-Date).ToString('HHmmss_ffffff')
  Copy-Item -LiteralPath $path -Destination (Join-Path $hist "${date}_$stamp.json")
  $mine = @(Get-ChildItem -LiteralPath $hist -File | Where-Object { $_.Name -like "${date}_*.json" } | Sort-Object Name)
  if ($mine.Count -gt $HistoryKeep) {
    $mine[0..($mine.Count - $HistoryKeep - 1)] | ForEach-Object { try { [System.IO.File]::Delete($_.FullName) } catch { } }
  }
}

function Add-Log([string]$date, $records) {
  $path = Join-Path $script:DataDirFull "$date.log.jsonl"
  if (-not $script:LoggedIds.ContainsKey($date)) {
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'
    if ([System.IO.File]::Exists($path)) {
      foreach ($line in [System.IO.File]::ReadAllLines($path, $Utf8)) {
        if (-not $line.Trim()) { continue }
        try {
          $id = Get-Field (ConvertFrom-JsonText $line) 'id'
          if ($id -is [string]) { [void]$seen.Add($id) }
        } catch { }
      }
    }
    $script:LoggedIds[$date] = $seen
  }
  $seen = $script:LoggedIds[$date]
  $sb = New-Object System.Text.StringBuilder
  foreach ($r in $records) {
    $id = [string](Get-Field $r 'id')
    if ($seen.Contains($id)) { continue }
    [void]$sb.Append((ConvertTo-JsonText $r)).Append("`n")
    [void]$seen.Add($id)
  }
  if ($sb.Length -eq 0) { return }
  $bytes = $Utf8.GetBytes($sb.ToString())
  $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
  try {
    $fs.Write($bytes, 0, $bytes.Length)
    $fs.Flush($true)
  } finally {
    $fs.Dispose()
  }
}

function Save-Records([string]$date, $incoming) {
  $path = Join-Path $script:DataDirFull "$date.json"
  $current = Read-JsonFile $path (New-Object 'object[]' 0)
  if (-not (Test-List $current)) { $current = New-Object 'object[]' 0 }
  $merged = Merge-Records $current $incoming
  $mergedText = ConvertTo-JsonText $merged
  if (-not [System.IO.File]::Exists($path) -or $mergedText -ne (ConvertTo-JsonText $current)) {
    Backup-History $date $path
    Write-Atomic $path $mergedText
  }
  Add-Log $date $merged
  return $mergedText
}


# ---------------------------------------------------------------------------
# 受付（スマホで名前と部門を登録 → PC の順番待ち。server.py と同じ規則）
# ---------------------------------------------------------------------------

$Divisions = @('', 'k', 'low', 'high', 'adult')
$script:Lobby = $null
$script:Lan = $false

function Get-NowMs { return [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) }
function Get-CleanName($v) { $t = ([string]$v).Trim(); if ($t.Length -gt 20) { $t = $t.Substring(0, 20) }; return [string]$t }
function Get-CleanDiv($v) { $t = [string]$v; if ($Divisions -contains $t) { return $t }; return '' }

function Get-Lobby {
  if ($null -eq $script:Lobby) {
    $d = Read-JsonFile (Join-Path $script:DataDirFull 'lobby.json') $null
    $q = New-Object System.Collections.ArrayList
    $r = New-Object System.Collections.ArrayList
    $rev = 0
    if (Test-Dict $d) {
      if (Test-Number $d['rev']) { $rev = [int]$d['rev'] }
      if (Test-List $d['queue']) { foreach ($x in $d['queue']) { if ((Test-Dict $x) -and ($x['id'] -is [string])) { [void]$q.Add($x) } } }
      if (Test-List $d['recent']) { foreach ($x in $d['recent']) { if ((Test-Dict $x) -and ($x['recordId'] -is [string])) { [void]$r.Add($x) } } }
    }
    $script:Lobby = @{ rev = [int]$rev; queue = $q; recent = $r }
  }
  return $script:Lobby
}

function Save-Lobby {
  $script:Lobby['rev'] = [int]$script:Lobby['rev'] + 1
  Write-Atomic (Join-Path $script:DataDirFull 'lobby.json') (ConvertTo-JsonText $script:Lobby)
}

# 戻り値: @{ status = 200 / 400 ...; message = ... }
function Invoke-LobbyOp($body, [bool]$local) {
  if (-not (Test-Dict $body)) { return @{ status = 400; message = 'lobby op must be an object' } }
  $lb = Get-Lobby
  $op = [string]$body['op']
  if ($op -eq 'add') {
    $name = Get-CleanName $body['name']; $div = Get-CleanDiv $body['division']
    if (-not $name -and -not $div) { return @{ status = 400; message = 'name or division required' } }
    if ($lb['queue'].Count -ge 60) { return @{ status = 409; message = 'queue is full' } }
    $bytes = New-Object byte[] 6
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $id = [string](($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
    [void]$lb['queue'].Add(@{ id = $id; name = $name; division = $div; ts = (Get-NowMs) })
  } elseif ($op -eq 'remove') {
    $target = [string]$body['id']
    $keep = New-Object System.Collections.ArrayList
    foreach ($x in $lb['queue']) { if ([string]$x['id'] -ne $target) { [void]$keep.Add($x) } }
    if ($keep.Count -eq $lb['queue'].Count) { return @{ status = 200 } }
    $lb['queue'] = $keep
  } elseif ($op -eq 'edit') {
    $hit = $null
    foreach ($x in $lb['recent']) { if ([string]$x['recordId'] -eq [string]$body['recordId']) { $hit = $x } }
    if ($null -eq $hit) { return @{ status = 404; message = 'record not in recent' } }
    $hit['name'] = Get-CleanName $body['name']
    $hit['division'] = Get-CleanDiv $body['division']
    $hit['updatedAt'] = Get-NowMs
  } elseif ($op -eq 'result' -and $local) {
    $e = $body['entry']
    if (-not (Test-Dict $e) -or -not ($e['recordId'] -is [string])) { return @{ status = 400; message = 'entry.recordId required' } }
    $ts = Get-NowMs; if (Test-Number $e['ts']) { $ts = [long]$e['ts'] }
    $up = Get-NowMs; if (Test-Number $e['updatedAt']) { $up = [long]$e['updatedAt'] }
    $score = $null; if (Test-Number $e['score']) { $score = [double]$e['score'] }
    $entry = @{ recordId = [string]$e['recordId']; score = $score; reached = [string]$e['reached']; name = (Get-CleanName $e['name']);
                division = (Get-CleanDiv $e['division']); ts = $ts; updatedAt = $up }
    $list = New-Object System.Collections.Generic.List[object]
    foreach ($x in $lb['recent']) { if ([string]$x['recordId'] -ne $entry['recordId']) { $list.Add($x) } }
    $list.Add($entry)
    $list.Sort([System.Comparison[object]] { param($a, $b) ([double]$a['ts']).CompareTo([double]$b['ts']) })
    $keep = New-Object System.Collections.ArrayList
    $start = [Math]::Max(0, $list.Count - 8)
    for ($i = $start; $i -lt $list.Count; $i++) { [void]$keep.Add($list[$i]) }
    $lb['recent'] = $keep
  } elseif ($op -eq 'clear' -and $local) {
    $lb['queue'] = New-Object System.Collections.ArrayList
  } elseif ($op -eq 'result' -or $op -eq 'clear') {
    return @{ status = 403; message = 'PC only' }
  } else {
    return @{ status = 400; message = 'unknown op' }
  }
  Save-Lobby
  return @{ status = 200 }
}

function Get-PhoneKey {
  $path = Join-Path $script:DataDirFull 'phone-key.txt'
  try {
    if ([System.IO.File]::Exists($path)) {
      $k = [System.IO.File]::ReadAllText($path).Trim()
      if ($k -match '^[a-z0-9]{6,32}$') { return [string]$k }
    }
  } catch { }
  $chars = 'abcdefghjkmnpqrstuvwxyz23456789'
  $bytes = New-Object byte[] 8
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $k = [string](($bytes | ForEach-Object { $chars[$_ % $chars.Length] }) -join '')
  try { [System.IO.File]::WriteAllText($path, $k) } catch { }
  return $k
}

function Get-LanAddresses {
  $set = New-Object System.Collections.Generic.List[string]
  try {
    foreach ($a in [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName())) {
      if ($a.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) { $set.Add([string]$a.ToString()) }
    }
  } catch { }
  try {
    $u = New-Object System.Net.Sockets.Socket([System.Net.Sockets.AddressFamily]::InterNetwork, [System.Net.Sockets.SocketType]::Dgram, [System.Net.Sockets.ProtocolType]::Udp)
    $u.Connect('10.255.255.255', 1)
    $set.Add([string]$u.LocalEndPoint.Address.ToString())
    $u.Close()
  } catch { }
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($ip in $set) {
    if ($ip.StartsWith('127.') -or $ip.StartsWith('169.254.') -or $ip.StartsWith('0.') -or $out.Contains($ip)) { continue }
    if ($ip.StartsWith('192.168.137.')) { $out.Insert(0, $ip) } else { $out.Add($ip) }
  }
  return , $out.ToArray()
}

function Test-KeyOk($ctx) {
  $sent = [string]$ctx.Request.Headers['X-Kitano-Key']
  if (-not $sent) { $sent = [string]$ctx.Request.QueryString['k'] }
  return ($sent -ne '') -and ($sent -ceq (Get-PhoneKey))
}

# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

$ContentTypes = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'; '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon'
  '.md' = 'text/plain; charset=utf-8'; '.txt' = 'text/plain; charset=utf-8'; '.csv' = 'text/csv; charset=utf-8'
  '.woff2' = 'font/woff2'; '.mp3' = 'audio/mpeg'; '.ogg' = 'audio/ogg'; '.wav' = 'audio/wav'; '.m4a' = 'audio/mp4'
}

# sound フォルダの音楽ファイル名（名前順）。BGM 用。
function Get-SoundFiles {
  $list = New-Object 'System.Collections.Generic.List[string]'
  $dir = [System.IO.Path]::Combine($RootFull, 'sound')
  if ([System.IO.Directory]::Exists($dir)) {
    foreach ($f in [System.IO.Directory]::GetFiles($dir)) {
      $n = [string][System.IO.Path]::GetFileName($f)
      $e = [System.IO.Path]::GetExtension($n).ToLowerInvariant()
      if (-not $n.StartsWith('.') -and ($e -eq '.mp3' -or $e -eq '.ogg' -or $e -eq '.wav' -or $e -eq '.m4a')) { $list.Add($n) }
    }
  }
  $list.Sort([System.StringComparer]::Ordinal)
  return , $list.ToArray()
}

function Send-Bytes($ctx, [byte[]]$bytes, [string]$type, [int]$status = 200) {
  $res = $ctx.Response
  $res.StatusCode = $status
  $res.ContentType = $type
  $res.Headers['Cache-Control'] = 'no-store'
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Send-JsonText($ctx, [string]$text, [int]$status = 200) {
  Send-Bytes $ctx ($Utf8.GetBytes($text)) 'application/json; charset=utf-8' $status
}

function Send-Error($ctx, [int]$status, [string]$message) {
  $h = @{ ok = $false; error = [string]$message }
  Send-JsonText $ctx (ConvertTo-JsonText $h) $status
}

# 本文は先に全部読んでおく（読まずに応答すると、Windows では接続がリセットされることがある）
function Read-BodyText($ctx) {
  $req = $ctx.Request
  if ($req.ContentLength64 -gt $MaxBody) { return $null }
  $reader = New-Object System.IO.StreamReader($req.InputStream, $Utf8)
  try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

function ConvertFrom-Body([string]$text) {
  if ($null -eq $text) { throw [System.OverflowException]::new('body too large') }
  if (-not $text) { throw [System.FormatException]::new('empty body') }
  if ($Utf8.GetByteCount($text) -gt $MaxBody) { throw [System.OverflowException]::new('body too large') }
  try { return , (ConvertFrom-JsonText $text) } catch { throw [System.FormatException]::new('invalid json') }
}

function Send-Static($ctx, [string]$urlPath) {
  $rel = [System.Uri]::UnescapeDataString($urlPath)
  if ($rel -eq '/' -or $rel -eq '') { $rel = '/index.html' }
  if ($rel.StartsWith('/data/') -or $rel -eq '/data') { Send-Error $ctx 404 'not found'; return }
  $full = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($RootFull, $rel.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)))
  $prefix = $RootFull + [System.IO.Path]::DirectorySeparatorChar
  if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -or -not [System.IO.File]::Exists($full)) {
    Send-Error $ctx 404 'not found'
    return
  }
  $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
  $type = $ContentTypes[$ext]
  if (-not $type) { $type = 'application/octet-stream' }
  Send-Bytes $ctx ([System.IO.File]::ReadAllBytes($full)) $type
}

function Invoke-Request($ctx) {
  $path = $ctx.Request.Url.AbsolutePath
  $method = $ctx.Request.HttpMethod
  $local = [System.Net.IPAddress]::IsLoopback($ctx.Request.RemoteEndPoint.Address)
  if ($path -eq '/phone') { $path = '/phone.html' }
  if (-not $path.StartsWith('/api/')) {
    if (-not $local -and $path -ne '/phone.html') { Send-Error $ctx 403 'forbidden'; return }
    if ($method -eq 'GET' -or $method -eq 'HEAD') { Send-Static $ctx $path } else { Send-Error $ctx 404 'not found' }
    return
  }
  $parts = @($path.Substring(5).Trim('/').Split('/'))
  $name = $parts[0]
  $rest = @()
  if ($parts.Count -gt 1) { $rest = @($parts[1..($parts.Count - 1)]) }
  # PC 以外（LAN）からは、合言葉付きの受付 API だけ
  if (-not $local -and -not ($name -eq 'lobby' -and (Test-KeyOk $ctx))) { [void](Read-BodyText $ctx); Send-Error $ctx 403 'forbidden'; return }

  if ($name -eq 'lobby' -and $rest.Count -eq 0) {
    if ($method -eq 'GET') { Send-JsonText $ctx (ConvertTo-JsonText (Get-Lobby)); return }
    if ($method -eq 'POST') {
      $bodyText = Read-BodyText $ctx
      try { $body = ConvertFrom-Body $bodyText } catch { Send-Error $ctx 400 'invalid json'; return }
      $res = Invoke-LobbyOp $body $local
      if ($res['status'] -ne 200) { Send-Error $ctx ([int]$res['status']) ([string]$res['message']); return }
      Send-JsonText $ctx (ConvertTo-JsonText (Get-Lobby)); return
    }
  }

  if ($method -eq 'GET') {
    if ($name -eq 'health' -and $rest.Count -eq 0) {
      # 値は必ず素の string/int にする。Join-Path などの出力は PSObject で包まれていて、
      # Windows PowerShell 5.1 の JavaScriptSerializer が循環参照エラーになる（Windows 実機で確認）
      $key = Get-PhoneKey
      $urls = New-Object System.Collections.Generic.List[string]
      if ($script:Lan) { foreach ($ip in (Get-LanAddresses)) { $urls.Add([string]"http://${ip}:$($script:PortUsed)/phone.html?k=$key") } }
      $h = @{ ok = $true; server = 'powershell'; dataDir = [string]$script:DataDirFull; port = [int]$script:PortUsed;
              lan = [bool]$script:Lan; phoneKey = [string]$key; phoneUrls = [string[]]$urls.ToArray() }
      Send-JsonText $ctx (ConvertTo-JsonText $h); return
    }
    if ($name -eq 'records' -and $rest.Count -eq 1 -and $rest[0] -match $DateRe) {
      $data = Read-JsonFile (Join-Path $script:DataDirFull "$($rest[0]).json") $null
      if (Test-List $data) { Send-JsonText $ctx (ConvertTo-JsonText $data) } else { Send-JsonText $ctx '[]' }
      return
    }
    if ($name -eq 'settings' -and $rest.Count -eq 0) {
      $data = Read-JsonFile (Join-Path $script:DataDirFull 'settings.json') $null
      if (Test-Dict $data) { Send-JsonText $ctx (ConvertTo-JsonText $data) } else { Send-JsonText $ctx 'null' }
      return
    }
    if ($name -eq 'sounds' -and $rest.Count -eq 0) {
      $files = [string[]](Get-SoundFiles)
      Send-JsonText $ctx (ConvertTo-JsonText @{ files = $files }); return
    }
    Send-Error $ctx 400 'bad request'; return
  }

  if ($method -eq 'POST') {
    $bodyText = Read-BodyText $ctx
    try {
      if ($name -eq 'records' -and $rest.Count -eq 1 -and $rest[0] -match $DateRe) {
        $body = ConvertFrom-Body $bodyText
        $ok = Test-List $body
        if ($ok) { foreach ($r in $body) { if (-not (Test-Record $r)) { $ok = $false; break } } }
        if (-not $ok) { Send-Error $ctx 400 'records must be an array of objects with string id'; return }
        Send-JsonText $ctx (Save-Records $rest[0] $body); return
      }
      if ($name -eq 'settings' -and $rest.Count -eq 0) {
        $body = ConvertFrom-Body $bodyText
        if (-not (Test-Dict $body)) { Send-Error $ctx 400 'settings must be an object'; return }
        Write-Atomic (Join-Path $script:DataDirFull 'settings.json') (ConvertTo-JsonText $body)
        Send-JsonText $ctx '{"ok":true}'; return
      }
      Send-Error $ctx 400 'bad request'; return
    } catch [System.OverflowException] {
      Send-Error $ctx 413 'body too large'; return
    } catch [System.FormatException] {
      Send-Error $ctx 400 'invalid json'; return
    }
  }
  Send-Error $ctx 404 'not found'
}

# ---------------------------------------------------------------------------
# 環境チェック
# ---------------------------------------------------------------------------

function Test-Writable([string]$dir) {
  try {
    [void][System.IO.Directory]::CreateDirectory($dir)
    $test = Join-Path $dir '.write-test'
    [System.IO.File]::WriteAllText($test, 'ok')
    [System.IO.File]::Delete($test)
    return $true
  } catch {
    return $false
  }
}

function Test-PortFree([int]$p) {
  # IPv4 と IPv6 の両方で空いているか（片方だけ別アプリが使っていると、ブラウザがそちらに繋がることがある）
  try {
    $t = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
    $t.Start()
    $t.Stop()
  } catch {
    return $false
  }
  if ([System.Net.Sockets.Socket]::OSSupportsIPv6) {
    try {
      $t6 = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::IPv6Loopback, $p)
      $t6.Start()
      $t6.Stop()
    } catch [System.Net.Sockets.SocketException] {
      if ($_.Exception.SocketErrorCode -eq [System.Net.Sockets.SocketError]::AddressAlreadyInUse) { return $false }
    }
  }
  return $true
}

function Find-Browser {
  $cands = @(
    @{ Label = 'Chrome'; Bases = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA); Rel = 'Google\Chrome\Application\chrome.exe' },
    @{ Label = 'Edge'; Bases = @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA); Rel = 'Microsoft\Edge\Application\msedge.exe' }
  )
  foreach ($c in $cands) {
    foreach ($b in $c.Bases) {
      if ($b -and (Test-Path -LiteralPath (Join-Path $b $c.Rel))) { return @{ Exe = (Join-Path $b $c.Rel); Label = $c.Label } }
    }
  }
  return @{ Exe = $null; Label = '既定のブラウザ' }
}

$lines = New-Object System.Collections.ArrayList
[void]$lines.Add("===== 環境チェック $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') =====")
[void]$lines.Add("[OK] サーバー: PowerShell $($PSVersionTable.PSVersion)")

# JSON 処理の自己テスト（保存形式が壊れないことを起動時に確認）
try {
  $sample = '[{"id":"b","ts":2,"updatedAt":2,"name":"テスト","score":80.5,"series":[[0,70.1],[50,80.25]]},{"id":"a","ts":1,"updatedAt":1,"series":[[0,1]]}]'
  $newer = '[{"id":"b","ts":2,"updatedAt":9,"deleted":true,"series":[[0,70.1]]}]'
  $m = Merge-Records (ConvertFrom-JsonText $sample) (ConvertFrom-JsonText $newer)
  $back = ConvertFrom-JsonText (ConvertTo-JsonText $m)
  $ok = ($back.Count -eq 2) -and ((Get-Field $back[0] 'id') -eq 'a') -and (Test-Deleted $back[1]) -and
        ($back[0]['series'][0].Count -eq 2) -and ([double]($back[1]['series'][0][1]) -eq 70.1)
  if (-not $ok) { throw 'roundtrip mismatch' }
  $engine = if ($script:Ser) { 'JavaScriptSerializer' } else { 'ConvertFrom-Json' }
  [void]$lines.Add("[OK] JSON 処理の自己テスト（$engine）")
} catch {
  Write-Host "[NG] JSON 処理の自己テストに失敗しました: $($_.Exception.Message)"
  Write-Host '     Python 3 をインストールして start.bat を実行し直してください。'
  exit 1
}

if ($DataDir) {
  $script:DataDirFull = [System.IO.Path]::GetFullPath($DataDir)
  if (-not (Test-Writable $script:DataDirFull)) { Write-Host "[NG] 保存先に書き込めません: $($script:DataDirFull)"; exit 1 }
} else {
  $primary = Join-Path $RootFull 'data'
  if (Test-Writable $primary) {
    $script:DataDirFull = [string]$primary
  } else {
    [void]$lines.Add("[注意] $primary に書き込めません（読み取り専用の場所/USBの書き込み禁止など）")
    $base = $env:LOCALAPPDATA
    if (-not $base) { $base = Join-Path $HOME '.local/share' }
    $fallback = Join-Path (Join-Path $base 'kitano-decibel') 'data'
    if (-not (Test-Writable $fallback)) { Write-Host "[NG] 保存先フォルダに書き込めません: $primary / $fallback"; exit 1 }
    [void]$lines.Add("[注意] 代わりに $fallback に保存します")
    $script:DataDirFull = [string]$fallback
  }
}
[void]$lines.Add("[OK] 保存先: $($script:DataDirFull)")

$candidates = if ($Port -gt 0) { @($Port) } else { 8000..8010 }
$listener = $null
foreach ($p in $candidates) {
  if (-not (Test-PortFree $p)) { continue }
  # まず LAN にも公開（スマホ受付用）を試し、権限が無ければ localhost だけ
  $hosts = @('localhost')
  if (-not $LocalOnly) { $hosts = @('+', 'localhost') }
  foreach ($h in $hosts) {
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://${h}:$p/")
    try {
      $l.Start()
      $listener = $l
      $script:PortUsed = $p
      $script:Lan = ($h -eq '+')
      break
    } catch {
      try { $l.Close() } catch { }
    }
  }
  if ($listener) { break }
}
if (-not $listener) {
  Write-Host "[NG] ポート $($candidates[0])〜$($candidates[-1]) がすべて使用中です。他のサーバーを閉じてから再実行してください。"
  exit 1
}
if ($Port -le 0 -and $script:PortUsed -ne 8000) {
  [void]$lines.Add("[注意] ポート 8000 が使用中のため $($script:PortUsed) を使います（記録はファイルから復元されるので問題ありません）")
}
$url = "http://localhost:$($script:PortUsed)/"
[void]$lines.Add("[OK] アドレス: $url")
[void](Get-PhoneKey)
if ($script:Lan) {
  $ipList = New-Object System.Collections.Generic.List[string]
  foreach ($ip in (Get-LanAddresses)) { $ipList.Add("${ip}:$($script:PortUsed)") }
  $ips = $ipList -join ', '
  if (-not $ips) { $ips = 'ネットワーク未接続。テザリングをオンにすると使えます' }
  [void]$lines.Add("[OK] スマホ受付: 管理者画面の QR コードから（$ips）")
} else {
  [void]$lines.Add('[注意] スマホ受付は使えません（PowerShell 版は管理者として実行したときだけ LAN に公開できます）。PC だけで遊べます')
}

$browser = Find-Browser
if (-not $NoBrowser) { [void]$lines.Add("[OK] ブラウザ: $($browser.Label)") }

foreach ($ln in $lines) { Write-Host $ln }
try { [System.IO.File]::AppendAllText((Join-Path $script:DataDirFull 'env-check.log'), (($lines -join "`r`n") + "`r`n"), $Utf8) } catch { }
Write-Host ''
Write-Host 'このウィンドウは本番中は閉じないでください（閉じると保存サーバーが止まります）。'
Write-Host '止まっても、もう一度 start.bat を実行すれば記録はそのまま戻ります。'

if (-not $NoBrowser) {
  try {
    if ($browser.Exe) { Start-Process -FilePath $browser.Exe -ArgumentList $url } else { Start-Process $url }
  } catch {
    Write-Host "[注意] ブラウザを開けませんでした。手動で $url を開いてください。"
  }
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try {
      Invoke-Request $ctx
    } catch {
      Write-Host "[エラー] $($_.Exception.Message)"
      try { Send-Error $ctx 500 $_.Exception.Message } catch { }
    } finally {
      try { $ctx.Response.Close() } catch { }
    }
  }
} finally {
  try { $listener.Stop(); $listener.Close() } catch { }
}
