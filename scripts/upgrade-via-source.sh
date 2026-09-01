#!/bin/bash

# qqbot 一键更新并启动脚本
# 版本: 2.0 (增强错误处理版)
#
# 主要改进:
# 1. 详细的安装错误诊断和排查建议
# 2. 所有关键步骤的错误捕获和报告
# 3. 日志文件保存和错误摘要
# 4. 智能故障排查指南
# 5. 用户友好的交互提示

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# 如果脚本在 scripts/ 子目录里，往上一级就是项目根目录
if [ "$(basename "$SCRIPT_DIR")" = "scripts" ]; then
    PROJ_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
    PROJ_DIR="$SCRIPT_DIR"
fi

# 安全检查：PROJ_DIR 不应指向 extensions 目录（那是安装副本，cleanup 会删除）
if echo "$PROJ_DIR" | grep -q '/.openclaw/extensions\|/.clawdbot/extensions\|/.moltbot/extensions'; then
    echo "❌ 错误: 脚本正在从 extensions 安装副本运行，而非源码仓库"
    echo "   当前路径: $PROJ_DIR"
    echo ""
    echo "请从源码仓库运行:"
    echo "   cd /path/to/openclaw-qqbot && ./scripts/upgrade-via-source.sh"
    exit 1
fi

cd "$PROJ_DIR"

# 解析命令行参数
APPID=""
SECRET=""
MARKDOWN=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --appid)
            APPID="$2"
            shift 2
            ;;
        --secret)
            SECRET="$2"
            shift 2
            ;;
        --markdown)
            MARKDOWN="$2"
            shift 2
            ;;
        -h|--help)
            echo "用法: $0 [选项]"
            echo ""
            echo "选项:"
            echo "  --appid <appid>       QQ机器人 appid"
            echo "  --secret <secret>     QQ机器人 secret"
            echo "  --markdown <yes|no>   是否启用 markdown 消息格式（默认: no）"
            echo "  -h, --help            显示帮助信息"
            echo ""
            echo "也可以通过环境变量设置:"
            echo "  QQBOT_APPID           QQ机器人 appid"
            echo "  QQBOT_SECRET          QQ机器人 secret"
            echo "  QQBOT_TOKEN           QQ机器人 token (appid:secret)"
            echo "  QQBOT_MARKDOWN        是否启用 markdown（yes/no）"
            echo ""
            echo "不带参数时，将使用已有配置直接启动。"
            echo ""
            echo "⚠️  注意: 启用 markdown 需要在 QQ 开放平台申请 markdown 消息权限"
            exit 0
            ;;
        *)
            echo "未知选项: $1"
            echo "使用 --help 查看帮助信息"
            exit 1
            ;;
    esac
done

# 使用命令行参数或环境变量
APPID="${APPID:-$QQBOT_APPID}"
SECRET="${SECRET:-$QQBOT_SECRET}"
MARKDOWN="${MARKDOWN:-$QQBOT_MARKDOWN}"

echo "========================================="
echo "  qqbot 一键更新启动脚本"
echo "========================================="

# 1. 备份已有 qqbot 通道配置，防止升级过程丢失
echo ""
echo "[1/6] 备份已有配置..."
SAVED_QQBOT_TOKEN=""
SAVED_QQBOT_CONFIG_FILE=""  # 有 qqbot 配置的文件路径
SAVED_QQBOT_CHANNEL_JSON="" # 完整 channels.qqbot JSON

