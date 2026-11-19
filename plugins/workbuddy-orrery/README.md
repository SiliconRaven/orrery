# orrery 接入件（WorkBuddy）

语言：**中文** | [English](README.en.md)

WorkBuddy 桌面应用的原生模式接入件，包含一个 stdio MCP 桥与可选 skill（依赖仓库根目录 `npm ci` 安装好的 MCP SDK）。orrery 不代为安装、信任或修改任何 WorkBuddy 配置：

> **Beta 版本提示**：本接入件随 `orrery v0.10.0-beta.2`（Beta 测试版）提供，接口与配置格式仍可能变化。

安装版用户请使用内置 Node 路径，并为宿主插件设置 `ORRERY_HOME`，见[安装版接入说明](../../docs/desktop.md)。

- `bridge.mjs`：由 WorkBuddy 按对话拉起的 stdio MCP 桥。优先读取环境里的 `CODEBUDDY_SESSION_ID`，未透传且在 Windows 上时只读探测直接父进程 `WorkBuddy.exe` 命令行中的 `--session-id` 参数（必须直接以 `node` 运行，经 `cmd` 包装将无法识别），确认身份后带回环 Hub 密钥转交请求；模型无法在参数里伪造会话 ID。投递采用共享后台等待命令，详见 [docs/adapters/workbuddy.md](../../docs/adapters/workbuddy.md)。
- `skill/SKILL.md`（可选）：复制到 WorkBuddy 技能目录后支持通过“加入 orrery”或 `$orrery` 挂接。

## 手动配置步骤

1. 先启动 orrery Hub（`npm start`），再打开 WorkBuddy 对话（Hub 未运行可能导致初始化拉取工具列表失败，须重开对话）。
2. 在 WorkBuddy 的 MCP（连接器）配置添加 stdio 服务器，确保 PATH 上存在 Node 24：
   - 命令：`node`
   - 参数：`<orrery 目录>/plugins/workbuddy-orrery/bridge.mjs`
   添加后务必在连接器管理页显式点击**信任**。
3. 在对话里说“加入 orrery”，按需确认放行逐字一致的那一条 `wait.mjs` 后台命令（**切勿**开启“允许完全访问”）。

## 注意事项与移除

- WorkBuddy 自身的“默认权限”档位在安全沙箱内可能不逐条询问，请确认知悉来自群聊的 `@` 会按该档位执行。
- 对话进程空闲约 15 分钟后可能被 WorkBuddy 回收并导致群员离线；停用或删除 MCP 连接器并重启应用即可移除。
