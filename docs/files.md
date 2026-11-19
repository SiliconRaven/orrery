# 文件收发与 Skill `$` 引用

语言：**中文** | [English](files.en.md)

## 网页上传与附件安全呈现

用户可通过 `POST /api/files` 向群聊发言或任务定义附加文件，通过 `GET /api/files/:id` 读取：

- **大小与数量上限**：单文件最大 **20 MB**，单次发送最多附带 **10 个文件**。
- **魔数决定安全呈现方式**：Hub 读取文件头魔数（Magic Bytes）真实识别 PNG / JPEG / GIF / WebP（而不是用扩展名拒绝上传）。确认为以上 4 种图片时按识别出的 MIME 在线安全预览（附 `X-Content-Type-Options: nosniff` 与沙箱 CSP 头）；其他文件或魔数不匹配时强制按 `attachment` 附件下载，不作内联渲染。
- **未发出的上传与清理**：从输入区移除尚未发出的文件时仅解除本次消息引用；软删除集群经 `purge` 彻底清理时连同无主文件记录一并删除。

## 群员发件箱（`attachments`）

原生成员可在 MCP `send_message` 的 `attachments` 参数中附带纯文件名（不含路径）将发件箱内的真实副本随消息发出：

- Hub 为每个成员维护独立的发件箱目录，遵守同样单文件 `20 MB`、每次最多 `10` 个的上限；
- **防逃逸检查**：禁止目录分隔符、UNC 路径、符号链接（Symlinks）与多硬链接（Hardlinks）；Hub 仅核验后复制到附件存储，绝不修改或删除发件箱原件。
- **桌面外壳下载约束**：Electron 桌面外壳内限制非受控网页直接触发任意文件落盘下载。

## `$` 引用本地 Skill

在协作页输入 `$` 时从本地 skill 目录枚举名称供补全：

- 默认读取 **`~/.agents/skills`**；
- 启动 Hub 前设置环境变量 **`ORRERY_SKILLS_DIR`** 可切换为自定义目录（`$` 补全只读枚举这个目录）。
- 在“技能与 MCP”页装好 skill 后，`$` 列表会重新读一次；在页面外新加的 skill 要刷新页面。

## 技能与 MCP 页

左栏的“技能与 MCP”打开一个只读总览：共享 skill 文件夹，以及每个支持的应用在本机的用户级 skill 和 MCP 服务器（`GET /api/extensions`）。

- **skill**：只列每个 skill 文件夹的直接子文件夹，读 `SKILL.md` 开头 frontmatter 里的名字和描述；从不跟随符号链接或目录联接（只按名字列出并标“链接”）。同名 skill 已在共享文件夹里时标“已在共享文件夹”。
- **MCP 服务器**：每个服务器只给名字、传输方式（`stdio`、`http`、`sse`、`ws`）和目标（本机程序只给文件名，URL 只给协议和主机）。参数、环境变量、请求头、URL 里的用户名密码、路径和查询从不读出，配置内容不写日志。
- 位置一律写成 `~/.codex/config.toml` 这样的形式，不含用户名；应用状态为“暂不支持”（orrery 还不知道它的位置）或“未找到”（这台电脑上没有）时如实显示。

## 安装 skill

只能装进共享 skill 文件夹（`ORRERY_SKILLS_DIR`，默认 `~/.agents/skills`），从不写任何应用自己的文件夹，也不从网络下载。`POST /api/extensions/skills/install` 接受三种来源：

- `{ fromApp, skill, source?, overwrite? }`：某个应用里已有的 skill，Hub 按名字重新找到它（请求里没有路径）；
- `{ fromPath, overwrite? }`：本机文件夹，必须是盘符开头的绝对路径，网络和设备路径直接拒绝；
- ZIP：正文是 ZIP 原始字节（`application/octet-stream`，文件名放在 `x-orrery-filename`，覆盖用 `?overwrite=1`），最大 20 MB。

