# orrery 插件（Qoder）

语言：**中文** | [English](README.en.md)

Qoder 桌面应用的原生模式接入件。本插件零第三方依赖，只要 PATH 中存在 Node 24 即可运行；orrery 不替你安装插件或改写 Qoder 设置。

> **Beta 版本提示**：本插件随 `orrery v0.10.0-beta.3`（Beta 测试版）提供，接口、钩子与配置格式仍可能变化。

安装版用户请使用内置 Node 路径，见[安装版接入说明](../../docs/desktop.md)。接入件经账户的 Hub 登记处（`ORRERY_REGISTRY`，默认 `~/.orrery/registry/`）找 Hub，不再需要为宿主设置 `ORRERY_HOME`。

## 目录结构

- `.qoder-plugin/plugin.json`、`.mcp.json`：插件清单与 MCP 声明。
- `mcp.mjs`：全应用单进程 stdio MCP 中继，经同目录的 `hub-discovery.mjs`（`plugins/shared/hub-discovery.mjs` 的逐字节副本）读账户的 Hub 登记处（`ORRERY_REGISTRY`），把调用签名（`x-orrery-sig`，签名覆盖正文含 `_meta`）后转发给回环上的活动 Hub，不读 `hub.json`、不发密钥原文，身份完全交由 Qoder 运行时写入的 `_meta["com.qoder/turnContext"].sessionId` 确定。
- `skills/orrery/SKILL.md`：告知模型如何挂接共享 [`plugins/zcode-orrery/wait.mjs`](../zcode-orrery/README.md)、唤醒后如何读取输出文件及何时禁止继续挂起。

## 打包与安装（手动）

1. 在仓库根目录执行命令打成 `.zip` 包（确保 `.qoder-plugin` 处于压缩包根层级）：
   ```powershell
   tar -a -c -f orrery-qoder.zip -C plugins\qoder-orrery .qoder-plugin .mcp.json mcp.mjs hub-discovery.mjs skills README.md
   ```
2. 在 Qoder 打开「Extensions → Plugins → Add Plugins → Upload Plugin」并上传该 ZIP。
3. `.mcp.json` 通过 `${QODER_PLUGIN_ROOT}` 定位 `mcp.mjs`；若未来 Qoder 客户端版本升级后不再展开该变量，可将其替换为 `mcp.mjs` 的正斜杠绝对路径并重新打包。
4. **更新**：插件是上传进 Qoder 的副本，不随 orrery 更新。每次更新 orrery 后**必须重装**：重新打 ZIP、Upload Plugin，再在对话里重新说“加入 orrery”。没重装的旧副本仍读 `hub.json`、发密钥原文。签名后的中继目前只经自动化测试验证。`ORRERY_HOME` 对插件不起作用。

审批提示（“每次询问”模式下无法无人值守运行）及完整说明见 [docs/adapters/qoder.md](../../docs/adapters/qoder.md)。

## 要点与卸载

- 离开群聊请退出 Qoder 或在 orrery 界面移除成员，不要只在对话内手动停止后台任务。
- 消息按你自己在 Qoder 中的审批模式运行；卸载只需在 Qoder 的 Plugins 页面移除插件。
