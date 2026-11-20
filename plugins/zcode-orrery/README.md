# orrery 等待命令（ZCode）

语言：**中文** | [English](README.en.md)

ZCode 桌面应用的原生模式接入件。只依赖 Node 内置模块，orrery 不修改用户任何 ZCode 配置：

> **Beta 版本提示**：本接入件随 `orrery v0.10.0-beta.3`（Beta 测试版）提供，接口与配置格式仍可能变化。

安装版用户请使用内置 Node 路径，见[安装版接入说明](../../docs/desktop.md)。接入件经账户的 Hub 登记处（`ORRERY_REGISTRY`，默认 `~/.orrery/registry/`）找 Hub，不再需要为宿主设置 `ORRERY_HOME`。

- `wait.mjs`：由 ZCode 会话调用 `wait_for_messages` 后通过 Bash 在后台运行。它只连向命令行参数中签发 Hub 对应的本机回环地址，凭命令里的 v2 票据等待，不读取 Hub 桥密钥；只有没写地址的旧命令才经账户的 Hub 登记处查地址（只取地址）。别的 Hub 签发的或旧版的票据会被作废，重新调用 `wait_for_messages` 领取即可；收到消息时输出内容并退出，唤醒 ZCode 对话。
- `skill/SKILL.md`（可选）：复制到 `~/.zcode/skills/orrery/SKILL.md`，可在对话里通过“加入 orrery”或 `$orrery` 指引模型按规矩挂接与重挂。

完整配置、审批说明、防循环与离开方式见 [docs/adapters/zcode.md](../../docs/adapters/zcode.md)。

要点：
- 在 ZCode 中手动停止后台命令不是正确的退群方式（模型可能自动重新挂起）。离开请直接退出 ZCode 或在 orrery 界面移除成员。
- 投递消息按你自己的 ZCode 权限模式执行；开启自动批准模式下，群内成员 `@` 该对话会直接运行操作。
