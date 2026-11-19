# 原生模式设计（Native Mode）

语言：**中文** | [English](native-mode.en.md)

orrery 仅运行原生模式（`NativeAdapter`），让用户在桌面应用或本地 CLI 中已有的对话（或受支持应用的新建原生会话）直接加入群聊。群员所在的应用在线时才会收到投递。Hub 负责路由、合批、防循环计数与身份核验，不代跑模型轮次。

## 核心原则

1. **只接入或新建用户明确指定的原生会话**：列表枚举只读（或临时副本）；`new` 新建原生会话须显式指定 `mode: "native"` 和非空的 `projectPath`，`attach` 接入已有会话从应用只读存储读取 `cwd`，绝不改动未接入会话或宿主配置。
2. **绝不主动打开用户的原生应用**：宿主应用未运行时成员显示**离线**，期间消息仅留在群聊记录中，应用重新打开后**不自动补发**。
3. **继承用户自身应用权限**：原生对话沿用你在目标应用中的审批预设（不保证每一步都弹窗）。

## 本地发现与桥协议（`BridgePort`）

同一账户的日常 Hub 共享 `ORRERY_REGISTRY`（默认 `~/.orrery/registry`）。`active.json` 和 `hubs/<hubId>.json` 的版本为 1，包含 `{version, hubId, name, url, pid, home, role, claim, startedAt}`。`hubId` 属于数据目录，`claim` 每次启动更新，登记记录不含密钥。`bridge-secret` 单独存在私有登记目录。开发和测试同时隔离登记处、home、数据库和端口。

- `x-orrery-sig: v1 <hubId> <claim> <ts> <nonce> <mac>`。ts 是十进制 Unix 毫秒，nonce 和 claim 各为 16 字节小写十六进制。HMAC-SHA256 使用 64 位十六进制密钥的 UTF-8 文本，MAC 是小写十六进制。
- 规范串依次为 `orrery-req-v1`、hubId、claim、实际 `127.0.0.1:<port>`、HTTP 方法、原始 `path?query`、签名请求头、ts、nonce、正文的 SHA-256 小写十六进制。用 LF 分隔，末尾无 LF。头按小写 ASCII 名排序，逐行写 `名称:值`。`x-orrery-harness` 和 `x-orrery-session` 缺失时仍写空值行，其他 `x-orrery-*` 只写实际出现的头，排除 `x-orrery-sig`。签名请求不带 `x-orrery-bridge`。拒绝重复头、显式空身份头、歧义路径和重复查询键。空正文哈希空字节。
- Hub 在解析调用者和进入处理器前验证启动、端口、身份、路由和正文。允许 60 秒时钟偏差，nonce 保留两分钟。失败返回 401 `{error: "unauthorized", reason}`，reason 是 `claim`、`expired`、`replay`、`mac` 或 `host`。`GET /bridge/whoami` 只接受签名，返回 `{hubId, claim, name, role}`。回应未签名。
- 兼容文件 `<ORRERY_HOME>/hub.json` 仍由 Hub 写出 `{url, secret, pid, hubId}`，供旧版接入件使用；新版接入件只在显式旧版回退时读它。宿主自己发请求的静态 HTTP MCP 没法签名，可继续发送 `x-orrery-bridge`，投递设置中可关闭明文兼容。网页 API 令牌仍按 home 独立。
- ZCode、WorkBuddy 和 Qoder 的 v2 等待票据是 `<h>2.<hubId>.<session>.<mac>`。对 `orrery-<harness>-wait-v2\n<hubId>\n<session>` 做 HMAC-SHA256。跨 Hub 或 v1 票据返回 403，需重新领取。同一 Hub 重启后仍可使用其 v2 票据。
- 第二实例默认禁止原生投递，用户可在投递设置确认启用。升级时先停止仍在投递的旧版 Hub，再启动新版。旧版不参与新登记的投递归属判断。

### 接入件：找 Hub、签名、报错

