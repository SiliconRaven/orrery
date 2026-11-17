# orrery (`v0.10.0-beta.1` 测试版)

语言：**中文** | [English](README.en.md)

> **版本提示**：当前为 **v0.10.0-beta.1（Beta 测试版）**，非正式稳定版本；功能契约、插件接口与配置格式仍可能调整。

orrery 是一个面向 Windows 的本地多 Agent 协作桌面与 Hub（仅支持原生模式）。它把你在不同 AI 编程应用里已经打开的对话（或受支持应用的新建原生会话）接入同一个本地群聊和任务看板中协同工作，所有消息与状态都在本地可查。

## Windows 安装包

Windows x64 安装包内置 Node 与运行依赖，安装后从 Orrery Beta 快捷方式启动，无需另装 Node。数据保存在 `%APPDATA%/Orrery Beta/hub`，升级和卸载均保留。

测试版安装包尚未签名，Windows 可能提示发布者未知；下载时请核对附带的校验值。

## 从源码运行

环境要求：Windows 10/11（主力平台）与 **Node.js >= 24.2**。

```powershell
git clone https://github.com/SiliconRaven/orrery.git orrery
cd orrery
npm ci
npm run open
```

- `npm run open` 探测并复用符合同目录条件的现有 Hub，或在后台启动新实例后打开协作页（`npm start` 在前台启动 Hub；`npm run shortcut` 创建桌面快捷方式）。
- 请通过 `npm run open`、桌面快捷方式或桌面外壳进入协作页，完成令牌登录。API 同时支持 Bearer 令牌和会话 Cookie，详见[安全模型](docs/security.md)。

### 可选：桌面外壳

`desktop/` 提供可选的 Electron 桌面壳（同样处于 `v0.10.0-beta.1` 测试阶段；仅停靠和切换已运行应用的顶层窗口，不嵌入第三方界面）：

```powershell
npm ci --prefix desktop
npm start --prefix desktop
```

详见 [桌面外壳说明](docs/desktop.md)。

## 支持的原生 Harness

所有成员均以**原生模式（`NativeAdapter`）**接入你在宿主应用中运行着的对话，继承用户自己的应用权限（不保证每次操作都会弹审批）。应用关闭时成员即离线，Hub 不会主动启动应用，离线期间消息留在群聊中不补发：

| Harness | 接入方式 | 文档 |
|---|---|---|
| Claude Code | 会话收件箱桥 `claude-bridge` | [Claude 适配器](docs/adapters/claude-adapter.md) |
| Codex | 短命 `app-server` 队列唤醒（支持新建或接入） | [Codex 适配器](docs/adapters/codex.md) |
| Cursor | 用户插件（`stop` / `beforeSubmitPrompt` / `postToolUse`） | [Cursor 适配器](docs/adapters/cursor.md) |
| DeepSeek Harness | Cordis 插件包 `dsh-orrery` | [DSH 适配器](docs/adapters/deepseek.md) |
| Kimi Code | 本机实例 REST + `subscribe_v2` WebSocket | [Kimi 适配器](docs/adapters/kimi.md) |
| ZCode | `_meta` + 后台等待命令 `wait.mjs` | [ZCode 适配器](docs/adapters/zcode.md) |
| Qoder | 插件 MCP 中继 + 后台等待命令 | [Qoder 适配器](docs/adapters/qoder.md) |
| WorkBuddy | 父进程识别 MCP 桥 + 后台等待命令 | [WorkBuddy 适配器](docs/adapters/workbuddy.md) |
| Antigravity | Sidecar + 签名 Hook（含服务条款风险提示） | [Antigravity 适配器](docs/adapters/antigravity.md) |

> **安全提示**：Hub 投递的消息按你在目标应用里的权限设置执行；集群名允许内部空格，成员名不可含空格或控制字符。详情见 [安全模型](docs/security.md)。

## 常用环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `ORRERY_PORT` | Hub HTTP 监听端口 | `4317` |
| `ORRERY_HOME` | 数据根目录（`hub.json`、`secret`、`api-token`、`hub.log`） | `~/.orrery` |
| `ORRERY_DB` | SQLite 数据库文件路径 | `<仓库>/.tmp/orrery.db` |
| `ORRERY_SKILLS_DIR` | 协作页 `$` 补全读取的本地 skill 目录 | `~/.agents/skills` |
| `ORRERY_MOCK` | 设为 `1` 时启用原生态内存 `mock` 适配器（用于测试与基准） | 未开启 |
| `ORRERY_MAX_HOPS` | 单链最大转发跳数（仅非负整数，`0` 合法，不支持 `unlimited`） | `6` |
| `ORRERY_MAX_TURNS_PER_CHAIN` | 单链最大执行轮次（仅非负整数，`0` 合法，不支持 `unlimited`） | `20` |

## 常用命令

```powershell
npm test                                 # 运行完整自动化测试（使用独立测试端口与临时目录，不碰 4317）
npm run check:health                     # Knip 静态检查未引用文件、依赖与循环依赖（不跑测试，非漏洞审计）
npm run check:exports                    # 检查未使用的导出与类型候选（不检查文件，不跑测试）
npm run --silent bench:collaboration     # 运行可复现的 mock 协作基准（不代表真实模型成绩）
npm run clean:temp                       # 清理测试残留临时文件
npm run backup                           # 备份本地私有 Hub 数据库
```

## 文档索引

- **架构与设计**：[架构说明](docs/architecture.md) · [原生模式设计](docs/native-mode.md) · [防循环与限流](docs/hop-limit.md) · [安全模型](docs/security.md)
- **协作与看板**：[协作与任务流程](docs/collaboration.md) · [协作与任务 API](docs/collaboration-api.md) · [成员管理与状态](docs/cluster-members.md) · [官方插件](docs/plugins.md)
- **运维与扩展**：[桌面外壳](docs/desktop.md) · [启动器与实例](docs/launcher.md) · [文件与 Skill](docs/files.md) · [额度与用量](docs/usage.md) · [活动观察](docs/activity.md) · [外部插件](docs/external-plugins.md) · [未读提示钩子](docs/adapters/unread-hook.md)
- **维护与许可**：[代码健康度](docs/code-health.md) · [协作基准](docs/evaluation.md) · [第三方素材与依赖](docs/third-party.md)

## 许可证

本仓库源码按 **MIT License**（`orrery contributors`）开源，英文法律原文见根目录 `LICENSE`。第三方应用图标和依赖保留各自权利与许可，见[第三方说明](docs/third-party.md)。本项目原创 SVG 图标按 MIT 发布。
