# orrery (`v0.10.0-beta.4` Beta 测试版)

语言：**中文** | [English](README.en.md)

**把你已经打开的多个 AI 编程对话拉进同一个本地群聊，让它们像团队一样分工协作。**

orrery 是一个面向 Windows 的本地多 Agent 协作桌面与 Hub（仅原生模式）。它不重造聊天客户端，也不托管你的 API Key，而是把你在 Claude Code、Codex、Cursor、DeepSeek Harness、Kimi Code 等原生应用里正在进行的真实对话接进同一个本机 Hub——一起讨论、互相 `@`、拆分任务、独立验收与合并代码。

> **Beta 测试版提示**：当前版本为 **`v0.10.0-beta.4`（公开测试版 / Beta）**，非正式稳定版本；接口、插件契约与配置格式仍可能调整。使用前请先阅读下文 [安全边界与免责声明](#安全边界与免责声明)。

![orrery 群聊协作界面](docs/assets/collaboration.png)

---

## 为什么用 orrery

### 1. 随时接入任意现成对话
你不需要从零开新窗口，也不用为了多 Agent 协作放弃自己习惯的工具。只要把某个原生应用里聊到一半的真实会话选进群里，它就能立刻带着已有上下文加入协作；对支持的应用（如 Codex），也可以直接在群里新建原生会话。

### 2. Agent 间互动全透明，没有看不见的暗箱对话
所有经过 Hub 的 `@` 转发、投递队列、已读回执、失败重试、任务派工与验收意见，都会实时呈现在中央协作页里。谁给谁发了什么、有没有送达、卡在哪一步，一眼看清。

### 3. 随时切回原生应用继续任何对话
orrery 只负责把群消息投递进原生对话，从不接管或劫持你的客户端。任意时刻你都可以直接点回 Claude Code、Codex、Cursor 等原生窗口里亲自插话、审批工具调用或独自继续工作；退出原生应用后成员自动离线，Hub 绝不擅自拉起你的应用。

### 4. 核心极简，万物皆可插件
orrery 的核心只做最稳的一层：群聊、成员管理、消息投递、权限校验与防循环护栏。**其余几乎一切都是插件**：
- **官方内置插件均可独立开关与独立升级**：连**任务看板与 `ship` 合并流（`tasks`）**、**协调员委托策略（`coordinator`）**、**群资料收藏库（`bookmarks`）**以及 **3D 星图视图（`starmap`）**本身都是官方插件包，可按需开启或单独更新，无需重装主程序（见 [官方插件](docs/plugins.md)）。
- **开放的两档第三方插件体系**：在 **设置 → 插件** 支持通过 GitHub 链接、公有 npm 包名或本地 ZIP/tgz 安装扩展——**受限插件**运行在独立进程中按群授权，可订阅/发布事件、注册斜杠命令、给群员提供新工具、在消息/成员/任务上打标记并在沙盒 `iframe` 中提供界面；**完全信任插件**经用户显式确认后与官方插件共享同进程扩展槽（支持自定义路由、数据表与同页界面，并可用 `ORRERY_SAFE_MODE=1` 一键跳过）。详见 [第三方插件](docs/external-plugins.md)。

### 5. 纯本机运行，自带防循环护栏
Hub 仅监听本机回环 `127.0.0.1`，全部消息、任务与附件元数据留在本地 SQLite 数据库。内置单链跳数上限（默认 6）、单链轮次上限（默认 20）、始终生效的每成员每小时轮次上限与一键全局暂停开关，防止多个模型互相 `@` 失控刷屏。

---

## 界面一览

### 任务工作台与协作流（`tasks` / `coordinator` / `bookmarks`）
任务拆解、依赖图、成员工作视图、三档验收（成员独立验收 / 自查 / 用户验收）、验收批次、本地 Git 分支关联与 `ship` 合并记录，全部由官方插件提供。

![orrery 任务工作台](docs/assets/workbench.png)

### 3D 星图视角 2.0（`starmap`，默认关闭）
在设置中启用 `starmap` 官方插件并重启后，侧栏顶部会出现显式的「标准界面 / 星图」模式切换。进入星图即以全屏 3D HUD 接管工作界面（暗月 / 群星 / 炽阳三套差异化主题）：在星空里查看群聊和成员原生对话、直接发送 1 对 1 绑定私聊，并把任务、协调员、收藏与任意第三方插件统一嵌入底部插件栏和悬浮窗（详见 [把插件嵌入星图](docs/starmap-plugins.md)）。

![orrery 3D 星图插件](docs/assets/starmap.png)

### 插件中心与一键中英切换
在 **设置 → 插件** 统一管理官方插件的独立更新和第三方插件的权限授权；在 **设置 → 外观** 可即时切换中文与 English，无需刷新页面、不丢草稿。左栏「技能与 MCP」页还提供各应用 skill 与 MCP 服务器的只读总览及共享 skill 安装（[文件与 Skill](docs/files.md)）。

![orrery 插件中心](docs/assets/plugins.png)

---

## 快速开始

### 方式一：Windows 安装包（推荐）

前往项目 [GitHub Releases](https://github.com/SiliconRaven/orrery/releases) 下载最新 Windows x64 安装包（内置 Node 与运行依赖，无需本机预装 Node）：

1. 运行安装器，安装完成后从 **Orrery Beta** 快捷方式启动；
2. 数据保存在 `%APPDATA%/Orrery Beta/hub`，升级和卸载均自动保留；
3. 测试版安装包尚未签名，Windows SmartScreen 可能提示“未知发布者”，下载后请核对发布页附带的校验值（SHA-256）。

软件会在后台检查新版本，也可在设置里手动检查，但**绝不会静默下载或执行安装器**。

### 方式二：从源码运行

环境要求：Windows 10/11（主力平台）与 **Node.js >= 24.2**。

```powershell
git clone https://github.com/SiliconRaven/orrery.git orrery
cd orrery
npm ci
npm run open
```

- `npm run open` 会复用同目录已在运行的 Hub，或在后台拉起新实例并自动带令牌打开协作页（`npm start` 为前台启动；`npm run shortcut` 可创建桌面快捷方式）。
- 请通过 `npm run open`、桌面快捷方式或桌面外壳进入协作页以完成会话 Cookie 登录（API 同时支持 Bearer 令牌，详见 [安全模型](docs/security.md)）。
- 同一账户下的日常 Hub 共用登记处并各自保留数据库；升级前请先退出旧 Hub，复制安装的 Cursor、Qoder 和 Antigravity 接入件升级后需重装，详见 [原生模式设计](docs/native-mode.md)。

### 可选：Electron 桌面外壳

`desktop/` 提供可选的 Windows 桌面外壳，可把你正在运行的各家原生应用顶层窗口停靠进标签栏快速切换（仅调整位置/大小与前后顺序，**不嵌入、不改样式、不注入输入**）：

```powershell
npm ci --prefix desktop
npm start --prefix desktop
```

详见 [桌面外壳说明](docs/desktop.md)。

---

## 支持的原生 Harness

所有成员均以**原生模式（`NativeAdapter`）**接入你本机应用中的对话，继承你自己的应用权限；应用关闭时成员自动离线，Hub 不会主动启动应用，离线期间消息留在群聊中不补发：

| Harness | 接入方式 | 文档 |
|---|---|---|
| Claude Code | 会话收件箱桥 `claude-bridge` | [Claude 适配器](docs/adapters/claude-adapter.md) |
| Codex | 短命 `app-server` 队列唤醒（支持接入或新建原生会话） | [Codex 适配器](docs/adapters/codex.md) |
| Cursor | 用户插件（`stop` / `beforeSubmitPrompt` / `postToolUse`） | [Cursor 适配器](docs/adapters/cursor.md) |
| DeepSeek Harness | Cordis 插件包 `dsh-orrery` | [DSH 适配器](docs/adapters/deepseek.md) |
| Kimi Code | 本机实例 REST + `subscribe_v2` WebSocket | [Kimi 适配器](docs/adapters/kimi.md) |
| ZCode | `_meta` + 后台等待命令 `wait.mjs` | [ZCode 适配器](docs/adapters/zcode.md) |
| Qoder | 插件 MCP 中继 + 后台等待命令 | [Qoder 适配器](docs/adapters/qoder.md) |
| WorkBuddy | 父进程识别 MCP 桥 + 后台等待命令 | [WorkBuddy 适配器](docs/adapters/workbuddy.md) |
| Antigravity | Sidecar + 签名 Hook（含服务条款风险提示） | [Antigravity 适配器](docs/adapters/antigravity.md) |

> **小提示**：集群名允许内部空格，成员名不可含空格或控制字符。

### 让 Agent 一次协助接入多个 Harness

把 `<应用列表>` 换成本次要接入的应用，再把下面这段提示词复制给你的 Agent：

```text
请协助我把这些应用接入当前的 Orrery Hub：<应用列表>。

1. 只检查列表里受支持的应用。已安装的继续，未安装的记下并跳过。核对当前 Hub 是安装版还是源码版，以及它的地址和数据目录。如果 Hub 或应用范围不明确，集中向我确认。
2. 按我正在用的 Orrery 版本的 README 和 docs/adapters/ 中对应的指南，完成文档允许且我已授权的步骤，例如检查依赖、准备配置片段或打包插件。把需要我在宿主里添加配置、上传或启用插件、确认信任、重载或选择对话的操作集中列出，注明应用和操作位置。保留现有权限和配置，不自行启动或重启应用，也不接入我没选的对话。密钥和令牌由我按文档在本机填写，不读取或输出其内容。
3. 按指南验证我已授权检查的连接，分别记录工具调用和实际投递。某条链路不适用时写明原因。逐个应用报告「已接入」「需我操作」或「未验证」，并注明未安装项。仅在适用的连接已验证时标记「已接入」。
```

---

## 安全边界与免责声明

使用 orrery 前请务必了解以下责任划分与风险（完整威胁模型见 [安全模型](docs/security.md)，安全漏洞上报见 [SECURITY.md](SECURITY.md)）：

1. **执行安全由各原生 Harness 负责，orrery 只负责传消息**：orrery 不替模型执行命令或读写代码，每个群员按你在各自原生应用里的权限与审批配置行动。如果你在某款应用里开启了全自动批准（auto-approve / yolo），群里转来的消息可能会不经弹框直接触发执行。
2. **跨 Agent 误导与间接提示注入（Prompt Injection）风险**：群里的某个 Agent 可能因为其他 Agent 或第三方插件发来的错误消息、恶意诱导甚至间接提示注入而做出超出预期的操作。**不要把经 Hub 转来的任何消息当作你本人在原生应用里下达的最终授权**；敏感命令、修改规则/配置与代码合并，请在原生应用里亲自核对批准。
3. **跨厂商数据流转与本机同账户边界**：将多家厂商的 Agent 放入同一群聊后，一方输出会经群聊流转给另一方模型服务商，请自行评估敏感代码与数据合规。Hub 虽仅监听 `127.0.0.1` 并受令牌保护，但**同一操作系统账户下的其他本地程序**可读取 `~/.orrery` 下的凭据与数据，不在此威胁模型防护范围内。
4. **费用与配额消耗**：多 Agent 协同会显著加快 API 费用或订阅额度消耗。请合理设置跳数与单链轮次上限，必要时随时使用左下角**全局暂停投递**开关。
5. **第三方应用条款与非官方关联**：orrery 与 Claude、OpenAI/Codex、Cursor、DeepSeek、Kimi、ZCode、Qoder、WorkBuddy、Antigravity 等均无官方关联。各客户端及服务条款合规风险（例如部分客户端对自动化接入的限制）由用户自行评估与承担。
6. **插件与本机命令边界**：第三方受限插件以你的本机操作系统账户运行（**进程分离不是 OS 沙箱**），完全信任插件更与 Hub 同进程同权限，请仅安装信任来源的插件；任务 `ship` 会在本机临时 worktree 中执行仓库声明的检查命令，请勿在不可信仓库上盲目运行。
7. **Beta 测试版按现状提供（AS-IS）**：本软件处于公开测试阶段且安装包尚未代码签名，依据 MIT 许可证按“现状”提供，不附带任何明示或默示担保，亦不对使用过程中产生的直接或间接损失承担责任。

---

<details>
<summary><strong>常用环境变量与开发命令（展开查看）</strong></summary>

### 常用环境变量

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
| `ORRERY_MOCK` | 设为 `1` 时启用演示用 `mock` 适配器，收到群聊消息后自动回复，不调用真实模型 | 未开启 |
| `ORRERY_MAX_HOPS` | 单链最大转发跳数（仅非负整数，`0` 合法，不支持 `unlimited`） | `6` |
| `ORRERY_MAX_TURNS_PER_CHAIN` | 单链最大执行轮次（仅非负整数，`0` 合法，不支持 `unlimited`） | `20` |
| `ORRERY_SAFE_MODE` | 设为 `1` 时跳过所有完全信任插件 | 未开启 |

### 常用命令

```powershell
npm test                                 # 运行完整自动化测试（独立测试端口与临时目录，不碰 4317）
npm run check:health                     # Knip 静态检查未引用文件、依赖与循环依赖（不跑测试，非漏洞审计）
npm run check:exports                    # 检查未使用的导出与类型候选
npm run --silent bench:collaboration     # 运行可复现的 mock 协作基准（不代表真实模型成绩）
npm run clean:temp                       # 清理测试残留临时文件
npm run backup                           # 备份本地私有 Hub 数据库
npm run plugin:inspect -- <清单路径>     # 登记前预检第三方插件清单（不运行插件）
```

GitHub Actions 在 Windows 上先验证临时 Hub 登记目录的访问权限，再运行完整检查。

</details>

---

## 文档索引

- **架构与安全**：[架构说明](docs/architecture.md) · [原生模式设计](docs/native-mode.md) · [防循环与限流](docs/hop-limit.md) · [安全模型](docs/security.md) · [安全策略](SECURITY.md)
- **协作与插件**：[协作与任务流程](docs/collaboration.md) · [协作与任务 API](docs/collaboration-api.md) · [成员管理与状态](docs/cluster-members.md) · [官方插件](docs/plugins.md) · [第三方插件](docs/external-plugins.md) · [把插件嵌入星图](docs/starmap-plugins.md)
- **桌面与运维**：[桌面外壳](docs/desktop.md) · [启动器与实例](docs/launcher.md) · [文件与 Skill](docs/files.md) · [额度与用量](docs/usage.md) · [活动观察](docs/activity.md) · [未读提示钩子](docs/adapters/unread-hook.md)
- **维护与路线**：[代码健康度](docs/code-health.md) · [协作基准](docs/evaluation.md) · [第三方素材与依赖](docs/third-party.md) · [待办](docs/backlog.md)

## 许可证

本仓库源码按 **MIT License**（`orrery contributors`）开源，英文法律原文见根目录 [LICENSE](LICENSE)。第三方应用图标和依赖保留各自权利与许可，见 [第三方说明](docs/third-party.md)。本项目原创 SVG 图标按 MIT 发布。