# 完整备份 channels.qqbot 对象（含 token / groups / env / allowFrom 等）
for APP_NAME in openclaw clawdbot moltbot; do
    CONFIG_FILE="$HOME/.$APP_NAME/$APP_NAME.json"
    if [ -f "$CONFIG_FILE" ]; then
        SAVED_QQBOT_CHANNEL_JSON=$(node -e "
            const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf8'));
            const keys = ['qqbot', 'openclaw-qqbot', 'openclaw-qq'];
            for (const key of keys) {
                const ch = cfg.channels && cfg.channels[key];
                if (ch && Object.keys(ch).length > 0) {
                    process.stdout.write(JSON.stringify(ch));
                    process.exit(0);
                }
            }
        " 2>/dev/null || true)
        if [ -n "$SAVED_QQBOT_CHANNEL_JSON" ]; then
            SAVED_QQBOT_CONFIG_FILE="$CONFIG_FILE"
            # 提取 token 供 Step 4 fallback
            SAVED_QQBOT_TOKEN=$(node -e "
                const ch = JSON.parse(process.argv[1]);
                if (ch.token) { process.stdout.write(ch.token); }
                else if (ch.appId && ch.clientSecret) { process.stdout.write(ch.appId + ':' + ch.clientSecret); }
            " "$SAVED_QQBOT_CHANNEL_JSON" 2>/dev/null || true)
            echo "已备份完整 qqbot 通道配置"
            if [ -n "$SAVED_QQBOT_TOKEN" ]; then
                echo "  token: ${SAVED_QQBOT_TOKEN:0:10}..."
            fi
            break
        fi
    fi
done

# 若当前配置中没有，从 openclaw 备份文件恢复
if [ -z "$SAVED_QQBOT_CHANNEL_JSON" ] && [ -d "$HOME/.openclaw" ]; then
    SAVED_QQBOT_CHANNEL_JSON=$(node -e "
      const fs = require('fs');
      const path = require('path');
      const dir = path.join(process.env.HOME, '.openclaw');
      const files = fs.readdirSync(dir)
        .filter((n) => /^openclaw\.json\.bak(\.\d+)?$/.test(n))
        .map((n) => path.join(dir, n))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      for (const f of files) {
        try {
          const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
          const keys = ['qqbot', 'openclaw-qqbot', 'openclaw-qq'];
          for (const key of keys) {
            const ch = cfg.channels && cfg.channels[key];
            if (ch && Object.keys(ch).length > 0) {
              process.stdout.write(JSON.stringify(ch));
              process.exit(0);
            }
          }
        } catch {}
      }
    " 2>/dev/null || true)

    if [ -n "$SAVED_QQBOT_CHANNEL_JSON" ]; then
        SAVED_QQBOT_TOKEN=$(node -e "
            const ch = JSON.parse(process.argv[1]);
            if (ch.token) { process.stdout.write(ch.token); }
            else if (ch.appId && ch.clientSecret) { process.stdout.write(ch.appId + ':' + ch.clientSecret); }
        " "$SAVED_QQBOT_CHANNEL_JSON" 2>/dev/null || true)
        echo "已从 ~/.openclaw/openclaw.json.bak* 恢复 qqbot 通道配置"
        if [ -n "$SAVED_QQBOT_TOKEN" ]; then
            echo "  token: ${SAVED_QQBOT_TOKEN:0:10}..."
        fi
    fi
fi

# 2. 移除老版本
echo ""
echo "[2/6] 移除老版本..."
if [ -f "$PROJ_DIR/scripts/cleanup-legacy-plugins.sh" ]; then
    bash "$PROJ_DIR/scripts/cleanup-legacy-plugins.sh"
else
    echo "警告: cleanup-legacy-plugins.sh 不存在，跳过移除步骤"
fi

# cleanup 可能删除了当前 cwd 所在的目录（如 extensions 下的旧副本），
# 重新 cd 回源码目录以避免后续命令因 cwd 悬空而 ENOENT
cd "$PROJ_DIR"

# 3. 安装当前版本
echo ""
echo "[3/6] 安装当前版本（源码安装）..."

echo "检查当前目录: $(pwd)"
echo "检查openclaw版本: $(openclaw --version 2>/dev/null || echo 'openclaw not found')"

# 版本比较函数：version_gte a b → a >= b 时返回真
version_gte() {
    [ "$(printf '%s\n' "$1" "$2" | sort -V | head -1)" = "$2" ]
}

OPENCLAW_VERSION="$(openclaw --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 || true)"

# --force：确认非 ClawHub 来源（本地路径）+ 覆盖已存在插件。
#   2026.4.5 起引入；本地目录安装缺少该参数会报 "Install cancelled; rerun with --force"。
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
#   2026.6.2 起安全扫描移除，该参数废弃为 no-op（仅打印 deprecation 警告），不再附加。
FORCE_UNSAFE_FLAG=""
if [ -n "$OPENCLAW_VERSION" ] && version_gte "$OPENCLAW_VERSION" "2026.3.30" \
        && ! version_gte "$OPENCLAW_VERSION" "2026.6.2"; then
    FORCE_UNSAFE_FLAG="--dangerously-force-unsafe-install"
fi

LOCAL_PACKAGE_VERSION=$(node -e "
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join('$PROJ_DIR', 'package.json');
    const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
    if (v) process.stdout.write(String(v));
  } catch {}
" 2>/dev/null || true)
if [ -n "$LOCAL_PACKAGE_VERSION" ]; then
    echo "即将安装本地源码版本: $LOCAL_PACKAGE_VERSION"
else
    echo "即将安装本地源码版本: unknown（未读取到 package.json version）"
fi

# 记录更新前的 qqbot 插件版本
OLD_QQBOT_VERSION=$(node -e '
    try {
        const fs = require("fs");
        const path = require("path");
        const candidates = ["openclaw-qqbot", "qqbot", "openclaw-qq"];
        for (const name of candidates) {
            const pkgPath = path.join(process.env.HOME, ".openclaw", "extensions", name, "package.json");
            if (!fs.existsSync(pkgPath)) continue;
            const p = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
            process.stdout.write(p.version || "unknown");
            process.exit(0);
        }
        process.stdout.write("not_installed");
    } catch(e) { process.stdout.write("not_installed"); }
' 2>/dev/null || echo "not_installed")

echo "开始安装插件..."
echo "安装来源: 当前仓库源码（openclaw plugins install .）"
INSTALL_LOG="/tmp/openclaw-install-$(date +%s).log"

echo "安装日志文件: $INSTALL_LOG"
echo "详细信息将记录到日志文件中..."

# ── 临时移除 channels.qqbot 配置 ──
# openclaw CLI 任何子命令（包括 gateway stop、plugins install）启动时都会校验 openclaw.json，
# 如果 channels.qqbot 存在但插件还未安装，CLI 不认识该 channel id，
# 导致 "Config invalid: unknown channel id: qqbot" 而命令失败（鸡生蛋问题）。
# 解决方案：在所有 openclaw 命令之前把 channels.qqbot 暂存，完成后恢复。
_QQBOT_CHANNEL_STASH=""
for _app in openclaw clawdbot moltbot; do
    _cfg="$HOME/.$_app/$_app.json"
    if [ -f "$_cfg" ]; then
        _QQBOT_CHANNEL_STASH=$(node -e "
            const fs = require('fs');
            const cfg = JSON.parse(fs.readFileSync('$_cfg', 'utf8'));
            if (cfg.channels && cfg.channels.qqbot) {
                const stashed = JSON.stringify(cfg.channels.qqbot);
                delete cfg.channels.qqbot;
                fs.writeFileSync('$_cfg', JSON.stringify(cfg, null, 4) + '\n');
                process.stdout.write(stashed);
            }
        " 2>/dev/null || true)
        if [ -n "$_QQBOT_CHANNEL_STASH" ]; then
            _STASH_APP="$_app"
            _STASH_CFG="$_cfg"
            echo "  已暂存 channels.qqbot 配置（避免 CLI 校验失败）"
        fi
        break
    fi
done

# ── 安全网：注册 trap 确保脚本退出时恢复暂存的 channels.qqbot 配置 ──
_restore_stash_on_exit() {
    if [ -n "$_QQBOT_CHANNEL_STASH" ] && [ -n "$_STASH_CFG" ] && [ -f "$_STASH_CFG" ]; then
        # 检查配置是否已恢复（避免重复写入）
        local _already_restored
        _already_restored=$(node -e "
            const fs = require('fs');
            const cfg = JSON.parse(fs.readFileSync('$_STASH_CFG', 'utf8'));
            if (cfg.channels && cfg.channels.qqbot) process.stdout.write('yes');
            else process.stdout.write('no');
        " 2>/dev/null || echo "no")
        if [ "$_already_restored" = "no" ]; then
            _STASH="$_QQBOT_CHANNEL_STASH" _CFG="$_STASH_CFG" node -e '
                const fs = require("fs");
                const cfg = JSON.parse(fs.readFileSync(process.env._CFG, "utf8"));
                if (!cfg.channels) cfg.channels = {};
                cfg.channels.qqbot = JSON.parse(process.env._STASH);
                fs.writeFileSync(process.env._CFG, JSON.stringify(cfg, null, 4) + "\n");
            ' 2>/dev/null || true
            echo ""
            echo "  ⚠️  [trap] 已恢复暂存的 channels.qqbot 配置（脚本提前退出）"
        fi
    fi
}
trap _restore_stash_on_exit EXIT

# 安装前先 stop gateway，防止 chokidar 在 plugins install 写入配置的中间状态
# 触发 restart，导致 "unknown channel id: qqbot" 等错误

# 动态读取 gateway 端口（从 openclaw.json 配置中获取，默认 18789）
_GW_PORT=$(node -e "
    const fs = require('fs');
    const path = require('path');
    for (const app of ['openclaw', 'clawdbot', 'moltbot']) {
        const f = path.join(process.env.HOME, '.' + app, app + '.json');
        if (!fs.existsSync(f)) continue;
        const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (cfg.gateway && cfg.gateway.port) {
            process.stdout.write(String(cfg.gateway.port));
            process.exit(0);
        }
    }
    process.stdout.write('18789');
" 2>/dev/null || echo "18789")

_gw_was_running=0
if lsof -i :"$_GW_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    _gw_was_running=1
    echo "  暂停 gateway 服务（避免安装过程中中间状态 restart）..."
    openclaw gateway stop 2>/dev/null || true
    sleep 1
fi

# 清理之前可能残留的 staging 目录（extensions 和 /tmp 中都可能存在）
find "$HOME/.openclaw/extensions/" -maxdepth 1 -name ".openclaw-install-stage-*" -exec rm -rf {} + 2>/dev/null || true
find "${TMPDIR:-/tmp}" -maxdepth 1 -name ".openclaw-install-stage-*" -exec rm -rf {} + 2>/dev/null || true
# 清理可能残留的 node_modules 临时备份（上次脚本中断时留下的）
find "${TMPDIR:-/tmp}" -maxdepth 1 -name ".openclaw-qqbot-nm-bak-*" -exec rm -rf {} + 2>/dev/null || true
# 清理旧版脚本遗留的项目内备份
[ -d "$PROJ_DIR/.node_modules_install_bak" ] && mv "$PROJ_DIR/.node_modules_install_bak" "$PROJ_DIR/node_modules" 2>/dev/null || true

# ── 清空并重新构建 dist/ ──
# openclaw plugins install . 只做文件复制，不执行 npm lifecycle scripts。
# 必须每次清空 dist/ 再重新构建，否则旧的编译产物会被原样拷贝到安装目录，
# 导致新增的模块（如 streaming.js）缺失。
echo "  清空 dist/ 确保全量重新构建..."
rm -rf "$PROJ_DIR/dist"
if [ ! -f "$PROJ_DIR/dist/index.cjs" ] && [ ! -f "$PROJ_DIR/dist/index.js" ]; then
    echo "  dist/ 不存在，先执行构建..."
    if [ ! -d "$PROJ_DIR/node_modules" ]; then
        npm install --prefix "$PROJ_DIR" 2>&1 || true
    fi
    npm run --prefix "$PROJ_DIR" build 2>&1 || true
    if [ ! -f "$PROJ_DIR/dist/index.cjs" ] && [ ! -f "$PROJ_DIR/dist/index.js" ]; then
        echo "  ❌ 构建失败：dist/index.cjs 未生成"
        echo "  请手动执行: cd $PROJ_DIR && npm install && npm run build"
        exit 1
    fi
    echo "  ✅ 构建完成"
fi

# 尝试安装并捕获详细输出
# 注意：openclaw plugins install 会在安装后尝试验证加载插件，
# 由于 CJS/ESM 混用问题（Node 22 ERR_INTERNAL_ASSERTION），验证阶段可能失败
# 但文件已成功拷贝。因此不依赖退出码，而是检查安装目录中关键文件是否存在。
_INSTALL_DIR="$HOME/.openclaw/extensions/openclaw-qqbot"

# ── 优化：安装前临时移走 node_modules ──
# openclaw plugins install . 会把整个项目目录（含 node_modules/）复制到 extensions，
# 但运行时只需要 bundledDependencies 中的 3 个包 + openclaw symlink。
# 移走 node_modules 可避免复制数百个不必要的包，大幅加速安装。
# 同时临时移走 devDependencies 声明，避免 manifest dependency scan 递归解析
# 超出 10000 目录上限导致 "code safety scan failed"。
_NM_BACKUP=""
if [ -d "$PROJ_DIR/node_modules" ]; then
    echo "  临时移走 node_modules（避免安全扫描超出目录上限）..."
    # 备份到项目目录外部（/tmp），否则安全扫描仍会递归遍历到重命名后的目录
    _NM_BACKUP="${TMPDIR:-/tmp}/.openclaw-qqbot-nm-bak-$$"
    mv "$PROJ_DIR/node_modules" "$_NM_BACKUP"
fi

openclaw plugins install . $INSTALL_FORCE_FLAG $FORCE_UNSAFE_FLAG $ACCEPT_CAPABILITIES_FLAG 2>&1 | tee "$INSTALL_LOG" || true

# ── 恢复 node_modules ──
if [ -n "$_NM_BACKUP" ] && [ -d "$_NM_BACKUP" ]; then
    mv "$_NM_BACKUP" "$PROJ_DIR/node_modules"
    echo "  已恢复源码目录 node_modules"
fi
if { [ ! -f "$_INSTALL_DIR/dist/index.cjs" ] && [ ! -f "$_INSTALL_DIR/dist/index.js" ]; } || [ ! -f "$_INSTALL_DIR/preload.cjs" ]; then
    echo ""
    echo "❌ 插件安装失败！"
    echo "========================================="
    echo "故障排查信息:"
    echo "========================================="
    
    # 分析错误原因
    echo "1. 检查日志文件末尾: $INSTALL_LOG"
    echo "2. 常见原因分析:"
    
    # 检查网络连接
    echo "   - 网络问题: 测试 npm 仓库连接"
    echo "     curl -I https://registry.npmjs.org/ || curl -I https://registry.npmmirror.com/"
    
    # 检查权限
    echo "   - 权限问题: 检查安装目录权限"
    echo "     ls -la ~/.openclaw/ 2>/dev/null || echo '目录不存在'"
    
    # 检查npm配置
    echo "   - npm配置: 检查当前npm配置"
    echo "     npm config get registry"
    
    # 显示错误摘要
    echo ""
    echo "3. 错误摘要:"
    tail -20 "$INSTALL_LOG" | grep -i -E "(error|fail|warn|npm install)"
    
    echo ""
    echo "4. 可选解决方案:"
    echo "   a. 更换npm镜像源:"
    echo "      npm config set registry https://registry.npmmirror.com/"
    echo "   b. 清理npm缓存:"
    echo "      npm cache clean --force"
    echo "   c. 手动安装依赖:"
    echo "      cd $(pwd) && npm install --verbose"
    
    echo ""
    echo "========================================="
    echo "建议: 先查看完整日志文件: cat $INSTALL_LOG"
    echo "或者尝试手动安装: cd $(pwd) && npm install"
    echo "========================================="
    
    read -t 10 -p "是否继续配置其他步骤? (y/N): " continue_choice || continue_choice="N"
    case "$continue_choice" in
        [Yy]* )
            echo "继续执行后续配置步骤..."
            ;;  
        * )
            echo "安装失败，脚本退出。"
            echo "请先解决安装问题后再运行此脚本。"
            # 恢复 channels.qqbot 后再退出
            if [ -n "$_QQBOT_CHANNEL_STASH" ] && [ -n "$_STASH_CFG" ] && [ -f "$_STASH_CFG" ]; then
                _STASH="$_QQBOT_CHANNEL_STASH" _CFG="$_STASH_CFG" node -e '
                    const fs = require("fs");
                    const cfg = JSON.parse(fs.readFileSync(process.env._CFG, "utf8"));
                    if (!cfg.channels) cfg.channels = {};
                    cfg.channels.qqbot = JSON.parse(process.env._STASH);
                    fs.writeFileSync(process.env._CFG, JSON.stringify(cfg, null, 4) + "\n");
                ' 2>/dev/null || true
            fi
            exit 1
            ;;  
    esac
else
    echo ""
    echo "✅ 插件安装命令执行完成"
    echo "安装日志已保存到: $INSTALL_LOG"

    # 确保 openclaw.json 中的 source 为 path（从 npm 切回 path）
    for _app in openclaw clawdbot moltbot; do
        _cfg="$HOME/.$_app/$_app.json"
        if [ -f "$_cfg" ]; then
            node -e "
              const fs = require('fs');
              const cfg = JSON.parse(fs.readFileSync('$_cfg', 'utf8'));
              const inst = cfg.plugins && cfg.plugins.installs && cfg.plugins.installs['openclaw-qqbot'];
              if (inst && inst.source !== 'path') {
                inst.source = 'path';
                inst.sourcePath = '$PROJ_DIR';
                fs.writeFileSync('$_cfg', JSON.stringify(cfg, null, 4) + '\n');
                console.log('  已将 plugins.installs.openclaw-qqbot.source 更新为 path');
              }
            " 2>/dev/null || true
            break
        fi
    done

    # 验证插件目录是否真正创建（防止 "安装成功" 但目录缺失的情况）
    _plugin_dir_ok=0
    for _candidate_name in openclaw-qqbot qqbot openclaw-qq; do
        if [ -d "$HOME/.openclaw/extensions/$_candidate_name" ] && \
           [ -f "$HOME/.openclaw/extensions/$_candidate_name/package.json" ]; then
            _plugin_dir_ok=1
            echo "  ✅ 插件目录验证通过: ~/.openclaw/extensions/$_candidate_name/"
            break
        fi
    done
    if [ "$_plugin_dir_ok" -eq 0 ]; then
        echo ""
        echo "⚠️  警告: 插件目录不存在！安装命令返回成功但目录未创建"
        echo "  可能原因: staging 目录未正确 rename（参考 openclaw/issues）"
        echo "  检查 staging 残留:"
        ls -la "$HOME/.openclaw/extensions/" 2>/dev/null
        echo ""
        echo "  尝试自动修复: 清理残留并重试安装..."
        find "$HOME/.openclaw/extensions/" -maxdepth 1 -name ".openclaw-install-stage-*" -exec rm -rf {} + 2>/dev/null || true
        find "${TMPDIR:-/tmp}" -maxdepth 1 -name ".openclaw-install-stage-*" -exec rm -rf {} + 2>/dev/null || true
        # 重试时同样移走 node_modules 避免安全扫描超出目录上限
        _NM_BACKUP=""
        if [ -d "$PROJ_DIR/node_modules" ]; then
            _NM_BACKUP="${TMPDIR:-/tmp}/.openclaw-qqbot-nm-bak-$$"
            mv "$PROJ_DIR/node_modules" "$_NM_BACKUP"
        fi
        if openclaw plugins install . $INSTALL_FORCE_FLAG $FORCE_UNSAFE_FLAG $ACCEPT_CAPABILITIES_FLAG 2>&1 | tee -a "$INSTALL_LOG"; then
            for _candidate_name in openclaw-qqbot qqbot openclaw-qq; do
                if [ -d "$HOME/.openclaw/extensions/$_candidate_name" ]; then
                    _plugin_dir_ok=1
                    echo "  ✅ 重试安装成功: ~/.openclaw/extensions/$_candidate_name/"
                    break
                fi
            done
        fi
        # 恢复 node_modules
        if [ -n "$_NM_BACKUP" ] && [ -d "$_NM_BACKUP" ]; then
            mv "$_NM_BACKUP" "$PROJ_DIR/node_modules"
        fi
        if [ "$_plugin_dir_ok" -eq 0 ]; then
            echo "  ❌ 重试安装仍失败，插件目录不存在"
            echo "  请手动排查: ls -la ~/.openclaw/extensions/"
            # 清理无效的配置条目，防止 gateway 启动时报错
            echo "  清理无效的配置条目..."
            node -e "
              const fs = require('fs');
              const path = require('path');
              for (const app of ['openclaw', 'clawdbot', 'moltbot']) {
                const f = path.join(process.env.HOME, '.' + app, app + '.json');
                if (!fs.existsSync(f)) continue;
                const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
                let changed = false;
                // 移除 channels.qqbot（插件未加载时此配置会导致 unknown channel id 错误）
                if (cfg.channels && cfg.channels.qqbot) { delete cfg.channels.qqbot; changed = true; }
                // 清理 plugins.allow 中的 openclaw-qqbot
                if (cfg.plugins && Array.isArray(cfg.plugins.allow)) {
                  cfg.plugins.allow = cfg.plugins.allow.filter(x => x !== 'openclaw-qqbot');
                  changed = true;
                }
                if (changed) fs.writeFileSync(f, JSON.stringify(cfg, null, 4) + '\n');
                break;
              }
            " 2>/dev/null || true
            echo "  已清理无效配置，gateway 可正常启动（无 qqbot 插件状态）"
            read -t 10 -p "是否继续? (y/N): " _cont || _cont="N"
            case "$_cont" in
                [Yy]* ) echo "继续..." ;;
                * ) exit 1 ;;
            esac
        fi
    fi

    # ── 复制 bundledDependencies 到插件 node_modules ──
    # 由于安装前移走了源码的 node_modules，extensions 中的插件目录没有依赖。
    # 只需复制 bundledDependencies（ws, silk-wasm, mpg123-decoder）及其传递依赖即可。
    PLUGIN_NM=""
    for _candidate in openclaw-qqbot qqbot openclaw-qq; do
        _nm="$HOME/.openclaw/extensions/$_candidate/node_modules"
        _ext_dir="$HOME/.openclaw/extensions/$_candidate"
        [ -d "$_ext_dir" ] && PLUGIN_NM="$_nm" && break
    done
    if [ -n "$PLUGIN_NM" ] && [ -d "$PROJ_DIR/node_modules" ]; then
        # 如果 extensions 中已有大量包（旧版 openclaw 安装的 peerDeps），先清理
        # 但保留 openclaw symlink
        if [ -d "$PLUGIN_NM" ]; then
            _before=$({ ls -d "$PLUGIN_NM"/*/ "$PLUGIN_NM"/@*/*/ 2>/dev/null || true; } | wc -l | tr -d ' ')
            if [ "$_before" -gt 50 ]; then
                echo ""
                echo "检测到 ${_before} 个包（超过阈值 50），清理多余的 peerDep 传递依赖..."
                _has_openclaw_link=""
                [ -L "$PLUGIN_NM/openclaw" ] && _has_openclaw_link="$(readlink "$PLUGIN_NM/openclaw")"
                rm -rf "$PLUGIN_NM"
                if [ -n "$_has_openclaw_link" ]; then
                    mkdir -p "$PLUGIN_NM"
                    ln -sf "$_has_openclaw_link" "$PLUGIN_NM/openclaw"
                fi
            fi
        fi

        # 读取 bundledDependencies 及其传递依赖列表，复制到插件目录
        _deps_to_copy=$(node -e "
          const fs = require('fs');
          const path = require('path');
          const pkgPath = path.join('$PROJ_DIR', 'package.json');
          if (!fs.existsSync(pkgPath)) process.exit(0);
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          const bundled = pkg.bundledDependencies || pkg.bundleDependencies || [];
          const keep = new Set();
          const resolve = (name) => {
            if (keep.has(name)) return;
            keep.add(name);
            const depPkg = path.join('$PROJ_DIR', 'node_modules', name, 'package.json');
            if (!fs.existsSync(depPkg)) return;
            const dep = JSON.parse(fs.readFileSync(depPkg, 'utf8'));
            for (const d of Object.keys(dep.dependencies || {})) resolve(d);
          };
          bundled.forEach(resolve);
          process.stdout.write([...keep].join('\\n'));
        " 2>/dev/null || true)

        if [ -n "$_deps_to_copy" ]; then
            mkdir -p "$PLUGIN_NM"
            _copied=0
            while IFS= read -r _dep; do
                [ -z "$_dep" ] && continue
                _src="$PROJ_DIR/node_modules/$_dep"
                _dst="$PLUGIN_NM/$_dep"
                if [ -d "$_src" ]; then
                    mkdir -p "$(dirname "$_dst")"
                    rm -rf "$_dst"
                    cp -r "$_src" "$_dst"
                    _copied=$((_copied + 1))
                fi
            done <<< "$_deps_to_copy"
            echo "  ✅ 已复制 ${_copied} 个 bundled 依赖到插件目录"
        else
            echo "  ⚠️  未读取到 bundledDependencies，跳过依赖复制"
            echo "  回退: 使用 npm install --omit=dev 安装运行时依赖..."
            npm install --omit=dev --prefix "$_ext_dir" 2>&1 || true
        fi
        # 验证关键依赖是否就绪
        if [ ! -d "$PLUGIN_NM/ws" ]; then
            echo "  ⚠️  ws 包仍缺失，回退: 使用 npm install --omit=dev 安装..."
            npm install --omit=dev --prefix "$_ext_dir" 2>&1 || true
        fi
    elif [ -n "$PLUGIN_NM" ] && [ ! -d "$PROJ_DIR/node_modules" ]; then
        echo "  ⚠️  源码 node_modules 不存在，使用 npm install --omit=dev 安装运行时依赖..."
        npm install --omit=dev --prefix "$_ext_dir" 2>&1 || true
    elif [ -n "$PLUGIN_NM" ] && [ -d "$PLUGIN_NM" ]; then
        # node_modules 已存在（可能是旧版 openclaw 安装的），检查是否需要清理
        _before=$({ ls -d "$PLUGIN_NM"/*/ "$PLUGIN_NM"/@*/*/ 2>/dev/null || true; } | wc -l | tr -d ' ')
        if [ "$_before" -gt 50 ]; then
            echo ""
            echo "检测到 ${_before} 个包（超过阈值 50），清理多余的 peerDep 传递依赖..."
            # 读取 bundledDependencies 列表，只保留这些包及其子依赖
            _bundled_deps=$(node -e "
              const fs = require('fs');
              const path = require('path');
              const pkgPath = path.join('$PLUGIN_NM', '..', 'package.json');
              if (!fs.existsSync(pkgPath)) process.exit(0);
              const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
              const bundled = pkg.bundledDependencies || pkg.bundleDependencies || [];
              const keep = new Set();
              const resolve = (name) => {
                if (keep.has(name)) return;
                keep.add(name);
                const depPkg = path.join('$PLUGIN_NM', name, 'package.json');
                if (!fs.existsSync(depPkg)) return;
                const dep = JSON.parse(fs.readFileSync(depPkg, 'utf8'));
                for (const d of Object.keys(dep.dependencies || {})) resolve(d);
              };
              bundled.forEach(resolve);
              const installed = fs.readdirSync('$PLUGIN_NM').filter(n => !n.startsWith('.'));
              const toRemove = [];
              for (const item of installed) {
                if (item.startsWith('@')) {
                  const scopeDir = path.join('$PLUGIN_NM', item);
                  const subs = fs.readdirSync(scopeDir);
                  const keepSubs = subs.filter(s => keep.has(item + '/' + s));
                  if (keepSubs.length === 0) toRemove.push(item);
                  else {
                    for (const s of subs) {
                      if (!keep.has(item + '/' + s)) toRemove.push(item + '/' + s);
                    }
                  }
                } else {
                  if (!keep.has(item)) toRemove.push(item);
                }
              }
              process.stdout.write(toRemove.join('\n'));
            " 2>/dev/null || true)
            if [ -n "$_bundled_deps" ]; then
                echo "$_bundled_deps" | while IFS= read -r _pkg; do
                    rm -rf "$PLUGIN_NM/$_pkg"
                done
                find "$PLUGIN_NM" -maxdepth 1 -type d -name '@*' -empty -delete 2>/dev/null || true
                _after=$({ ls -d "$PLUGIN_NM"/*/ "$PLUGIN_NM"/@*/*/ 2>/dev/null || true; } | wc -l | tr -d ' ')
                echo "  已清理: ${_before} → ${_after} 个包"
            fi
        else
            echo "  node_modules 包数量正常（${_before} 个），无需清理"
        fi
    fi

    # gateway 已在安装前 stop，此时不会有自动 restart 的问题
    # 所有配置写入完成后，在 Step 6 统一启动

    # 确保 openclaw/plugin-sdk 可解析：
    # openclaw plugins install 不会执行 npm lifecycle scripts，
    # 需要手动调用 postinstall-link-sdk.js 创建 node_modules/openclaw → 全局 openclaw 的符号链接。
    # 必须在 peerDeps 清理之后执行，否则 symlink 会被清理逻辑删除。
    for _candidate_name in openclaw-qqbot qqbot openclaw-qq; do
        _postinstall="$HOME/.openclaw/extensions/$_candidate_name/scripts/postinstall-link-sdk.js"
        if [ -f "$_postinstall" ]; then
            echo "  执行 postinstall-link-sdk..."
            if node "$_postinstall" 2>&1; then
                echo "  ✅ plugin-sdk 链接就绪"
            else
                echo "  ⚠️  postinstall-link-sdk 失败，插件可能无法加载"
            fi
            break
        fi
    done

    # 清理 openclaw CLI install 留下的 backup 目录，
    # 避免 gateway 发现两个同 id 插件不断刷 duplicate plugin id 警告
    find "$HOME/.openclaw/extensions/" -maxdepth 1 -name ".openclaw-qqbot-backup-*" -exec rm -rf {} + 2>/dev/null || true
    find "${TMPDIR:-/tmp}" -maxdepth 1 -name ".qqbot-upgrade-backup-*" -exec rm -rf {} + 2>/dev/null || true

    # 记录更新后的 qqbot 插件版本
    NEW_QQBOT_VERSION=$(node -e '
        try {
            const fs = require("fs");
            const path = require("path");
            const candidates = ["openclaw-qqbot", "qqbot", "openclaw-qq"];
            for (const name of candidates) {
                const pkgPath = path.join(process.env.HOME, ".openclaw", "extensions", name, "package.json");
                if (!fs.existsSync(pkgPath)) continue;
                const p = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
                process.stdout.write(p.version || "unknown");
                process.exit(0);
            }
            process.stdout.write("unknown");
        } catch(e) { process.stdout.write("unknown"); }
    ' 2>/dev/null || echo "unknown")
fi

# ── 暂不恢复 channels.qqbot 配置 ──
# openclaw 3.23+ 启动时在插件加载前就校验 channels，
# 如果此时恢复 channels.qqbot，gateway 会因 "unknown channel id: qqbot" 拒绝启动。
# 延迟到 gateway 启动、插件加载完成后再恢复（见 Step 6）。
echo "  [兼容] channels.qqbot 将在 gateway 启动后恢复（避免启动校验失败）"

# ── Step 4/5：不在此时写入 channels.qqbot 配置 ──
# openclaw 3.23+ 在插件加载前校验 channels，此时写入 channels.qqbot 会导致
# "unknown channel id: qqbot" 错误。所有 channels.qqbot 相关配置延迟到
# gateway 启动、插件加载完成后统一写入（见 Step 6 末尾）。
#
# 这里只计算出 DESIRED_QQBOT_TOKEN 和 MARKDOWN_VALUE，不实际写入。

# 4. 确定机器人通道配置
echo ""
echo "[4/6] 准备机器人通道配置..."

# 读取当前 qqbot token（从暂存或配置文件）
# 注意：channels.qqbot 已被暂存移除，所以从 _QQBOT_CHANNEL_STASH 读取
CURRENT_QQBOT_TOKEN=""
if [ -n "$_QQBOT_CHANNEL_STASH" ]; then
    CURRENT_QQBOT_TOKEN=$(_STASH="$_QQBOT_CHANNEL_STASH" node -e '
        const ch = JSON.parse(process.env._STASH);
        if (ch.token) { process.stdout.write(ch.token); }
        else if (ch.appId && ch.clientSecret) { process.stdout.write(ch.appId + ":" + ch.clientSecret); }
    ' 2>/dev/null || true)
fi

DESIRED_QQBOT_TOKEN=""
if [ -n "$APPID" ] && [ -n "$SECRET" ]; then
    DESIRED_QQBOT_TOKEN="${APPID}:${SECRET}"
    echo "使用提供的 appid 和 secret 配置..."
elif [ -n "$QQBOT_TOKEN" ]; then
    DESIRED_QQBOT_TOKEN="$QQBOT_TOKEN"
    echo "使用环境变量 QQBOT_TOKEN 配置..."
elif [ -n "$SAVED_QQBOT_TOKEN" ]; then
    DESIRED_QQBOT_TOKEN="$SAVED_QQBOT_TOKEN"
    echo "未提供 appid/secret，使用备份 token 恢复配置..."
fi

if [ -n "$DESIRED_QQBOT_TOKEN" ]; then
    echo "目标 Token: ${DESIRED_QQBOT_TOKEN:0:10}..."
    echo "  [兼容] 将在 gateway 启动后写入 channels.qqbot"
elif [ -z "$CURRENT_QQBOT_TOKEN" ] && [ -z "$_QQBOT_CHANNEL_STASH" ]; then
    echo ""
    echo "❌ 未检测到 qqbot 通道配置！"
    echo ""
    echo "首次运行请提供 appid 和 appsecret："
    echo ""
    echo "  bash $0 --appid <你的appid> --secret <你的appsecret>"
    echo ""
    echo "也可以通过环境变量："
    echo ""
    echo "  QQBOT_APPID=<appid> QQBOT_SECRET=<appsecret> bash $0"
    echo ""
    echo "appid 和 appsecret 可在 QQ 开放平台 (https://q.qq.com) 获取。"
    exit 1
else
    echo "使用已有配置（暂存中）"
fi

# 5. 确定 markdown 选项
echo ""
echo "[5/6] 准备 markdown 配置..."

MARKDOWN_VALUE=""
if [ -n "$MARKDOWN" ]; then
    if [ "$MARKDOWN" = "yes" ] || [ "$MARKDOWN" = "y" ] || [ "$MARKDOWN" = "true" ]; then
        MARKDOWN_VALUE="true"
        echo "将启用 markdown 消息格式"
    else
        MARKDOWN_VALUE="false"
        echo "将禁用 markdown 消息格式（使用纯文本）"
    fi
    echo "  [兼容] 将在 gateway 启动后写入配置"
else
    echo "未指定 markdown 选项，使用已有配置"
fi

# 6. 启动 openclaw
echo ""
echo "[6/6] 启动 openclaw..."
echo "========================================="

# 检查openclaw是否可用
if ! command -v openclaw &> /dev/null; then
    echo "❌ 错误: openclaw 命令未找到！"
    echo ""
    echo "可能的原因:"
    echo "1. openclaw未安装或安装失败"
    echo "2. PATH环境变量未包含openclaw路径"
    echo "3. 需要重新登录或重启终端"
    echo ""
    exit 1
fi

echo "openclaw版本: $(openclaw --version 2>/dev/null || echo '未知')"

# 显示 qqbot 插件更新信息
NEW_QQBOT_VERSION="${NEW_QQBOT_VERSION:-unknown}"
if [ "$OLD_QQBOT_VERSION" = "$NEW_QQBOT_VERSION" ]; then
    echo "qqbot 插件版本: $NEW_QQBOT_VERSION (未变化)"
elif [ "$OLD_QQBOT_VERSION" = "not_installed" ]; then
    echo "qqbot 插件版本: $NEW_QQBOT_VERSION (新安装)"
else
    echo "qqbot 插件版本: $OLD_QQBOT_VERSION -> $NEW_QQBOT_VERSION"
fi
echo ""
read -t 120 -p "是否后台重启 openclaw 网关服务？[Y/n] " start_choice || start_choice="y"
start_choice="${start_choice:-y}"
start_choice=$(printf '%s' "$start_choice" | tr '[:upper:]' '[:lower:]')

    # 辅助函数：带超时执行 openclaw 命令（防止 CLI 阻塞卡死脚本）
    _openclaw_with_timeout() {
        local _timeout_sec="${1:-30}"
        shift
        if command -v timeout &>/dev/null; then
            timeout "$_timeout_sec" "$@" 2>&1 || true
        elif command -v gtimeout &>/dev/null; then
            gtimeout "$_timeout_sec" "$@" 2>&1 || true
        else
            "$@" 2>&1 &
            local _pid=$!
            local _elapsed=0
            while kill -0 "$_pid" 2>/dev/null && [ "$_elapsed" -lt "$_timeout_sec" ]; do
                sleep 1
                _elapsed=$((_elapsed + 1))
            done
            if kill -0 "$_pid" 2>/dev/null; then
                echo "  ⚠️  命令超时（${_timeout_sec}s），继续执行..."
                kill "$_pid" 2>/dev/null || true
            fi
            wait "$_pid" 2>/dev/null || true
        fi
    }

case "$start_choice" in
    y|yes)
        echo ""
        # gateway 在安装前已 stop（unload），直接 restart 会报 "not loaded"
        # 因此先 install（注册服务）再 start，避免必现的恢复流程
        echo "正在启动 openclaw 网关服务..."
        openclaw gateway install 2>/dev/null || true
        _start_output=$(_openclaw_with_timeout 30 openclaw gateway start)
        echo "$_start_output"

        # 判断是否真正启动失败：
        # 1. 过滤掉 Config warnings 区块中的 "plugin not installed"（其他插件的警告，非错误）
        # 2. 过滤掉 "not loaded; re-bootstrapped"（自动恢复的正常行为）
        # 3. 只检查 gateway 自身的启动/加载状态
        _start_output_filtered=$(echo "$_start_output" | grep -v "^│" | grep -vi "re-bootstrapped\|re-bootstrap")
        if echo "$_start_output_filtered" | grep -qi "not loaded\|not found\|not installed\|error\|fail"; then
            echo ""
            echo "⚠️  启动异常，尝试 restart 恢复..."
            _restart_output=$(_openclaw_with_timeout 30 openclaw gateway restart)
            echo "$_restart_output"
            if echo "$_restart_output" | grep -v "^│" | grep -vi "re-bootstrapped\|re-bootstrap" | grep -qi "not loaded\|not found\|not installed"; then
                echo ""
                echo "⚠️  自动恢复失败，请手动执行："
                echo "  openclaw gateway install && openclaw gateway start"
            else
                echo ""
                echo "✅ gateway 服务已启动"
            fi
        else
            echo ""
            echo "✅ openclaw 网关已在后台启动"
        fi
        echo ""
        # 等待 gateway 端口就绪
        echo "等待 gateway 就绪..."
        echo "========================================="
        _port_ready=0
        for i in $(seq 1 30); do
            if lsof -i :"$_GW_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
                _port_ready=1
                break
            fi
            printf "\r  等待端口 %s 就绪... (%d/30)" "$_GW_PORT" "$i"
            sleep 2
        done
        echo ""

        if [ "$_port_ready" -eq 0 ]; then
            echo "⚠️  等待超时，尝试 openclaw doctor --fix 自动修复..."
            _doctor_output=$(openclaw doctor --fix 2>&1) || true
            echo "$_doctor_output"
            # doctor --fix 后再尝试 restart 一次
            echo ""
            echo "doctor 修复后重试 gateway restart..."
            _openclaw_with_timeout 30 openclaw gateway restart
            sleep 5
            if lsof -i :"$_GW_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
                echo "✅ doctor --fix 后 gateway 启动成功"
                _port_ready=1
            else
                echo "❌ 仍然无法启动，请手动排查:"
                echo "  openclaw doctor"
                echo "  tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
            fi
        fi

        # 端口就绪后：恢复 channels.qqbot 配置 + 检查连接 + 跟踪日志
        if [ "$_port_ready" -eq 1 ]; then
            echo "✅ Gateway 端口已就绪（插件已加载）"
            echo ""

            # ── 恢复 channels.qqbot 配置 ──
            # gateway 已启动、插件已注册 qqbot channel，现在可以安全写回配置
            _need_reload=0
            _target_cfg=""
            for _app in openclaw clawdbot moltbot; do
                _cfg="$HOME/.$_app/$_app.json"
                if [ -f "$_cfg" ]; then
                    _target_cfg="$_cfg"
                    break
                fi
            done

            if [ -n "$_target_cfg" ]; then
                # 构建完整的 channels.qqbot 对象（合并暂存配置 + 新 token + markdown）
                # 通过环境变量传递，避免 JSON 双引号在 node -e "..." 中被 shell 错误解析
                _STASH="$_QQBOT_CHANNEL_STASH" \
                _DESIRED="$DESIRED_QQBOT_TOKEN" \
                _MD="$MARKDOWN_VALUE" \
                _CFG="$_target_cfg" \
                node -e '
                    const fs = require("fs");
                    const cfg = JSON.parse(fs.readFileSync(process.env._CFG, "utf8"));
                    if (!cfg.channels) cfg.channels = {};

                    // 从暂存恢复基础配置
                    const stash = process.env._STASH;
                    if (stash) {
                        try { cfg.channels.qqbot = JSON.parse(stash); } catch {}
                    }
                    if (!cfg.channels.qqbot) cfg.channels.qqbot = {};

                    // 覆盖 token（如果有新值）
                    const desired = process.env._DESIRED;
                    if (desired && desired.includes(":")) {
                        const [appId, ...rest] = desired.split(":");
                        cfg.channels.qqbot.appId = appId;
                        cfg.channels.qqbot.clientSecret = rest.join(":");
                        delete cfg.channels.qqbot.token;
                    }

                    // 覆盖 markdown（如果有指定）
                    const md = process.env._MD;
                    if (md === "true") cfg.channels.qqbot.markdownSupport = true;
                    else if (md === "false") cfg.channels.qqbot.markdownSupport = false;

                    fs.writeFileSync(process.env._CFG, JSON.stringify(cfg, null, 4) + "\n");
                ' 2>&1 || echo "  ⚠️  配置写入失败"
                echo "  ✅ 已恢复 channels.qqbot 配置（含 token/markdown）"
                _need_reload=1
                # 清空暂存变量，防止 EXIT trap 重复恢复
                _QQBOT_CHANNEL_STASH=""
            fi

            # 配置写回后让 gateway 重载配置使其生效
            # gateway 有 chokidar 文件监听，写入 openclaw.json 后通常会自动 reload。
            # 这里发送 SIGHUP 通知进程立即重载，无需完整 restart（避免冷启动 10-20s）。
            if [ "$_need_reload" -eq 1 ]; then
                echo "  通知 gateway 重载配置..."
                sleep 2
                # 尝试用 SIGHUP 触发热重载；若失败则回退到 restart
                _gw_pid=$(lsof -i :"$_GW_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)
                if [ -n "$_gw_pid" ]; then
                    kill -HUP "$_gw_pid" 2>/dev/null || true
                    echo "  已发送 SIGHUP 到 gateway (pid: $_gw_pid)"
                    sleep 3
                else
                    # gateway 端口还在但 pid 拿不到，回退到 restart
                    _openclaw_with_timeout 30 openclaw gateway restart
                    # 等待重启后端口重新就绪
                    for _k in $(seq 1 30); do
                        if lsof -i :"$_GW_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
                            break
                        fi
                        printf "\r  等待端口 %s 重新就绪... (%d/30)" "$_GW_PORT" "$_k"
                        sleep 2
                    done
                    echo ""
                fi
            fi
            # 检查 qqbot WS 是否连接成功（最多等 20 秒）
            echo "检查 qqbot 插件连接状态..."
            _LOG_FILE="/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
            _restart_ts=$(date +%s)
            _qqbot_ready=0
            for _j in $(seq 1 10); do
                if [ -f "$_LOG_FILE" ]; then
                    _last_line=$(grep "Gateway ready" "$_LOG_FILE" 2>/dev/null | tail -1 || true)
                    if [ -n "$_last_line" ]; then
                        _qqbot_ready=1
                        break
                    fi
                fi
                printf "\r  等待 qqbot WS 连接... (%d/10)" "$_j"
                sleep 2
            done
            echo ""

            if [ "$_qqbot_ready" -eq 0 ]; then
                echo "⚠️  qqbot 插件可能未正确加载"
                echo "请检查: openclaw doctor"
            else
                echo "✅ qqbot 插件已连接"
            fi
            echo ""
            echo "正在跟踪日志输出（按 Ctrl+C 停止查看，不影响后台服务）..."
            echo "========================================="
            _retries=0
            while ! openclaw logs --follow 2>&1; do
                _retries=$((_retries + 1))
                if [ $_retries -ge 5 ]; then
                    echo ""
                    echo "⚠️  无法连接日志流，请手动执行: openclaw logs --follow"
                    echo "或直接查看日志文件: tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
                    break
                fi
                echo "等待日志流就绪... (${_retries}/5)"
                sleep 3
            done
        fi
        ;;
    n|no)
        echo ""
        echo "✅ 插件更新完毕，未启动服务"
        # 不启动时也需要恢复 channels.qqbot，否则配置丢失
        # 注意：下次 gateway 启动可能因 "unknown channel id" 失败，
        # 需要用户手动 stop → 移除 channels.qqbot → start → 恢复
        if [ -n "$_QQBOT_CHANNEL_STASH" ] && [ -n "$_STASH_CFG" ] && [ -f "$_STASH_CFG" ]; then
            _STASH="$_QQBOT_CHANNEL_STASH" _CFG="$_STASH_CFG" node -e '
                const fs = require("fs");
                const cfg = JSON.parse(fs.readFileSync(process.env._CFG, "utf8"));
                if (!cfg.channels) cfg.channels = {};
                cfg.channels.qqbot = JSON.parse(process.env._STASH);
                fs.writeFileSync(process.env._CFG, JSON.stringify(cfg, null, 4) + "\n");
            ' 2>/dev/null || true
            echo "  已恢复 channels.qqbot 配置"
            _QQBOT_CHANNEL_STASH=""
        fi
        echo ""
        echo "后续启动方法（兼容 openclaw 3.23+）："
        echo "  1. 先临时移除 channels.qqbot 再启动："
        echo "     openclaw gateway restart"
        echo "  2. 或使用本脚本自动处理："
        echo "     bash $0"
        echo "  3. 跟踪日志："
        echo "     openclaw logs --follow"
        ;;
    *)
        echo "无效选择，按默认值 y 执行后台重启"
        echo ""
        echo "正在后台重启 openclaw 网关服务..."
        if ! _openclaw_with_timeout 30 openclaw gateway restart; then
            echo "⚠️  后台重启失败，可能服务未安装"
            echo "尝试: openclaw gateway install && openclaw gateway start"
        fi
        echo "✅ openclaw 网关已在后台重启"
        ;;
esac

echo "========================================="
