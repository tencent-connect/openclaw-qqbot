#!/bin/bash

# qqbot 通过 openclaw 原生插件指令升级（v4）
#
# 两级降级策略：
#   Level 1: openclaw plugins install/update（原生命令，经 ClawHub → npm）
#   Level 2: npm pack 下载 + 解压 + openclaw plugins install <本地目录>（绕过 ClawHub + 安全扫描 bug，保留原子部署）
#   全部失败 → 回滚到用户原有版本
#
# 用法:
#   upgrade-via-npm.sh                                    # 升级到 latest
#   upgrade-via-npm.sh --version <version>                # 升级到指定版本
#   upgrade-via-npm.sh --self-version                     # 升级到当前仓库 package.json 版本
#   upgrade-via-npm.sh --appid <appid> --secret <secret>  # 首次安装时配置 appid/secret
#   upgrade-via-npm.sh --no-restart                       # 只做文件替换，不重启 gateway
#   upgrade-via-npm.sh --timeout 600                      # 自定义安装超时时间（秒）

set -eo pipefail

# 忽略 SIGTERM：gateway restart 时可能向进程组发送 SIGTERM，不能让它中断升级
trap 'echo "  ⚠️  收到 SIGTERM，已忽略（升级进行中）"' SIGTERM

# ============================================================================
#  进程隔离 — 脱离 gateway 进程组
# ============================================================================
if [ -z "$_UPGRADE_ISOLATED" ] && [ -f "$0" ] && command -v setsid &>/dev/null; then
    export _UPGRADE_ISOLATED=1
    exec setsid "$0" "$@"
fi

# ============================================================================
#  环境准备
# ============================================================================
_SCRIPT_START_MS="$(node -e "process.stdout.write(String(Date.now()))" 2>/dev/null || echo "$(date +%s)000")"

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || SCRIPT_DIR=""
PROJECT_DIR=""
[ -n "$SCRIPT_DIR" ] && PROJECT_DIR="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)" || true

cd "$HOME" 2>/dev/null || cd / 2>/dev/null || true

ensure_valid_cwd() {
    stat . &>/dev/null 2>&1 || cd "$HOME" 2>/dev/null || cd / 2>/dev/null || true
}

read_pkg_version() {
    node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync('$1','utf8')).version||'')}catch{}" 2>/dev/null || true
}

version_gte() {
    [ "$(printf '%s\n' "$1" "$2" | sort -V | head -1)" = "$2" ]
}

for _p in /usr/local/bin /usr/local/sbin /usr/bin /usr/sbin /bin /sbin; do
    case ":$PATH:" in *":$_p:"*) ;; *) [ -d "$_p" ] && export PATH="$PATH:$_p" ;; esac
done
[ -z "$npm_config_registry" ] && export npm_config_registry="https://registry.npmjs.org"

NPM_REGISTRIES="https://registry.npmjs.org/ https://mirrors.cloud.tencent.com/npm/"

# ============================================================================
#  CLS 日志上报（腾讯云日志服务）
# ============================================================================
CLS_HOST="ap-guangzhou.cls.tencentcs.com"
CLS_TOPIC_ID="${CLS_TOPIC_ID:-845a0802-ec56-49a0-afa0-fe686b0a16f2}"
CLS_ENABLED="${CLS_ENABLED:-true}"

# 静态字段（全局变量，启动时采集一次）
_STATIC_FIELDS=""
_SESSION_ID=""

# 采集静态字段（只执行一次）
init_track_log() {
    [ "$CLS_ENABLED" != "true" ] && return 0
    [ -n "$_STATIC_FIELDS" ] && return 0  # 已初始化
    
    _SESSION_ID="$(node -e "try{process.stdout.write(require('crypto').randomUUID())}catch{process.stdout.write(Date.now().toString())}" 2>/dev/null || echo "$$-$(date +%s)")"
    
    local node_ver="${NODE_VERSION:-$(node --version 2>/dev/null || echo "")}"
    local os_type="$(uname -s 2>/dev/null || echo "unknown")"
    
    # 构造静态字段 JSON（转义处理）
    _STATIC_FIELDS=$(node -e "
      const fields = {
        session_id: '$_SESSION_ID',
        script_version: 'v4',
        node_version: '$node_ver',
        os: '$os_type'
      };
      process.stdout.write(JSON.stringify(fields));
    " 2>/dev/null || echo "{}")
}

# 上报日志到 CLS
# 用法: track_log <event> <result> <log_message> [extra_key1=val1] [extra_key2=val2] ...
track_log() {
    [ "$CLS_ENABLED" != "true" ] && return 0
    [ -z "$CLS_TOPIC_ID" ] && return 0
    
    local event="$1"
    local result="$2"
    local log_msg="$3"
    shift 3
    
    # 确保静态字段已初始化
    [ -z "$_STATIC_FIELDS" ] && init_track_log
    
    # 计算耗时（毫秒）
    local _now_ms="$(node -e "process.stdout.write(String(Date.now()))" 2>/dev/null || echo "$(date +%s)000")"
    local _elapsed_ms="$(( _now_ms - _SCRIPT_START_MS ))"
    
    # 构造额外字段
    local extra_fields=",\"elapsed_ms\":\"$_elapsed_ms\""
    for arg in "$@"; do
        if [[ "$arg" == *=* ]]; then
            local key="${arg%%=*}"
            local val="${arg#*=}"
            extra_fields="$extra_fields,\"$key\":\"$val\""
        fi
    done
    
    # 后台异步上报（不阻塞主流程）
    (
        node -e "
          (() => {
            try {
              const https = require('https');
              const staticFields = $_STATIC_FIELDS;
              const contents = {
                ...staticFields,
                event: '$event',
                result: '$result',
                log: $(node -e "process.stdout.write(JSON.stringify('$log_msg'))" 2>/dev/null || echo "'$log_msg'"),
                openclaw_version: '${OPENCLAW_VERSION:-}',
                old_version: '${OLD_VERSION:-}',
                new_version: '${NEW_VERSION:-}',
                target_version: '${TARGET_VERSION:-}'$extra_fields
              };
              
              const body = JSON.stringify({
                logs: [{
                  contents: contents,
                  time: Math.floor(Date.now() / 1000)
                }],
                source: 'qqbot-upgrade-script'
              });
              
              const req = https.request({
                hostname: '$CLS_HOST',
                path: '/tracklog?topic_id=$CLS_TOPIC_ID',
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(body)
                },
                timeout: 5000
              }, (res) => { res.resume(); });
              
              req.on('error', () => {});
              req.on('timeout', () => req.destroy());
              req.end(body);
            } catch {}
          })();
        " 2>/dev/null
    ) &
}

