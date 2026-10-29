# qqbot upgrade via npm package (Windows PowerShell)
#
# Windows-native equivalent of upgrade-via-npm.sh.
# No bash / Git Bash / WSL required.
#
# Two-level fallback strategy:
#   Level 1: openclaw plugins install/update (native command via ClawHub -> npm)
#   Level 2: npm pack download + extract + openclaw plugins install <local dir> (bypasses ClawHub, retains atomic deployment)
#   All failed -> rollback to previous version
#
# Usage:
#   .\upgrade-via-npm.ps1                                    # upgrade to latest (default)
#   .\upgrade-via-npm.ps1 -Version <version>                 # upgrade to specific version
#   .\upgrade-via-npm.ps1 -SelfVersion                       # upgrade to local package.json version
#   .\upgrade-via-npm.ps1 -AppId <appid> -Secret <secret>    # configure on first install
#   .\upgrade-via-npm.ps1 -NoRestart                         # file replacement only (for hot-upgrade)
#   .\upgrade-via-npm.ps1 -Timeout <seconds>                 # custom install timeout
#   .\upgrade-via-npm.ps1 -DisableBuiltin                     # disable builtin conflict plugins
#   .\upgrade-via-npm.ps1 -Help                               # show help

param(
    [string]$Version = "",
    [switch]$SelfVersion,
    [string]$AppId = "",
    [string]$Secret = "",
    [switch]$NoRestart,
    [string]$Tag = "",
    [string]$Pkg = "",
    [switch]$Help,
    [int]$Timeout = 1000,
    [switch]$DisableBuiltin = $true
)

# 设置 UTF-8 输出编码，防止 openclaw CLI 框线字符乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

function Read-PkgVersion {
    param([string]$PkgPath)
    try {
        if (Test-Path $PkgPath) {
            $pkg = Get-Content $PkgPath -Raw | ConvertFrom-Json
            return $pkg.version
        }
    } catch {}
    return ""
}

function Test-VersionGte {
    param([string]$Version1, [string]$Version2)
    if ($Version1 -eq $Version2) { return $true }
    $v1 = $Version1 -split '\.'
    $v2 = $Version2 -split '\.'
    for ($i = 0; $i -lt [Math]::Max($v1.Count, $v2.Count); $i++) {
        $n1 = if ($i -lt $v1.Count) { [int]($v1[$i] -replace '[^0-9]','') } else { 0 }
        $n2 = if ($i -lt $v2.Count) { [int]($v2[$i] -replace '[^0-9]','') } else { 0 }
        if ($n1 -gt $n2) { return $true }
        if ($n1 -lt $n2) { return $false }
    }
    return $true
}

function Invoke-WithTimeout {
    param(
        [int]$TimeoutSecs,
        [string]$Description,
        [scriptblock]$ScriptBlock
    )
    
    $startTime = Get-Date
    $job = Start-Job -ScriptBlock $ScriptBlock
    
    while ($true) {
        $elapsed = (Get-Date) - $startTime
        if ($elapsed.TotalSeconds -ge $TimeoutSecs) {
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            Remove-Job -Job $job -ErrorAction SilentlyContinue
            Write-Host "  ⏰ ${Description} 超时 (${TimeoutSecs}s)" -ForegroundColor Yellow
            return $false
        }

        $jobState = (Get-Job -Id $job.Id -ErrorAction SilentlyContinue).State
        if ($jobState -ne 'Running') { break }
        Start-Sleep -Milliseconds 500
    }

    # 输出命令执行结果
    $output = ""
    try {
        $output = Receive-Job -Job $job -ErrorAction SilentlyContinue
        if ($output) {
            $output | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
        }
    } catch {}

    Remove-Job -Job $job -ErrorAction SilentlyContinue

    return $output
}

$PLUGIN_ID = "openclaw-qqbot"
$PKG_NAME = "@tencent-connect/openclaw-qqbot"
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Definition
$PROJECT_DIR = Split-Path -Parent $SCRIPT_DIR
$LOCAL_VERSION = Read-PkgVersion -PkgPath (Join-Path $PROJECT_DIR "package.json")

$env:npm_config_registry = "https://registry.npmjs.org"
$NPM_REGISTRIES = @("https://registry.npmjs.org/", "https://registry.npmmirror.com/", "")
$env:_UPGRADE_ISOLATED = "1"

if ($Help) {
    Write-Host "Usage:"
    Write-Host "  .\upgrade-via-npm.ps1                              # upgrade to latest (default)"
    Write-Host "  .\upgrade-via-npm.ps1 -Version [version]           # upgrade to specific version"
    Write-Host "  .\upgrade-via-npm.ps1 -SelfVersion                 # upgrade to repo version ($LOCAL_VERSION)"
    Write-Host "  .\upgrade-via-npm.ps1 -Pkg [scope/name]            # custom npm package"
    Write-Host "  .\upgrade-via-npm.ps1 -AppId [appid]               # QQ bot appid"
    Write-Host "  .\upgrade-via-npm.ps1 -Secret [secret]             # QQ bot secret"
    Write-Host "  .\upgrade-via-npm.ps1 -NoRestart                   # file replacement only"
    Write-Host "  .\upgrade-via-npm.ps1 -Timeout [seconds]           # install timeout (default 1000)"
    Write-Host "  .\upgrade-via-npm.ps1 -DisableBuiltin              # disable builtin conflict plugins"
    Write-Host "  .\upgrade-via-npm.ps1 -Help                        # show this help"
    Write-Host ""
    Write-Host "Environment variables: QQBOT_APPID, QQBOT_SECRET, QQBOT_TOKEN"
    exit 0
}

