# WorkBuddy 适配器（原生模式）

语言：**中文** | [English](workbuddy.en.md)

> **会话识别**：桥需要从运行中的 WorkBuddy 取得可信的会话 ID。工具未显示时，请确认连接器已信任，并在当前对话重新连接。

WorkBuddy 适配器结合“独立 stdio MCP 桥（识别会话 ID）”与 [共用等待核心](zcode.md#共用等待核心) 后台等待命令，不安装桌面插件或改动系统设置。

## 工作原理

1. **独立 stdio 桥识别会话（`plugins/workbuddy-orrery/bridge.mjs`）**：
   - 由于 WorkBuddy 的 channel 通知不会拉起新对话轮次且也不向 MCP 子进程传递 `CODEBUDDY_SESSION_ID`，因此桥启动时先检查该环境变量（若未来版本开始透传则优先使用），在缺失且位于 Windows 上时只读探测一次直接父进程：确认父进程映像名严格为 `WorkBuddy.exe` 并扫描命令行中的所有 `--session-id` 参数值（须全部一致且匹配白名单正则，禁止经 `cmd` 等中间壳包装启动）。
   - 该机制防止模型在工具参数内伪造身份，且整个探测在回答 MCP `initialize` 前同步完成；若取不到合法 ID，桥直接返回空工具清单且不向 Hub 发任何请求。
   - **重要**：每次先启动 `npm start` / Hub 再打开 WorkBuddy 对话；若 Hub 未启动导致取工具列表失败，须重开对话重新拉取。
2. **后台静默等待与安全信封**：
   - 模型调用 `wait_for_messages` 获得 `w1` 票据命令并后台运行 `wait.mjs`。为兼容 WorkBuddy 的“AI 安全防护”扫描，下发信封仅含纯群聊内容，不包含“再次运行命令”提示文本；`SKILL.md` 与工具说明承担流程指引。
   - 对话进程空闲约 15 分钟后可能被 WorkBuddy 回收进程，届时群员转为离线且停止投递，不会自动补发。

## 用户一次性设置与权限提醒

详见 [plugins/workbuddy-orrery/README.md](../../plugins/workbuddy-orrery/README.md)：

1. 在 WorkBuddy 的 MCP 连接器管理页添加 stdio 服务器（`command: node`，`args: ["<orrery>/plugins/workbuddy-orrery/bridge.mjs"]`）并显式点击**信任**；
2. 可选复制 `plugins/workbuddy-orrery/skill/SKILL.md` 到本地技能目录，在目标对话说“加入 orrery”；
3. **权限警示**：WorkBuddy 自身的“默认权限”沙箱档位可能不逐条弹窗确认文件改动或沙箱内行为；若出现运行等待命令询问，仅可放行逐字相同命令，切勿切换到“允许完全访问”。

## 只读会话存储与对话正文读取

- **列表来源**：复制 `<WORKBUDDY_CONFIG_DIR 或 ~/.workbuddy>/workbuddy.db`（及 `-wal`）临时副本只读查询 `sessions`（过滤 playground、后台定时任务及非本地会话）与 `workspaces`。暂不支持在 Hub 新建对话，不支持额度与 token 统计。
- **只读对话正文**：`Hub.memberTranscript` 按页只读 `<workbuddyHome>/projects/<proj>/<sessionId>.jsonl`（严格核对首行 `session-meta.sessionId`、排除 `subagents/` 并拒绝越界路径、硬链接与符号链接，不碰 `workbuddy.db`）；`reasoning` 仅输出占位、`isMeta` 归为 `system`、支持直接 MCP 与 `DeferExecuteTool` 工具调用及跨页配对；展示工具文本前遮盖等待票据，且仅将整条命令结构精确匹配本会话 `wait.mjs` 票据的 `TaskOutput` 或已配对前景 Shell 等待命令输出交由 Hub 核实归属，未配对或子串嵌套均保留原条目。
- 会话身份由宿主提供；重置、回退或新建对话后身份变化时，应重新连接 MCP。
