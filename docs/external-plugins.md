# 外部插件协议（实验性 API v1）

语言：**中文** | [English](external-plugins.en.md)

orrery（`v0.10.0-beta.1` Beta 测试版）允许以独立操作系统子进程运行第三方外部插件，通过 `stdin`/`stdout` 行分隔 JSON-RPC 2.0 协议与本机 Hub 交互；外部插件接口仍处于实验与 Beta 演进期，配置与能力格式可能调整。

> 本设计致谢 MIT 开源参考实现 `deepseek-harness` `dsh-v0.2.1-rc.2`（Copyright (c) 2026 DeepSeek）。外部插件与 Hub 使用同一操作系统用户账户运行，进程分离**仅做故障隔离，不是安全沙箱**——请只安装和启用完全可信的插件。

## 清单与最小权限控制

插件目录放置 `orrery-plugin.json` 清单，由用户手动登记到 `<ORRERY_HOME>/external-plugins.json` 并重启 Hub：

```json
{
  "plugins": [
    {
      "manifest": "C:/projects/my-plugin/orrery-plugin.json",
      "permissions": ["clusters.read", "messages.read", "messages.send", "messages.mention", "events.read"],
      "events": ["task.submitted", "task.approved"],
      "clusterIds": ["<允许读取与收事件的群 ID>"],
      "writeClusterIds": ["<允许发言的群 ID>"]
    }
  ]
}
```

- **读写白名单严格分离**：`clusterIds` 仅授权群信息/消息读取与事件订阅；只有同时满足授出 `messages.send` 且目标群列入 `writeClusterIds`，插件才能向该群发消息。配置最多 16 个插件、单个最多 32 个命令、每群清单不超过 100 项（无通配符，省略等同空列表）。
- **点名唤醒控制（`messages.mention` + `mentionEnabled`）**：仅授出 `messages.send` 而不授 `messages.mention`（或在设置页未开启 `mentionEnabled`）时，插件消息中的 `@` 不会唤醒任何群员；若用户显式同时授权了 `messages.mention` 并开启开关（可配置每分钟/每小时限流），插件消息**可以合法点名并唤醒对应群员**。
- **资源与入口安全检查**：入口必须是插件目录内解析后的 `.js` / `.mjs` / `.cjs`；清单图标仅接受目录内合法 `.png` / `.webp` / `.ico` / `.svg` 普通文件（校验魔数/根节点与 256 KiB 上限），拒绝对外链接或越界符号链接。
- 参见独立示例：[消息计数示例](../examples/hub-plugins/message-counter/README.md) 与 [验收提醒示例](../examples/hub-plugins/review-reminder/README.md)。

## 协议与运行隔离

1. **命令调用与停止**：经认证 `POST /api/plugins/:id/invoke` 执行插件命令；`POST /api/plugins/:id/stop`（传 `{}`）立即停止子进程。
2. **订阅事件流（`events.read`）**：可订阅 `message.created`、`task.submitted`、`task.approved`、`task.rejected`、`task.merged`、`member.status`，带队列背压与丢帧计数通知。
3. **写设置调节**：可通过 `PATCH /api/plugins/:id/write-settings`（或设置页开关）单独开关 `mentionEnabled` 与频率上限。

## 当前限制

- 外部插件崩溃、超时或协议错乱不会牵连 Hub 主进程与群聊投递；变更清单或增删授权须重启 Hub 生效；外部插件不能向协作页注入前端 UI 插槽或脚本。
