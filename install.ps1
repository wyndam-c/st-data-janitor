<#
  数据清洁工 (ST Data Janitor) 一键安装器 —— Windows
  用法（在 PowerShell 里）：
    iwr -UseB https://raw.githubusercontent.com/wyndam-c/st-data-janitor/main/install.ps1 -OutFile "$env:TEMP\stj-install.ps1"
    & "$env:TEMP\stj-install.ps1"                  # 自动找 SillyTavern
    & "$env:TEMP\stj-install.ps1" -StPath "D:\SillyTavern"
  也可以直接双击 install.cmd（和 install.ps1 放同一个文件夹）。

  参数：
    -StPath <路径>     指定 SillyTavern 根目录
    -User <名字>       酒馆用户名，默认 default-user
    -Channel <分支>    发布分支，默认 plugin-dist
    -Online            强制从 GitHub 下载最新发布
    -FixConfig         自动把 config.yaml 的 enableServerPlugins 打开（先备份）
    -Restart           装完尝试自动重启酒馆（会先关掉 node 进程，再用 Start.bat 拉起）
    -Uninstall         卸载（移到 .removed-时间戳，不直接删）
    -DryRun            演习，不动任何文件
#>
[CmdletBinding()]
param(
    [string]$StPath = $env:SILLYTAVERN_HOME,
    [string]$User = 'default-user',
    [string]$Channel = 'plugin-dist',
    [switch]$Online,
    [switch]$FixConfig,
    [switch]$Restart,
    [switch]$Uninstall,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Repo = 'wyndam-c/st-data-janitor'
$ExtBranch = 'ext-dist'
$PluginId = 'st-data-janitor'
$Ts = Get-Date -Format 'yyyyMMdd-HHmmss'

function Ok($m)   { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Bad($m)  { Write-Host $m -ForegroundColor Red }
function Hr       { Write-Host ('-' * 60) }

function Is-StRoot($p) {
    if (-not $p) { return $false }
    if (-not (Test-Path $p)) { return $false }
    return ((Test-Path (Join-Path $p 'config.yaml')) -and ((Test-Path (Join-Path $p 'package.json')) -or (Test-Path (Join-Path $p 'src\plugin-loader.js')) -or (Test-Path (Join-Path $p 'server.js'))))
}

function Find-St {
    $cands = @(
        $StPath,
        (Join-Path $env:APPDATA 'SillyTavern'),
        (Join-Path $env:USERPROFILE 'SillyTavern'),
        (Join-Path $env:USERPROFILE 'Desktop\SillyTavern'),
        (Join-Path $env:USERPROFILE 'Documents\SillyTavern'),
        'C:\SillyTavern', 'D:\SillyTavern', 'E:\SillyTavern',
        (Get-Location).Path,
        (Join-Path (Get-Location).Path 'SillyTavern')
    )
    foreach ($c in $cands) { if (Is-StRoot $c) { return (Resolve-Path $c).Path } }
    return $null
}

function Get-File($urls, $out) {
    foreach ($u in $urls) {
        try {
            if ($DryRun) { Write-Host "  [演习] 下载 $u"; return $true }
            Write-Host "  ↓ $u"
            Invoke-WebRequest -Uri $u -OutFile $out -UseBasicParsing -TimeoutSec 300
            return $true
        } catch { Write-Host "    × 失败：$($_.Exception.Message)" }
    }
    return $false
}

function Archive($dstDir, $label) {
    if (Test-Path $dstDir) {
        $zip = "$dstDir.bak-$Ts.zip"
        if ($DryRun) { Write-Host "  [演习] 备份 $dstDir → $zip" }
        else {
            Warn "  已存在旧版本，先备份：$zip"
            Compress-Archive -Path $dstDir -DestinationPath $zip -Force
        }
    }
}

Hr; Write-Host "  数据清洁工 (ST Data Janitor) — 一键安装 (Windows)"; Hr

$st = Find-St
if (-not $st) {
    Bad "找不到 SillyTavern 根目录（要有 config.yaml 的那一层）。"
    Write-Host '  请手动指定，例如：  .\install.ps1 -StPath "D:\SillyTavern"'
    exit 1
}
Write-Host "  SillyTavern：$st"
Write-Host "  用户目录：  data\$User"

$PluginDst = Join-Path $st "plugins\$PluginId"
$ExtDst = Join-Path $st "data\$User\extensions\$PluginId"

if ($Uninstall) {
    Hr; Write-Host '  卸载（只移走，不删除）'
    foreach ($d in @($PluginDst, $ExtDst)) {
        if (Test-Path $d) {
            $dst = "$d.removed-$Ts"
            if ($DryRun) { Write-Host "  [演习] 移走 $d → $dst" }
            else { Move-Item $d $dst; Ok "  ✓ 已移走：$dst" }
        }
    }
    Warn '  重启酒馆后生效。'
    Hr; exit 0
}

$tmp = Join-Path $env:TEMP "stj-$Ts"
if (-not $DryRun) { New-Item -ItemType Directory -Path $tmp -Force | Out-Null }

# ---------- ① 服务端插件 ----------
Hr; Write-Host "  ① 服务端插件 → plugins\$PluginId"
if ($DryRun) { Write-Host "  [演习] 下载并安装到 $PluginDst" }
else {
    Archive $PluginDst 'plugin'
    $zip = Join-Path $tmp 'plugin.zip'
    $urls = @(
        "https://codeload.github.com/$Repo/zip/refs/heads/$Channel",
        "https://gh-proxy.com/https://codeload.github.com/$Repo/zip/refs/heads/$Channel",
        "https://ghfast.top/https://codeload.github.com/$Repo/zip/refs/heads/$Channel"
    )
    if (Get-File $urls $zip) {
        $ex = Join-Path $tmp 'plugin'
        Expand-Archive -Path $zip -DestinationPath $ex -Force
        $src = (Get-ChildItem $ex -Directory | Select-Object -First 1).FullName
        New-Item -ItemType Directory -Path $PluginDst -Force | Out-Null
        Copy-Item (Join-Path $src 'index.mjs') $PluginDst -Force
        if (Test-Path (Join-Path $src 'lib')) {
            New-Item -ItemType Directory -Path (Join-Path $PluginDst 'lib') -Force | Out-Null
            Copy-Item (Join-Path $src 'lib\*') (Join-Path $PluginDst 'lib') -Recurse -Force
        }
        $ver = (Select-String -Path (Join-Path $PluginDst 'index.mjs') -Pattern "version: '([0-9.]+)'" | Select-Object -First 1).Matches.Groups[1].Value
        Ok "  ✓ 服务端插件 → $PluginDst  $(if($ver){"(v$ver)"})"
    } else { Bad '  下载失败；网络不通可以先开代理再试，或用 -Channel 换分支' }
}

# ---------- ② 前端扩展 ----------
Hr; Write-Host "  ② 前端扩展 → data\$User\extensions\$PluginId"
if ($DryRun) { Write-Host "  [演习] 下载并安装到 $ExtDst" }
else {
    Archive $ExtDst 'ext'
    $zip = Join-Path $tmp 'ext.zip'
    $urls = @(
        "https://codeload.github.com/$Repo/zip/refs/heads/$ExtBranch",
        "https://gh-proxy.com/https://codeload.github.com/$Repo/zip/refs/heads/$ExtBranch",
        "https://ghfast.top/https://codeload.github.com/$Repo/zip/refs/heads/$ExtBranch"
    )
    if (Get-File $urls $zip) {
        $ex = Join-Path $tmp 'ext'
        Expand-Archive -Path $zip -DestinationPath $ex -Force
        $src = (Get-ChildItem $ex -Directory | Select-Object -First 1).FullName
        New-Item -ItemType Directory -Path $ExtDst -Force | Out-Null
        Copy-Item (Join-Path $src 'manifest.json'), (Join-Path $src 'index.js'), (Join-Path $src 'style.css') $ExtDst -Force
        Ok "  ✓ 前端扩展 → $ExtDst"
    } else { Warn "  下载失败 —— 也可以在酒馆里手动装：扩展 → 安装扩展 → URL 填 https://github.com/$Repo ，分支填 $ExtBranch" }
}

# ---------- ③ config.yaml ----------
Hr; Write-Host '  ③ 检查 config.yaml'
$cfg = Join-Path $st 'config.yaml'
$cfgTxt = Get-Content $cfg -Raw
if ($cfgTxt -match '(?m)^\s*enableServerPlugins:\s*true') {
    Ok '  ✓ enableServerPlugins 已开启'
} else {
    Warn '  ! config.yaml 没开 enableServerPlugins → 服务端插件不会加载'
    if ($FixConfig) {
        if (-not $DryRun) { Copy-Item $cfg "$cfg.bak-$Ts" -Force }
        if ($cfgTxt -match '(?m)^\s*enableServerPlugins:') {
            $cfgTxt = [regex]::Replace($cfgTxt, '(?m)^(\s*enableServerPlugins:).*$', '$1 true')
        } else {
            $cfgTxt += "`r`nenableServerPlugins: true`r`n"
        }
        if ($cfgTxt -match '(?m)^\s*enableServerPluginsAutoUpdate:') {
            $cfgTxt = [regex]::Replace($cfgTxt, '(?m)^(\s*enableServerPluginsAutoUpdate:).*$', '$1 true')
        }
        if ($DryRun) { Write-Host '  [演习] 改写 config.yaml' } else { Set-Content -Path $cfg -Value $cfgTxt -NoNewline; Ok "  ✓ 已开启（备份 config.yaml.bak-$Ts）" }
    } else {
        Write-Host "    重新跑一次并加 -FixConfig 即可自动改（会备份）"
    }
}

# ---------- ④ 重启 ----------
Hr
if ($Restart) {
    Warn '→ 尝试自动重启酒馆…'
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'sillytavern|server\.js' }
    if ($procs) {
        foreach ($p in $procs) { if (-not $DryRun) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } ; Write-Host "  · 关闭进程 $($p.ProcessId)" }
        Start-Sleep -Seconds 2
        $bat = @('Start.bat', 'start.bat') | ForEach-Object { Join-Path $st $_ } | Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($bat) {
            if ($DryRun) { Write-Host "  [演习] 运行 $bat" } else { Start-Process -FilePath $bat -WorkingDirectory $st; Ok "  ✓ 已重新拉起：$bat" }
        } else { Warn "  ! 没找到 Start.bat，请自己双击酒馆的启动脚本" }
    } else { Warn '  ! 没找到酒馆进程，请自己重启' }
} else {
    Warn '  最后一步：重启酒馆（关掉窗口再双击 Start.bat）插件才会加载'
    Write-Host '    想让脚本自己重启：  .\install.ps1 -Restart'
}
if (-not $DryRun) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
Hr; Ok '  装好了 🌱'
Write-Host '  · 重启后在酒馆「扩展」面板里能看到「数据清洁工 / ST Data Janitor」'
Write-Host '  · 没看到就 Ctrl+F5 强刷页面'
Write-Host "  · 卸载：  .\install.ps1 -Uninstall"
Hr