# 封装 echo：同时输出到终端 + 上报 CLS
# 用法: log <message>                        → event=log, result=info
#        log <event> <result> <message>       → 自定义 event/result
#        log <event> <result> <message> k=v   → 带额外字段
log() {
    if [ $# -eq 1 ]; then
        echo "$1"
        track_log "log" "info" "$1"
    elif [ $# -ge 3 ]; then
        local _event="$1" _result="$2" _msg="$3"
        shift 3
        echo "$_msg"
        track_log "$_event" "$_result" "$_msg" "$@"
    else
        # 2 个参数：当普通 echo，不上报
        echo "$@"
    fi
}

# ============================================================================
#  超时执行包装器（兼容 macOS 无 GNU timeout）
# ============================================================================
run_with_timeout() {
    local timeout_secs="$1" description="$2"; shift 2

    if command -v timeout &>/dev/null; then
        timeout --kill-after=10 "$timeout_secs" "$@" && return 0
        local rc=$?
        # GNU coreutils timeout 超时返回 124；uutils coreutils 返回 125
        if [ $rc -eq 124 ] || [ $rc -eq 125 ]; then
            echo "  ⏰ ${description} 超时 (${timeout_secs}s)"
            return 124  # 统一返回 124 表示超时
        fi
        return $rc
    fi

    # macOS fallback
    "$@" &
    local cmd_pid=$!
    ( sleep "$timeout_secs" 2>/dev/null
      kill -0 "$cmd_pid" 2>/dev/null && echo "  ⏰ ${description} 超时 (${timeout_secs}s)，终止中..." && \
          kill -TERM "$cmd_pid" 2>/dev/null && sleep 5 && \
          kill -0 "$cmd_pid" 2>/dev/null && kill -KILL "$cmd_pid" 2>/dev/null
    ) &
    local wd=$!; disown "$wd" 2>/dev/null || true
    wait "$cmd_pid" 2>/dev/null; local rc=$?
    kill "$wd" 2>/dev/null || true; wait "$wd" 2>/dev/null 2>&1 || true
    [ $rc -eq 143 ] || [ $rc -eq 137 ] && return 124
    return $rc
}

# ============================================================================
#  配置快照 / 回滚
# ============================================================================
CONFIG_SNAPSHOT_FILE=""

snapshot_config() {
    [ -f "$CONFIG_FILE" ] || return 0
    CONFIG_SNAPSHOT_FILE="$(mktemp "${TMPDIR:-/tmp}/.qqbot-config-snapshot-XXXXXX")"
    cp -a "$CONFIG_FILE" "$CONFIG_SNAPSHOT_FILE"
    echo "  [快照] 已保存配置快照"
}

restore_config_snapshot() {
    [ -n "$CONFIG_SNAPSHOT_FILE" ] && [ -f "$CONFIG_SNAPSHOT_FILE" ] && [ -n "$CONFIG_FILE" ] && \
        cp -a "$CONFIG_SNAPSHOT_FILE" "$CONFIG_FILE" && echo "  ↩️  已恢复配置到安装前状态"
    return 0
}

cleanup_config_snapshot() {
    [ -n "$CONFIG_SNAPSHOT_FILE" ] && rm -f "$CONFIG_SNAPSHOT_FILE" 2>/dev/null || true
}

# _PREV_RELOAD_MODE: 安装前读取的原始值
#   非空 → config set 恢复；空（配置中本无此项）→ config unset 删除我们写入的值
_PREV_RELOAD_MODE=""
restore_reload_mode() {
    if [ -n "$_PREV_RELOAD_MODE" ]; then
        openclaw config set gateway.reload.mode "$_PREV_RELOAD_MODE" 2>/dev/null || true
    else
        openclaw config unset gateway.reload.mode 2>/dev/null || true
    fi
    _PREV_RELOAD_MODE=""   # 防止重复执行
}

rollback_plugin_dir() {
    local reason="${1:-未知原因}"
    log "rollback" "start" "  开始回滚..." "reason=$reason"
    if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR/$PLUGIN_ID" ]; then
        rm -rf "$EXTENSIONS_DIR/$PLUGIN_ID" 2>/dev/null || true
        mv "$BACKUP_DIR/$PLUGIN_ID" "$EXTENSIONS_DIR/$PLUGIN_ID" 2>/dev/null || \
            cp -a "$BACKUP_DIR/$PLUGIN_ID" "$EXTENSIONS_DIR/$PLUGIN_ID" 2>/dev/null || true
        if [ -f "$EXTENSIONS_DIR/$PLUGIN_ID/package.json" ]; then
            local rollback_ver="$(read_pkg_version "$EXTENSIONS_DIR/$PLUGIN_ID/package.json")"
            log "rollback" "success" "  ↩️  已回滚到旧版本 v${rollback_ver}（原因: ${reason}）" "rollback_version=$rollback_ver"
            return 0
        fi
        log "rollback" "fail" "  ❌ 回滚后插件目录仍不完整！"
        return 1
    fi
    log "rollback" "fail" "  ⚠️  无备份可回滚（原因: ${reason}）" "reason=$reason"
    return 1
}

# ============================================================================
#  升级锁
# ============================================================================
UPGRADE_LOCK_FILE=""

acquire_upgrade_lock() {
    [ -z "$UPGRADE_LOCK_FILE" ] && return 0
    if [ -f "$UPGRADE_LOCK_FILE" ]; then
        local lock_pid="$(cat "$UPGRADE_LOCK_FILE" 2>/dev/null || true)"
        if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
            log "lock_conflict" "fail" "❌ 另一个升级进程正在运行 (PID: $lock_pid)" "lock_pid=$lock_pid"; exit 1
        fi
        rm -f "$UPGRADE_LOCK_FILE" 2>/dev/null || true
    fi
    echo "$$" > "$UPGRADE_LOCK_FILE"
}

release_upgrade_lock() {
    [ -n "$UPGRADE_LOCK_FILE" ] && rm -f "$UPGRADE_LOCK_FILE" 2>/dev/null || true
}

# ============================================================================
#  临时配置副本（绕过 openclaw 3.23+ 配置校验）
# ============================================================================
setup_temp_config() {
    [ -f "$CONFIG_FILE" ] || return 0
    local need_temp
    need_temp="$(node -e "
      try {
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
        if (cfg.channels?.qqbot || cfg.plugins?.allow?.includes('$PLUGIN_ID') || cfg.plugins?.entries?.['$PLUGIN_ID'])
          process.stdout.write('1');
      } catch {}
    " 2>/dev/null || true)"
    [ "$need_temp" != "1" ] && return 0

    # 临时配置必须放在 $OPENCLAW_HOME 下，避免 openclaw ≥2026.4.9 将其父目录当作 CONFIG_DIR
    # （2026-04-07 新增逻辑：OPENCLAW_CONFIG_PATH 的 dirname 会被用作 CONFIG_DIR）
    TEMP_CONFIG_FILE="$(mktemp "$OPENCLAW_HOME/.qqbot-temp-config-XXXXXX")"
    if node -e "
      const fs = require('fs');
      const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
      delete cfg.channels?.qqbot;
      cfg.channels && Object.keys(cfg.channels).length === 0 && delete cfg.channels;
      if (Array.isArray(cfg.plugins?.allow)) {
        cfg.plugins.allow = cfg.plugins.allow.filter(p => p !== '$PLUGIN_ID');
        cfg.plugins.allow.length === 0 && delete cfg.plugins.allow;
      }
      delete cfg.plugins?.entries?.['$PLUGIN_ID'];
      cfg.plugins?.entries && Object.keys(cfg.plugins.entries).length === 0 && delete cfg.plugins.entries;
      fs.writeFileSync('$TEMP_CONFIG_FILE', JSON.stringify(cfg, null, 4) + '\n');
    " 2>/dev/null; then
        log "temp_config" "success" "  [兼容] 创建临时配置副本以通过 3.23+ 配置校验"
        export OPENCLAW_CONFIG_PATH="$TEMP_CONFIG_FILE"
    else
        log "temp_config" "fail" "  ⚠️  创建临时配置失败，继续使用原配置"
        rm -f "$TEMP_CONFIG_FILE" 2>/dev/null || true; TEMP_CONFIG_FILE=""
    fi
}

sync_temp_config() {
    [ -n "$TEMP_CONFIG_FILE" ] && [ -f "$TEMP_CONFIG_FILE" ] || return 0
    if [ ! -f "$EXTENSIONS_DIR/$PLUGIN_ID/package.json" ]; then
        echo "  ⚠️  插件目录不完整，跳过配置同步"
        rm -f "$TEMP_CONFIG_FILE"; unset OPENCLAW_CONFIG_PATH; return 1
    fi
    ensure_valid_cwd
    node -e "
      const fs = require('fs');
      const tmp = JSON.parse(fs.readFileSync('$TEMP_CONFIG_FILE', 'utf8'));
      const real = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
      let c = false;
      if (tmp.plugins?.installs) { (real.plugins ??= {}).installs = { ...real.plugins.installs, ...tmp.plugins.installs }; c = true; }
      if (tmp.plugins?.entries) { (real.plugins ??= {}).entries = { ...real.plugins.entries, ...tmp.plugins.entries }; c = true; }
      for (const id of tmp.plugins?.allow || []) {
        if (!(real.plugins ??= {}).allow) real.plugins.allow = [];
        if (!real.plugins.allow.includes(id)) { real.plugins.allow.push(id); c = true; }
      }
      if (c) fs.writeFileSync('$CONFIG_FILE', JSON.stringify(real, null, 4) + '\n');
    " 2>/dev/null || true
    rm -f "$TEMP_CONFIG_FILE"; unset OPENCLAW_CONFIG_PATH
    echo "  [兼容] 已同步配置并清理临时副本"
}

# ============================================================================
#  npm pack 下载 tarball（供 Level 2 使用）
#  成功后设置 PACK_TGZ_FILE 变量指向 tgz 文件路径
# ============================================================================
PACK_TMP_DIR=""
PACK_TGZ_FILE=""

npm_pack_download() {
    for _cmd in npm tar node; do
        command -v "$_cmd" &>/dev/null || { echo "  ❌ $_cmd 不可用"; return 1; }
    done

    PACK_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/.qqbot-pack-XXXXXX")"
    PACK_TGZ_FILE=""
    local ok=false
    ensure_valid_cwd
    for registry in $NPM_REGISTRIES; do
        echo "    尝试 registry: $registry"
        if run_with_timeout "$INSTALL_TIMEOUT" "npm pack" npm pack "$INSTALL_SRC" \
                --pack-destination "$PACK_TMP_DIR" --registry "$registry" 2>&1; then
            ok=true; break
        fi
    done
    if [ "$ok" != "true" ]; then
        log "npm_pack" "fail" "  ❌ npm pack 失败（所有 registry 均不可用）"
        rm -rf "$PACK_TMP_DIR" 2>/dev/null; PACK_TMP_DIR=""; return 1
    fi
    PACK_TGZ_FILE="$(find "$PACK_TMP_DIR" -maxdepth 1 -name '*.tgz' -type f | head -1)"
    if [ -z "$PACK_TGZ_FILE" ]; then
        log "npm_pack" "fail" "  ❌ 未找到 tgz 文件"
        rm -rf "$PACK_TMP_DIR" 2>/dev/null; PACK_TMP_DIR=""; return 1
    fi
    log "npm_pack" "success" "    已下载: $(basename "$PACK_TGZ_FILE")"
    return 0
}

cleanup_pack() {
    [ -n "$PACK_TMP_DIR" ] && rm -rf "$PACK_TMP_DIR" 2>/dev/null || true
    PACK_TMP_DIR=""; PACK_TGZ_FILE=""
}

# ============================================================================
#  Level 2: npm pack 下载 + 解压 + openclaw plugins install <目录>
#  绕过 ClawHub 下载，保留 openclaw CLI 的原子部署、验证、完整 install record
#  注意：传目录路径而非 tarball 路径，因为 openclaw 的 installPluginFromArchive
#  历史上存在漏传安装参数（dangerouslyForceUnsafeInstall）的 bug；
#  传目录可让 installPluginFromDir 正确接收 --force（非 ClawHub 来源确认）等参数
# ============================================================================
npm_pack_native_install() {
    echo ""
    echo "  ============================================"
    echo "  [Level 2] npm pack + openclaw install 本地目录"
    echo "  ============================================"

    echo "  [L2 1/4] 下载 tarball..."
    npm_pack_download || return 1

    # 先解压再传目录路径给 openclaw，而非直接传 tarball 路径
    # 原因：openclaw installPluginFromArchive 历史上漏传安装参数，
    #       installPluginFromDir 正确接收 --force 等参数，传目录更可靠
    echo "  [L2 2/4] 解压 tarball..."
    local extract_dir
    extract_dir="$(mktemp -d "${TMPDIR:-/tmp}/.qqbot-extract-XXXXXX")"
    if ! tar xzf "$PACK_TGZ_FILE" -C "$extract_dir" 2>&1; then
        log "l2_extract" "fail" "  ❌ 解压失败"; cleanup_pack; rm -rf "$extract_dir"; return 1
    fi
    cleanup_pack
    local package_dir="$extract_dir/package"
    if [ ! -f "$package_dir/package.json" ]; then
        log "l2_extract" "fail" "  ❌ 解压后未找到 package.json"; rm -rf "$extract_dir"; return 1
    fi

    # L1 失败可能留下残缺目录或 stage，L2 安装前再次清理
    echo "  [L2 3/4] 清理残留..."
    [ -d "$EXTENSIONS_DIR/$PLUGIN_ID" ] && rm -rf "$EXTENSIONS_DIR/$PLUGIN_ID" 2>/dev/null || true
    find "${EXTENSIONS_DIR:-/dev/null}" "${TMPDIR:-/tmp}" -maxdepth 1 -name ".openclaw-install-stage-*" \
        -exec rm -rf {} + 2>/dev/null || true
    # 从配置中移除插件记录，防止 openclaw CLI 报 "already exists"
    local _l2_cfg="${TEMP_CONFIG_FILE:-$CONFIG_FILE}"
    [ -f "$_l2_cfg" ] && node -e "
      try {
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$_l2_cfg', 'utf8'));
        let c = false;
        if (cfg.plugins?.installs?.['$PLUGIN_ID']) { delete cfg.plugins.installs['$PLUGIN_ID']; c = true; }
        if (cfg.plugins?.entries?.['$PLUGIN_ID']) { delete cfg.plugins.entries['$PLUGIN_ID']; c = true; }
        if (Array.isArray(cfg.plugins?.allow)) {
          const i = cfg.plugins.allow.indexOf('$PLUGIN_ID');
          if (i >= 0) { cfg.plugins.allow.splice(i, 1); c = true; }
        }
        if (c) fs.writeFileSync('$_l2_cfg', JSON.stringify(cfg, null, 4) + '\n');
      } catch {}
    " 2>/dev/null || true

    echo "  [L2 4/4] 用 openclaw 安装本地目录..."
    ensure_valid_cwd
    local rc=0
    run_with_timeout "$INSTALL_TIMEOUT" "plugins install (local dir)" \
        openclaw plugins install "$package_dir" $INSTALL_FORCE_FLAG $FORCE_UNSAFE_FLAG $ACCEPT_CAPABILITIES_FLAG 2>&1 || rc=$?

    rm -rf "$extract_dir" 2>/dev/null || true

    if [ $rc -eq 0 ] && [ -f "$EXTENSIONS_DIR/$PLUGIN_ID/package.json" ]; then
        log "l2_install" "success" "  ✅ Level 2 安装成功"
        return 0
    fi
    log "l2_install" "fail" "  Level 2 失败 (exit=$rc)" "exit_code=$rc"
    [ -d "$EXTENSIONS_DIR/$PLUGIN_ID" ] && [ ! -f "$EXTENSIONS_DIR/$PLUGIN_ID/package.json" ] && \
        rm -rf "$EXTENSIONS_DIR/$PLUGIN_ID" 2>/dev/null || true
    find "${EXTENSIONS_DIR:-/dev/null}" "${TMPDIR:-/tmp}" -maxdepth 1 -name ".openclaw-install-stage-*" \
        -exec rm -rf {} + 2>/dev/null || true
    return 1
}

# 降级入口：Level 2
run_fallback() {
    npm_pack_native_install && return 0
    return 1
}

# ============================================================================
#  异常退出清理
# ============================================================================
INSTALL_COMPLETED=false
BACKUP_DIR=""
TEMP_CONFIG_FILE=""

cleanup_on_exit() {
    local exit_code=$?
    ensure_valid_cwd

    if [ "$INSTALL_COMPLETED" != "true" ] && [ $exit_code -ne 0 ]; then
        local reason="异常退出 (code=$exit_code)"
        case $exit_code in 124|125) reason="安装超时";; 130) reason="用户中断";; 143) reason="SIGTERM";; 129) reason="SIGHUP";; esac
        log "abnormal_exit" "fail" "  ⚠️  ${reason}" "reason=$reason" "exit_code=$exit_code"
        restore_config_snapshot
        rollback_plugin_dir "$reason"
    fi

    [ -n "$TEMP_CONFIG_FILE" ] && rm -f "$TEMP_CONFIG_FILE" 2>/dev/null || true
    [ -n "$BACKUP_DIR" ] && rm -rf "$BACKUP_DIR" 2>/dev/null || true
    restore_reload_mode
    cleanup_config_snapshot
    cleanup_pack
    find "${EXTENSIONS_DIR:-/dev/null}" -maxdepth 1 -name ".openclaw-install-stage-*" -exec rm -rf {} + 2>/dev/null || true
    find "${TMPDIR:-/tmp}" -maxdepth 1 \( -name ".openclaw-install-stage-*" -o -name ".qqbot-pack-*" \
        -o -name ".qqbot-extract-*" -o -name ".qqbot-upgrade-backup-*" \) -exec rm -rf {} + 2>/dev/null || true
    find "${OPENCLAW_HOME:-/dev/null}" -maxdepth 1 -name ".qqbot-temp-config-*" -exec rm -f {} + 2>/dev/null || true
    release_upgrade_lock
    exit $exit_code
}
trap cleanup_on_exit EXIT
trap 'echo "  中断"; exit 130' INT
trap 'exit 129' HUP