# Determine install source
$INSTALL_SRC = ""
if ($Tag) {
    $INSTALL_SRC = "${PKG_NAME}@${Tag}"
} elseif ($Version) {
    $INSTALL_SRC = "${PKG_NAME}@${Version}"
} elseif ($SelfVersion) {
    if (-not $LOCAL_VERSION) {
        Write-Host "[ERROR] Cannot read version from package.json" -ForegroundColor Red
        exit 1
    }
    $INSTALL_SRC = "${PKG_NAME}@${LOCAL_VERSION}"
} else {
    $INSTALL_SRC = "${PKG_NAME}@latest"
}

# Environment variable fallback
if (-not $AppId) { $AppId = $env:QQBOT_APPID }
if (-not $Secret) { $Secret = $env:QQBOT_SECRET }
if ((-not $AppId) -and (-not $Secret) -and $env:QQBOT_TOKEN) {
    $parts = $env:QQBOT_TOKEN -split ":", 2
    $AppId = $parts[0]
    $Secret = $parts[1]
}

# Detect CLI
$CMD = ""
foreach ($name in @("openclaw", "clawdbot", "moltbot")) {
    try {
        $null = Get-Command $name -ErrorAction Stop
        $CMD = $name
        break
    } catch {}
}
if (-not $CMD) {
    Write-Host "[ERROR] openclaw / clawdbot / moltbot not found" -ForegroundColor Red
    exit 1
}

$HOME_DIR = $env:USERPROFILE
if (-not $HOME_DIR) { $HOME_DIR = [Environment]::GetFolderPath("UserProfile") }
$OPENCLAW_HOME = Join-Path $HOME_DIR ".openclaw"
$EXTENSIONS_DIR = Join-Path $OPENCLAW_HOME "extensions"
$CONFIG_FILE = Join-Path $OPENCLAW_HOME "openclaw.json"
$UPGRADE_LOCK_FILE = Join-Path $OPENCLAW_HOME ".upgrading"

function Acquire-UpgradeLock {
    if (Test-Path $UPGRADE_LOCK_FILE) {
        $lockPid = Get-Content $UPGRADE_LOCK_FILE -ErrorAction SilentlyContinue
        if ($lockPid) {
            try {
                $proc = Get-Process -Id $lockPid -ErrorAction SilentlyContinue
                if ($proc) {
                    Write-Host "❌ 另一个升级进程正在运行 (PID: $lockPid)" -ForegroundColor Red
                    exit 1
                }
            } catch {}
        }
        Remove-Item $UPGRADE_LOCK_FILE -ErrorAction SilentlyContinue
    }
    $PID | Set-Content $UPGRADE_LOCK_FILE -ErrorAction SilentlyContinue
}

function Release-UpgradeLock {
    if (Test-Path $UPGRADE_LOCK_FILE) {
        Remove-Item $UPGRADE_LOCK_FILE -ErrorAction SilentlyContinue
    }
}

$CONFIG_SNAPSHOT_FILE = ""
$PREV_RELOAD_MODE = ""

function Snapshot-Config {
    if (Test-Path $CONFIG_FILE) {
        $script:CONFIG_SNAPSHOT_FILE = Join-Path ([System.IO.Path]::GetTempPath()) ".qqbot-config-snapshot-$([guid]::NewGuid().ToString('N').Substring(0,8)).json"
        Copy-Item -Path $CONFIG_FILE -Destination $CONFIG_SNAPSHOT_FILE -Force | Out-Null
        Write-Host "  [快照] 已保存配置快照"
    }
    return
}

function Restore-ConfigSnapshot {
    if ($CONFIG_SNAPSHOT_FILE -and (Test-Path $CONFIG_SNAPSHOT_FILE) -and $CONFIG_FILE) {
        Copy-Item -Path $CONFIG_SNAPSHOT_FILE -Destination $CONFIG_FILE -Force
        Write-Host "  ↩️  已恢复配置到安装前状态"
    }
}

function Cleanup-ConfigSnapshot {
    if ($CONFIG_SNAPSHOT_FILE -and (Test-Path $CONFIG_SNAPSHOT_FILE)) {
        Remove-Item $CONFIG_SNAPSHOT_FILE -ErrorAction SilentlyContinue
    }
}

function Restore-ReloadMode {
    if ($PREV_RELOAD_MODE) {
        try { & $CMD config set gateway.reload.mode $PREV_RELOAD_MODE 2>&1 | Out-Null } catch {}
    } else {
        try { & $CMD config unset gateway.reload.mode 2>&1 | Out-Null } catch {}
    }
}

$TEMP_CONFIG_FILE = ""

function Test-ConfigConflict {
    if (-not (Test-Path $CONFIG_FILE)) { return $false }
    try {
        $cfg = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
        if ($cfg.channels.qqbot) { return $true }
        if ($cfg.plugins.allow -contains $PLUGIN_ID) { return $true }
        if ($cfg.plugins.entries.$PLUGIN_ID) { return $true }
    } catch {}
    return $false
}

