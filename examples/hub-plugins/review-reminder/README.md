# 验收提醒示例插件

语言：**中文** | [English](README.en.md)

本目录可完整复制到仓库外运行（随 `orrery v0.10.0-beta.2` Beta 测试版提供，接口仍可能变化），只依赖 Node 内置模块。插件监听任务提交（`task.submitted`）事件并等待 5 分钟，若未收到验收结论则向对应群聊发送一条署名「插件 review-reminder」的纯提醒消息（不申请 `messages.mention` 故不点名唤醒成员）。同一任务重提会重置计时器；收到通过、退回或合并事件（或自查直接完成）时自动取消计时器。

## 在独立测试环境运行

1. 运行内置插件测试验证：
   ```powershell
   node --test --test-name-pattern 'standalone review reminder' test/external-plugins.test.ts
   ```
2. 或起一个完全独立的测试 Hub 人工体验（切勿使用用户日常 `4317` 端口与默认 `~/.orrery` 目录）：
   ```powershell
   $demo = Join-Path $env:TEMP ('orrery-review-reminder-' + [guid]::NewGuid())
   $env:ORRERY_HOME = Join-Path $demo 'home'
   $env:ORRERY_DB = Join-Path $demo 'orrery.db'
   $env:ORRERY_PORT = '14917'
   $env:ORRERY_MOCK = '1'
   npm run open
   ```
   在页面里新建集群时勾选 `mock`，选它的演示项目，再勾选里面的现成对话接入（或勾选“另外新建一个对话”）（从地址 `#c=...` 或 `GET /api/clusters` 获取群 ID），将本目录复制到临时路径（可酌情改小副本中 `main.mjs` 的 `REMINDER_DELAY_MS`），写入 `$demo\home\external-plugins.json` 并重启这个临时 Hub：

   ```json
   {
     "plugins": [{
       "manifest": "C:/projects/review-reminder/orrery-plugin.json",
       "permissions": ["events.read", "messages.send"],
       "events": ["task.submitted", "task.approved", "task.rejected", "task.merged"],
       "clusterIds": ["<完整群 ID>"],
       "writeClusterIds": ["<完整群 ID>"]
     }]
   }
   ```

   **同时在 `clusterIds`（收事件）和 `writeClusterIds`（写发言）列出的群**才会接收该提醒。支持经认证的 `POST /api/plugins/review-reminder/stop`（正文 `{}`）立即停止插件。

## 行为边界

- 不回放启动前的历史提交；若出现丢帧通知则清空现有计时器后继续追踪新事件；取消或重开任务未在默认订阅名单内，既有计时器可能照常触发。
- 进程分离仅做故障隔离、非 OS 级安全沙箱，请只加载可信插件。详情见 [外部插件说明](../../../docs/external-plugins.md)。