# 清理上次升级遗留（>60min）
find "${TMPDIR:-/tmp}" -maxdepth 1 \( -name ".qqbot-upgrade-backup-*" -o -name ".qqbot-pack-*" \
    -o -name ".qqbot-extract-*" \) -mmin +60 -exec rm -rf {} + 2>/dev/null || true
find "${OPENCLAW_HOME:-/dev/null}" -maxdepth 1 -name ".qqbot-temp-config-*" -mmin +60 -exec rm -f {} + 2>/dev/null || true

# ============================================================================
#  参数解析
# ============================================================================
PKG_NAME="@tencent-connect/openclaw-qqbot"
PLUGIN_ID="openclaw-qqbot"
TARGET_VERSION=""
APPID=""
SECRET=""
NO_RESTART=false
DISABLE_BUILTIN=true
INSTALL_TIMEOUT=1000
LOCAL_VERSION="$(read_pkg_version "$PROJECT_DIR/package.json")"

# 可能与我们冲突的内置/官方插件 ID 列表
# 如果 OpenClaw 未来内置了 qqbot 相关插件，在此列表中添加其 ID
BUILTIN_CONFLICT_IDS="qqbot openclaw-qq"

print_usage() {
    cat <<EOF
用法:
  upgrade-via-npm.sh                              # 升级到 latest
  upgrade-via-npm.sh --version <版本号>            # 升级到指定版本
  upgrade-via-npm.sh --self-version               # 升级到当前仓库版本${LOCAL_VERSION:+ ($LOCAL_VERSION)}

  --pkg <scope/name>    指定 npm 包名
  --appid <appid>       QQ机器人 appid
  --secret <secret>     QQ机器人 secret
  --no-restart          只做文件替换，不重启 gateway
  --disable-builtin     额外删除内置冲突插件目录（配置禁用默认执行）
  --timeout <秒>        自定义安装超时（默认1000）

环境变量: QQBOT_APPID / QQBOT_SECRET / QQBOT_TOKEN (appid:secret)
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tag|--version) [ -z "$2" ] && echo "❌ $1 需要参数" && exit 1; TARGET_VERSION="${2#v}"; shift 2 ;;
        --self-version) [ -z "$LOCAL_VERSION" ] && echo "❌ 无法读取版本" && exit 1; TARGET_VERSION="$LOCAL_VERSION"; shift ;;
        --appid) [ -z "$2" ] && echo "❌ --appid 需要参数" && exit 1; APPID="$2"; shift 2 ;;
        --secret) [ -z "$2" ] && echo "❌ --secret 需要参数" && exit 1; SECRET="$2"; shift 2 ;;
        --pkg) [ -z "$2" ] && echo "❌ --pkg 需要参数" && exit 1; _p="$2"; [[ "$_p" != @* ]] && _p="@$_p"; PKG_NAME="$_p"; shift 2 ;;
        --no-restart) NO_RESTART=true; shift ;;
        --disable-builtin) DISABLE_BUILTIN=true; shift ;;
        --timeout) [ -z "$2" ] && echo "❌ --timeout 需要参数" && exit 1; INSTALL_TIMEOUT="$2"; shift 2 ;;
        -h|--help) print_usage; exit 0 ;;
        *) echo "未知选项: $1"; print_usage; exit 1 ;;
    esac
