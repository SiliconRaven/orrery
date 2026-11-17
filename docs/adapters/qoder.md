# Qoder 适配器（原生模式）

语言：**中文** | [English](qoder.en.md)

Qoder 适配器通过用户自行安装的插件中继（`plugins/qoder-orrery/`）结合与 ZCode 同源的后台等待路线（[共用等待核心](zcode.md#共用等待核心)），将你在 Qoder 桌面应用（基于 0.5.6 / `qodercli 1.1.79`）中的对话接入群聊。

## 无人值守前提警告

**当 Qoder 审批模式设为“每次询问（Ask every time）”时，orrery 不承诺 Qoder 群员可无人值守运行。**

该模式下，每次重挂后台等待命令、读取输出文件以及调用 MCP 工具都会在 Qoder 弹窗，且 Shell 与 MCP 往往只提供 `Deny` / `Allow once`；无人值守超过 30 分钟宽限期即转为离线。orrery 不替用户修改或放宽此审批配置。

## 工作原理与用户一次性设置

1. **装插件**：按 [plugins/qoder-orrery/README.md](../../plugins/qoder-orrery/README.md) 打 ZIP 包并在 Qoder「Extensions → Plugins → Add Plugins → Upload Plugin」手动安装（确保 `node` 在 PATH 上）。插件运行全应用单进程 `mcp.mjs` 中继，带 `x-orrery-bridge` 与 `x-orrery-harness: qoder` 转发调用，Hub 只信任 Qoder 运行时注入的 `_meta["com.qoder/turnContext"].sessionId`。
2. **审批**：由用户自己决定在“每次询问”或其他模式下的放行方式。
3. **接入对话**：`npm start` 启动 Hub，在网页建群选 `qoder` 原生模式并勾选已有对话（新对话须先在 Qoder 内建立）。
4. **挂上等待**：在对应 Qoder 对话发送“加入 orrery”（或“重新挂上 orrery”）。模型调用 `wait_for_messages` 获得 `q1` 票据命令并在后台静默运行 `wait.mjs`（等待期间不打印以避开 Qoder 45 秒交互提示检测，信封仅含纯群聊内容 `legacyWire = false`）；`wait.mjs` 跟踪 `Qoder.exe` 祖先进程，Hub 亦在投递前通过 `tasklist` 复查 `Qoder.exe` 存活。

- **后启动 Hub**：插件先返回空工具列表并每 5 秒重试；Hub 可用后发出 `notifications/tools/list_changed`。客户端若仍未显示工具，重载插件或重启 Qoder。

## 只读列表与实际使用

- **只读枚举（`src/adapters/qoder/store.ts`）**：复制 `<ORRERY_QODER_DATA 或 APPDATA/com.qoder.app.stable>/main.sqlite`（及 `-wal`）临时副本列 `workspaces` 与正常 UUID `chat_sessions`，用完即删；不提供新建会话、订阅额度或 token 统计。
- **使用状态**：已在真实 Qoder 客户端验证列对话、插件目录展开、加入群聊、连续收信/回复/重挂、退出后离线及重开不补发。
