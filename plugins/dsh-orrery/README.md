# dsh-orrery

语言：**中文** | [English](README.en.md)

DeepSeek Harness（DSH）的 orrery 插件包。它把你在 DSH 里的会话接入本机运行的 orrery Hub（原生模式）。本目录只依赖 Node 内置模块，单独复制也可独立安装。

> **Beta 版本提示**：本插件随 `orrery v0.10.0-beta.2`（Beta 测试版）提供，接口与配置格式仍可能变化。

安装版用户请使用内置 Node 路径，见[安装版接入说明](../../docs/desktop.md)。接入件经账户的 Hub 登记处（`ORRERY_REGISTRY`，默认 `~/.orrery/registry/`）找 Hub，不再需要为宿主设置 `ORRERY_HOME`。

## 功能与边界

- **收消息与合批**：收到 `@` 点名投递后以排队用户消息进入目标会话（`sessionController.prompt` `queue` 模式），并在本轮结束（`turn/end`）时向 Hub 上报 `done` 及 token 用量，期间新消息在 Hub 合批等待下一轮。
- **协作工具与前缀**：注册 `mcp__orrery__*` 系列群聊、确认、任务与资料工具（加前缀避开 DSH 内置的 `send_message` 与 `list_agents`）。
- **工具后置未读提示**：默认随新版插件生效；工具执行后后台请求 `/bridge/unread-hint`（500 毫秒超时），仅在仍有未读且分项计数变化时在 `additionalContexts` 插入精简计数提示（来源 `dsh-orrery`）。注：子代理是否使用独立身份，取决于宿主提供的会话字段。
- **活动观察**：仅上报已入群会话的工具与轮次状态，不含参数或正文；已真机验证真实收发、轮次结束与心跳展示。
- **找 Hub 与签名**：经 `lib/hub-discovery.mjs` 每次请求读账户的 Hub 登记处（`ORRERY_REGISTRY`，默认 `~/.orrery/registry/`），连活动 Hub 或 `ORRERY_HUB` 钉住的那个；所有请求用 `x-orrery-sig` 签名，不读 `hub.json`、不发密钥原文。
- **零侵入约定**：只连回环地址上的 Hub，不读 `~/.dsh` 凭据文件、不记录密钥、不改会话模型与审批预设，也不用 `steer` 打断进行中的对话。

## 安装、更新与卸载

1. 在 DSH 侧栏 **Plugins → Add plugin** 填入本目录的**绝对路径**（例如 `C:/projects/orrery/plugins/dsh-orrery`）；或先完全退出 DSH 后运行：
   ```powershell
   dsh plugin --profile desktop add link:<本目录绝对路径>
   ```
2. 启动 orrery Hub（`npm start`）。`ORRERY_HOME` 对插件不起作用；如自定义了 `ORRERY_REGISTRY` 或要用 `ORRERY_HUB` 钉住某个 Hub，确保 DSH 进程环境一致。
3. **更新后重载**：更新 orrery 后，请在 DSH 插件页将 `dsh-orrery` **停用再重新启用**（或重启 DSH），使新代码生效（插件按路径引用，不用重装）。
4. **停用或卸载**：在插件页停用/移除，或退出 DSH 后执行 `dsh plugin --profile desktop remove dsh-orrery`。插件断开即离线，停用期间群聊消息不补发。

## 风险与兼容性

- **审批提示**：投递进来的消息按**你自己在 DSH 中的权限预设**执行。若设为自动批准不询问，别的群员 `@` 该会话将直接运行工具与命令。
- **版本范围**：`engines.dsh` 要求 `>=0.2.1-rc.2 <0.3.0-0`；DSH 处于预览迭代阶段，应用更新后请复测基础收发。详细说明见 [docs/adapters/deepseek.md](../../docs/adapters/deepseek.md)。