done

INSTALL_SRC="${PKG_NAME}@${TARGET_VERSION:-latest}"

# 环境变量 fallback
APPID="${APPID:-$QQBOT_APPID}"; SECRET="${SECRET:-$QQBOT_SECRET}"
if [ -z "$APPID" ] && [ -z "$SECRET" ] && [ -n "$QQBOT_TOKEN" ]; then
    APPID="${QQBOT_TOKEN%%:*}"; SECRET="${QQBOT_TOKEN#*:}"
fi

# 检测 openclaw
command -v openclaw &>/dev/null || { echo "❌ 未找到 openclaw"; exit 1; }

# 解析数据目录（支持 OPENCLAW_STATE_DIR 覆盖）
OPENCLAW_HOME="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
EXTENSIONS_DIR="$OPENCLAW_HOME/extensions"
CONFIG_FILE="$OPENCLAW_HOME/openclaw.json"

UPGRADE_LOCK_FILE="$OPENCLAW_HOME/.upgrading"
acquire_upgrade_lock

OPENCLAW_VERSION="$(openclaw --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 || true)"

# --force：确认非 ClawHub 来源（本地路径/第三方 npm）+ 覆盖已存在插件。
#   2026.4.5 起引入；2026.6.2 起（安全扫描移除后）是绕过非交互式来源确认的必需参数，
#   否则本地路径安装会报 "Install cancelled; rerun with --force"。
INSTALL_FORCE_FLAG=""
if [ -n "$OPENCLAW_VERSION" ] && version_gte "$OPENCLAW_VERSION" "2026.4.5"; then
    INSTALL_FORCE_FLAG="--force"
fi

# --accept-capabilities：2026.8.0 起引入 capability consent，
#   插件在 openclaw.plugin.json 中声明的能力需显式同意，否则报 "requires capability consent"。
ACCEPT_CAPABILITIES_FLAG=""
if [ -n "$OPENCLAW_VERSION" ] && version_gte "$OPENCLAW_VERSION" "2026.8.0"; then
    ACCEPT_CAPABILITIES_FLAG="--accept-capabilities"
fi

# --dangerously-force-unsafe-install：仅 2026.3.30 ~ 2026.6.1 内置安全扫描时代用于绕过扫描；
#   2026.6.2 起安全扫描已移除（PR #89516），该参数废弃为 no-op（仅打印 deprecation 警告）。
# 该参数仅 plugins install 支持，plugins update 不支持；update 决策也依赖其非空判断。
FORCE_UNSAFE_FLAG=""
if [ -n "$OPENCLAW_VERSION" ] && version_gte "$OPENCLAW_VERSION" "2026.3.30" \
        && ! version_gte "$OPENCLAW_VERSION" "2026.6.2"; then
    FORCE_UNSAFE_FLAG="--dangerously-force-unsafe-install"
fi

log "upgrade_start" "start" "==========================================="
echo "  qqbot 升级: $INSTALL_SRC"
echo "  openclaw: v${OPENCLAW_VERSION:-unknown}"
echo "  隔离: ${_UPGRADE_ISOLATED:+✓ setsid}${_UPGRADE_ISOLATED:-✗}  超时: ${INSTALL_TIMEOUT}s"
echo "==========================================="

