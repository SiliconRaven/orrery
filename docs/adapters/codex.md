# Codex 适配器（原生模式）

语言：**中文** | [English](codex.en.md)

原生 Codex 群员对应用户在 ChatGPT/Codex 桌面应用里看得到的 `thread`。Hub 只做**入队、唤醒与只读观察**，真实轮次执行、权限和审批由桌面应用自己承担。原生会话可选配置 [未读提示钩子](unread-hook.md#codex)（确认子代理身份字段前不建议启用）。

## 二进制发现顺序与短命进程

- **可执行文件优先级**：**`ORRERY_CODEX_NATIVE_BIN`** → 桌面应用自带最新后台 **`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`** → `PATH` 上的 **`codex`**。
- **一操作一短命进程**：每次列对话、接入、建群、`thread/queue/add`（携带 `clientUserMessageId`）与轮询观察都单独启动短命 `app-server`（传 `-c features.plugins=false -c features.apps=false`，绝不改动 `~/.codex` 中的用户配置、rules 或 hooks），**在当前操作完成之后才关闭 stdin 让其自然退出**（3 秒未退则结束进程树，避免长期占用线程写入锁把桌面应用挡在外面；并发上限 `maxProcesses = 3`，单操作超时 60 秒）。
- **新建（`createSession`）与接入（`attach`）**：
  - 新建原生对话**必须显式传入 `projectPath`**，不存在默认沙箱目录回退；若新建时选定了模型或思考强度，因空对话不会落盘保存配置，适配器会在同一短命进程里先运行一轮极简初始化通知以持久化配置后再交回应用（均未选则不跑首轮）。
  - 接入已有对话时，从只读 `thread/read` 提取该会话原有的 `cwd`。

## 身份认证、在线探测与唤醒

- **原生 Codex MCP 认证（单独契约）**：用户在 Codex 配置 orrery HTTP MCP 时，请求头**只配置 `x-orrery-bridge: <secret>`**，**绝不传 `x-orrery-session`，也不传 `x-orrery-harness`**（如果带了 `x-orrery-harness: codex` 而没有 `x-orrery-session`，Hub 会按 `nobody` 拒绝）。Hub 在这种桥密钥无额外头部的调用上专门从运行时 `_meta.threadId` 识别群员（`src/mcp/server.ts`）。Codex 自己发 HTTP、没法签名，这里的密钥是登记处的共享接入密钥 K（明文兼容，投递设置里可关）：设置 → 投递 → 原生接入里点显示接入密钥，或读 `<ORRERY_REGISTRY>/bridge-secret`。从旧版升级时，把 `config.toml` 里的值一次性换成 K 并重启 Codex（见[接入件的升级和回退](../native-mode.md#接入件的升级和回退)）。
- **只认桌面主进程存活**：Windows 上通过 `tasklist /APPS /FO CSV /NH` 检查包名 `OpenAI.Codex_*` 下映像为 `ChatGPT.exe` 的主进程（`appCheckMs` 缓存 10 秒，忽略退出后可能残留的 `RuntimeBroker.exe` 进程，也不把 Hub 自己的短命 `codex.exe` 误判为桌面应用）。
- **唤醒前置实时现查**：入队后打开 `codex://threads/wake/<threadId>` 前跳过缓存现查一次桌面应用是否在运行；若此时已退出则尝试撤出队列并返回 `unknown`，绝不主动拉起关闭的应用（系统查询到打开链接之间的极短时间窗口仍为已知可接受剩余风险）。
- **轮次观察与用量**：默认每 3 秒轮询一次（连续 3 次看到目标轮次仍在跑后降为 6 秒），排在另一运行中轮次后面的时间不计入 30 分钟空闲取件超时；读取 `$CODEX_HOME/thread-writer-locks/<threadId>.lock` 遇 `EBUSY` 继续等待，缺失队列项持续 3 次轮询且超 15 秒报 `unknown`。额度与按轮/会话 token 从本地最新 `rollout-*.jsonl` 只读提取（仅手动刷新额度调 `account/rateLimits/read`）。
- **使用状态**：已有原生会话接入、与 Claude 互相发言、忙时合批、退出后离线和重开不补发均已有真机验证及日常使用记录。

## 分页读取会话记录（`transcript`）

插件经 Hub 读取群员绑定的原生对话时（见[架构说明](../architecture.md#读取群员当前绑定的原生对话)），适配器按绑定的线程 UUID 在 `sessions/` 或 `archived_sessions/` 里找到 rollout，并核对首条 `session_meta` 的线程 ID。只读本地文件，应用离线时也能读。

- `.jsonl.zst` 用 Node 自带的 Zstandard 解压（压缩输入最多 16 MiB，解压输出最多 64 MiB），损坏或超限返回 `archived`；找不到文件返回 `missing`，路径或线程 ID 归属不符返回 `refused`。
- 按 `session_meta.history_mode` 选事件格式：新版读完成的条目，旧版读独立的显示事件并跳过重复副本。fork 和子代理只显示明确属于本线程的记录，旧版复制的历史没有可靠归属标记时返回 `unsupported`。思考只取公开摘要或显示标记，未知记录保留一条占位说明。
- 用户消息的 `client_id` 和发言工具返回的 `messageId` 只作为 Hub 核对的线索。
- 已知限制：第一行 `session_meta` 超过 64 KiB 时读取返回 `unsupported`。

`node --test test/codex-transcript.test.ts` 用手写的模拟文件检查分页、追加、归档、归属和工具结果；分页尚未在运行中的桌面应用里验收。格式依据 [Codex 0.165.0 的 rollout 保留策略](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/rollout/src/policy.rs)。
