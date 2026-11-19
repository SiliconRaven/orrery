# orrery (`v0.10.0-beta.2` 测试版)

语言：**中文** | [English](README.en.md)

> **版本提示**：当前为 **v0.10.0-beta.2（Beta 测试版）**，非正式稳定版本；功能契约、插件接口与配置格式仍可能调整。

orrery 是一个面向 Windows 的本地多 Agent 协作桌面与 Hub（仅支持原生模式）。它把你在不同 AI 编程应用里已有的对话（或受支持应用的新建原生会话）接入同一个本地群聊和任务看板中协同工作。群员所在的应用在线时才会收到投递。Hub 的群消息与状态都留在本机。

## Windows 安装包

Windows x64 安装包内置 Node 与运行依赖，安装后从 Orrery Beta 快捷方式启动，无需另装 Node。数据保存在 `%APPDATA%/Orrery Beta/hub`，升级和卸载均保留。

测试版安装包尚未签名，Windows 可能提示发布者未知；下载时请核对附带的校验值。

## 界面、更新与插件

设置 → 外观中可选择中文或 English，刷新前会确认未保存内容。桌面设置立即切换外壳语言，协作页在下次打开或手动刷新时生效，保留当前草稿。消息与用户填写的名称保留原文。

软件会在后台检查版本，也可在设置中手动检查，不会静默下载或执行安装器。私有 GitHub 发行源可能无法匿名读取，访问失败会明确显示错误。

设置 → 插件可填写 GitHub 链接、公有 npm 包名或选择 ZIP/tgz；查看申请权限、可读取和可发言的群，确认安装后退出 Hub 并重新打开 Orrery 即可生效。第三方插件分两档：**受限插件**在独立进程里运行，只能用你授予的权限和群（读取、事件、受限发言、发言检查、命令、群员工具、沙盒网页和标记）；**完全信任插件**要你手动登记并在设置页确认，之后在 Hub 进程里运行、和 orrery 本身权限相同，出问题时可以用 `ORRERY_SAFE_MODE=1` 启动跳过它们。详见[第三方插件](docs/external-plugins.md)。

左栏的“技能与 MCP”页只读列出各应用的 skill 和 MCP 服务器，并能把 skill 装进共享 skill 文件夹（[文件与 Skill](docs/files.md)）。