function Setup-TempConfig {
    if (-not (Test-Path $CONFIG_FILE)) { return $false }
    if (-not (Test-ConfigConflict)) { return $false }

    $script:TEMP_CONFIG_FILE = Join-Path ([System.IO.Path]::GetTempPath()) ".openclaw-temp-$([guid]::NewGuid().ToString('N').Substring(0,8)).json"
    try {
        $cfg = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
        if ($cfg.channels) { $cfg.channels.PSObject.Properties.Remove("qqbot") }
        if ($cfg.plugins.allow -and $cfg.plugins.allow -contains $PLUGIN_ID) {
            $cfg.plugins.allow = $cfg.plugins.allow | Where-Object { $_ -ne $PLUGIN_ID }
        }
        if ($cfg.plugins.entries.$PLUGIN_ID) { $cfg.plugins.entries.PSObject.Properties.Remove($PLUGIN_ID) }
        $cfg | ConvertTo-Json -Depth 10 | Set-Content $TEMP_CONFIG_FILE -Encoding UTF8
        $env:OPENCLAW_CONFIG_PATH = $TEMP_CONFIG_FILE
        Write-Host "  [兼容] 创建临时配置副本以通过 3.23+ 配置校验"
        return $true
    } catch {
        Write-Host "  ⚠️  创建临时配置失败：$($_.Exception.Message)"
        if ($TEMP_CONFIG_FILE -and (Test-Path $TEMP_CONFIG_FILE)) { Remove-Item $TEMP_CONFIG_FILE -ErrorAction SilentlyContinue }
        $script:TEMP_CONFIG_FILE = ""
        return $false
    }
}

function Sync-TempConfig {
    # 与 Bash 版本 sync_temp_config() 逻辑一致，但增加 channels 同步（修复 Bash 版本的 bug）
    if (-not $TEMP_CONFIG_FILE -or -not (Test-Path $TEMP_CONFIG_FILE)) { return $false }
    $targetDir = Join-Path $EXTENSIONS_DIR $PLUGIN_ID
    if (-not (Test-Path (Join-Path $targetDir "package.json"))) {
        Write-Host "  ⚠️  插件目录不完整，跳过配置同步"
        Remove-Item $TEMP_CONFIG_FILE -ErrorAction SilentlyContinue
        $env:OPENCLAW_CONFIG_PATH = $null
        return $false
    }
    try {
        $tmp = Get-Content $TEMP_CONFIG_FILE -Raw | ConvertFrom-Json
        $real = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
        $changed = $false
        if ($tmp.plugins.installs) {
            if (-not $real.plugins) { $real | Add-Member -NotePropertyName plugins -NotePropertyValue @{} }
            if (-not $real.plugins.installs) { $real.plugins | Add-Member -NotePropertyName installs -NotePropertyValue @{} }
            foreach ($k in $tmp.plugins.installs.PSObject.Properties.Name) {
                $real.plugins.installs | Add-Member -NotePropertyName $k -NotePropertyValue $tmp.plugins.installs.$k -Force
            }
            $changed = $true
        }
        if ($tmp.plugins.entries) {
            if (-not $real.plugins) { $real | Add-Member -NotePropertyName plugins -NotePropertyValue @{} }
            if (-not $real.plugins.entries) { $real.plugins | Add-Member -NotePropertyName entries -NotePropertyValue @{} }
            foreach ($k in $tmp.plugins.entries.PSObject.Properties.Name) {
                $real.plugins.entries | Add-Member -NotePropertyName $k -NotePropertyValue $tmp.plugins.entries.$k -Force
            }
            $changed = $true
        }
        if ($tmp.plugins.allow) {
            if (-not $real.plugins) { $real | Add-Member -NotePropertyName plugins -NotePropertyValue @{} }
            if (-not $real.plugins.allow) { $real.plugins | Add-Member -NotePropertyName allow -NotePropertyValue @() }
            foreach ($id in $tmp.plugins.allow) {
                if ($real.plugins.allow -notcontains $id) { $real.plugins.allow += $id }
            }
            $changed = $true
        }
        # 同步 channels 配置（修复 Bash 版本的 bug）
        if ($tmp.channels) {
            if (-not $real.channels) { $real | Add-Member -NotePropertyName channels -NotePropertyValue @{} }
            foreach ($k in $tmp.channels.PSObject.Properties.Name) {
                $real.channels | Add-Member -NotePropertyName $k -NotePropertyValue $tmp.channels.$k -Force
            }
            $changed = $true
        }
        if ($changed) {
            $real | ConvertTo-Json -Depth 10 | Set-Content $CONFIG_FILE -Encoding UTF8
        }
    } catch {}
    Remove-Item $TEMP_CONFIG_FILE -ErrorAction SilentlyContinue
    $env:OPENCLAW_CONFIG_PATH = $null
    Write-Host "  [兼容] 已同步配置并清理临时副本"
    return $true
}

$BUILTIN_CONFLICT_IDS = @("qqbot", "openclaw-qq")