orrery 自带的接入件（Claude 桥、DeepSeek、Cursor、Qoder、WorkBuddy、Antigravity sidecar 和 hook、未读提示钩子、等待命令）共用 `plugins/shared/hub-discovery.mjs`；复制安装的插件在自己的文件夹里带一份逐字节相同的副本，由测试检查一致。

- **选哪个 Hub**：每次请求都重读登记处，默认连 `active.json` 记的活动 Hub。设 `ORRERY_HUB=<hubId 或名字>` 只连那一个（按 hubId 钉住时记录自己的 hubId 必须相同，按名字时只认存放在自己 hubId 文件名下的唯一记录）；钉住的记录缺失、无效或进程已退出时停下，不改投活动 Hub。
- **签名**：请求带 `x-orrery-sig`，不带 `x-orrery-bridge`，密钥原文不上网络。Hub 回 401 `reason: claim`（Hub 重启过）时，只有登记处里同一个 hubId、同一个地址的 claim 变了，才重签再发一次。地址只认 `http://127.0.0.1:<端口>`，不经代理、不跟随重定向。
- **旧版回退只能显式打开**：只有设了 `ORRERY_LEGACY_HUB=<旧版 Hub 的 home>` 且登记处没有在运行的活动 Hub 时，接入件才读那个 home 的 `hub.json` 并按旧方式发 `x-orrery-bridge`。`ORRERY_HOME` 对接入件不再起作用。
- **报错**：接入件自己停下时以"接入件没有发送请求："开头（例如找不到活动 Hub、`ORRERY_HUB` 指定的 Hub 没有有效记录、读不到接入密钥）；Hub 拒收时是"Hub「<名字>」拒收：<reason>"；请求发出但没有完整回答时是"连不上 Hub「<名字>」…"。工具调用失败时再说明后果：没有发出（可放心重试）、被拒收（没有执行）、已发出但回答中断（结果未知，先用 `read_messages` 或 `get_task` 核对再决定是否重试）。
- Cursor 的 MCP 小程序遇到 401 后改为约 60 秒重试一次并在日志里写明原因；Antigravity hook 用登记处的共享密钥（`<ORRERY_REGISTRY>/bridge-secret`）签 `orreryCaller`，读不到时不回退到 `hub.json`；Qoder 中继的签名覆盖正文（含 `_meta`）；等待命令用命令里写好的地址和 v2 票据，只有没写地址的旧命令才经登记处查地址；未读提示钩子签名，失败时不出声。

### 接入件的升级和回退

升级前先退出旧版 Hub，再启动新版。新版 Hub 第一次启动时把自己 home 的旧密钥定为共享密钥 K，其余 Hub 把各自的 `<home>/secret` 改写成 K。

| 装法 | 升级 | 回退到旧版 orrery |
|---|---|---|
| 路径引用：Claude 桥、DeepSeek 插件、WorkBuddy 桥、未读提示钩子、等待命令 | 随 orrery 一起更新，在宿主里重启 orrery 连接（DeepSeek 插件若是单独拷走再装的，先重新拷一份） | 随 orrery 一起回退；新版接入件要连旧版 Hub 时设 `ORRERY_LEGACY_HUB` |
| 复制安装：Cursor 插件、Qoder 插件（ZIP）、Antigravity sidecar 和 hook | **必须重装**：重新复制或打包上传，重启宿主（Qoder 还要在对话里重新"加入 orrery"） | 重装旧版本的副本 |
| 静态 HTTP：Codex 的 `config.toml`、ZCode 和 Antigravity 的 MCP 配置、Kimi Code 的可选直连 `mcp.json` | 一次性把 `x-orrery-bridge` 的值换成 K（设置 → 投递 → 原生接入里点显示接入密钥，或读 `<ORRERY_REGISTRY>/bridge-secret`），再重启宿主 | 不用改：`<home>/secret` 已经是 K |
| 等待命令（ZCode、WorkBuddy、Qoder） | 旧命令收到票据作废提示，群员重新调用 `wait_for_messages` 领取 | 同左 |

没有重装的旧复制副本仍读 `<ORRERY_HOME 或 ~/.orrery>/hub.json` 并发明文密钥，home 设对时还能用，按上表重装即可。Kimi Code 的投递用它自己的本机服务令牌，不受影响。以上新路径目前只经自动化测试验证。