# 记录旧版本
OLD_VERSION=""
OLD_PKG="$EXTENSIONS_DIR/$PLUGIN_ID/package.json"
[ -f "$OLD_PKG" ] && OLD_VERSION="$(read_pkg_version "$OLD_PKG")"
[ -n "$OLD_VERSION" ] && echo "  当前版本: $OLD_VERSION"

# 初始化日志上报
init_track_log

# ============================================================================
#  禁用内置冲突插件（配置禁用 + 验证）
# ============================================================================
# 记录已确认存在的内置冲突插件 ID，供 verify_builtin_disabled 复用
CONFIRMED_BUILTIN_IDS=""

disable_builtin_plugins() {
    local found_any=false
    CONFIRMED_BUILTIN_IDS=""

    # 一次性获取 openclaw 已知的所有插件 ID（stock + global）
    local _known_ids=""
    ensure_valid_cwd
    _known_ids="$(run_with_timeout 15 "plugins list" openclaw plugins list 2>/dev/null \
        | sed -n 's/^│[^│]*│[[:space:]]*\([a-zA-Z0-9_-]*\)[[:space:]]*│.*/\1/p' || true)"

    for bid in $BUILTIN_CONFLICT_IDS; do
        [ "$bid" = "$PLUGIN_ID" ] && continue

        # 判断该内置插件是否存在：plugins list 中有 / 配置中有记录 / user extensions 目录有
        local _bid_exists=false
        echo "$_known_ids" | grep -qx "$bid" 2>/dev/null && _bid_exists=true
        [ "$_bid_exists" != "true" ] && [ -d "$EXTENSIONS_DIR/$bid" ] && _bid_exists=true
        [ "$_bid_exists" != "true" ] && node -e "
          try {
            const c = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf8'));
            if (c.plugins?.entries?.['$bid'] || c.plugins?.installs?.['$bid'] ||
                (Array.isArray(c.plugins?.allow) && c.plugins.allow.includes('$bid')))
              process.stdout.write('1');
          } catch {}
        " 2>/dev/null | grep -q '1' && _bid_exists=true

        if [ "$_bid_exists" != "true" ]; then
            echo "  [禁用内置] $bid: 未检测到，跳过"
            continue
        fi

        CONFIRMED_BUILTIN_IDS="$CONFIRMED_BUILTIN_IDS $bid"

        local _changed=""
        _changed="$(node -e "
          try {
            const fs = require('fs');
            const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
            let c = [];
            // 显式写入 enabled:false，内置插件即使没有 entries 记录也会自动加载
            (cfg.plugins ??= {}).entries ??= {};
            if (!cfg.plugins.entries['$bid'] || cfg.plugins.entries['$bid'].enabled !== false) {
              cfg.plugins.entries['$bid'] = { ...cfg.plugins.entries['$bid'], enabled: false };
              c.push('entries');
            }
            if (Array.isArray(cfg.plugins?.allow) && cfg.plugins.allow.includes('$bid')) {
              cfg.plugins.allow = cfg.plugins.allow.filter(p => p !== '$bid'); c.push('allow');
            }
            if (cfg.plugins?.installs?.['$bid']) { delete cfg.plugins.installs['$bid']; c.push('installs'); }
            if (c.length) fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 4) + '\n');
            process.stdout.write(c.join(','));
          } catch {}
        " 2>/dev/null || true)"
        [ -n "$_changed" ] && echo "  [禁用内置] $bid: 已修改 $_changed" && found_any=true
    done
    if [ "$found_any" = "true" ]; then
        log "disable_builtin" "success" "  ✅ 内置冲突插件已禁用" "confirmed_ids=$CONFIRMED_BUILTIN_IDS"
    else
        log "disable_builtin" "skip" "  ℹ️  未发现需要禁用的内置冲突插件"
    fi
}

verify_builtin_disabled() {
    [ -z "$CONFIRMED_BUILTIN_IDS" ] && return 0
    for bid in $CONFIRMED_BUILTIN_IDS; do
        local _e="$(node -e "
          try {
            const c = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf8'));
            const e = c.plugins?.entries?.['$bid'];
            // 不存在或 enabled 不为 false 都需要修复
            if (!e || e.enabled !== false) process.stdout.write('1');
          } catch {}
        " 2>/dev/null || true)"
        if [ "$_e" = "1" ]; then
            log "verify_builtin" "fix" "  ⚠️  内置插件 $bid 未禁用，写入 entries..." "bid=$bid"
            node -e "
              try {
                const f = require('fs');
                const c = JSON.parse(f.readFileSync('$CONFIG_FILE', 'utf8'));
                (c.plugins ??= {}).entries ??= {};
                c.plugins.entries['$bid'] = { ...c.plugins.entries['$bid'], enabled: false };
                f.writeFileSync('$CONFIG_FILE', JSON.stringify(c, null, 4) + '\n');
              } catch {}
            " 2>/dev/null || true
        fi
    done
}

# ============================================================================
#  [1/4] 安装/升级插件
# ============================================================================
echo ""

# 快照提前到所有写操作前（包括 [前置] 的 disable_builtin_plugins）
snapshot_config

# hybrid 模式下写 openclaw.json 会触发 gateway restart，导致脚本被 cgroup kill
# 在整个安装窗口内切换为 hot（只热更新，不重启），退出前从变量恢复原值
# 原值为空说明用户从未手动设置过，退出时 unset 删掉我们写入的值
_PREV_RELOAD_MODE="$(node -e "try{const c=JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8'));process.stdout.write(c?.gateway?.reload?.mode||'')}catch{}" 2>/dev/null || true)"
openclaw config set gateway.reload.mode hot 2>/dev/null || true

# 默认禁用内置冲突插件（openclaw ≥2026.3.31 内置了 qqbot 插件，与我们的 openclaw-qqbot 冲突）
echo "[前置] 检查并禁用内置冲突插件..."
disable_builtin_plugins
echo ""

echo "[1/4] 安装/升级插件..."
setup_temp_config

# 清理历史遗留 ID 的配置记录（qqbot/openclaw-qq 是旧版本使用的 ID，
# entries 中残留会导致 gateway 重复加载同一插件报 tool name conflict）
# 注意：跳过 enabled===false 的 entries，那是 disable_builtin_plugins 写入的禁用记录
[ -f "$CONFIG_FILE" ] && node -e "
  try {
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
    let c = false;
    for (const old of ['qqbot', 'openclaw-qq']) {
      if (cfg.plugins?.entries?.[old] && cfg.plugins.entries[old].enabled !== false) {
        delete cfg.plugins.entries[old]; c = true;
      }
      if (cfg.plugins?.installs?.[old]) { delete cfg.plugins.installs[old]; c = true; }
      if (Array.isArray(cfg.plugins?.allow)) {
        const i = cfg.plugins.allow.indexOf(old);
        if (i >= 0) { cfg.plugins.allow.splice(i, 1); c = true; }
      }
    }
    if (c) { fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 4) + '\n'); process.stdout.write('1'); }
  } catch {}
" 2>/dev/null | grep -q '1' && echo "  [清理] 已移除历史遗留配置记录" || true

UPGRADE_OK=false

# 检测安装状态
INSTALL_RECORD_INFO="$(node -e "
  try {
    const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf8'));
    const inst = cfg.plugins?.installs?.['$PLUGIN_ID'];
    if (inst) process.stdout.write('yes|' + (inst.spec || ''));
  } catch {}
" 2>/dev/null || true)"
HAS_INSTALL_RECORD="${INSTALL_RECORD_INFO%%|*}"
INSTALL_SPEC="${INSTALL_RECORD_INFO#*|}"
HAS_PLUGIN_DIR=false
[ -d "$EXTENSIONS_DIR/$PLUGIN_ID" ] && [ -f "$OLD_PKG" ] && HAS_PLUGIN_DIR=true

