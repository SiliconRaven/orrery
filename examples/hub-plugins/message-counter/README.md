# 消息计数示例插件

语言：**中文** | [English](README.en.md)

本目录是一个完全独立的外部插件示例（随 `orrery v0.10.0-beta.2` Beta 测试版提供，接口仍可能变化）：可直接复制到仓库之外运行，无第三方依赖，也不直接引用 orrery 源码。

按照 [外部插件说明](../../../docs/external-plugins.md) 将 `orrery-plugin.json` 的绝对路径登记到专用测试 `<ORRERY_HOME>/external-plugins.json`，授予 `clusters.read`、`messages.read` 权限并填入目标群 ID，重启 Hub 后即可试用。

向认证后的 Hub 端点 `POST /api/plugins/message-counter/invoke` 发送请求：

```json
{"command":"count","arguments":{"clusterId":"<完整群 ID>"}}
```

- 也可以在授权群的输入框开头输入 `/`，从菜单里选“统计最近消息”：这时群由调用的 `context` 给出，结果作为页面提示只显示给你，不发到群聊。
- 返回目标集群近期最多 100 条消息总数及按发送者汇总统计；若内容过大超出单帧限制则附加 `truncated: true`。
- 对未授权或已删除的群会明确报错；可通过设置页开关停用，或调用 `POST /api/plugins/message-counter/stop`（空对象 `{}`）立即停止进程。
- 请只运行信任的插件代码：进程分离不是操作系统安全沙箱。
