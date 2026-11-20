# 界面示例插件

语言：**中文** | [English](README.en.md)

本目录是一个受限插件示例（随 `orrery v0.10.0-beta.3` Beta 测试版提供，接口仍可能变化），可以整个复制到仓库外运行，不导入 orrery 源码、不需要 npm 依赖，也不调用模型或网络。

它在协作页里显示一个按群计数的小计数器，两处各一份：群聊标题栏的标签（点开是面板）和任务工作台里的“界面示例”标签页。点“加一”时，网页（`ui/`）经 orrery 的通道给插件进程发一个 `ui.request`；插件回答新的计数，再用 `host.ui.push` 推给这个群所有打开着的界面，用 `host.ui.chip` 把标题栏标签改成“计数 N”。计数只在插件进程的内存里，插件重启后从 0 开始。

授予了 `marks` 位置时，每次计数变化它还用 `host.ui.mark` 加几个由 orrery 画的小标记：成员列表里前三个成员名字右边的“计数 N”、最新一条消息下面的“第 N 次”，以及它最近从任务事件里听到的那个任务。找成员和最新消息要 `clusters.read`、`messages.read`，知道任务要 `events.read` 和任务事件；没授予的那一项示例会跳过，其余照常。

按[第三方插件说明](../../../docs/external-plugins.md)把 `orrery-plugin.json` 的绝对路径登记到自己选择的 `ORRERY_HOME` 下的 `external-plugins.json`，授予需要的权限、位置和具体群 ID，然后重启 Hub：

```json
{
  "plugins": [{
    "manifest": "C:/plugins/ui-demo/orrery-plugin.json",
    "permissions": ["ui.show", "clusters.read", "messages.read", "events.read"],
    "events": ["task.created", "task.changed", "task.deleted"],
    "ui": ["titlebar", "workbench", "marks"],
    "clusterIds": ["<完整群 ID>"]
  }]
}
```

只想看网页界面时，`permissions` 写 `["ui.show"]`、`ui` 写 `["titlebar", "workbench"]`、不写 `events` 即可。

打开这个群，标题栏会出现“界面示例”标签。在这个群里新建或改动一个任务后再点“加一”，那个任务上也会出现标记。设置 → 插件 → 这个插件卡片上的“显示网页界面”开关可以随时关掉它的界面和标记。

网页运行在 `sandbox="allow-scripts"` 的框架里：只能加载 `ui/` 里自己的文件，不能联网、读页面或 cookie，只能和这个插件进程通信。插件进程本身不受这些限制（独立进程不是安全沙箱），请只运行可信插件。
