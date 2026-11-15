---
name: qqbot-upgrade
description: 通过官方 CLI 将 openclaw-qqbot 插件安装或升级到最新 npm 版本。当用户要求更新 QQ 机器人插件、升级 qqbot 扩展或同步官方最新版时使用。
metadata: {"openclaw":{"emoji":"⬆️","requires":{"config":["channels.qqbot"]}}}
---

# QQBot 插件升级

## 何时使用

用户表达以下意图时，应在**本机终端**执行升级命令（不要只口头说明「去官网升级」）：

- 更新 / 升级 `openclaw-qqbot` 或 QQBot 插件
- 拉取官方最新 npm 包
- 安装或更新 qqbot 插件

---

## 标准命令

在终端执行（需已安装 Node.js，`npx` 会自动拉取最新版 CLI）：

```bash
npx -y @tencent-connect/openclaw-qqbot-cli@latest
```

说明：

- `-y`：跳过 npx 的安装确认提示，适合非交互式执行
- `@latest`：始终使用 npm 上的最新版本
- CLI 会自动检测当前环境：**未安装** qqbot 插件时执行安装流程；**已安装**时执行对应版本的更新操作
- 完成后根据命令退出码与输出向用户简要汇报安装/更新结果
 