# 决策：配置有记录 + 目录存在 + 未指定版本 → 优先 update，其他 → install
# 仅 2026.3.30~2026.6.1（FORCE_UNSAFE_FLAG 非空）的 update 会被安全扫描阻断
# （update 不支持 --dangerously-force-unsafe-install），直接走 install；
# 2026.6.2 起安全扫描已移除，恢复走 update。
USE_UPDATE=false
if [ "$HAS_INSTALL_RECORD" = "yes" ] && [ "$HAS_PLUGIN_DIR" = "true" ] && [ -z "$TARGET_VERSION" ]; then
    if [ -n "$FORCE_UNSAFE_FLAG" ]; then
        log "install_decision" "info" "  [检测] 配置 ✓ | 目录 ✓ | openclaw 3.30~6.1 → 跳过 update，直接 install（安全扫描兼容）" "decision=install" "reason=force_unsafe"
    else
        USE_UPDATE=true
        log "install_decision" "info" "  [检测] 配置 ✓ | 目录 ✓ | 未指定版本 → update" "decision=update"
        # spec 解锁
        if [ -n "$INSTALL_SPEC" ]; then
            SPEC_SUFFIX="${INSTALL_SPEC##*@}"
            if echo "$SPEC_SUFFIX" | grep -qE '^[0-9]+\.[0-9]+'; then
                echo "  [spec 解锁] '$INSTALL_SPEC' → @latest"
                node -e "
                  try {
                    const fs = require('fs'), p = process.env.OPENCLAW_CONFIG_PATH || '$CONFIG_FILE';
                    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
                    if (cfg.plugins?.installs?.['$PLUGIN_ID']) {
                      cfg.plugins.installs['$PLUGIN_ID'].spec = '$PKG_NAME@latest';
                      fs.writeFileSync(p, JSON.stringify(cfg, null, 4) + '\n');
                    }
                  } catch {}
                " 2>/dev/null || true
            fi
        fi
    fi
elif [ "$HAS_PLUGIN_DIR" = "true" ]; then
    log "install_decision" "info" "  [检测] 目录 ✓ | 指定版本或无配置记录 → reinstall" "decision=reinstall"
else
    log "install_decision" "info" "  [检测] 目录 ✗ → 全新安装" "decision=fresh_install"
fi

mark_success() {
    UPGRADE_OK=true; INSTALL_COMPLETED=true
    [ -n "$BACKUP_DIR" ] && rm -rf "$BACKUP_DIR" 2>/dev/null && BACKUP_DIR="" || true
}

# ── 更新路径（Level 1: 原生 update，仅 <3.30 版本） ──
if [ "$USE_UPDATE" = "true" ]; then
    ensure_valid_cwd
    UPDATE_TIMEOUT=$((INSTALL_TIMEOUT < 180 ? INSTALL_TIMEOUT : 180))
    echo "  [Level 1] 尝试 openclaw plugins update...（${UPDATE_TIMEOUT}s 超时）"
    UPDATE_RC=0
    UPDATE_OUTPUT="$(run_with_timeout "$UPDATE_TIMEOUT" \
        "plugins update" openclaw plugins update "$PLUGIN_ID" $ACCEPT_CAPABILITIES_FLAG 2>&1)" || UPDATE_RC=$?
    echo "$UPDATE_OUTPUT"

    if [ $UPDATE_RC -eq 0 ]; then
        POST_VER=""; [ -f "$OLD_PKG" ] && POST_VER="$(read_pkg_version "$OLD_PKG")"
        if [ -n "$POST_VER" ] && [ "$POST_VER" != "$OLD_VERSION" ]; then
            mark_success; log "level1_update" "success" "  ✅ update 成功 ($OLD_VERSION → $POST_VER)" "method=update" "post_version=$POST_VER"
        elif [ -z "$OLD_VERSION" ]; then
            mark_success; log "level1_update" "success" "  ✅ update 成功" "method=update"
        else
            echo "  ℹ️  版本未变 ($POST_VER)，查询 npm latest..."
            NPM_LATEST="$(npm view "$PKG_NAME" version 2>/dev/null || true)"
            if [ -n "$NPM_LATEST" ] && [ "$NPM_LATEST" = "$POST_VER" ]; then
                mark_success; log "level1_update" "success" "  ✅ 已是最新版本 $POST_VER" "method=update" "version=$POST_VER"
            else
                log "level1_update" "fail" "  npm latest=${NPM_LATEST:-unknown}，当前=$POST_VER" "npm_latest=$NPM_LATEST" "current=$POST_VER"
            fi
        fi
    else
        if [ $UPDATE_RC -eq 124 ]; then
            log "level1_update" "fail" "  ⏰ update 超时" "method=update" "exit_code=$UPDATE_RC"
        else
            log "level1_update" "fail" "  update 失败 (exit=$UPDATE_RC)" "method=update" "exit_code=$UPDATE_RC"
        fi
    fi

    # Level 1 失败 → Level 2 降级
    if [ "$UPGRADE_OK" != "true" ]; then
        log "level2_fallback" "start" "  尝试 Level 2 降级..." "reason=level1_failed"
        if [ -z "$BACKUP_DIR" ] && [ -d "$EXTENSIONS_DIR/$PLUGIN_ID" ]; then
            BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/.qqbot-upgrade-backup-XXXXXX")"
            cp -a "$EXTENSIONS_DIR/$PLUGIN_ID" "$BACKUP_DIR/$PLUGIN_ID"
        fi
        if run_fallback; then
            mark_success
            log "level2_fallback" "success" "  ✅ Level 2 降级成功"
        else
            log "level2_fallback" "fail" "  ❌ Level 2 降级失败"
        fi
    fi
fi

# ── 安装路径（Level 1 → Level 2） ──
if [ "$UPGRADE_OK" != "true" ]; then
    # 备份旧目录
    if [ -d "$EXTENSIONS_DIR/$PLUGIN_ID" ]; then
        BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/.qqbot-upgrade-backup-XXXXXX")"
        cp -a "$EXTENSIONS_DIR/$PLUGIN_ID" "$BACKUP_DIR/$PLUGIN_ID"
        echo "  已备份旧目录"
    fi

    # 清理历史遗留
    for d in qqbot openclaw-qq; do
        [ -d "$EXTENSIONS_DIR/$d" ] && rm -rf "$EXTENSIONS_DIR/$d" && echo "  已清理: $d"
    done
    [ -d "$EXTENSIONS_DIR/$PLUGIN_ID" ] && rm -rf "$EXTENSIONS_DIR/$PLUGIN_ID"

    # 从配置中移除插件记录，防止 openclaw CLI 报 "already exists"
    _install_cfg="${TEMP_CONFIG_FILE:-$CONFIG_FILE}"
    [ -f "$_install_cfg" ] && node -e "
      try {
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$_install_cfg', 'utf8'));
        let c = false;
        if (cfg.plugins?.installs?.['$PLUGIN_ID']) { delete cfg.plugins.installs['$PLUGIN_ID']; c = true; }
        if (cfg.plugins?.entries?.['$PLUGIN_ID']) { delete cfg.plugins.entries['$PLUGIN_ID']; c = true; }
        if (Array.isArray(cfg.plugins?.allow)) {
          const i = cfg.plugins.allow.indexOf('$PLUGIN_ID');
          if (i >= 0) { cfg.plugins.allow.splice(i, 1); c = true; }
        }
        if (c) fs.writeFileSync('$_install_cfg', JSON.stringify(cfg, null, 4) + '\n');
      } catch {}
    " 2>/dev/null || true

    # Level 1: 原生 install（单次尝试，失败后由 Level 2 的 npm pack 多源重试接管）
    log "level1_install" "start" "  [Level 1] 尝试 openclaw plugins install..." "method=install"
    ensure_valid_cwd
    RC=0
    run_with_timeout "$INSTALL_TIMEOUT" \
        "plugins install" openclaw plugins install "$INSTALL_SRC" --pin \
        $INSTALL_FORCE_FLAG $FORCE_UNSAFE_FLAG $ACCEPT_CAPABILITIES_FLAG 2>&1 || RC=$?

    if [ $RC -eq 0 ] && [ -f "$EXTENSIONS_DIR/$PLUGIN_ID/package.json" ]; then
        mark_success; log "level1_install" "success" "  ✅ Level 1 install 成功" "method=install"
    else
        log "level1_install" "fail" "  Level 1 install 失败 (exit=$RC)" "method=install" "exit_code=$RC"
        # 清理不完整的目录和 stage
        [ -d "$EXTENSIONS_DIR/$PLUGIN_ID" ] && [ ! -f "$EXTENSIONS_DIR/$PLUGIN_ID/package.json" ] && \
            rm -rf "$EXTENSIONS_DIR/$PLUGIN_ID" 2>/dev/null || true
        find "${EXTENSIONS_DIR:-/dev/null}" "${TMPDIR:-/tmp}" -maxdepth 1 -name ".openclaw-install-stage-*" \
            -exec rm -rf {} + 2>/dev/null || true

        log "level2_fallback" "start" "  Level 1 失败，尝试 Level 2 降级..." "reason=level1_install_failed"
        if run_fallback; then
            mark_success
            log "level2_fallback" "success" "  ✅ Level 2 降级成功"
        else
            log "level2_fallback" "fail" "  ❌ Level 2 降级失败"
            log "upgrade_complete" "fail" "  升级完全失败，已回滚"
            rollback_plugin_dir "安装失败"; restore_config_snapshot
            [ -n "$TEMP_CONFIG_FILE" ] && rm -f "$TEMP_CONFIG_FILE" 2>/dev/null || true
            unset OPENCLAW_CONFIG_PATH 2>/dev/null || true
            echo "QQBOT_NEW_VERSION=unknown"
            echo "QQBOT_REPORT=❌ QQBot 安装失败（已回滚），请检查网络"
            exit 1
        fi
    fi