function Disable-BuiltinPlugins {
    $foundAny = $false
    foreach ($bid in $BUILTIN_CONFLICT_IDS) {
        if ($bid -eq $PLUGIN_ID) { continue }
        $changed = ""
        try {
            if (Test-Path $CONFIG_FILE) {
                $cfg = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
                $changes = @()
                if ($cfg.plugins.entries.$bid) {
                    $cfg.plugins.entries.$bid.enabled = $false
                    $changes += "entries"
                }
                if ($cfg.plugins.allow -and $cfg.plugins.allow -contains $bid) {
                    $cfg.plugins.allow = $cfg.plugins.allow | Where-Object { $_ -ne $bid }
                    $changes += "allow"
                }
                if ($cfg.plugins.installs.$bid) {
                    $cfg.plugins.installs.PSObject.Properties.Remove($bid)
                    $changes += "installs"
                }
                if ($changes.Count -gt 0) {
                    $cfg | ConvertTo-Json -Depth 10 | Set-Content $CONFIG_FILE -Encoding UTF8
                    $changed = $changes -join ","
                }
            }
        } catch {}
        if ($changed) {
            Write-Host "  [禁用内置] $bid：已修改 $changed"
            $foundAny = $true
        }
        $bidDir = Join-Path $EXTENSIONS_DIR $bid
        if (Test-Path $bidDir) {
            Remove-Item -Recurse -Force $bidDir -ErrorAction SilentlyContinue
            Write-Host "  [禁用内置] 已删除 extensions/$bid"
            $foundAny = $true
        }
    }
    if ($foundAny) {
        Write-Host "  ✅ 内置冲突插件已禁用"
    }
    return
}

function Verify-BuiltinDisabled {
    foreach ($bid in $BUILTIN_CONFLICT_IDS) {
        if ($bid -eq $PLUGIN_ID) { continue }
        try {
            if (Test-Path $CONFIG_FILE) {
                $cfg = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
                if ($cfg.plugins.entries.$bid.enabled) {
                    Write-Host "  ⚠️  内置插件 $bid 仍启用，再次禁用..."
                    $cfg.plugins.entries.$bid.enabled = $false
                    $cfg | ConvertTo-Json -Depth 10 | Set-Content $CONFIG_FILE -Encoding UTF8
                }
            }
        } catch {}
    }
}

$PACK_TMP_DIR = ""
$PACK_TGZ_FILE = ""

function Invoke-NpmPack {
    $script:PACK_TMP_DIR = Join-Path ([System.IO.Path]::GetTempPath()) "qqbot-pack-$([guid]::NewGuid().ToString('N').Substring(0,8))"
    New-Item -ItemType Directory -Path $script:PACK_TMP_DIR -Force | Out-Null
    $script:PACK_TGZ_FILE = ""

    $ok = $false
    foreach ($registry in $NPM_REGISTRIES) {
        $packDest = $script:PACK_TMP_DIR
        $packSrc = $INSTALL_SRC
        $packRegistry = $registry

        $result = Invoke-WithTimeout -TimeoutSecs $Timeout -Description "npm pack" -ScriptBlock {
            if ($using:packRegistry) {
                & npm pack $using:packSrc --pack-destination $using:packDest --registry $using:packRegistry
            } else {
                & npm pack $using:packSrc --pack-destination $using:packDest
            }
        }

        $tgz = Get-ChildItem -Path $script:PACK_TMP_DIR -Filter "*.tgz" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($tgz) {
            $ok = $true
            break
        }
    }

    if (-not $ok) {
        Write-Host "  ❌ npm pack 失败（所有 registry 均不可用）"
        if ($script:PACK_TMP_DIR -and (Test-Path $script:PACK_TMP_DIR)) {
            Remove-Item -Recurse -Force $script:PACK_TMP_DIR -ErrorAction SilentlyContinue
        }
        $script:PACK_TMP_DIR = ""
        return $false
    }

    $tgz = Get-ChildItem -Path $script:PACK_TMP_DIR -Filter "*.tgz" | Select-Object -First 1
    if (-not $tgz) {
        Write-Host "  ❌ 未找到 tgz 文件"
        if ($script:PACK_TMP_DIR -and (Test-Path $script:PACK_TMP_DIR)) {
            Remove-Item -Recurse -Force $script:PACK_TMP_DIR -ErrorAction SilentlyContinue
        }
        $script:PACK_TMP_DIR = ""
        return $false
    }

    $script:PACK_TGZ_FILE = $tgz.FullName
    Write-Host "    已下载：$(Split-Path $tgz.FullName -Leaf)"
    return $true
}

function Expand-NpmPack {
    if (-not $script:PACK_TGZ_FILE) { return $null }

    $extractDir = Join-Path ([System.IO.Path]::GetTempPath()) "qqbot-extract-$([guid]::NewGuid().ToString('N').Substring(0,8))"
    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

    try {
        & tar xzf $script:PACK_TGZ_FILE -C $extractDir 2>&1 | Out-Null
        $packageDir = Join-Path $extractDir "package"
        if (-not (Test-Path (Join-Path $packageDir "package.json"))) {
            Write-Host "  ❌ 解压后未找到 package.json"
            Remove-Item -Recurse -Force $extractDir -ErrorAction SilentlyContinue
            return $null
        }
        return $packageDir
    } catch {
        Write-Host "  ❌ 解压失败: $($_.Exception.Message)"
        Remove-Item -Recurse -Force $extractDir -ErrorAction SilentlyContinue
        return $null
    }
}

function Cleanup-Pack {
    if ($script:PACK_TMP_DIR -and (Test-Path $script:PACK_TMP_DIR)) {
        Remove-Item -Recurse -Force $script:PACK_TMP_DIR -ErrorAction SilentlyContinue
    }
    $script:PACK_TMP_DIR = ""
    $script:PACK_TGZ_FILE = ""
}