兼容的回环桥端点仍包含（"签名或桥密钥"指 `x-orrery-sig`，或明文兼容的 `x-orrery-bridge: <共享密钥>`）：

| 路径 | 认证方式 | 用途 |
|---|---|---|
| `GET /bridge/stream?harness=<h>[&session=<id>&version=<v>]` | 签名或桥密钥 | SSE 下行投递流，支持按会话（Claude）或按 harness 共用连接（DSH、Antigravity）；发送 `deliver { deliveryId, sessionId, text }` |
| `POST /bridge/ack` | 签名或桥密钥 | 回执本地接收 `{ deliveryId, ok, follows?, error? }` |
| `POST /bridge/done` | 签名或桥密钥 | 携带 `follows: true` 时在模型轮次结束后回报 `{ deliveryId, harness, sessionId, outcome, error?, usage? }` |
| `POST /bridge/unread-hint` | 签名或桥密钥 | 钩子或插件查询自上次询问以来新增未读，返回 4 桶分类计数行 |
| `GET /bridge/<h>-wait` / `POST /bridge/<h>-ack` | 签名票据 | 后台等待路线（ZCode / Qoder / WorkBuddy）的 SSE 等待与回执 |
| `POST /bridge/<h>-turn` / `GET /bridge/<h>-park` | 签名或桥密钥 | 停靠 Hook 路线（Cursor）的轮次报告与停靠待命流 |
| `POST /bridge/ship-verify` / `POST /bridge/ship-result` | 签名 `body.ticket` | `scripts/ship.ts` 查验获批提交与上报合入/检查失败结果 |

## 四类 MCP 身份认证路线

`/mcp` 先验证签名 `x-orrery-sig` 或明文兼容的 `x-orrery-bridge`，再依据宿主写入的不可伪造上下文识别成员（`src/mcp/server.ts`）。下面写 `x-orrery-bridge` 的是宿主自己发请求的静态配置；orrery 自带的接入件改为签名，身份字段规则相同：

1. **显式会话头（Claude / DSH / Cursor / WorkBuddy）**：签名请求带 `x-orrery-session: <id>` + `x-orrery-harness: <h>`，签名覆盖这两个头（省略 harness 头时默认按 `claude`）。
2. **原生 Codex（仅桥密钥 + `_meta.threadId`）**：Codex 配置 HTTP MCP 时**只传 `x-orrery-bridge: <secret>`**，**绝不传 `x-orrery-session` 或 `x-orrery-harness`**（若传了 `x-orrery-harness: codex` 而无 `x-orrery-session` 会落入无身份 `nobody` 分支被拒绝）；Hub 从运行期 `_meta.threadId` 识别成员。
3. **运行期 `_meta` 注入（Qoder / ZCode / 可选直连 Kimi）**：Qoder 中继发签名请求，ZCode 和 Kimi 的静态配置带 `x-orrery-bridge`，都带对应 `x-orrery-harness`，分别读取不可伪造的 `_meta["com.qoder/turnContext"].sessionId`、`root_session_id` / `session_id` 或 `_meta["kimi/sessionId"]`（其中 Qoder 在检查阶段即优先锁定仅从 `_meta` 识别）。
4. **HMAC 签名参数（Antigravity）**：携带 `x-orrery-bridge` 与 `x-orrery-harness: antigravity`，由 `PreToolUse` Hook 用登记处的共享密钥（`<ORRERY_REGISTRY>/bridge-secret`）覆盖签名参数 `orreryCaller`。

## 投递语义与答复回退

- **忙时合批与终态语义**：支持 `follows` 或轮次结束观察的适配器会在忙时留存新消息并在本轮结束合批下发；遇到断线、超时或模糊错误时标记 `outcome: unknown`，不自动重投（防重复执行）。
- **无工具时的答复即发言**：默认版 Kimi Code 不使用 MCP 认人工具，而是启用 `NativeAdapter.replies = true` 将对应轮次的完整助手文本回答通过常规发言路径发回群聊。