fi

sync_temp_config
cleanup_config_snapshot
INSTALL_COMPLETED=true

# ============================================================================
#  [2/4] 验证安装
# ============================================================================
echo ""
echo "[2/4] 验证安装..."

TARGET_DIR="$EXTENSIONS_DIR/$PLUGIN_ID"
NEW_VERSION=""; [ -f "$TARGET_DIR/package.json" ] && NEW_VERSION="$(read_pkg_version "$TARGET_DIR/package.json")"

PREFLIGHT_OK=true
[ -z "$NEW_VERSION" ] && echo "  ❌ 无法读取版本号" && PREFLIGHT_OK=false || echo "  ✅ 版本: $NEW_VERSION"

ENTRY=""; for f in "dist/index.cjs" "dist/index.js" "index.js"; do [ -f "$TARGET_DIR/$f" ] && ENTRY="$f" && break; done
[ -z "$ENTRY" ] && echo "  ❌ 缺少入口文件" && PREFLIGHT_OK=false || echo "  ✅ 入口: $ENTRY"

# 检测构建模式：bundled (tsup dist/index.cjs) vs unbundled (dist/src/ 独立文件)
# 优先看 dist/src/ 是否存在；存在 → unbundled；否则依赖入口文件大小判断
IS_BUNDLED=false
if [ -d "$TARGET_DIR/dist/src" ]; then
    IS_BUNDLED=false
elif [ -f "$TARGET_DIR/$ENTRY" ]; then
    BUNDLE_SIZE=$(wc -c < "$TARGET_DIR/$ENTRY" 2>/dev/null || echo "0")
    # bundled 输出通常 > 200KB，unbundled 入口 < 50KB
    [ "$BUNDLE_SIZE" -gt 200000 ] 2>/dev/null && IS_BUNDLED=true
fi

if [ "$IS_BUNDLED" = "true" ]; then
    echo "  ✅ bundled 构建 (${BUNDLE_SIZE} bytes)"

    # 内联验证：bundle 中 grep 关键导出
    BUNDLE_MISS=""
    for sig in "GatewayConnection" "dispatchToOpenClaw" "qqbotPlugin" "sendText" "sendMedia"; do
        if ! grep -qF "$sig" "$TARGET_DIR/$ENTRY" 2>/dev/null; then
            BUNDLE_MISS="$BUNDLE_MISS $sig"
        fi
    done
    [ -n "$BUNDLE_MISS" ] && echo "  ❌ bundle 缺少签名:$BUNDLE_MISS" && PREFLIGHT_OK=false || echo "  ✅ 关键模块签名完整"

    # ws 依赖应该被 tsup noExternal 打包进 bundle
    if grep -qF "ws" "$TARGET_DIR/$ENTRY" 2>/dev/null; then
        echo "  ✅ ws bundled"
    else
        echo "  ⚠️  ws 未打包"
    fi
else
    if [ -d "$TARGET_DIR/dist/src" ]; then
        JS_COUNT=$(find "$TARGET_DIR/dist/src" -name "*.js" -type f 2>/dev/null | wc -l | tr -d ' ')
        echo "  ✅ dist/src/ 含 ${JS_COUNT} 个 JS"
        [ "$JS_COUNT" -lt 5 ] && echo "  ❌ JS 数量异常偏少" && PREFLIGHT_OK=false
    else
        echo "  ❌ 缺少 dist/src/"; PREFLIGHT_OK=false
    fi

    MISS=""
    for m in "dist/src/gateway.js" "dist/src/api.js" "dist/src/admin-resolver.js"; do
        [ ! -f "$TARGET_DIR/$m" ] && MISS="$MISS $m"
    done
    [ -n "$MISS" ] && echo "  ❌ 缺少:$MISS" && PREFLIGHT_OK=false || echo "  ✅ 关键模块完整"
fi

if [ -d "$TARGET_DIR/node_modules" ]; then
    BOK=true
    for dep in ws silk-wasm; do [ ! -d "$TARGET_DIR/node_modules/$dep" ] && echo "  ⚠️  缺失: $dep" && BOK=false; done
    $BOK && echo "  ✅ bundled 依赖完整"
fi

if [ "$PREFLIGHT_OK" != "true" ]; then
    echo ""
    log "validation" "fail" "❌ 验证未通过" "missing=$MISS"
    echo "QQBOT_NEW_VERSION=unknown"; echo "QQBOT_REPORT=⚠️ 验证未通过"
    exit 1
fi
log "validation" "success" "  ✅ 验证全部通过"

# 轻量健康检查
echo ""
echo "  [健康检查] 确认插件注册..."
ensure_valid_cwd
PLIST="$(run_with_timeout 10 "plugins list" openclaw plugins list 2>&1 || true)"
echo "$PLIST" | grep -q "$PLUGIN_ID" && echo "  ✅ 插件已注册" || \
    echo "  ⚠️  未在 plugins list 中找到（重启后可能自动修复）"

# 安装后再次验证内置插件已禁用（install/update 过程中 openclaw 可能重新启用）
verify_builtin_disabled

# postinstall SDK link（update 路径不会执行 lifecycle scripts，这里统一补执行）
if [ -f "$TARGET_DIR/scripts/postinstall-link-sdk.js" ]; then
    echo "  执行 postinstall-link-sdk..."
    ensure_valid_cwd
    node "$TARGET_DIR/scripts/postinstall-link-sdk.js" 2>&1 && echo "  ✅ SDK 链接就绪" || \
        echo "  ⚠️  postinstall-link-sdk 失败（非致命）"
fi

# ============================================================================
#  [3/4] 升级结果
# ============================================================================
echo ""
echo "[3/4] 升级结果..."
echo "QQBOT_NEW_VERSION=${NEW_VERSION:-unknown}"
[ -n "$NEW_VERSION" ] && [ "$NEW_VERSION" != "unknown" ] && \
    echo "QQBOT_REPORT=✅ QQBot 升级完成: v${NEW_VERSION}" || \
    echo "QQBOT_REPORT=⚠️ 无法确认新版本"

echo ""
log "upgrade_complete" "success" "==========================================="  "new_version=${NEW_VERSION:-unknown}"
echo "  ✅ 安装完成"
echo "==========================================="