function Invoke-Level2Install {
    Write-Host ""
    Write-Host "  [Level 2] npm pack + openclaw install 本地目录"

    Write-Host "  [L2 1/3] 下载 tarball..."
    if (-not (Invoke-NpmPack)) { return $false }

    Write-Host "  [L2 2/3] 解压 tarball..."
    $packageDir = Expand-NpmPack
    if (-not $packageDir) {
        Cleanup-Pack
        return $false
    }
    Cleanup-Pack

    Write-Host "  [L2 3/3] 用 openclaw 安装本地目录..."
    $pkgDir = $packageDir
    $unsafeFlag = $FORCE_UNSAFE_FLAG
    $installOutput = Invoke-WithTimeout -TimeoutSecs $Timeout -Description "plugins install (local dir)" -ScriptBlock {
        if ($using:unsafeFlag) {
            & $using:CMD plugins install $using:pkgDir --pin $using:unsafeFlag
        } else {
            & $using:CMD plugins install $using:pkgDir --pin
        }
    }

    Remove-Item -Recurse -Force $packageDir -ErrorAction SilentlyContinue

    $targetDir = Join-Path $EXTENSIONS_DIR $PLUGIN_ID
    if (Test-Path (Join-Path $targetDir "package.json")) {
        Write-Host "  ✅ Level 2 安装成功"
        return $true
    }
    return $false
}

$INSTALL_COMPLETED = $false
$BACKUP_DIR = ""
$TEMP_CONFIG_FILE = ""
$STAGING_DIR = ""

function Rollback-PluginDir {
    param([string]$Reason)
    if ($BACKUP_DIR -and (Test-Path (Join-Path $BACKUP_DIR $PLUGIN_ID))) {
        $targetDir = Join-Path $EXTENSIONS_DIR $PLUGIN_ID
        if (Test-Path $targetDir) { Remove-Item -Recurse -Force $targetDir -ErrorAction SilentlyContinue }
        Copy-Item -Path (Join-Path $BACKUP_DIR $PLUGIN_ID) -Destination $targetDir -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path (Join-Path $targetDir "package.json")) {
            $ver = Read-PkgVersion -PkgPath (Join-Path $targetDir "package.json")
            Write-Host "  ↩️  已回滚到旧版本 v$ver（原因：$Reason）"
        }
    }
}

function Cleanup-OnExit {
    $exitCode = $LASTEXITCODE
    if ($INSTALL_COMPLETED -ne $true -and $exitCode -ne 0) {
        $reason = "异常退出 (code=$exitCode)"
        Restore-ConfigSnapshot
        if ($BACKUP_DIR -and (Test-Path $BACKUP_DIR)) {
            $targetDir = Join-Path $EXTENSIONS_DIR $PLUGIN_ID
            if (Test-Path (Join-Path $BACKUP_DIR $PLUGIN_ID)) {
                if (Test-Path $targetDir) { Remove-Item -Recurse -Force $targetDir -ErrorAction SilentlyContinue }
                Copy-Item -Path (Join-Path $BACKUP_DIR $PLUGIN_ID) -Destination $targetDir -Recurse -Force -ErrorAction SilentlyContinue
                Write-Host "  ↩️  已回滚到旧版本（原因: ${reason}）"
            }
        }
    }
    if ($TEMP_CONFIG_FILE -and (Test-Path $TEMP_CONFIG_FILE)) { Remove-Item $TEMP_CONFIG_FILE -ErrorAction SilentlyContinue }
    if ($BACKUP_DIR -and (Test-Path $BACKUP_DIR)) { Remove-Item -Recurse -Force $BACKUP_DIR -ErrorAction SilentlyContinue }
    Restore-ReloadMode
    Cleanup-ConfigSnapshot
    if ($env:OPENCLAW_CONFIG_PATH) { Remove-Item $env:OPENCLAW_CONFIG_PATH -ErrorAction SilentlyContinue; $env:OPENCLAW_CONFIG_PATH = $null }
    # 清理本次安装创建的 staging 目录（排除安装前已存在的）
    if (Test-Path $EXTENSIONS_DIR) {
        Get-ChildItem -Path $EXTENSIONS_DIR -Filter ".openclaw-install-stage-*" -Directory -ErrorAction SilentlyContinue | 
            Where-Object { $_.FullName -notin $PRE_EXISTING_STAGING } |
            Remove-Item -Recurse -Force
    }
    Release-UpgradeLock
    exit $exitCode
}

Acquire-UpgradeLock
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { Cleanup-OnExit } | Out-Null

# 记录安装前已存在的 staging 目录，避免误删其他进程的
$PRE_EXISTING_STAGING = @()
if (Test-Path $EXTENSIONS_DIR) {
    $PRE_EXISTING_STAGING = Get-ChildItem -Path $EXTENSIONS_DIR -Filter ".openclaw-install-stage-*" -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
}

$OPENCLAW_VERSION = ""
try {
    $versionOutput = & $CMD --version 2>&1
    if ($versionOutput -match '([0-9]+\.[0-9]+(?:\.[0-9]+)?)') {
        $OPENCLAW_VERSION = $Matches[1]
    }
} catch {}

$FORCE_UNSAFE_FLAG = ""
if ($OPENCLAW_VERSION -and (Test-VersionGte -Version1 $OPENCLAW_VERSION -Version2 "2026.3.30")) {
    $FORCE_UNSAFE_FLAG = "--dangerously-force-unsafe-install"
}

