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

## 读对话原文

进程内的 `Hub.memberTranscript` 经 `src/adapters/qoder/transcript.ts` 读群员当前绑定的 Qoder 对话（契约见 [架构](../architecture.md)）。按 Qoder 桌面 0.5.7 写下的 `main.sqlite` 结构实现（2026-11-19 核对）；这套表结构不是 Qoder 的对外接口，更新后可能变。

- **来源**：Qoder 有两处记录：应用的 `main.sqlite`（表 `chat_session_messages`）和 qodercli 的 `~/.qoder/projects/<项目>/<会话 id>.jsonl`。选前者：它覆盖 orrery 能绑定的全部对话（绑定用的就是同库 `chat_sessions` 的会话 id，JSONL 不一定每个对话都有），是应用界面显示的线性记录，按 `(session_id, sequence)` 有唯一索引；JSONL 是带分支的树状日志，夹着大量非对话记录。代价：Qoder 给模型附加的提醒和技能清单在库里看不到。
- **读法**：用共用读取器 `src/adapters/shared/sqlite-transcript.ts` 在原处只读打开，不复制、不写任何文件；有 `-wal` 却没有 `-shm`（异常退出后 `-shm` 被删）时不打开库、返回 `unsupported`，Qoder 下次打开这个库后就能再读（做法和剩下的一个竞态同 [ZCode](zcode.md#读对话原文)）；只查绑定会话的行，按 `sequence` 排序。会话不存在或已删除：`missing`；缺用到的列：`unsupported`；会话 ID 不是 UUID：`refused`。
- **归类**：用户输入 → `user`；助手文字 → `assistant`；思考 → `thinking`，只给占位，不给正文；工具（调用和结果在同一部分）→ `tool_call` 加上结束后的 `tool_result`；钩子活动 → `system`；其他 → `unknown` 并计数。超过 256 KiB 的行读作一条截断的 `unknown`。还没结束的行下次往后读时重读（条目 ID 不变）；已经结束的行被原地改写时，指向它的游标返回 `reset`。
- **MCP 调用**：Qoder 经自己的 `mcp_call` 工具调 MCP，`toolName` 是 `mcp__<服务器>__<工具>`；服务器名按记录拆出，不写死。
- **投递**：等待命令只打印信封（或直发正文）。只有同时满足这些条件的 `Read` 结果才作为候选交给 Hub：它所在的轮次由一个后台任务结束而开启；这个任务是本会话之前最近 16 个助手轮次里、在后台运行、逐字等于本会话票据的等待命令；`Read` 只带 `file_path`，读的是这个任务的输出文件，结果从第 1 行起逐行编号。Hub 只在投递确实发给这个群员时才标成 orrery 投递。用户输入的文字、别的会话的票据、部分读取和别的工具的输出都不算。票据能用来占用这个会话的等待，所以返回的每段文字里 orrery 票据的签名部分都换成 `<hidden>`，判断证据仍用原始记录。
- **发言**：`send_message` 成功结果里的 `messageId` 交给 Hub 核对，确实是这个群员在这个群发的才标成发言。
- **未验证**：Qoder 正在写库时的读取；一轮进行中的行状态取值；对话回退和上下文压缩后的行；在 16 个助手轮次之前启动的等待命令（投递显示为普通工具结果）。
