# 启动器与多实例检查（`launcher.ts`）

语言：**中文** | [English](launcher.en.md)

启动器负责在确认数据归属的前提下启动或复用本机 orrery Hub，并将带会话令牌的地址交给浏览器（桌面外壳通过 `--ensure` 复用同一套探测逻辑）。

## 常用启动命令

| 命令 | 行为 |
|---|---|
| `npm start` | 在当前终端前台直接启动 Hub |
| `npm run open` | 探测现存 Hub；若未运行则在后台拉起实例、等待就绪后打开浏览器 |
| `npm run open -- --ensure` | 执行同一套探测/拉起流程并在标准输出打印一行 JSON（`{"url"}` 或 `{"error"}`），不打开浏览器 |
| `npm run shortcut` | 在 Windows 桌面创建启动快捷方式 |

## 配置解析与端口复用机制

`resolveConfig()` 读取 `ORRERY_PORT`（默认 `4317`）、`ORRERY_HOME`（默认 `~/.orrery`）与 `ORRERY_DB`（默认 `<仓库>/.tmp/orrery.db`）。测试须自行覆盖端口与目录，以免碰及 `4317` 上的日常 Hub。

- **无目录锁文件**：启动器不使用目录锁文件，也不主动检查或清理所谓的“死 PID”或锁文件；进程互斥依靠 Hub 绑定回环端口。
- **跨端口同数据目录复用**：启动器读取 `<ORRERY_HOME>/hub.json` 中的回环地址与 PID，带上 API 令牌请求该端口的 `GET /api/health`（未带令牌会被 `401` 拒绝，见下节）：
  1. 响应来自 orrery、PID 与 `hub.json` 一致，且返回的 `(home, db)` 路径与当前配置完全相同时，直接复用该现存 Hub（**即使其监听端口不同于当前的 `ORRERY_PORT`**，也会复用它并打开它所在的端口）；
  2. 若 `hub.json` 指向另一组 `(home, db)` 的存活 Hub（`other-data`）、返回 `401`（`unauthorized`）或超时/未知状态（`unknown`），均直接拒绝启动，绝不接管或强杀其他进程；
  3. 确认未运行（`none`：无合法 `hub.json`、端口拒绝连接、非 orrery 或 PID 不符）时才在后台拉起新 Hub，并在最长 **20 秒（`START_TIMEOUT_MS`）**内轮询 `/api/health`。若超时仍未就绪，启动器报错退出并提示日志位置（`<ORRERY_HOME>/hub.log`），**不会结束已在后台运行的 Hub 进程**（它可能仍在启动途中）。

## 认证与关闭边界

- **页面会话与 API 令牌**：浏览器打开的地址附带 `#token=<apiToken>`（URL fragment 不会发给服务器）；前端静态页将其经 `POST /api/session` 换取 `HttpOnly`、`SameSite=Strict` 会话 Cookie（令牌本身不做“一次性”拦截）。静态根页可直接访问，而包括 `GET /api/health` 在内的所有 `/api/*` 接口未带有效令牌或 Cookie 时均返回 `401`。
- **受控关闭（`POST /api/shutdown`）**：仅经认证后触发优雅停机并结束监听。启动器本身从不向无关进程发起关闭或杀进程操作。
