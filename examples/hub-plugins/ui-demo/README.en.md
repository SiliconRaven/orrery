# UI Demo Plugin

Language: [中文](README.md) | **English**

A restricted plugin example (bundled with `orrery v0.10.0-beta.3` Beta pre-release; APIs may change). The whole folder can be copied outside the repository; it imports no orrery source, needs no npm dependencies and calls no model or network.

It shows a small per-group counter on the collaboration page in two places: a chip in the group title bar (which opens a panel) and a "界面示例" (UI demo) tab in the task workbench. The example's own texts are in Chinese. Clicking the "加一" (+1) button makes the page (`ui/`) send a `ui.request` to the plugin process through orrery's channel; the plugin answers with the new count, pushes it to every open page of that group with `host.ui.push`, and renames the title-bar chip to "计数 N" (count N) with `host.ui.chip`. The count lives only in the plugin process's memory and restarts at 0 with the plugin.

When the `marks` position is granted, each change also adds a few marks drawn by orrery through `host.ui.mark`: "计数 N" next to the first three members in the member list, "第 N 次" (the Nth time) under the latest message, and on the task it most recently heard about from task events. Finding members and the latest message needs `clusters.read` and `messages.read`; knowing tasks needs `events.read` and task events. The example skips whatever is not granted.

Following [Third-party plugins](../../../docs/external-plugins.en.md), register the absolute path of `orrery-plugin.json` in `external-plugins.json` under an `ORRERY_HOME` of your choice, grant the permissions, positions and group IDs you want, and restart the Hub:

```json
{
  "plugins": [{
    "manifest": "C:/plugins/ui-demo/orrery-plugin.json",
    "permissions": ["ui.show", "clusters.read", "messages.read", "events.read"],
    "events": ["task.created", "task.changed", "task.deleted"],
    "ui": ["titlebar", "workbench", "marks"],
    "clusterIds": ["<full-cluster-id>"]
  }]
}
```

For the pages alone, use `"permissions": ["ui.show"]`, `"ui": ["titlebar", "workbench"]` and no `events`.

Open the group and a "界面示例" chip appears in the title bar. Create or change a task in that group, click "加一" again, and the task gets a mark too. The "Show web UI" switch on the plugin's card under Settings → Plugins removes its pages and marks at any time.

The page runs in a `sandbox="allow-scripts"` frame: it can only load its own files from `ui/`, cannot reach the network, the page or cookies, and can only talk to its plugin process. The plugin process itself is not restricted (a separate process is not a security sandbox), so run trusted plugins only.