$OLD_VERSION = ""
$targetDir = Join-Path $EXTENSIONS_DIR $PLUGIN_ID
$oldPkg = Join-Path $targetDir "package.json"
if (Test-Path $oldPkg) {
    $OLD_VERSION = Read-PkgVersion -PkgPath $oldPkg
}

Write-Host "==========================================="
Write-Host "  qqbot 升级：$INSTALL_SRC"
Write-Host "  openclaw: v$OPENCLAW_VERSION"
Write-Host "  隔离：$(if ($_UPGRADE_ISOLATED) { '✓' } else { '✗' })  超时：${Timeout}s"
Write-Host "==========================================="
if ($OLD_VERSION) { Write-Host "  当前版本：$OLD_VERSION" }

Write-Host ""
Write-Host "[前置] 检查并禁用内置冲突插件..."
if ($DisableBuiltin) {
    Disable-BuiltinPlugins
} else {
    Write-Host "  ℹ  跳过禁用内置冲突插件"
}

Snapshot-Config

$PREV_RELOAD_MODE = ""
try {
    if (Test-Path $CONFIG_FILE) {
        $cfg = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
        if ($cfg.gateway.reload.mode) { $PREV_RELOAD_MODE = $cfg.gateway.reload.mode }
    }
} catch {}
try { & $CMD config set gateway.reload.mode hot 2>&1 | Out-Null } catch {}

Write-Host ""
Write-Host "[1/4] 安装/升级插件..."
Setup-TempConfig

$targetDir = Join-Path $EXTENSIONS_DIR $PLUGIN_ID
$oldPkg = Join-Path $targetDir "package.json"
$hasPluginDir = (Test-Path $targetDir) -and (Test-Path $oldPkg)
$hasInstallRecord = $false

if (Test-Path $CONFIG_FILE) {
    try {
        $cfg = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
        if ($cfg.plugins.installs.$PLUGIN_ID) { $hasInstallRecord = $true }
    } catch {}
}

$useUpdate = $false
if ($hasInstallRecord -and $hasPluginDir -and -not $Version) {
    if ($FORCE_UNSAFE_FLAG) {
        Write-Host "  [检测] 配置 ✓ | 目录 ✓ | openclaw ≥3.30 → 跳过 update，直接 install（安全扫描兼容）"
    } else {
        $useUpdate = $true
    }
} elseif ($hasPluginDir) {
    Write-Host "  [检测] 目录 ✓ | 指定版本或无配置记录 → reinstall"
} else {
    Write-Host "  [检测] 目录 ✗ → 全新安装"
}

$UPGRADE_OK = $false

if ($useUpdate) {
    $updateTimeout = [Math]::Min($Timeout, 180)
    $updateOutput = Invoke-WithTimeout -TimeoutSecs $updateTimeout -Description "plugins update" -ScriptBlock {
        & $using:CMD plugins update $using:PLUGIN_ID
    }
    if (Test-Path $oldPkg) {
        $postVer = Read-PkgVersion -PkgPath $oldPkg
        if ($postVer -and $postVer -ne $OLD_VERSION) {
            $UPGRADE_OK = $true
        } elseif (-not $OLD_VERSION) {
            $UPGRADE_OK = $true
        }
    }
}

if (-not $UPGRADE_OK) {
    if ($hasPluginDir) {
        $BACKUP_DIR = Join-Path ([System.IO.Path]::GetTempPath()) "qqbot-upgrade-backup-$([guid]::NewGuid().ToString('N').Substring(0,8))"
        New-Item -ItemType Directory -Path $BACKUP_DIR -Force | Out-Null
        Copy-Item -Path $targetDir -Destination (Join-Path $BACKUP_DIR $PLUGIN_ID) -Recurse -Force
    }

    foreach ($legacyName in @("qqbot", "openclaw-qq")) {
        $legacyDir = Join-Path $EXTENSIONS_DIR $legacyName
        if (Test-Path $legacyDir) { Remove-Item -Recurse -Force $legacyDir }
    }

    if (Test-Path $targetDir) { Remove-Item -Recurse -Force $targetDir }

    if (Test-Path $CONFIG_FILE) {
        try {
            $cfg = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
            if ($cfg.plugins.installs.$PLUGIN_ID) { $cfg.plugins.installs.PSObject.Properties.Remove($PLUGIN_ID) }
            if ($cfg.plugins.entries.$PLUGIN_ID) { $cfg.plugins.entries.PSObject.Properties.Remove($PLUGIN_ID) }
            if ($cfg.plugins.allow -and $cfg.plugins.allow -contains $PLUGIN_ID) {
                $cfg.plugins.allow = $cfg.plugins.allow | Where-Object { $_ -ne $PLUGIN_ID }
            }
            $cfg | ConvertTo-Json -Depth 10 | Set-Content $CONFIG_FILE -Encoding UTF8
        } catch {}
    }

    $installOutput = Invoke-WithTimeout -TimeoutSecs $Timeout -Description "plugins install" -ScriptBlock {
        & $using:CMD plugins install $using:INSTALL_SRC --pin $using:FORCE_UNSAFE_FLAG
    }

    if (-not (Test-Path (Join-Path (Join-Path $EXTENSIONS_DIR $PLUGIN_ID) "package.json"))) {
        $level2Result = Invoke-Level2Install
        if (-not $level2Result) {
            Rollback-PluginDir "安装失败"
            Restore-ConfigSnapshot
            Sync-TempConfig
            Write-Host "QQBOT_NEW_VERSION=unknown"
            Write-Host "QQBOT_REPORT=❌ QQBot 安装失败（已回滚），请检查网络"
            exit 1
        }
    }
}