[ "$NO_RESTART" = "true" ] && echo "" && echo "[跳过重启] --no-restart 已指定" && exit 0

# ============================================================================
#  [配置] appid/secret
# ============================================================================
if [ -n "$APPID" ] && [ -n "$SECRET" ]; then
    echo ""
    echo "[配置] 写入 qqbot 通道配置..."
    DESIRED="${APPID}:${SECRET}"
    CURRENT=""
    [ -f "$CONFIG_FILE" ] && CURRENT=$(node -e "
        try {
            const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf8'));
            for (const k of ['qqbot','openclaw-qqbot','openclaw-qq']) {
                const ch = cfg.channels?.[k]; if (!ch) continue;
                if (ch.token) { process.stdout.write(ch.token); break; }
                if (ch.appId && ch.clientSecret) { process.stdout.write(ch.appId+':'+ch.clientSecret); break; }
            }
        } catch {}
    " 2>/dev/null || true)

    if [ "$CURRENT" = "$DESIRED" ]; then
        echo "  ✅ 配置已是目标值"
    elif [ -f "$CONFIG_FILE" ] && node -e "
        const fs = require('fs'), cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
        (cfg.channels ??= {}).qqbot = { ...cfg.channels.qqbot, appId: '$APPID', clientSecret: '$SECRET' };
        fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 4) + '\n');
    " 2>&1; then
        echo "  ✅ 通道配置写入成功"
    else
        echo "  ❌ 写入失败，请手动编辑 $CONFIG_FILE"
    fi
elif [ -n "$APPID" ] || [ -n "$SECRET" ]; then
    echo ""; echo "⚠️  --appid 和 --secret 必须同时提供"
fi

# ============================================================================
#  [4/4] 重启 gateway
# ============================================================================
echo ""

restore_reload_mode

# startup-marker 防重复通知
if [ -n "$NEW_VERSION" ] && [ "$NEW_VERSION" != "unknown" ]; then
    MARKER_DIR="$OPENCLAW_HOME/qqbot/data"; mkdir -p "$MARKER_DIR"
    NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date +%Y-%m-%dT%H:%M:%SZ)"
    echo "{\"version\":\"$NEW_VERSION\",\"startedAt\":\"$NOW\",\"greetedAt\":\"$NOW\"}" > "$MARKER_DIR/startup-marker.json"
fi

echo "[4/4] 重启 gateway..."
ensure_valid_cwd
GW_RC=0; GW_OUTPUT="$(run_with_timeout 90 "gateway restart" openclaw gateway restart 2>&1)" || GW_RC=$?
echo "$GW_OUTPUT"

if [ $GW_RC -eq 0 ]; then
    log "gateway_restart" "success" "  ✅ gateway 已重启"
    [ -n "$NEW_VERSION" ] && echo "" && echo "🎉 QQBot 插件已更新至 v${NEW_VERSION}，在线等候你的吩咐。"
else
    if [ $GW_RC -eq 124 ]; then
        log "gateway_restart" "fail" "  ⏰ gateway restart 超时" "exit_code=$GW_RC"
    else
        log "gateway_restart" "fail" "  ⚠️  重启失败" "exit_code=$GW_RC"
    fi

    # 检测是否是 qqbot 通道配置的 additional properties 校验错误
    if echo "$GW_OUTPUT" | grep -q "additional properties"; then
        echo ""
        log "config_fix" "start" "  [配置修复] 检测到 QQBot 通道配置包含不支持的字段"

        # 备份当前配置
        _cfg_backup="${CONFIG_FILE}.pre-fix.$(date +%s)"
        cp -a "$CONFIG_FILE" "$_cfg_backup" 2>/dev/null && \
            echo "  [配置修复] 已备份当前配置到: $_cfg_backup"

        # 只保留合法字段: enabled/appId/clientSecret/allowFrom/accounts
        # accounts 内每个条目也只保留: enabled/appId/clientSecret/allowFrom
        node -e "
          try {
            const fs = require('fs');
            const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
            const ch = cfg.channels?.qqbot;
            if (!ch) process.exit(0);

            const ALLOWED_ROOT = new Set(['enabled', 'appId', 'clientSecret', 'allowFrom', 'accounts']);
            const ALLOWED_ACCOUNT = new Set(['enabled', 'appId', 'clientSecret', 'allowFrom']);

            const cleaned = {};
            for (const k of Object.keys(ch)) {
              if (!ALLOWED_ROOT.has(k)) continue;
              if (k === 'accounts' && typeof ch.accounts === 'object' && ch.accounts !== null) {
                cleaned.accounts = {};
                for (const [accId, acc] of Object.entries(ch.accounts)) {
                  if (typeof acc !== 'object' || acc === null) continue;
                  const cleanedAcc = {};
                  for (const ak of Object.keys(acc)) {
                    if (ALLOWED_ACCOUNT.has(ak)) cleanedAcc[ak] = acc[ak];
                  }
                  if (Object.keys(cleanedAcc).length > 0) cleaned.accounts[accId] = cleanedAcc;
                }
                if (Object.keys(cleaned.accounts).length === 0) delete cleaned.accounts;
              } else {
                cleaned[k] = ch[k];
              }
            }

            cfg.channels.qqbot = cleaned;
            fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 4) + '\n');
            process.stdout.write('fixed');
          } catch (e) { process.stderr.write(String(e)); }
        " 2>/dev/null && log "config_fix" "success" "  [配置修复] ✅ 已清理 channels.qqbot 中不支持的字段" || \
            log "config_fix" "fail" "  [配置修复] ⚠️  自动修复失败，请手动编辑 $CONFIG_FILE"

        echo "  [配置修复] 如需恢复原配置: cp $_cfg_backup $CONFIG_FILE"
    fi

    ensure_valid_cwd
    _bak=""; [ -f "$CONFIG_FILE" ] && _bak="$(mktemp "${TMPDIR:-/tmp}/.qqbot-pre-doctor-XXXXXX")" && cp -a "$CONFIG_FILE" "$_bak"
    run_with_timeout 30 "doctor --fix" openclaw doctor --fix 2>&1 | head -20 | sed 's/^/    /' || true

    if [ -n "$_bak" ] && [ -f "$_bak" ] && [ -f "$CONFIG_FILE" ]; then
        _damaged=$(node -e "
          try {
            const fs = require('fs');
            const b = JSON.parse(fs.readFileSync('$_bak','utf8')), a = JSON.parse(fs.readFileSync('$CONFIG_FILE','utf8'));
            if (b.channels?.qqbot && !a.channels?.qqbot) process.stdout.write('channels.qqbot');
            else if (b.plugins?.installs?.['$PLUGIN_ID'] && !a.plugins?.installs?.['$PLUGIN_ID']) process.stdout.write('installs');
            else if (b.plugins?.entries?.['$PLUGIN_ID'] && !a.plugins?.entries?.['$PLUGIN_ID']) process.stdout.write('entries');
          } catch {}
        " 2>/dev/null || true)
        [ -n "$_damaged" ] && log "doctor_fix" "warn" "  ⚠️  doctor 误删 $_damaged，恢复中..." "damaged=$_damaged" && cp -a "$_bak" "$CONFIG_FILE" && echo "  ✅ 已恢复"
        rm -f "$_bak" 2>/dev/null || true
    fi

    echo ""; echo "  [重试] gateway restart..."
    ensure_valid_cwd
    RR=0; run_with_timeout 90 "gateway restart (重试)" openclaw gateway restart 2>&1 || RR=$?
    if [ $RR -eq 0 ]; then
        log "gateway_retry" "success" "  ✅ 重启成功"
        [ -n "$NEW_VERSION" ] && echo "" && echo "🎉 QQBot 插件已更新至 v${NEW_VERSION}，在线等候你的吩咐。"
    else
        log "gateway_retry" "fail" "  ❌ 仍无法重启，请手动排查:" "exit_code=$RR"
        echo "    openclaw doctor && openclaw gateway restart"
    fi
fi