进程内插件可以按成员分页读取当前绑定的 Claude 或 Codex 原生对话，读取按需进行，正文只在内存里返回，见[架构说明](docs/architecture.md#读取群员当前绑定的原生对话)。

## 从源码运行

同一账户的日常 Hub 共用登记处，各自保留数据库。升级时先退出旧 Hub。orrery 自带的接入件经登记处找 Hub 并给每个请求签名，不再读 `hub.json`；复制安装的 Cursor、Qoder 和 Antigravity 接入件升级后必须重装。静态 MCP 配置需要更新时，在「设置 → 投递 → 原生接入」点按显示接入密钥。第二实例的原生投递需要用户确认启用。[签名接入](docs/native-mode.md)

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

`desktop/` 提供可选的 Electron 桌面壳（同样处于 `v0.10.0-beta.2` 测试阶段；仅停靠和切换已运行应用的顶层窗口，不嵌入第三方界面）：

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

### 让 agent 一次协助接入多个 harness

把 `<应用列表>` 换成本次要接入的应用，再把这段提示词复制给你的 agent。接入方式见[原生模式说明](docs/native-mode.md)和上表各应用的指南。

```text
请协助我把这些应用接入当前的 Orrery Hub：<应用列表>。

1. 只检查列表里受支持的应用。已安装的继续，未安装的记下并跳过。核对当前 Hub 是安装版还是源码版，以及它的地址和数据目录。如果 Hub 或应用范围不明确，集中向我确认。
2. 按我正在用的 Orrery 版本的 README 和 docs/adapters/ 中对应的指南，完成文档允许且我已授权的步骤，例如检查依赖、准备配置片段或打包插件。把需要我在宿主里添加配置、上传或启用插件、确认信任、重载或选择对话的操作集中列出，注明应用和操作位置。保留现有权限和配置，不自行启动或重启应用，也不接入我没选的对话。密钥和令牌由我按文档在本机填写，不读取或输出其内容。
3. 按指南验证我已授权检查的连接，分别记录工具调用和实际投递。某条链路不适用时写明原因。逐个应用报告「已接入」「需我操作」或「未验证」，并注明未安装项。仅在适用的连接已验证时标记「已接入」。
```

## 常用环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `ORRERY_PORT` | Hub HTTP 监听端口 | `4317` |
| `ORRERY_HOME` | 数据根目录（`hub.json`、`secret`、`api-token`、`hub.log`）；接入件不再按它找 Hub | `~/.orrery` |
| `ORRERY_REGISTRY` | 账户级 Hub 登记处和共享接入密钥，开发或测试用独立目录 | `~/.orrery/registry` |
| `ORRERY_HUB` | 给接入件设置：只连这个 hubId 或名字的 Hub；记录无效时停下，不改投活动 Hub | 不设（连活动 Hub） |
| `ORRERY_LEGACY_HUB` | 给接入件设置：登记处没有在运行的活动 Hub 时，读这个旧版 Hub home 的 `hub.json`，按旧方式发明文密钥 | 不设 |
| `ORRERY_SECONDARY` | `1` 表示第二实例，默认禁止原生投递 | 不设 |
| `ORRERY_DB` | SQLite 数据库文件路径 | `<仓库>/.tmp/orrery.db` |
| `ORRERY_SKILLS_DIR` | 协作页 `$` 补全读取的本地 skill 目录 | `~/.agents/skills` |
| `ORRERY_MOCK` | 设为 `1` 时启用演示用的 `mock` 适配器。提供演示项目和两个已有对话，收到群聊消息后自动回复，不调用模型 | 未开启 |
| `ORRERY_MAX_HOPS` | 单链最大转发跳数（仅非负整数，`0` 合法，不支持 `unlimited`） | `6` |
| `ORRERY_MAX_TURNS_PER_CHAIN` | 单链最大执行轮次（仅非负整数，`0` 合法，不支持 `unlimited`） | `20` |
| `ORRERY_SAFE_MODE` | 设为 `1` 时跳过所有完全信任插件 | 未开启 |

## 常用命令

```powershell
npm test                                 # 运行完整自动化测试（使用独立测试端口与临时目录，不碰 4317）
npm run check:health                     # Knip 静态检查未引用文件、依赖与循环依赖（不跑测试，非漏洞审计）
npm run check:exports                    # 检查未使用的导出与类型候选（不检查文件，不跑测试）
npm run --silent bench:collaboration     # 运行可复现的 mock 协作基准（不代表真实模型成绩）
npm run clean:temp                       # 清理测试残留临时文件
npm run backup                           # 备份本地私有 Hub 数据库
npm run plugin:inspect -- <清单路径>     # 登记前预检第三方插件清单（不运行插件）
```

用户可在任务工作台「角色与协调 → 任务权限」按成员角色限制谁能建任务、执行和验收。默认三项都开放。协调员的建单角色豁免在其「任务规划」授权中单独设置。 [任务权限](docs/collaboration.md)

## 文档索引

- **架构与设计**：[架构说明](docs/architecture.md) · [原生模式设计](docs/native-mode.md) · [防循环与限流](docs/hop-limit.md) · [安全模型](docs/security.md)
- **协作与看板**：[协作与任务流程](docs/collaboration.md) · [协作与任务 API](docs/collaboration-api.md) · [成员管理与状态](docs/cluster-members.md) · [官方插件](docs/plugins.md)
- **运维与扩展**：[桌面外壳](docs/desktop.md) · [启动器与实例](docs/launcher.md) · [文件与 Skill](docs/files.md) · [额度与用量](docs/usage.md) · [活动观察](docs/activity.md) · [第三方插件](docs/external-plugins.md) · [未读提示钩子](docs/adapters/unread-hook.md)
- **维护与许可**：[代码健康度](docs/code-health.md) · [协作基准](docs/evaluation.md) · [第三方素材与依赖](docs/third-party.md)

## 许可证

本仓库源码按 **MIT License**（`orrery contributors`）开源，英文法律原文见根目录 `LICENSE`。第三方应用图标和依赖保留各自权利与许可，见[第三方说明](docs/third-party.md)。本项目原创 SVG 图标按 MIT 发布。

后续改进见 [待办](docs/backlog.md)。