Sync-TempConfig
Cleanup-ConfigSnapshot
$INSTALL_COMPLETED = $true
# 清理本次安装创建的 staging 目录（排除安装前已存在的）
if (Test-Path $EXTENSIONS_DIR) {
    Get-ChildItem -Path $EXTENSIONS_DIR -Filter ".openclaw-install-stage-*" -Directory -ErrorAction SilentlyContinue | 
        Where-Object { $_.FullName -notin $PRE_EXISTING_STAGING } |
        Remove-Item -Recurse -Force
}

$targetDir = Join-Path $EXTENSIONS_DIR $PLUGIN_ID
$NEW_VERSION = ""
if (Test-Path (Join-Path $targetDir "package.json")) {
    $NEW_VERSION = Read-PkgVersion -PkgPath (Join-Path $targetDir "package.json")
}

$PreflightOK = $true
if (-not $NEW_VERSION) {
    Write-Host "  ❌ 无法读取版本号"
    $PreflightOK = $false
} else {
    Write-Host "  ✅ 版本：$NEW_VERSION"
}

$ENTRY = ""
foreach ($f in @("dist/index.js", "index.js")) {
    if (Test-Path (Join-Path $targetDir $f)) { $ENTRY = $f; break }
}
if (-not $ENTRY) {
    Write-Host "  ❌ 缺少入口文件"
    $PreflightOK = $false
} else {
    Write-Host "  ✅ 入口：$ENTRY"
}

if (Test-Path (Join-Path $targetDir "dist\src")) {
    $jsCount = (Get-ChildItem -Path (Join-Path $targetDir "dist\src") -Filter "*.js" -File -ErrorAction SilentlyContinue | Measure-Object).Count
    Write-Host "  ✅ dist/src/ 含 ${jsCount} 个 JS"
    if ($jsCount -lt 5) { $PreflightOK = $false }
} else {
    Write-Host "  ❌ 缺少 dist/src/"
    $PreflightOK = $false
}

$MISS = @()
foreach ($m in @("dist/src/gateway.js", "dist/src/api.js", "dist/src/admin-resolver.js")) {
    if (-not (Test-Path (Join-Path $targetDir $m))) { $MISS += $m }
}
if ($MISS.Count -gt 0) {
    Write-Host "  ❌ 缺少：$($MISS -join ', ')"
    $PreflightOK = $false
} else {
    Write-Host "  ✅ 关键模块完整"
}

if (Test-Path (Join-Path $targetDir "node_modules")) {
    $BOK = $true
    foreach ($dep in @("ws", "silk-wasm")) {
        if (-not (Test-Path (Join-Path $targetDir "node_modules\$dep"))) {
            Write-Host "  ⚠️  缺失：$dep"
            $BOK = $false
        }
    }
    if ($BOK) { Write-Host "  ✅ bundled 依赖完整" }
}

if ($PreflightOK -ne $true) {
    Write-Host ""
    Write-Host "❌ 验证未通过"
    Write-Host "QQBOT_NEW_VERSION=unknown"
    Write-Host "QQBOT_REPORT=⚠️ 验证未通过"
    exit 1
}
Write-Host "  ✅ 验证全部通过"

Write-Host ""
Write-Host "  [健康检查] 确认插件注册..."
$plistOutput = Invoke-WithTimeout -TimeoutSecs 20 -Description "plugins list" -ScriptBlock {
    & $using:CMD plugins list
}
if ($plistOutput -and $plistOutput -match $PLUGIN_ID) {
    Write-Host "  ✅ 插件已注册"
} else {
    Write-Host "  ⚠️  未在 plugins list 中找到（重启后可能自动修复）"
}

Verify-BuiltinDisabled

$postinstallScript = Join-Path (Join-Path $targetDir "scripts") "postinstall-link-sdk.js"
if (Test-Path $postinstallScript) {
    try {
        Push-Location $targetDir
        & node $postinstallScript 2>&1
        Pop-Location
    } catch {
        try { Pop-Location } catch {}
    }
}

Write-Host ""
Write-Host "[3/4] 升级结果..."
Write-Host "QQBOT_NEW_VERSION=${NEW_VERSION:-unknown}"
if ($NEW_VERSION -and $NEW_VERSION -ne "unknown") {
    Write-Host "QQBOT_REPORT=✅ QQBot 升级完成：v${NEW_VERSION}"
} else {
    Write-Host "QQBOT_REPORT=⚠️ 无法确认新版本"
}

Write-Host ""
Write-Host "==========================================="
Write-Host "  ✅ 安装完成"
Write-Host "==========================================="

if ($NoRestart) {
    Write-Host ""
    Write-Host "[跳过重启] --NoRestart 已指定"
    exit 0
}