规则：来源最上层要有 `SKILL.md`（ZIP 可以在唯一的顶层文件夹里）；名字取 frontmatter 的 `name`，不合法时用文件夹名；来源和目标里都不能有链接；最多 1000 个文件和文件夹、合计 50 MB、16 层。ZIP 只支持不压缩和 deflate，拒绝加密、zip64、分卷、链接、不安全或重名的文件名、压缩比异常和校验失败的文件。先写进共享文件夹里的临时文件夹再改名到位；覆盖时旧的一份在新的到位后才删除。成功回答 `200 { name, description, replaced, oldRemoved? }`，拒绝回答 `{ error, code }`（`exists` 为 409，其余 400），错误信息不含路径和文件内容。

只有用户能用这两个接口：它们在 `/api/*` 下要 API 令牌，没有对应的 MCP 工具，桥密钥和插件都调不到。不做：写进应用的文件夹、改 MCP 配置、网络下载、卸载、运行 skill。

**拒绝代码**：

| 代码 | 含义 |
|---|---|
| `bad_request` | 请求的格式不对 |
| `not_configured` | 没有设置共享 skill 文件夹 |
| `shared_dir_link` | 共享 skill 文件夹或它的上级是链接（或目录联接），不往这样的位置安装 |
| `shared_dir_invalid` | 共享 skill 文件夹不能用（不是文件夹，或建不起来） |
| `unknown_app` | 没有这个应用 |
| `unknown_skill` | 这个应用里已经没有这个 skill，请刷新列表 |
| `skill_is_link` | 这个 skill 是指向别处的链接；请改用“从文件夹安装”，选它实际所在的文件夹 |
| `path_not_absolute` | 路径要以盘符开头 |
| `path_not_local` | 不支持网络路径和设备路径 |
| `path_not_found` | 找不到这个文件夹 |
| `path_not_directory` | 这个路径不是文件夹 |
| `source_has_link` | 来源里有链接（符号链接或目录联接） |
| `source_bad_entry` | 来源里有既不是文件也不是文件夹的东西 |
| `source_unreadable` | 来源里有读不了的文件或文件夹 |
| `source_changed` | 复制时来源里的文件被改动了，请再试一次 |
| `source_contains_shared` | 这个文件夹包含共享 skill 文件夹本身 |
| `missing_skill_md` | 最上层没有 `SKILL.md` |
| `invalid_name` | 没有合法的名字（字母、数字和 `_ . : -`，最长 64 个字符） |
| `too_many_files` | 文件太多（最多 1000 个文件和文件夹） |
| `too_large` | 太大（ZIP 最大 20 MB，解压后合计最多 50 MB） |
| `too_deep` | 文件夹层次太深（最多 16 层） |
| `exists` | 共享文件夹里已经有同名的 skill（可以选择覆盖） |
| `target_is_link` | 共享文件夹里同名的是一个链接，不替换链接 |
| `target_not_folder` | 共享文件夹里有一个同名的文件 |
| `existing_has_link` | 已安装的那一份里有链接，不删除含链接的文件夹 |
| `existing_too_large` | 已安装的那一份太大，没法先检查再替换 |
| `busy` | 文件正被别的程序（例如杀毒软件）占用，请稍后再试 |
| `io_error` | 复制时出错 |
| `zip_invalid` | 不是完整的 ZIP 文件 |
| `zip_unsupported` | 不支持这种 ZIP（分卷、zip64 或特殊的压缩方式） |
| `zip_encrypted` | ZIP 加了密码 |
| `zip_symlink` | ZIP 里有链接 |
| `zip_bad_name` | ZIP 里有不安全的文件名（绝对路径、盘符、`..`、反斜杠或 Windows 不允许的名字） |
| `zip_duplicate` | ZIP 里有重名的文件（只差大小写也算） |
| `zip_ratio` | ZIP 里有压缩比异常高的文件 |
| `zip_crc` | ZIP 里有文件校验不通过 |