if ($AppId -and $Secret) {
    Write-Host ""
    Write-Host "[配置] 写入 qqbot 通道配置..."
    $DESIRED_TOKEN = "${AppId}:${Secret}"
    $current = ""
    if (Test-Path $CONFIG_FILE) {
        try {
            $cfg = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
            foreach ($k in @("qqbot", "openclaw-qqbot", "openclaw-qq")) {
                if ($cfg.channels.$k) {
                    if ($cfg.channels.$k.token) { $current = $cfg.channels.$k.token; break }
                    if ($cfg.channels.$k.appId -and $cfg.channels.$k.clientSecret) {
                        $current = "$($cfg.channels.$k.appId):$($cfg.channels.$k.clientSecret)"; break
                    }
                }
            }
        } catch {}
    }

    if ($current -eq $DESIRED_TOKEN) {
        Write-Host "  ✅ 配置已是目标值"
    } elseif (Test-Path $CONFIG_FILE) {
        try {
            $cfg = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
            if (-not $cfg.channels) { $cfg | Add-Member -NotePropertyName channels -NotePropertyValue @{} }
            if (-not $cfg.channels.qqbot) { $cfg.channels | Add-Member -NotePropertyName qqbot -NotePropertyValue @{} }
            $cfg.channels.qqbot | Add-Member -NotePropertyName appId -NotePropertyValue $AppId -Force
            $cfg.channels.qqbot | Add-Member -NotePropertyName clientSecret -NotePropertyValue $Secret -Force
            $cfg | ConvertTo-Json -Depth 10 | Set-Content $CONFIG_FILE -Encoding UTF8
            Write-Host "  ✅ 通道配置写入成功"
        } catch {
            Write-Host "  ❌ 写入失败，请手动编辑 $CONFIG_FILE"
        }
    }
} elseif ($AppId -or $Secret) {
    Write-Host ""
    Write-Host "⚠️  --appid 和 --secret 必须同时提供"
} else {
    Write-Host "  ℹ  未提供 appid/secret，跳过配置写入，请在完成后使用命令创建通道" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "[4/4] 重启 gateway..."

Write-Host "  正在删除 gateway.reload.mode 配置（恢复自动重载）..." -ForegroundColor Cyan
try { & $CMD config unset gateway.reload.mode 2>&1 | Out-Null } catch {}
Write-Host "  ✓ 已删除配置项，gateway 将自动重载配置变更" -ForegroundColor Green

if ($NEW_VERSION -and $NEW_VERSION -ne "unknown") {
    $MarkerDir = Join-Path $OPENCLAW_HOME "qqbot\data"
    if (-not (Test-Path $MarkerDir)) { New-Item -ItemType Directory -Path $MarkerDir -Force | Out-Null }
    $MarkerFile = Join-Path $MarkerDir "startup-marker.json"
    $Now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    @{ version = $NEW_VERSION; startedAt = $Now; greetedAt = $Now } | ConvertTo-Json -Compress | Set-Content $MarkerFile -Encoding UTF8
}

$GW_RC = 0
$restartOutput = Invoke-WithTimeout -TimeoutSecs 90 -Description "gateway restart" -ScriptBlock {
    & $using:CMD gateway restart
}

if ($restartOutput) {
    Write-Host "  ✅ gateway 已重启"
    if ($NEW_VERSION -and $NEW_VERSION -ne "unknown") {
        Write-Host ""
        Write-Host "🎉 QQBot 插件已更新至 v${NEW_VERSION}，在线等候你的吩咐。"
    }
} else {
    Write-Host "  ⚠️  重启失败，尝试 doctor --fix..."

    $preDoctorBak = ""
    if (Test-Path $CONFIG_FILE) {
        $preDoctorBak = Join-Path ([System.IO.Path]::GetTempPath()) ".qqbot-pre-doctor-$([guid]::NewGuid().ToString('N').Substring(0,8)).json"
        Copy-Item -Path $CONFIG_FILE -Destination $preDoctorBak -Force
    }

    $doctorOutput = Invoke-WithTimeout -TimeoutSecs 30 -Description "doctor --fix" -ScriptBlock {
        & $using:CMD doctor --fix
    }

    if ($preDoctorBak -and (Test-Path $CONFIG_FILE)) {
        try {
            $before = Get-Content $preDoctorBak -Raw | ConvertFrom-Json
            $after = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
            $damaged = $null
            if ($before.channels.qqbot -and -not $after.channels.qqbot) { $damaged = "channels.qqbot" }
            elseif ($before.plugins.installs.$PLUGIN_ID -and -not $after.plugins.installs.$PLUGIN_ID) { $damaged = "installs" }
            elseif ($before.plugins.entries.$PLUGIN_ID -and -not $after.plugins.entries.$PLUGIN_ID) { $damaged = "entries" }
            if ($damaged) {
                Write-Host "  ⚠️  doctor 误删 $damaged，恢复中..."
                Copy-Item -Path $preDoctorBak -Destination $CONFIG_FILE -Force
                Write-Host "  ✅ 已恢复"
            }
        } catch {}
        Remove-Item $preDoctorBak -ErrorAction SilentlyContinue
    }

    Write-Host ""
    Write-Host "  [重试] gateway restart..."
    $retryOutput = Invoke-WithTimeout -TimeoutSecs 90 -Description "gateway restart (重试)" -ScriptBlock {
        & $using:CMD gateway restart
    }
    if ($retryOutput) {
        Write-Host "  ✅ 重启成功"
        if ($NEW_VERSION -and $NEW_VERSION -ne "unknown") {
            Write-Host ""
            Write-Host "🎉 QQBot 插件已更新至 v${NEW_VERSION}，在线等候你的吩咐。"
        }
    } else {
        Write-Host "  ❌ 仍无法重启，请手动排查:"
        Write-Host "    $CMD doctor; $CMD gateway restart"
    }
}

Release-UpgradeLock

